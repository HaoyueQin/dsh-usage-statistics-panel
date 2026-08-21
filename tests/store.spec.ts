/**
 * UsageStore tests against an in-memory storage-domain stand-in: the day
 * rows accumulate atomically (KvTable.update semantics), turn markers land
 * on their own row, and rangeRows filters by day.
 */
import { describe, expect, it } from 'vitest'
import { UsageStore, dayRowKey, type UsageDayRow } from '../src/store.ts'
import type { UsageDomain, UsageKvTable, UsageStorageDomain } from '../src/context-types.ts'

function memoryDomain(): UsageStorageDomain {
  const records = new Map<string, UsageDayRow>()
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
  const domain: UsageDomain = {
    table: () => table as UsageKvTable<string, unknown>,
    global: { get: () => undefined, set: async () => {} },
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

  it('dayRowKey round-trips through dayRowKeyParts', async () => {
    const key = dayRowKey('2026-08-01', 'deepseek', 'deepseek/deepseek-chat')
    expect(key).toBe('2026-08-01|deepseek|deepseek/deepseek-chat')
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
})
