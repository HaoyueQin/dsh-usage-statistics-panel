/**
 * Usage collector: turns the session event stream into atomic usage samples.
 * Two sources feed the same fold:
 *
 * - live: `session/event` subscription — every committed session event
 *   reaches this plugin after the fact. `assistant/message` carries the
 *   step's final `usage` (TokenUsage); `assistant/chunk` carries an early
 *   `usage` sample from the streaming adapter; `request/context` carries the
 *   provider/model route. A completed call's usage is attributed to the model
 *   the request used — in priority order: the message's own `source`
 *   (authoritative per call), then the session's last-known route, which
 *   comes from observed `request/context` events OR is lazily seeded from
 *   the live Session's `requestContext()` fold. That seed matters because
 *   `request/context` only lands in the log on route CHANGES: a session that
 *   predates this collector would otherwise attribute nothing. Both the fold
 *   bucket and the route are keyed by the session id carried by every
 *   callback, so concurrent sessions never share dedupe state or attribution.
 * - backfill: on first boot (when the domain is empty) the collector
 *   enumerates every persisted session (`sessionPersistence.list()`) and
 *   replays its event log (`inspect(id)`) through a FRESH per-session
 *   fold, so historical usage is accounted from the day the plugin is
 *   installed. Sessions the live listener already touched replay only their
 *   pre-observation PREFIX (see markLiveSession) — recovering history the
 *   live path never saw without double counting what it did. A forked
 *   child's stored log begins with the events it copied from its parent;
 *   the host always reports that cut (`inheritedEventCount`, DSH
 *   >= 0.1.2-rc.1, 0 for a non-forked session), and the replay skips it —
 *   the parent's own backfill already counted those events.
 *
 * Idempotence: within ONE session, the same (turn, step) may report usage
 * more than once (a streaming sample then the final assistant/message;
 * compaction replays). The fold emits each (turn, step) key exactly once and
 * keeps the newest values in its own state — see the replaceSample note for
 * why the store observably keeps the FIRST emission. Cross-session
 * (turn, step) collisions are NOT deduped: two sessions both own a turn 1 /
 * step 1, and each must count. The store's per-day rows accumulate, so
 * re-folding the same log must not add twice: live events are only folded
 * once per event, and every session the live listener touches is written
 * into the durable backfill cursor with its first observed seq, so a later
 * boot's backfill never re-processes what the live path already recorded.
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
  message?: {
    source?: { provider?: string; model?: string }
  }
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
  /** Store operations this generation refused (degraded domain, write
   *  failure, ...): live samples AND durable cursor writes. Recording is
   *  observational and must never take the host down, so failures are
   *  counted here instead of escaping as rejections. */
  recordFailures: number
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
      // Attribution note: agent-loop appends step/start BEFORE request/context
      // (core/agent-loop agent.ts), so the FIRST request marker of a fresh —
      // or subagent — session reaches the fold with no route known yet and is
      // recorded model-less (the store's "(unknown)" row). The REQUEST COUNT is
      // never lost; only the per-model slot of that one marker stays unknown.
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
    if (key === null) {
      // No (turn, step) marker: every emission counts (no dedupe slot). The
      // shipped adapters always stamp both on usage events, so this path is
      // a defensive tail, not a live double-count source. ponytail: a
      // synthetic key (e.g. by time+usage hash) could dedupe it if an
      // adapter ever reports usage without turn/step.
      return sample
    }
    const prev = this.seen.get(key)
    // Track the newest report internally either way; the fold must NEVER
    // mutate an object the store already received.
    this.seen.set(key, sample)
    if (prev) {
      // Duplicate report for a known (turn, step): swallow it. The shipped
      // adapters emit the identical TokenUsage on the streaming chunk and
      // the final message (llm-deepseek yields one `pendingUsage` at DONE;
      // llm-pi-ai only on done/error), so first == last observationally.
      // ponytail: true last-wins would need store-side delta corrections
      // keyed by (session, turn, step); add them only if an adapter ever
      // reports differing values for one call.
      return null
    }
    // First emission: hand the store its own copy. The internal object stays
    // fold-owned — mutating it on a later duplicate would rewrite the sample
    // already sitting in the store's write path through the shared reference.
    return { ...sample }
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
    recordFailures: 0,
  }
  /** One fold bucket per live session id: (turn, step) dedupe keys are
   *  session-scoped, so concurrent sessions never collide. */
  private folds = new Map<string, UsageFold>()
  /** Per-session last-seen request route ("provider/model" or bare model).
   *  `request/context` only logs on route CHANGES, so each session carries
   *  its own last-known route for attributing subsequent usage samples. */
  private routes = new Map<string, string>()
  private started = false
  /** Live session ids already written (or queued) into the backfill cursor
   *  this boot — one entry per session, not per event. */
  private liveMarked = new Set<string>()
  /** Coalescing buffer for cursor writes: a burst of first events flushes as
   *  one markLiveSequences call instead of one global rewrite per session.
   *  Value = the first observed seq (-1 sentinel when unknown). */
  private liveMarkBuffer = new Map<string, number>()
  private liveMarkFlushScheduled = false

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

  /** Canonical "provider/model" (or bare model) ref from a route shape. */
  private static refOf(rc: { provider?: string; model?: string } | undefined | null): string | undefined {
    if (!rc) return undefined
    if (rc.provider && rc.model) return `${rc.provider}/${rc.model}`
    return rc.model || undefined
  }

  /** The session's own route fold, read through the live Session object.
   *  `request/context` only lands in the log on route CHANGES, so a session
   *  that predates this collector (host restart, plugin reload) would never
   *  re-announce its route — the authoritative per-session fold is the only
   *  way to attribute such sessions instead of dropping their usage into
   *  "(unknown)". */
  private routeFor(sid: string): string | undefined {
    const known = this.routes.get(sid)
    if (known !== undefined) return known
    const sessions = (this.ctx as unknown as {
      sessions?: { get?(id: string): { requestContext?(): { provider?: string; model?: string } | undefined } | undefined }
    }).sessions
    const rc = sessions?.get?.(sid)?.requestContext?.()
    const ref = UsageCollector.refOf(rc)
    if (ref !== undefined) this.routes.set(sid, ref)
    return ref
  }

  private foldFor(sessionId: string): UsageFold {
    let fold = this.folds.get(sessionId)
    if (!fold) {
      fold = new UsageFold()
      this.folds.set(sessionId, fold)
    }
    return fold
  }

  /** Write a live session into the durable backfill cursor (coalesced per
   *  tick) together with the seq of its FIRST observed event. This is the
   *  restart-safety invariant, upgraded: `SessionStore.list()` only reports
   *  LIVE sessions, and the first-observed seq partitions the persisted log
   *  into [0, firstSeq) — which no live pass ever folded, so the next boot's
   *  backfill replays exactly that prefix to recover pre-attach history —
   *  and [firstSeq, ∞), which the live path owns. The sentinel -1 records
   *  "observed with an unknown boundary" and replays nothing (never risk a
   *  duplicate). */
  private markLiveSession(sessionId: string, firstSeq: number | undefined): void {
    if (sessionId === '(unknown-session)' || this.liveMarked.has(sessionId)) return
    this.liveMarked.add(sessionId)
    this.liveMarkBuffer.set(sessionId, typeof firstSeq === 'number' ? firstSeq : -1)
    if (this.liveMarkFlushScheduled) return
    this.liveMarkFlushScheduled = true
    queueMicrotask(() => {
      this.liveMarkFlushScheduled = false
      const batch = [...this.liveMarkBuffer.entries()]
      this.liveMarkBuffer.clear()
      // Same observational contract as record(): a degraded store must never
      // turn a cursor write into an unhandled rejection.
      if (batch.length > 0) void this.store.markLiveSequences(batch).catch(() => { this.status.recordFailures++ })
    })
  }

  /** Attach the live listeners (call once from apply). */
  start(): void {
    if (this.started) return
    this.started = true
    const ctx = this.ctx as unknown as {
      on?: (event: string, listener: (...args: never[]) => void) => void
      logger?: { warn(message: unknown): void }
    }
    if (typeof ctx.on !== 'function') {
      // A cordis Context always has `on`; the optional chaining below is
      // defensive. If it is ever missing, the LIVE path would die silently
      // while the backfill still works — surface that instead of hiding it.
      ctx.logger?.warn('[dsh-usage-statistics-panel] live session-event subscription unavailable (ctx.on missing); only the boot backfill will record usage')
    }
    ctx.on?.('session/event', (session: { id: string }, event: UsageSessionEvent) => {
      const sid = UsageCollector.sessionIdOf(session)
      this.markLiveSession(sid, typeof event?.seq === 'number' ? event.seq : undefined)
      if (event.type === 'request/context') {
        const data = event.data as RequestContextData
        if (data.provider && data.model) this.routes.set(sid, `${data.provider}/${data.model}`)
        else if (data.model) this.routes.set(sid, data.model)
      }
      // The message itself names the model that served THIS call (every
      // shipped adapter stamps message.source). It is authoritative for the
      // sample below AND refreshes the session's last-known route for later
      // chunk-borne samples, which carry no model of their own.
      let fromSource: string | undefined
      if (event.type === 'assistant/message') {
        fromSource = UsageCollector.refOf((event.data as AssistantMessageData).message?.source)
        if (fromSource !== undefined) this.routes.set(sid, fromSource)
      }
      const sample = this.foldFor(sid).fold(event)
      if (!sample) return
      // Turn markers carry no model attribution (the store lands them on the
      // synthetic "(turns)" row); everything else attributes to the event's
      // own source first, then this session's route (observed or seeded).
      if (!sample.turn) sample.model = fromSource ?? this.routeFor(sid)
      // Recording is observational: a store refusal (degraded domain, disk
      // failure, ...) is counted, never allowed to escape as an unhandled
      // rejection — those take the whole host down.
      void this.store.record(sample).catch(() => {
        this.status.recordFailures++
      })
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
   *  through its own fold. Idempotent — the cursor partitions every session's
   *  log exactly once across boots and live passes:
   *  - a session NOT in backfilledSessions replays up to its cursor boundary:
   *    FULLY when none is recorded (no live pass ever folded this log), only
   *    the PREFIX [0, boundary) when one is — including a STILL-LIVE session,
   *    whose post-boundary events the live path owns (a /reset watermark uses
   *    the same shape: everything below the wipe-time log length must be
   *    rebuilt from the log because the wipe destroyed it);
   *  - whatever the boundary, a fork-inherited prefix reported by the host
   *    (SessionInspection.inheritedEventCount, DSH >= 0.1.2-rc.1) is skipped:
   *    the child copied those events from its parent, whose own backfill
   *    already counted them;
   *  - a session already in backfilledSessions is NEVER replayed again: it
   *    lands there only after a clean replay of its full replayable range,
   *    so re-selecting it would double that range on every later boot;
   *  - a live session without a usable boundary is skipped (its events are
   *    owned by this boot's live pass — or it resumed mid-scan and our
   *    boundary snapshot is stale; stale absence must never widen a replay).
   *  Resolves early (mid-scan) when `signal` aborts — the fiber teardown
   *  path uses this so disposal does not leave a fire-and-forget scan
   *  writing behind it. */
  async backfill(persistence: UsageSessionPersistence, sessions: UsageSessionStore, signal?: AbortSignal): Promise<void> {
    if (this.status.running) return
    if (signal?.aborted) return
    this.status.running = true
    this.status.error = undefined
    try {
      const headers = await persistence.list(signal)
      // The cursor keeps a reboot's backfill from re-folding sessions the
      // store already saw: the fold's replace semantics dedupe within one
      // pass only, so a full replay would double every counter.
      const seen = await this.store.seenSessions()
      const liveSeq = await this.store.liveSequences()
      // seen alone decides target selection: a session enters
      // backfilledSessions only after its whole replayable range was cleanly
      // folded, so selecting it again would multiply that range by the boot
      // count (the boundary bounds WHAT a not-yet-seen session may replay,
      // never WHETHER a seen one does).
      const targets = headers.filter((h) => !seen.has(h.id))
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
          const boundary = liveSeq.get(header.id)
          // Liveness recheck at replay time: the snapshot above ages as the
          // scan runs. A LIVE session is only safe to touch when its cursor
          // boundary is known and non-negative (prefix replay); otherwise
          // its events belong to the live path of this boot — or it resumed
          // mid-scan with a boundary written after our snapshot, and the
          // stale absence must not widen what we replay.
          const isLiveNow = sessions.list().some((s) => s.id === header.id)
          const liveOwnedWhole = isLiveNow && (boundary === undefined || boundary < 0)
          if (liveOwnedWhole) {
            this.status.done++
            continue
          }
          // Seq partition for everything below:
          // - no boundary recorded → no live pass ever folded this log →
          //   replay from scratch;
          // - negative sentinel (-1, observed with unknown boundary) →
          //   replay nothing rather than risk a duplicate;
          // - valid boundary N → replay exactly [0, N);
          // - a fork-inherited prefix [0, inheritedEventCount) is skipped
          //   separately in the loop (the parent session owns those events).
          const fromScratch = boundary === undefined
          const replayNothing = !fromScratch && boundary < 0
          const skipLiveOwned = (ev: UsageSessionEvent): boolean => {
            if (replayNothing) return true
            if (fromScratch) return false
            return typeof ev.seq === 'number' && ev.seq >= (boundary as number)
          }
          // One FRESH fold per session replay: (turn, step) keys are
          // session-scoped, so concurrent replays must never share a fold.
          const fold = new UsageFold()
          let route = ''
          try {
            const inspection = await persistence.inspect(header.id, signal)
            // Fork-inherited cut (DSH >= 0.1.2-rc.1): a forked child's stored
            // log starts with its parent's copied events, and the parent is
            // backfilled independently — replaying that prefix here would count
            // its usage twice. The host always reports the exact cut (0 for a
            // non-forked session), so the prefix below it is skipped. Inherited
            // events are skipped WHOLESALE (route seeding included): per-call
            // attribution rides message.source on every shipped adapter, and a
            // resumed child re-announces the route at its first change, so
            // nothing child-owned loses its model.
            const inheritedCut = inspection.inheritedEventCount
            for (const ev of inspection.events) {
              if (signal?.aborted) return
              if (skipLiveOwned(ev)) continue
              if (inheritedCut > 0 && typeof ev.seq === 'number' && ev.seq < inheritedCut) continue
              if (ev.type === 'request/context') {
                const data = ev.data as RequestContextData
                if (data.provider && data.model) route = `${data.provider}/${data.model}`
                else if (data.model) route = data.model
              } else if (ev.type === 'assistant/message') {
                // The message's own source names the model that served that
                // call — authoritative even when request/context is missing
                // from old logs. It also refreshes last-known route for any
                // following chunk-borne samples.
                const ref = UsageCollector.refOf((ev.data as AssistantMessageData).message?.source)
                if (ref !== undefined) route = ref
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
