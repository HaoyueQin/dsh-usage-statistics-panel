/**
 * Route + range-resolution tests — a TS translation of reasonix's
 * stats_app_test.go (resolveStatsRange branches) plus the aggregate route
 * wiring against an in-memory store.
 */
import { describe, expect, it } from 'vitest'
import { resolveRange } from '../src/routes.ts'
import type { UsageStatsRequest } from '../src/wire.ts'

function fixedNow(): Date {
  return new Date(2026, 7, 20, 15, 0, 0) // 2026-08-20 local
}

function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

describe('resolveRange', () => {
  const now = fixedNow()

  it('preset 7 days ends today', () => {
    const { from, to } = resolveRange({ range: '7' }, now)
    expect(to).toBe('2026-08-20')
    expect(from).toBe('2026-08-14')
  })

  it('preset 14 / 30 / 90 days', () => {
    expect(resolveRange({ range: '14' }, now).from).toBe('2026-08-07')
    expect(resolveRange({ range: '30' }, now).from).toBe('2026-07-22')
    expect(resolveRange({ range: '90' }, now).from).toBe('2026-05-23')
  })

  it('custom range with valid dates', () => {
    const { from, to } = resolveRange({ range: 'custom', from: '2026-07-01', to: '2026-07-31' }, now)
    expect(from).toBe('2026-07-01')
    expect(to).toBe('2026-07-31')
  })

  it('custom range rejects missing or malformed dates', () => {
    expect(() => resolveRange({ range: 'custom', to: '2026-07-31' }, now)).toThrow(/valid from\/to/)
    expect(() => resolveRange({ range: 'custom', from: '2026-07-01', to: 'not-a-date' }, now)).toThrow(/valid from\/to/)
  })

  it('custom range rejects to < from', () => {
    expect(() => resolveRange({ range: 'custom', from: '2026-07-31', to: '2026-07-01' }, now)).toThrow(/>= from/)
  })

  it('unknown/empty range defaults to the last 7 days', () => {
    expect(resolveRange({ range: '' }, now).from).toBe('2026-08-14')
    expect(resolveRange({ range: '365' }, now).from).toBe('2026-08-14')
  })
})

// A tiny in-memory UsageStore stand-in so the aggregate route test can run
// without the storage domain.
import { aggregateRange } from '../src/routes.ts'
import type { UsageDayRow } from '../src/store.ts'
import { readJsonBody } from '../src/wire.ts'
import type { UsageHttpRequest } from '../src/context-types.ts'

function memoryStore(rows: UsageDayRow[]): Parameters<typeof aggregateRange>[0] {
  return {
    async rangeRows(from: string, to: string) {
      return rows.filter((r) => r.day >= from && r.day <= to)
    },
  } as Parameters<typeof aggregateRange>[0]
}

describe('aggregateRange', () => {
  it('folds store rows — requests expand from the per-row count', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0, requests: 1, turns: 0, lastSeen: 0 },
      { day: '2026-08-02', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, turns: 2, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-02')
    expect(out.tokens).toBe(350)
    expect(out.turns).toBe(2)
    expect(out.requests).toBe(2)
    expect(out.cacheMiss).toBe(300)
  })

  it('counts a request-only row (a failed call) as one request with no tokens', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, turns: 0, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    expect(out.requests).toBe(1)
    expect(out.tokens).toBe(0)
  })

  it('keeps a pure-cache call in the aggregate (zero input/output, real cache traffic)', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 5000, cacheWriteTokens: 0, requests: 1, turns: 0, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    expect(out.cacheHit).toBe(5000)
    expect(out.tokens).toBe(0)
  })

  it('reports per-day turns in the daily series', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'default', model: '(turns)', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, turns: 3, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    expect(out.turns).toBe(3)
    expect(out.daily[0]!.turns).toBe(3)
    expect(out.daily[0]!.total).toBe(0)
  })
})

describe('readJsonBody', () => {
  function bodyReq(chunks: string[]): UsageHttpRequest {
    return {
      url: '/usage/api/range',
      method: 'POST',
      headers: {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as UsageHttpRequest
  }

  it('parses a small JSON body', async () => {
    expect(await readJsonBody(bodyReq(['{"range":"7"}']))).toEqual({ range: '7' })
  })

  it('rejects an oversized body with 413', async () => {
    await expect(readJsonBody(bodyReq(['x'.repeat(70_000)]))).rejects.toThrow(/exceeds/)
  })

  it('rejects malformed JSON with 400', async () => {
    await expect(readJsonBody(bodyReq(['{nope']))).rejects.toThrow(/invalid json/)
  })
})
