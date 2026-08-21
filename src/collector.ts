/**
 * Usage collector: turns the session event stream into atomic usage samples.
 * Two sources feed the same fold:
 *
 * - live: `session/event` subscription — every committed session event
 *   reaches this plugin after the fact. `assistant/message` carries the
 *   step's final `usage` (TokenUsage); `assistant/chunk` carries an early
 *   `usage` sample from the streaming adapter; `request/context` carries the
 *   provider/model route. A completed call's usage is attributed to the model
 *   the request used. Both the fold bucket and the route are keyed by the
 *   session id carried by every callback, so concurrent sessions never share
 *   dedupe state or attribution.
 * - backfill: on first boot (when the domain is empty) the collector
 *   enumerates every persisted session (`sessionPersistence.list()`) and
 *   replays its full event log (`inspect(id)`) through a FRESH per-session
 *   fold, so historical usage is accounted from the day the plugin is
 *   installed.
 *
 * Idempotence: within ONE session, the same (turn, step) may report usage
 * more than once (a streaming sample then the final assistant/message;
 * compaction replays). The fold keeps the newest sample per (turn, step) and
 * replaces the earlier one instead of double counting — the same replace
 * semantics as dsh-token-meter's usage projection, which is likewise a
 * per-session projection. Cross-session (turn, step) collisions are NOT
 * deduped: two sessions both own a turn 1 / step 1, and each must count.
 * The store's per-day rows accumulate, so re-folding the same log must not
 * add twice: live events are only folded once per event; backfill runs on a
 * fresh (empty) domain and never re-processes a session the store already
 * saw (guarded by the per-session cursor below).
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

/** The turn/end payload: why the turn ended (reasonix records every ended turn). */
interface TurnEndData {
  turn?: number
  reason?: { kind?: string }
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

/** How many completed sessions accumulate before one batched cursor write.
 *  The backfill cursor is a full read-modify-write global, so batching keeps
 *  the rewrite count at N/batch instead of N (and shrinks the window in
 *  which a crash loses progress to "at most MARK_BATCH sessions replayed"). */
const MARK_BATCH = 32

/**
 * One in-memory fold state for ONE session: tracks the newest usage sample
 * per (turn, step) so a replayed log or a streaming-then-final pair never
 * double counts. The store is the durable side; this fold dedupes within a
 * single event pass (a session replay).
 */
export class UsageFold {
  private seen = new Map<string, UsageSample>()

  private keyOf(ev: UsageSessionEvent): string | null {
    const data = ev.data as UsageEventData
    if (typeof data?.turn !== 'number' || typeof data?.step !== 'number') return null
    // The dedupe key is the (turn, step) pair WITHIN this fold's session,
    // independent of the event type: a streaming usage sample and the final
    // assistant/message for the same call share one slot (the later report
    // replaces the earlier), matching dsh-token-meter's per-session usage
    // projection semantics.
    return `${data.turn}:${data.step}`
  }

  /** Fold one event. Returns the sample to persist, or null when the event
   *  carries no (new) usage or turn marker. */
  fold(ev: UsageSessionEvent): UsageSample | null {
    if (ev.type === 'turn/end') {
      // Every ended turn counts once (reasonix TurnDone parity): a turn ends
      // exactly once, so no dedupe key is needed. Failed turns end too, and
      // reasonix emits TurnDone regardless of the run's error.
      return { day: dayKey(ev.time), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true }
    }
    if (ev.type === 'step/start' || ev.type === 'llm/retry-started') {
      // One actual provider call. reasonix counts every provider call as a
      // request (usage.RequestCount, defaulting to 1) — including calls that
      // fail and report no tokens. DSH's TokenUsage has no RequestCount field,
      // so requests are derived from the call boundaries: `step/start` opens
      // exactly one model call ("one model call plus the tool executions it
      // requested"), and `llm/retry-started` marks each actually-started retry
      // of that call (a scheduled-but-cancelled retry never reaches -started).
      // The marker carries no tokens; the store counts it as one request.
      return {
        day: dayKey(ev.time),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        request: true,
      }
    }
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
    // A sample with nothing at all is noise; a pure-cache call (zero
    // uncached input AND zero output but real cache traffic) still counts —
    // its cacheRead/cacheWrite buckets are real provider-reported tokens.
    if (
      (usage2.inputTokens ?? 0)
      + (usage2.outputTokens ?? 0)
      + (usage2.cacheReadTokens ?? 0)
      + (usage2.cacheWriteTokens ?? 0)
      <= 0
    ) {
      return null
    }
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
 * Samples are folded into the durable store; per-session folds keep
 * replayed/duplicate reports from double counting without ever swallowing a
 * concurrent session's samples.
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
  /** One fold bucket per live session id: (turn, step) dedupe keys are
   *  session-scoped, so concurrent sessions never collide. */
  private folds = new Map<string, UsageFold>()
  /** Per-session last-seen request route ("provider/model" or bare model).
   *  `request/context` only logs on route CHANGES, so each session carries
   *  its own last-known route for attributing subsequent usage samples. */
  private routes = new Map<string, string>()
  private started = false

  constructor(
    private ctx: Context,
    private store: UsageStore,
    private options: CollectorOptions = {},
  ) {}

  /** Extract a stable session id from a callback's session argument. */
  private static sessionIdOf(session: unknown): string {
    const id = (session as { id?: unknown } | null | undefined)?.id
    return typeof id === 'string' && id !== '' ? id : '(unknown-session)'
  }

  private foldFor(sessionId: string): UsageFold {
    let fold = this.folds.get(sessionId)
    if (!fold) {
      fold = new UsageFold()
      this.folds.set(sessionId, fold)
    }
    return fold
  }

  /** Attach the live listeners (call once from apply). */
  start(): void {
    if (this.started) return
    this.started = true
    const ctx = this.ctx as unknown as {
      on?: (event: string, listener: (...args: never[]) => void) => void
    }
    ctx.on?.('session/event', (session: { id: string }, event: UsageSessionEvent) => {
      const sid = UsageCollector.sessionIdOf(session)
      if (event.type === 'request/context') {
        const data = event.data as RequestContextData
        if (data.provider && data.model) this.routes.set(sid, `${data.provider}/${data.model}`)
        else if (data.model) this.routes.set(sid, data.model)
      }
      const sample = this.foldFor(sid).fold(event)
      if (!sample) return
      // Turn markers carry no model attribution (the store lands them on the
      // synthetic "(turns)" row); everything else attributes to THIS
      // session's last-known route — never another session's.
      if (!sample.turn) sample.model = this.routes.get(sid) || undefined
      void this.store.record(sample)
    })
    // Drop a disposed session's buckets so a long-running host does not
    // accumulate one small map entry per session forever.
    ctx.on?.('session/disposed', (session: { id: string }) => {
      const sid = UsageCollector.sessionIdOf(session)
      this.folds.delete(sid)
      this.routes.delete(sid)
    })
  }

  /** Whether a backfill is in progress or was completed. */
  get running(): boolean {
    return this.status.running
  }

  /** Run the one-time backfill: enumerate persisted sessions and replay each
   *  through its own fold. Idempotent — re-running on a populated store only
   *  re-folds sessions the store hasn't seen (guarded by a per-session
   *  cursor persisted in the domain global; the fold's replace semantics
   *  make a full replay safe only when the store is empty). Resolves early
   *  (mid-scan) when `signal` aborts — the fiber teardown path uses this so
   *  disposal does not leave a fire-and-forget scan writing behind it. */
  async backfill(persistence: UsageSessionPersistence, sessions: UsageSessionStore, signal?: AbortSignal): Promise<void> {
    if (this.status.running) return
    if (signal?.aborted) return
    this.status.running = true
    this.status.error = undefined
    try {
      const headers = await persistence.list(signal)
      const liveIds = new Set(sessions.list().map((s) => s.id))
      // The per-session cursor keeps a reboot's backfill from re-folding
      // sessions the store already saw: the fold's replace semantics dedupe
      // within one pass only, so a full replay would double every counter.
      const seen = await this.store.seenSessions()
      if (seen.size === 0 && (await this.store.count()) > 0) {
        // Rows without a cursor predate the per-call request/turn semantics
        // (≤0.1.1): their requests use the old definition and turns are all
        // zero. Rebuild once from the logs instead of replaying on top.
        await this.store.clearDays()
      }
      const targets = headers.filter((h) => !liveIds.has(h.id) && !seen.has(h.id))
      this.status.total = targets.length
      this.status.done = 0
      const concurrency = this.options.backfillConcurrency ?? 4
      let next = 0
      const completed: string[] = []
      const flushCompleted = async (): Promise<void> => {
        if (completed.length === 0) return
        const batch = completed.splice(0, completed.length)
        await this.store.markSeenSessions(batch)
      }
      const worker = async () => {
        for (;;) {
          if (signal?.aborted) return
          const i = next++
          if (i >= targets.length) return
          const header = targets[i]!
          this.status.lastSessionId = header.id
          // One FRESH fold per session replay: (turn, step) keys are
          // session-scoped, so concurrent replays must never share a fold.
          const fold = new UsageFold()
          let route = ''
          try {
            const inspection = await persistence.inspect(header.id, signal)
            for (const ev of inspection.events) {
              if (signal?.aborted) return
              if (ev.type === 'request/context') {
                const data = ev.data as RequestContextData
                if (data.provider && data.model) route = `${data.provider}/${data.model}`
                else if (data.model) route = data.model
              }
              const sample = fold.fold(ev)
              if (sample) {
                if (!sample.turn) sample.model = route || undefined
                await this.store.record(sample)
              }
            }
            // Mark only after a clean replay, so a failed session retries on
            // the next boot instead of being silently skipped forever.
            completed.push(header.id)
            if (completed.length >= MARK_BATCH) await flushCompleted()
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
      await flushCompleted()
    } finally {
      this.status.running = false
    }
  }
}
