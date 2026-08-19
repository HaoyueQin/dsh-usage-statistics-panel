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
    put: async (k, v) => { records.set(k, v) },
    update: async (k, fn) => {
      const next = fn(records.get(k) ?? (undefined as unknown as UsageDayRow))
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
    const rows = await store.rangeRows('2026-08-01', '2026-08-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.inputTokens).toBe(300)
    expect(rows[0]!.outputTokens).toBe(50)
    expect(rows[0]!.cacheReadTokens).toBe(40)
    expect(rows[0]!.cacheWriteTokens).toBe(10)
    expect(rows[0]!.requests).toBe(2)
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
})
