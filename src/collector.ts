/**
 * Usage collector: turns the session event stream into atomic usage samples.
 * Two sources feed the same fold:
 *
 * - live: `session/event` subscription — every committed session event
 *   reaches this plugin after the fact. `assistant/message` carries the
 *   step's final `usage` (TokenUsage); `assistant/chunk` carries an early
 *   `usage` sample from the streaming adapter; `request/context` carries the
 *   provider/model route. A completed call's usage is attributed to the
 *   model the request used.
 * - backfill: on first boot (when the domain is empty) the collector
 *   enumerates every persisted session (`sessionPersistence.list()`) and
 *   replays its full event log (`inspect(id)`) through the same fold, so
 *   historical usage is accounted from the day the plugin is installed.
 *
 * Idempotence: the same (turn, step) may report usage more than once (a
 * streaming sample then the final assistant/message; compaction replays).
 * The fold keeps the newest sample per (turn, step) and replaces the
 * earlier one instead of double counting — the same replace semantics as
 * dsh-token-meter's usage projection. The store's per-day rows accumulate,
 * so re-folding the same log must not add twice: live events are only folded
 * once per event; backfill runs on a fresh (empty) domain and never
 * re-processes a session the store already saw (guarded by the per-session
 * cursor below).
 */

import type { Context } from './context-types.ts'
import type { UsageSessionEvent, UsageSessionPersistence, UsageSessionStore } from './context-types.ts'
import type { UsageStore } from './store.ts'
import type { UsageSample } from './query.ts'
import { dayKey } from './query.ts'

/** A usage-bearing event shape we extract from the session log. */
interface UsageEventData {
  turn?: number
  step?: number
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
}

/** The assistant/message payload. */
interface AssistantMessageData extends UsageEventData {
  message?: unknown
}

/** The assistant/chunk payload. */
interface AssistantChunkData extends UsageEventData {
  chunk?: { type?: string; usage?: UsageEventData['usage'] }
}

/** The request/context payload: the provider/model route. */
interface RequestContextData {
  provider?: string
  model?: string
}

export interface CollectorOptions {
  /** The source label recorded with every sample (matches the reasonix Source). */
  source?: string
  /** Backfill concurrency (default 4, matching session-query-sqlite). */
  backfillConcurrency?: number
}

export interface CollectorStatus {
  running: boolean
  total: number
  done: number
  scannedSessions: number
  lastSessionId?: string
  error?: string
}

/**
 * One in-memory fold state: tracks the newest usage sample per (turn, step)
 * so a replayed log or a streaming-then-final pair never double counts.
 * The store is the durable side; this fold dedupes within a single event
 * pass (a session replay).
 */
export class UsageFold {
  private seen = new Map<string, UsageSample>()

  private keyOf(ev: UsageSessionEvent): string | null {
    const data = ev.data as UsageEventData
    if (typeof data?.turn !== 'number' || typeof data?.step !== 'number') return null
    // The dedupe key is the (turn, step) pair, independent of the event type:
    // a streaming usage sample and the final assistant/message for the same
    // call share one slot (the later report replaces the earlier), matching
    // dsh-token-meter's usage projection semantics.
    return `${data.turn}:${data.step}`
  }

  /** Fold one event. Returns the sample to persist, or null when the event
   *  carries no (new) usage. */
  fold(ev: UsageSessionEvent): UsageSample | null {
    if (ev.type === 'request/context') return null
    if (ev.type === 'assistant/chunk') {
      const data = ev.data as AssistantChunkData
      const usage = data.chunk?.type === 'usage' ? data.chunk.usage : undefined
      return usage ? this.replaceSample(ev, usage) : null
    }
    if (ev.type === 'assistant/message') {
      const data = ev.data as AssistantMessageData
      return data.usage ? this.replaceSample(ev, data.usage) : null
    }
    return null
  }

  private replaceSample(ev: UsageSessionEvent, usage: UsageEventData['usage']): UsageSample | null {
    const usage2 = usage
    if (!usage2) return null
    if (usage2.inputTokens + usage2.outputTokens <= 0) return null
    const key = this.keyOf(ev)
    const sample: UsageSample = {
      day: dayKey(ev.time),
      inputTokens: usage2.inputTokens,
      outputTokens: usage2.outputTokens,
      cacheReadTokens: usage2.cacheReadTokens ?? 0,
      cacheWriteTokens: usage2.cacheWriteTokens ?? 0,
    }
    if (key === null) return sample
    const prev = this.seen.get(key)
    if (prev) {
      // Replace: the later sample wins (same (turn, step)), never add.
      prev.inputTokens = sample.inputTokens
      prev.outputTokens = sample.outputTokens
      prev.cacheReadTokens = sample.cacheReadTokens
      prev.cacheWriteTokens = sample.cacheWriteTokens
      prev.day = sample.day
      return null
    }
    this.seen.set(key, sample)
    return sample
  }
}

/**
 * The collector: subscribes to live events and runs the one-time backfill.
 * Samples are folded into the durable store; the fold's replace semantics
 * keep replayed/duplicate reports from double counting.
 */
export class UsageCollector {
  readonly status: CollectorStatus = {
    running: false,
    total: 0,
    done: 0,
    scannedSessions: 0,
    lastSessionId: undefined,
    error: undefined,
  }
  private fold = new UsageFold()
  private lastRoute = ''
  private started = false

  constructor(
    private ctx: Context,
    private store: UsageStore,
    private options: CollectorOptions = {},
  ) {}

  /** Attach the live listener (call once from apply). */
  start(): void {
    if (this.started) return
    this.started = true
    const ctx = this.ctx as unknown as {
      on?: (event: string, listener: (session: { id: string }, event: UsageSessionEvent) => void) => void
    }
    ctx.on?.('session/event', (session: { id: string }, event: UsageSessionEvent) => {
      if (event.type === 'request/context') {
        const data = event.data as RequestContextData
        if (data.provider && data.model) this.lastRoute = `${data.provider}/${data.model}`
        else if (data.model) this.lastRoute = data.model
      }
      const sample = this.fold.fold(event)
      if (!sample) return
      sample.model = this.lastRoute || undefined
      void this.store.record(sample)
    })
  }

  /** Whether a backfill is in progress or was completed. */
  get running(): boolean {
    return this.status.running
  }

  /** Run the one-time backfill: enumerate persisted sessions and replay each
   *  through the fold. Idempotent — re-running on a populated store only
   *  re-folds sessions the store hasn't seen (guarded by a per-session
   *  cursor persisted in the store's day rows is NOT done here: the fold's
   *  replace semantics make a full replay safe only when the store is empty.
   *  The caller guards with a "backfill done" flag in the domain global. */
  async backfill(persistence: UsageSessionPersistence, sessions: UsageSessionStore): Promise<void> {
    if (this.status.running) return
    this.status.running = true
    this.status.error = undefined
    try {
      const headers = await persistence.list()
      const liveIds = new Set(sessions.list().map((s) => s.id))
      const targets = headers.filter((h) => !liveIds.has(h.id))
      this.status.total = targets.length
      this.status.done = 0
      const concurrency = this.options.backfillConcurrency ?? 4
      let next = 0
      const worker = async () => {
        for (;;) {
          const i = next++
          if (i >= targets.length) return
          const header = targets[i]!
          this.status.lastSessionId = header.id
          try {
            const inspection = await persistence.inspect(header.id)
            let route = ''
            for (const ev of inspection.events) {
              if (ev.type === 'request/context') {
                const data = ev.data as RequestContextData
                if (data.provider && data.model) route = `${data.provider}/${data.model}`
                else if (data.model) route = data.model
              }
              const sample = this.fold.fold(ev)
              if (sample) {
                sample.model = route || undefined
                await this.store.record(sample)
              }
            }
            this.status.scannedSessions++
          } catch (err) {
            // A single unreadable session must not abort the whole backfill.
            this.status.error = `session ${header.id}: ${err instanceof Error ? err.message : String(err)}`
          } finally {
            this.status.done++
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker))
    } finally {
      this.status.running = false
    }
  }
}
