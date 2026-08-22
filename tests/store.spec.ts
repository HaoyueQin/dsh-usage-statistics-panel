/**
 * UsageStore tests against an in-memory storage-domain stand-in: the day
 * rows accumulate atomically (KvTable.update semantics), turn markers land
 * on their own row, and rangeRows filters by day.
 */
import { describe, expect, it } from 'vitest'
import { UsageStore, dayRowKey, type UsageDayRow } from '../src/store.ts'
import type { UsageDomain, UsageKvTable, UsageStorageDomain } from '../src/context-types.ts'

function memoryDomain(): UsageStorageDomain {
  return memoryDomainWith(new Map())
}

/** A storage-domain stand-in whose table starts with `records` and whose
 *  global starts at `globalValue` (mirroring an absent cursor). */
function memoryDomainWith(
  records: Map<string, UsageDayRow>,
  globalValue?: { backfilledSessions: string[]; liveFirstSeq?: Record<string, number> },
): UsageStorageDomain {
  const table: UsageKvTable<string, UsageDayRow> = {
    get: (k) => records.get(k),
    entries: () => records.entries() as IterableIterator<[string, UsageDayRow]>,
    keys: () => records.keys() as IterableIterator<string>,
    get size() { return records.size },
    delete: async (k) => records.delete(k),
    put: async (k, v) => { records.set(k, v) },
    update: async (k, fn) => {
      // Mirror the real storage-domain KvTable.update contract: it requires
      // an existing record and throws otherwise (the store retries by
      // seeding the row with put()).
      const cur = records.get(k)
      if (cur === undefined) {
        throw new Error(`domain 'usage_history' table 'days' has no record '${k}' to update`)
      }
      const next = fn(cur)
      records.set(k, next)
      return next
    },
  }
  const state = { global: globalValue }
  const domain: UsageDomain = {
    table: () => table as UsageKvTable<string, unknown>,
    global: {
      get: () => state.global,
      set: async (value) => { state.global = value as typeof globalValue },
    },
  }
  return {
    open: async () => domain,
  }
}

describe('UsageStore', () => {
  it('accumulates samples into one day/model row', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0 })
    await store.record({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10 })
    // Requests come only from the per-call markers (step/start / retry), not
    // from the usage samples — counting both would double every call.
    await store.record({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, request: true })
    await store.record({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, request: true })
    const rows = await store.rangeRows('2026-08-01', '2026-08-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.inputTokens).toBe(300)
    expect(rows[0]!.outputTokens).toBe(50)
    expect(rows[0]!.cacheReadTokens).toBe(40)
    expect(rows[0]!.cacheWriteTokens).toBe(10)
    expect(rows[0]!.requests).toBe(2)
  })

  it('counts a failed call marker as one request with no tokens', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, request: true })
    const rows = await store.rangeRows('2026-08-01', '2026-08-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.requests).toBe(1)
    expect(rows[0]!.inputTokens + rows[0]!.outputTokens).toBe(0)
  })

  it('keeps different models and days on separate rows', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', model: 'a/m1', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await store.record({ day: '2026-08-01', model: 'b/m2', inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await store.record({ day: '2026-08-02', model: 'a/m1', inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await store.count()).toBe(3)
    const rows = await store.rangeRows('2026-08-01', '2026-08-01')
    expect(rows).toHaveLength(2)
  })

  it('counts turn markers on the synthetic (turns) row', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true })
    await store.record({ day: '2026-08-01', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true })
    const rows = await store.rangeRows('2026-08-01', '2026-08-01')
    const turnRow = rows.find((r) => r.model === '(turns)')
    expect(turnRow?.turns).toBe(2)
  })

  it('rangeRows filters by inclusive day bounds', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', model: 'm', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await store.record({ day: '2026-08-03', model: 'm', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const rows = await store.rangeRows('2026-08-02', '2026-08-04')
    expect(rows.map((r) => r.day)).toEqual(['2026-08-03'])
  })

  it('formats the day row key as day|provider|model', async () => {
    expect(dayRowKey('2026-08-01', 'deepseek', 'deepseek/deepseek-chat')).toBe('2026-08-01|deepseek|deepseek/deepseek-chat')
  })

  it('rebuilds a pre-cursor store once at open (legacy rows, empty cursor)', async () => {
    // The ≤0.1.1 shape: rows exist but no cursor was ever written. The
    // rebuild decision runs inside ready(), so the rows are gone before the
    // first record/seen call and the backfill repopulates from scratch.
    const records = new Map<string, UsageDayRow>([
      ['2026-08-01|deepseek|m', { day: '2026-08-01', provider: 'deepseek', model: 'm', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, turns: 0, lastSeen: 0 }],
    ])
    const domain = memoryDomainWith(records)
    const store = new UsageStore(domain)
    await store.readyPromise()
    expect(await store.count()).toBe(0)
  })

  it('keeps rows when the cursor is populated (no false rebuild)', async () => {
    const records = new Map<string, UsageDayRow>([
      ['2026-08-01|deepseek|m', { day: '2026-08-01', provider: 'deepseek', model: 'm', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, turns: 0, lastSeen: 0 }],
    ])
    const domain = memoryDomainWith(records, { backfilledSessions: ['s1'] })
    const store = new UsageStore(domain)
    await store.readyPromise()
    expect(await store.count()).toBe(1)
  })

  it('serializes concurrent cursor writes so no session id is lost', async () => {
    // A domain whose global.set resolves on a later macrotask widens the
    // get→set window that a concurrent caller would race through.
    let globalValue: { backfilledSessions: string[] } | undefined
    const emptyTable = {
      get: () => undefined,
      entries: () => [][Symbol.iterator](),
      keys: () => [][Symbol.iterator](),
      size: 0,
      put: async () => {},
      delete: async () => false,
      update: async () => {
        throw new Error('missing-key')
      },
    }
    const domain: UsageDomain = {
      table: () => emptyTable as unknown as ReturnType<UsageDomain['table']>,
      global: {
        get: () => globalValue,
        set: async (value) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          globalValue = value as { backfilledSessions: string[] }
        },
      },
    }
    const store = new UsageStore({ open: async () => domain } as unknown as UsageStorageDomain)
    await Promise.all([
      store.markSeenSessions(['a']),
      store.markSeenSessions(['b']),
      store.markSeenSessions(['c']),
    ])
    const seen = await store.seenSessions()
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })

  it('merges live observation sequences keeping the earliest boundary per session', async () => {
    const store = new UsageStore(memoryDomain())
    await store.markLiveSequences([['a', 5], ['b', 7]])
    // A later boot may observe the same session at an earlier seq? No — but
    // concurrent flushes can reorder, so min() keeps the safest boundary.
    await store.markLiveSequences([['a', 3]])
    const seq = await store.liveSequences()
    expect(seq.get('a')).toBe(3)
    expect(seq.get('b')).toBe(7)
  })

  it('keeps backfilledSessions intact when merging live sequences', async () => {
    const records = new Map<string, UsageDayRow>()
    const store = new UsageStore(memoryDomainWith(records, { backfilledSessions: ['s1'] }))
    await store.readyPromise()
    await store.markLiveSequences([['s2', 4]])
    const seen = await store.seenSessions()
    expect([...seen]).toEqual(['s1'])
    const seq = await store.liveSequences()
    expect(seq.get('s2')).toBe(4)
  })

  it('resets rows and the whole cursor on reset()', async () => {
    const records = new Map<string, UsageDayRow>()
    const store = new UsageStore(memoryDomainWith(records, { backfilledSessions: ['s1'], liveFirstSeq: { s2: 3 } }))
    await store.readyPromise()
    await store.record({ day: '2026-08-01', model: 'm', inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await store.count()).toBe(1)
    await store.reset()
    expect(await store.count()).toBe(0)
    expect(await store.seenSessions()).toEqual(new Set())
    expect((await store.liveSequences()).size).toBe(0)
  })

  it('reset() re-bounds named sessions at their wipe-time watermarks', async () => {
    const records = new Map<string, UsageDayRow>()
    const store = new UsageStore(memoryDomainWith(records, { backfilledSessions: ['s1'], liveFirstSeq: { s2: 3, s3: 9 } }))
    await store.readyPromise()
    // Only s2 is still open at wipe time, and its watermark is its CURRENT
    // log length (10), not its old attach boundary: the wipe destroys the
    // live path's recorded samples too, so the follow-up backfill must
    // reconstruct everything below the watermark — including the span
    // [3,10) the live path had folded before the wipe. Everything else
    // (rows, backfilled ids, s3's stale boundary) is gone.
    await store.record({ day: '2026-08-01', model: 'm', inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await store.count()).toBe(1)
    await store.reset(new Map([['s2', 10]]))
    expect(await store.count()).toBe(0)
    expect(await store.seenSessions()).toEqual(new Set())
    const seq = await store.liveSequences()
    expect(seq.get('s2')).toBe(10)
    expect(seq.has('s3')).toBe(false)
  })

  it('degrades instead of rejecting forever when the domain cannot open', async () => {
    // The 2026-08-22 hot-reload crash: a second open of the same domain used
    // to leave this.ready permanently rejected — an unhandled rejection one
    // `void record()` away from taking the host down. Now the failure is
    // captured and every operation fails per-call with a clear error.
    const store = new UsageStore({
      open: async () => {
        throw Object.assign(new Error("domain 'usage_history' is already open"), { name: 'DomainError' })
      },
    } as unknown as UsageStorageDomain)
    await store.readyPromise() // resolves (degraded), never rejects
    expect(store.degradation).toBeInstanceOf(Error)
    await expect(store.seenSessions()).resolves.toEqual(new Set())
    await expect(store.record({ day: '2026-08-01', model: 'm', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
      .rejects.toThrow(/degraded/)
  })

  it('fails cursor writes per-call when degraded instead of silently no-op', async () => {
    // A silent success here would tell callers a replay boundary was made
    // durable when nothing persisted — the same observational contract as
    // record(): throw per-call, count the failure upstream.
    const store = new UsageStore({
      open: async () => {
        throw Object.assign(new Error("domain 'usage_history' is already open"), { name: 'DomainError' })
      },
    } as unknown as UsageStorageDomain)
    await store.readyPromise()
    await expect(store.markSeenSessions(['a'])).rejects.toThrow(/degraded/)
    await expect(store.markLiveSequences([['a', 1]])).rejects.toThrow(/degraded/)
    await expect(store.reset()).rejects.toThrow(/degraded/)
    // One rejection must not poison the chain: later writes still observe
    // the degradation clearly rather than hanging or losing ids quietly.
    await expect(store.markSeenSessions(['b'])).rejects.toThrow(/degraded/)
  })
})
