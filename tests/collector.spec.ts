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
      markSeenSessions: async (ids: Iterable<string>) => { const arr = [...ids]; state.marked.push(arr); for (const id of arr) state.seen.add(id) },
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
    // into the durable cursor so boot 2's backfill skips its persisted log.
    const seenAcrossBoots = new Set<string>()
    function durableStore() {
      const recorded: Array<Record<string, unknown>> = []
      return {
        recorded,
        seenSessions: async () => new Set(seenAcrossBoots),
        markSeenSessions: async (ids: Iterable<string>) => { for (const id of ids) seenAcrossBoots.add(id) },
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
    // Drain the coalesced cursor write.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seenAcrossBoots.has('S11')).toBe(true)

    // Boot 2: S11 is disposed (absent from the live list) but persisted —
    // the backfill must NOT replay its log on top of the live-recorded row.
    const store2 = durableStore()
    const collector2 = new UsageCollector({ on: () => {} } as never, store2 as never)
    await collector2.backfill(persistence(['S11'], events), { list: () => [] } as never)
    expect(store2.recorded).toHaveLength(0)
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
      markSeenSessions: async (ids: Iterable<string>) => { for (const _ of ids) {} },
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
