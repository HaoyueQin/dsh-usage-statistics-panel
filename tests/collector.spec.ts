/**
 * Collector fold tests — the (turn, step) replace semantics that keep
 * replayed/duplicate usage reports from double counting (mirrors reasonix's
 * fix commit and dsh-token-meter's usage projection).
 */
import { describe, expect, it } from 'vitest'
import { UsageCollector, UsageFold } from '../src/collector.ts'
import type { UsageSessionEvent, UsageSessionPersistence } from '../src/context-types.ts'

function event(type: string, turn: number, step: number, time: number, data: Record<string, unknown>): UsageSessionEvent {
  return { type, seq: 0, time, data: { turn, step, ...data } }
}

const T = new Date(2026, 7, 2, 12).getTime() // 2026-08-02 local

/** A ctx whose `on` registrations are captured so tests can emit events. */
function captureCtx() {
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  return {
    ctx: {
      on: (event: string, listener: (...args: never[]) => void) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      },
    },
    listeners,
  }
}

function emit(listeners: Map<string, Array<(...args: never[]) => void>>, event: string, ...args: unknown[]): void {
  for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
}

describe('UsageFold', () => {
  it('extracts usage from assistant/message and assistant/chunk', () => {
    const fold = new UsageFold()
    const msg = fold.fold(event('assistant/message', 1, 1, T, {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40 },
    }))
    expect(msg).not.toBeNull()
    expect(msg!.day).toBe('2026-08-02')
    expect(msg!.inputTokens).toBe(100)
    expect(msg!.outputTokens).toBe(50)
    expect(msg!.cacheReadTokens).toBe(40)

    const chunk = fold.fold(event('assistant/chunk', 2, 1, T, {
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    }))
    expect(chunk).not.toBeNull()
    expect(chunk!.inputTokens).toBe(10)
  })

  it('ignores events without usage or with zero totals', () => {
    const fold = new UsageFold()
    expect(fold.fold(event('assistant/message', 1, 1, T, { message: {} }))).toBeNull()
    expect(fold.fold(event('assistant/chunk', 1, 1, T, { chunk: { type: 'text-delta' } }))).toBeNull()
    expect(fold.fold(event('assistant/message', 1, 1, T, { usage: { inputTokens: 0, outputTokens: 0 } }))).toBeNull()
    expect(fold.fold(event('request/context', 1, 1, T, { provider: 'deepseek', model: 'chat' }))).toBeNull()
  })

  it('swallows a duplicate report for the same (turn, step) instead of double counting', () => {
    const fold = new UsageFold()
    // Streaming sample first, then the final assistant/message — same (1,1).
    const first = fold.fold(event('assistant/chunk', 1, 1, T, {
      chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
    }))
    expect(first!.inputTokens).toBe(100)
    // The duplicate is swallowed: the fold emits each key exactly once, so
    // the store keeps the FIRST emission (the shipped adapters report
    // identical values on both events, so first == last observationally).
    const second = fold.fold(event('assistant/message', 1, 1, T, {
      usage: { inputTokens: 200, outputTokens: 90 },
    }))
    expect(second).toBeNull() // swallowed, no new sample
    // A later distinct (turn, step) still produces a new sample.
    const third = fold.fold(event('assistant/message', 1, 2, T, {
      usage: { inputTokens: 50, outputTokens: 10 },
    }))
    expect(third).not.toBeNull()
    expect(third!.inputTokens).toBe(50)
  })

  it('marks every ended turn (reasonix TurnDone parity)', () => {
    const fold = new UsageFold()
    const t1 = fold.fold({ type: 'turn/end', seq: 0, time: T, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(t1).not.toBeNull()
    expect(t1!.turn).toBe(true)
    expect(t1!.day).toBe('2026-08-02')
    expect(t1!.inputTokens + t1!.outputTokens).toBe(0)
    // A failed turn ends too and counts the same way.
    const t2 = fold.fold({ type: 'turn/end', seq: 1, time: T, data: { turn: 2, reason: { kind: 'error', error: { message: 'x' } } } })
    expect(t2).not.toBeNull()
    expect(t2!.turn).toBe(true)
  })

  it('marks each provider call: step/start and started retries', () => {
    const fold = new UsageFold()
    const call = fold.fold({ type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } })
    expect(call).not.toBeNull()
    expect(call!.request).toBe(true)
    expect(call!.inputTokens + call!.outputTokens).toBe(0)
    // A retried call is another actual provider call.
    const retry = fold.fold({ type: 'llm/retry-started', seq: 1, time: T, data: { turn: 1, step: 1, retry: 1 } })
    expect(retry).not.toBeNull()
    expect(retry!.request).toBe(true)
    // The route-only request/context event is not a call.
    expect(fold.fold(event('request/context', 1, 1, T, { provider: 'deepseek', model: 'chat' }))).toBeNull()
  })

  it('records a pure-cache call (zero uncached input, zero output, real cache traffic)', () => {
    const fold = new UsageFold()
    const s = fold.fold(event('assistant/message', 1, 1, T, {
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 5000 },
    }))
    expect(s).not.toBeNull()
    expect(s!.cacheReadTokens).toBe(5000)
    expect(s!.inputTokens + s!.outputTokens).toBe(0)
    // An all-zero usage is still noise.
    expect(fold.fold(event('assistant/message', 1, 2, T, { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }))).toBeNull()
  })

  it('treats the same key across different turn/step as distinct', () => {
    const fold = new UsageFold()
    const a = fold.fold(event('assistant/message', 1, 1, T, { usage: { inputTokens: 10, outputTokens: 1 } }))
    const b = fold.fold(event('assistant/message', 2, 1, T, { usage: { inputTokens: 20, outputTokens: 2 } }))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })
})

describe('UsageCollector.backfill', () => {
  function memoryStore(preRows = 0) {
    const state = {
      recorded: [] as Array<Record<string, unknown>>,
      seen: new Set<string>(),
      marked: [] as string[][],
    }
    return {
      state,
      seenSessions: async () => new Set(state.seen),
      liveSequences: async () => new Map<string, number>(),
      markSeenSessions: async (ids: Iterable<string>) => { const arr = [...ids]; state.marked.push(arr); for (const id of arr) state.seen.add(id) },
      markLiveSequences: async () => {},
      count: async () => preRows,
      record: async (sample: Record<string, unknown>) => { state.recorded.push(sample) },
    } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { state: typeof state }
  }

  function persistence(ids: string[], events: Record<string, unknown>[]) {
    return {
      list: async () => ids.map((id) => ({ id })),
      inspect: async (id: string) => ({ id, events }),
    } as unknown as UsageSessionPersistence
  }

  const events = [
    { type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'turn/end', seq: 2, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  it('never re-folds a session the cursor already holds', async () => {
    const ctx = { on: () => {} }
    const store = memoryStore(3)
    const collector = new UsageCollector(ctx as never, store as never)
    await collector.backfill(persistence(['s1'], events), { list: () => [] } as never)
    expect(store.state.recorded.length).toBe(3) // request marker + usage + turn
    expect(store.state.marked).toEqual([['s1']])

    // A second boot: the cursor holds s1, so nothing re-folds and the rows stay.
    const storeB = memoryStore(3)
    storeB.state.seen.add('s1')
    const collectorB = new UsageCollector(ctx as never, storeB as never)
    await collectorB.backfill(persistence(['s1'], events), { list: () => [] } as never)
    expect(storeB.state.recorded.length).toBe(0)
  })

  it('does not double-count a session the live listener already recorded (restart regression)', async () => {
    // Boot 1: a live session S11 produces usage; the listener must write it
    // into the durable cursor (with its first observed seq) so boot 2's
    // backfill skips its persisted log.
    const seenAcrossBoots = new Set<string>()
    const liveSeqAcrossBoots = new Map<string, number>()
    function durableStore() {
      const recorded: Array<Record<string, unknown>> = []
      return {
        recorded,
        seenSessions: async () => new Set(seenAcrossBoots),
        liveSequences: async () => new Map(liveSeqAcrossBoots),
        markSeenSessions: async (ids: Iterable<string>) => { for (const id of ids) seenAcrossBoots.add(id) },
        markLiveSequences: async (entries: Iterable<readonly [string, number]>) => { for (const [id, seq] of entries) if (!liveSeqAcrossBoots.has(id)) liveSeqAcrossBoots.set(id, seq) },
        count: async () => recorded.length,
        record: async (sample: Record<string, unknown>) => { recorded.push(sample) },
      } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { recorded: Array<Record<string, unknown>> }
    }
    const ctx1 = captureCtx()
    const store1 = durableStore()
    const collector1 = new UsageCollector(ctx1.ctx as never, store1 as never)
    collector1.start()
    emit(ctx1.listeners, 'session/event', { id: 'S11' }, { type: 'request/context', seq: 0, time: T, data: { provider: 'deepseek', model: 'model-a' } })
    emit(ctx1.listeners, 'session/event', { id: 'S11' }, { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500 } } })
    expect(store1.recorded).toHaveLength(1)
    // Drain the coalesced cursor write, then run boot 1's own backfill: S11
    // is persisted, so it is a target (not yet seen) bounded at seq 0 — a
    // clean empty-range replay that marks it seen without re-recording.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await collector1.backfill(persistence(['S11'], events), { list: () => [] } as never)
    // The cursor holds the session under its LIVE boundary (seq 0) AND as
    // backfilled: boot 2 must skip it on the strength of that mark alone.
    expect(liveSeqAcrossBoots.get('S11')).toBe(0)
    expect(seenAcrossBoots.has('S11')).toBe(true)

    // Boot 2: S11 is disposed (absent from the live list) but persisted —
    // the backfill must NOT replay its log on top of the live-recorded row.
    const store2 = durableStore()
    const collector2 = new UsageCollector({ on: () => {} } as never, store2 as never)
    await collector2.backfill(persistence(['S11'], events), { list: () => [] } as never)
    expect(store2.recorded).toHaveLength(0)
  })

  it('never re-replays a seen session across boots even with a live boundary recorded (prefix regression)', async () => {
    // The 2026-08-22 regression: boot 1 attaches MID-session (first observed
    // seq = 2), backfills the prefix [0,2) and marks the session seen — but
    // boot 2 re-selected the session because the target filter only excluded
    // seen sessions WITHOUT a live boundary. Every restart then multiplied
    // the prefix usage once more. A session in backfilledSessions has had its
    // whole replayable range folded; the boundary must bound WHAT a not-yet-
    // seen session may replay, never re-open a seen one.
    const fiveEvents = [
      { type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { provider: 'p', model: 'm1' } } } },
      { type: 'turn/end', seq: 2, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'step/start', seq: 3, time: T, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 4, time: T, data: { turn: 2, step: 1, usage: { inputTokens: 20, outputTokens: 2 }, message: { source: { provider: 'p', model: 'm2' } } } },
    ] as unknown as typeof events
    const seenAcrossBoots = new Set<string>()
    const liveSeqAcrossBoots = new Map<string, number>()
    const recorded: Array<Record<string, unknown>> = []
    function durableStore() {
      return {
        recorded,
        seenSessions: async () => new Set(seenAcrossBoots),
        liveSequences: async () => new Map(liveSeqAcrossBoots),
        markSeenSessions: async (ids: Iterable<string>) => { for (const id of ids) seenAcrossBoots.add(id) },
        // Earliest-wins, like the real UsageStore merge.
        markLiveSequences: async (entries: Iterable<readonly [string, number]>) => {
          for (const [id, seq] of entries) {
            const prev = liveSeqAcrossBoots.get(id)
            if (prev === undefined || seq < prev) liveSeqAcrossBoots.set(id, seq)
          }
        },
        count: async () => recorded.length,
        record: async (sample: Record<string, unknown>) => { recorded.push(sample) },
      } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { recorded: Array<Record<string, unknown>> }
    }
    const countInput10 = (): number => recorded.filter((s) => s.inputTokens === 10).length

    // Boot 1: the live listener first observes event seq 2 (mid-session);
    // the prefix [0,2) is then backfilled and marked seen.
    const ctxListeners: Array<(...a: unknown[]) => void> = []
    const collector1 = new UsageCollector({ on: (_e: string, l: never) => { ctxListeners.push(l as unknown as (...a: unknown[]) => void) } } as never, durableStore() as never)
    collector1.start()
    for (const ev of fiveEvents.slice(2)) {
      for (const l of ctxListeners) l({ id: 'S1' }, ev)
    }
    await new Promise((resolve) => setTimeout(resolve, 0)) // drain the cursor flush
    await collector1.backfill(persistence(['S1'], fiveEvents as unknown as Record<string, unknown>[]), { list: () => [] } as never)
    const afterBoot1 = countInput10()
    expect(afterBoot1).toBe(1)
    // Exactly the state that used to trigger the bug:
    expect(seenAcrossBoots.has('S1')).toBe(true)
    expect(liveSeqAcrossBoots.get('S1')).toBe(2)

    // Boot 2: same durable cursor, session disposed but persisted — nothing
    // may be recorded again.
    const collector2 = new UsageCollector({ on: () => {} } as never, durableStore() as never)
    await collector2.backfill(persistence(['S1'], fiveEvents as unknown as Record<string, unknown>[]), { list: () => [] } as never)
    expect(countInput10()).toBe(afterBoot1) // no second copy of the prefix
    const input20 = recorded.filter((s) => s.inputTokens === 20).length
    expect(input20).toBe(1) // live-owned segment still counted exactly once
  })

  it('skips a target that became live after the snapshot (liveness recheck)', async () => {
    const ctx = { on: () => {} }
    const store = memoryStore(0)
    const collector = new UsageCollector(ctx as never, store as never)
    // s2 is reported live by the session store even though the backfill
    // snapshot listed it: replaying it would double the live path's samples.
    await collector.backfill(persistence(['s1', 's2'], events), { list: () => [{ id: 's2' }] } as never)
    expect(store.state.recorded.length).toBe(3) // only s1 replayed
    expect(store.state.marked.flat()).toEqual(['s1'])
  })

  it('stops the scan when the abort signal fires', async () => {
    const ctx = { on: () => {} }
    const store = memoryStore(0)
    const collector = new UsageCollector(ctx as never, store as never)
    const controller = new AbortController()
    const persistence = {
      list: async () => ['s1', 's2', 's3'].map((id) => ({ id })),
      inspect: async (id: string) => {
        if (id === 's1') controller.abort() // abort mid-scan
        return { id, events: [] }
      },
    } as unknown as UsageSessionPersistence
    await collector.backfill(persistence, { list: () => [] } as never, controller.signal)
    // Only the session already in flight completes; the rest are skipped.
    expect(collector.status.done).toBe(1)
    expect(store.state.marked.flat()).toEqual(['s1'])
  })
})

describe('UsageCollector live attribution', () => {
  function recordingStore() {
    const recorded: Array<Record<string, unknown>> = []
    return {
      recorded,
      seenSessions: async () => new Set<string>(),
      liveSequences: async () => new Map<string, number>(),
      markSeenSessions: async (ids: Iterable<string>) => { for (const _ of ids) {} },
      markLiveSequences: async () => {},
      count: async () => recorded.length,
      record: async (sample: Record<string, unknown>) => { recorded.push(sample) },
    } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { recorded: Array<Record<string, unknown>> }
  }

  it('keeps concurrent sessions out of each other\'s dedupe and route buckets', () => {
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()

    // Session A: route deepseek/model-a, then usage on turn 1 / step 1.
    emit(listeners, 'session/event', { id: 'A' }, { type: 'request/context', seq: 0, time: T, data: { provider: 'deepseek', model: 'model-a' } })
    emit(listeners, 'session/event', { id: 'A' }, { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500 } } })
    // Session B: the SAME turn/step pair, its own route — neither the
    // dedupe fold nor the attribution may leak across sessions.
    emit(listeners, 'session/event', { id: 'B' }, { type: 'request/context', seq: 2, time: T, data: { provider: 'openai', model: 'model-b' } })
    emit(listeners, 'session/event', { id: 'B' }, { type: 'assistant/message', seq: 3, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 2000, outputTokens: 800 } } })

    expect(store.recorded).toHaveLength(2)
    const a = store.recorded.find((s) => s.model === 'deepseek/model-a')
    const b = store.recorded.find((s) => s.model === 'openai/model-b')
    expect(a?.inputTokens).toBe(1000)
    expect(b?.inputTokens).toBe(2000)
  })

  it('records a route-less request marker without a model (the first call of a session)', () => {
    // agent-loop appends step/start BEFORE request/context (core/agent-loop
    // agent.ts), so the FIRST request marker of a fresh — or subagent —
    // session cannot carry model attribution. The request must still count
    // exactly once; only its per-model slot stays unknown.
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'fresh' }, { type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } })
    emit(listeners, 'session/event', { id: 'fresh' }, { type: 'turn/end', seq: 1, time: T, data: { turn: 1 } })
    const request = store.recorded.find((s) => s.request === true)
    expect(request).toBeDefined()
    expect(request!.model).toBeUndefined()
    expect(store.recorded.filter((s) => s.request === true)).toHaveLength(1)
  })

  it('records every keyless usage emission (no dedupe slot without turn/step)', () => {
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'K' }, { type: 'assistant/message', seq: 0, time: T, data: { usage: { inputTokens: 10, outputTokens: 5 } } })
    emit(listeners, 'session/event', { id: 'K' }, { type: 'assistant/message', seq: 1, time: T, data: { usage: { inputTokens: 10, outputTokens: 5 } } })
    // Documented contract: no (turn, step) → no dedupe → both count.
    expect(store.recorded).toHaveLength(2)
    expect((store.recorded[0] as Record<string, unknown>).inputTokens).toBe(10)
  })

  it('records the FIRST emission for a repeated (turn, step) into the store', () => {
    // Documents the observable store semantics: the duplicate is swallowed,
    // so the early streaming sample is what the rows hold. Shipped adapters
    // emit identical values on both events, so first == last in practice.
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, { type: 'assistant/chunk', seq: 0, time: T, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } } } })
    emit(listeners, 'session/event', { id: 'A' }, { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 200, outputTokens: 90 } } })
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]!.inputTokens).toBe(100)
    expect(store.recorded[0]!.outputTokens).toBe(50)
  })

  it('drops a disposed session\'s fold and route buckets', () => {
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, { type: 'request/context', seq: 0, time: T, data: { provider: 'deepseek', model: 'model-a' } })
    emit(listeners, 'session/disposed', { id: 'A' })
    // After disposal the route is gone; a later usage sample from a
    // recycled id must not inherit the old route.
    emit(listeners, 'session/event', { id: 'A' }, { type: 'assistant/message', seq: 1, time: T, data: { turn: 9, step: 9, usage: { inputTokens: 5, outputTokens: 5 } } })
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]!.model).toBeUndefined()
  })
})

describe('live attribution without request/context (the (unknown) regression)', () => {
  function recordingStore() {
    const recorded: Array<Record<string, unknown>> = []
    return {
      recorded,
      seenSessions: async () => new Set<string>(),
      liveSequences: async () => new Map<string, number>(),
      markSeenSessions: async (ids: Iterable<string>) => { for (const _ of ids) {} },
      markLiveSequences: async () => {},
      count: async () => recorded.length,
      record: async (sample: Record<string, unknown>) => { recorded.push(sample) },
    } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { recorded: Array<Record<string, unknown>> }
  }

  /** A ctx whose sessions store answers get(id).requestContext() with `rc` —
   *  the authoritative route fold every real Session exposes. */
  function captureCtxWithSessionRoute(rc: { provider?: string; model?: string } | undefined) {
    const base = captureCtx()
    const ctx = Object.assign(base.ctx, {
      sessions: { get: (_id: string) => ({ requestContext: () => rc }) },
    })
    return { listeners: base.listeners, ctx }
  }

  it('attributes an assistant/message via its own message.source when no route was ever observed', () => {
    // The regression: a session that predates the collector (host restart /
    // plugin reload) never re-emits request/context, so EVERY sample used to
    // land in "(unknown)". The message itself carries the calling model.
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/message', seq: 7, time: T,
      data: {
        turn: 3, step: 2,
        usage: { inputTokens: 1000, outputTokens: 100 },
        message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      },
    })
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]!.model).toBe('deepseek-official/deepseek-v4-pro')
  })

  it('seeds the route from the live session requestContext() fold for chunk samples', () => {
    // A streaming usage chunk carries NO model of its own; for a session the
    // listener attached to mid-flight the only source is the session's own
    // log fold. The collector must consult it instead of giving up.
    const { ctx, listeners } = captureCtxWithSessionRoute({ provider: 'opnecode-zen', model: 'x-preview-f-free' })
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/chunk', seq: 9, time: T,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 5 } } },
    })
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]!.model).toBe('opnecode-zen/x-preview-f-free')
  })

  it('learns the route from message.source so later chunk samples attribute too', () => {
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/message', seq: 1, time: T,
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 10, outputTokens: 1 },
        message: { source: { provider: 'p', model: 'm' } },
      },
    })
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/chunk', seq: 2, time: T,
      data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 2 } } },
    })
    expect(store.recorded).toHaveLength(2)
    expect(store.recorded[0]!.model).toBe('p/m')
    expect(store.recorded[1]!.model).toBe('p/m')
  })

  it('keeps a bare-model source (no provider) attributable', () => {
    const { ctx, listeners } = captureCtx()
    const store = recordingStore()
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/message', seq: 1, time: T,
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { model: 'bare-model' } } },
    })
    expect(store.recorded[0]!.model).toBe('bare-model')
  })
})

describe('cursor-write failures are observational too', () => {
  it('counts a rejecting cursor write instead of leaving an unhandled rejection', async () => {
    // The degraded-store contract now covers the DURABLE CURSOR too: a
    // markLiveSequences refusal surfaces as status.recordFailures, never
    // as an escaping rejection from the coalescing microtask flush.
    const { ctx, listeners } = captureCtx()
    let cursorWrites = 0
    const store = {
      seenSessions: async () => new Set<string>(),
      liveSequences: async () => new Map<string, number>(),
      markSeenSessions: async () => {},
      markLiveSequences: async () => { cursorWrites++; throw new Error('degraded cursor') },
      count: async () => 0,
      record: async () => {},
    }
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/message', seq: 1, time: T,
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cursorWrites).toBe(1)
    expect(collector.status.recordFailures).toBe(1)
  })
})

describe('backfill attribution and the seq-partitioned cursor', () => {
  function partitionStore(live: Record<string, number>, backfilled: string[] = []) {
    const recorded: Array<Record<string, unknown>> = []
    const marked: string[][] = []
    return {
      recorded,
      marked,
      seenSessions: async () => new Set<string>(backfilled),
      liveSequences: async () => new Map(Object.entries(live).map(([k, v]) => [k, v] as [string, number])),
      markSeenSessions: async (ids: Iterable<string>) => { marked.push([...ids]) },
      markLiveSequences: async () => {},
      count: async () => recorded.length,
      record: async (sample: Record<string, unknown>) => { recorded.push(sample) },
    } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { recorded: Array<Record<string, unknown>>; marked: string[][] }
  }

  /** Five events: call 1 fully before any boundary, call 2 after it. */
  const fiveEvents = [
    { type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { provider: 'p', model: 'm1' } } } },
    { type: 'turn/end', seq: 2, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'step/start', seq: 3, time: T, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', seq: 4, time: T, data: { turn: 2, step: 1, usage: { inputTokens: 20, outputTokens: 2 }, message: { source: { provider: 'p', model: 'm2' } } } },
  ]

  it('replays only the pre-observation prefix of a live-marked session', async () => {
    // The cursor now records the first LIVE-OBSERVED seq per session: events
    // before it were never folded by any live pass, so replaying exactly
    // that prefix recovers pre-attach history without double counting.
    const store = partitionStore({ S1: 2 })
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'S1' }], inspect: async () => ({ id: 'S1', events: fiveEvents }) } as unknown as UsageSessionPersistence,
      { list: () => [] } as never,
    )
    // Only seq<2 folded: the call-1 request marker + its usage (+ nothing else).
    expect(store.recorded).toHaveLength(2)
    expect(store.recorded.find((s) => s.request)?.day).toBe('2026-08-02')
    expect(store.recorded.find((s) => s.inputTokens === 10)).toBeTruthy()
    expect(store.recorded.find((s) => s.inputTokens === 20)).toBeFalsy()
    // The prefix is now durable: the session lands in backfilledSessions.
    expect(store.marked).toEqual([['S1']])
  })

  it('replays a live-marked session with an unknown boundary sentinel not at all', async () => {
    // firstSeq -1 = "observed but boundary unknown" → the anti-double-count
    // choice is to skip everything (never duplicate).
    const store = partitionStore({ S1: -1 })
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'S1' }], inspect: async () => ({ id: 'S1', events: fiveEvents }) } as unknown as UsageSessionPersistence,
      { list: () => [] } as never,
    )
    expect(store.recorded).toHaveLength(0)
  })

  it('prefix-replays a session that is STILL LIVE when its boundary is known', async () => {
    // The reset/rescan flow: a continuously-live session (resumed before the
    // scan) owns its post-boundary events, so replaying the persisted prefix
    // recovers its pre-boundary history without any double counting.
    const store = partitionStore({ S1: 2 })
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'S1' }], inspect: async () => ({ id: 'S1', events: fiveEvents }) } as unknown as UsageSessionPersistence,
      { list: () => [{ id: 'S1' }] } as never, // S1 is live right now
    )
    expect(store.recorded).toHaveLength(2)
    expect(store.recorded.find((s) => s.inputTokens === 20)).toBeFalsy()
    expect(store.marked).toEqual([['S1']])
  })

  it('skips a live session whose boundary is missing from the snapshot (mid-scan resume)', async () => {
    // S1 went live AFTER the cursor snapshot: a stale absence must not widen
    // the replay into a full-log fold that would double the live samples.
    const store = partitionStore({})
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'S1' }], inspect: async () => ({ id: 'S1', events: fiveEvents }) } as unknown as UsageSessionPersistence,
      { list: () => [{ id: 'S1' }] } as never,
    )
    expect(store.recorded).toHaveLength(0)
  })

  it('attributes backfilled samples via message.source even without request/context', async () => {
    // Old logs may lack request/context entirely; the per-message source is
    // present on every shipped adapter message, so it must win.
    const store = partitionStore({})
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'S9' }], inspect: async () => ({ id: 'S9', events: fiveEvents }) } as unknown as UsageSessionPersistence,
      { list: () => [] } as never,
    )
    const m1 = store.recorded.find((s) => s.inputTokens === 10)
    const m2 = store.recorded.find((s) => s.inputTokens === 20)
    expect(m1?.model).toBe('p/m1')
    expect(m2?.model).toBe('p/m2')
  })

  it('skips a fork-inherited prefix when the host reports the cut', async () => {
    // A forked child's stored log begins with the events it copied from its
    // parent (here: call 1 at seq 0-1), and the parent session is backfilled
    // independently — replaying the prefix would count that usage twice. The
    // host reports the exact cut; only the child-owned tail folds.
    const store = partitionStore({})
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'F1' }], inspect: async () => ({ id: 'F1', events: fiveEvents, inheritedEventCount: 2 }) } as unknown as UsageSessionPersistence,
      { list: () => [] } as never,
    )
    // Child-owned tail only: turn/end + the call-2 request marker + usage 20.
    expect(store.recorded).toHaveLength(3)
    expect(store.recorded.find((s) => s.inputTokens === 10)).toBeFalsy()
    expect(store.recorded.find((s) => s.inputTokens === 20)).toBeTruthy()
    expect(store.recorded.filter((s) => s.request)).toHaveLength(1)
    expect(store.recorded.filter((s) => s.turn)).toHaveLength(1)
  })


  it('combines the inherited cut with a live boundary', async () => {
    // Child-owned pre-attach window [2, 4) only: the parent owns [0, 2), the
    // live pass owns [4, ∞). The three partitions tile the log exactly once.
    const store = partitionStore({ F1: 4 })
    const collector = new UsageCollector({ on: () => {} } as never, store as never)
    await collector.backfill(
      { list: async () => [{ id: 'F1' }], inspect: async () => ({ id: 'F1', events: fiveEvents, inheritedEventCount: 2 }) } as unknown as UsageSessionPersistence,
      { list: () => [] } as never,
    )
    expect(store.recorded).toHaveLength(2)
    expect(store.recorded.find((s) => s.turn)).toBeTruthy()
    expect(store.recorded.find((s) => s.request)).toBeTruthy()
    expect(store.recorded.find((s) => s.inputTokens === 20)).toBeFalsy()
  })

})

describe('live recording never escapes a rejection', () => {
  it('counts a refusing store in status.recordFailures instead of crashing the host', async () => {
    // The degraded-domain scenario: record() rejects. An unhandled
    // rejection here would take the whole backend down (observed class of
    // failure); the collector must swallow and count it.
    const { ctx, listeners } = captureCtx()
    const store = {
      seenSessions: async () => new Set<string>(),
      liveSequences: async () => new Map<string, number>(),
      markSeenSessions: async () => {},
      markLiveSequences: async () => {},
      count: async () => 0,
      record: async () => { throw new Error('degraded') },
    }
    const collector = new UsageCollector(ctx as never, store as never)
    collector.start()
    emit(listeners, 'session/event', { id: 'A' }, {
      type: 'assistant/message', seq: 1, time: T,
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { provider: 'p', model: 'm' } } },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(collector.status.recordFailures).toBe(1)
  })
})