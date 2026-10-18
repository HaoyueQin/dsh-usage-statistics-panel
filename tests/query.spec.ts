/**
 * Range aggregation tests — a TS translation of the reasonix stats query
 * test cases (internal/stats/stats_test.go): totals, cache hit-rate
 * derivation, per-day/per-model splits, the full-timeline emission of
 * inactive days, and the empty/edge inputs.
 */
import { describe, expect, it } from 'vitest'
import { aggregateSamples, daysInRange, providerOf, dayKey, type UsageSample } from '../src/query.ts'

function sample(partial: Partial<UsageSample> & { day: string }): UsageSample {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  }
}

describe('providerOf', () => {
  it('splits a provider/model ref', () => {
    expect(providerOf('deepseek/deepseek-chat')).toBe('deepseek')
  })
  it('defaults a bare model name', () => {
    expect(providerOf('deepseek-chat')).toBe('default')
  })
})

describe('daysInRange', () => {
  it('lists inclusive local days', () => {
    expect(daysInRange('2026-08-01', '2026-08-03')).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
  })
  it('returns [] for an inverted range', () => {
    expect(daysInRange('2026-08-03', '2026-08-01')).toEqual([])
  })
})

describe('dayKey', () => {
  it('uses the local calendar, not UTC', () => {
    // 2026-08-02 23:30 local (UTC+8) is 2026-08-02 15:30 UTC — must stay the
    // local day.
    const ts = new Date(2026, 7, 2, 23, 30).getTime()
    expect(dayKey(ts)).toBe('2026-08-02')
  })
})

describe('aggregateSamples', () => {
  it('aggregates tokens, requests, and cache buckets across days', () => {
    const samples: UsageSample[] = [
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 10 }),
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 200, outputTokens: 100, cacheReadTokens: 180, cacheWriteTokens: 20 }),
      sample({ day: '2026-08-02', model: 'anthropic/claude', inputTokens: 300, outputTokens: 0 }),
      // Requests come from the per-call markers, one per provider call.
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', request: true }),
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', request: true }),
      sample({ day: '2026-08-02', model: 'anthropic/claude', request: true }),
    ]
    const out = aggregateSamples(samples, { from: '2026-08-01', to: '2026-08-02' })
    // The headline total is PROVIDER-INCLUSIVE (reasonix TotalTokens parity):
    // uncached input + output + cache reads + cache writes — the number a
    // provider dashboard reports for the same calls.
    expect(out.tokens).toBe(1000)
    expect(out.requests).toBe(3)
    expect(out.cacheHit).toBe(220)
    // The uncached input side is the cache miss: inputTokens (100+200+300).
    expect(out.cacheMiss).toBe(630) // uncached 600 + cacheWrite 30 — the miss side includes cache writes
    expect(out.activeDays).toBe(2)
    expect(out.turns).toBe(0)
  })

  it('counts the tokens of a sample that is both a request and usage', () => {
    // `compaction/summary` states the call AND its provider usage in ONE
    // sample; the request count and the buckets are independent facts.
    const out = aggregateSamples(
      [sample({ day: '2026-08-01', model: 'deepseek/deepseek-flash', inputTokens: 376, outputTokens: 3163, cacheReadTokens: 314184, request: true })],
      { from: '2026-08-01', to: '2026-08-01' },
    )
    expect(out.requests).toBe(1)
    expect(out.tokens).toBe(317723) // 376 + 3163 + 314184
    expect(out.cacheHit).toBe(314184)
    expect(out.cacheMiss).toBe(376)
    expect(out.activeDays).toBe(1)
    expect(out.models).toHaveLength(1)
  })

  it('keeps a token-free request marker out of the model rows and active days', () => {
    const out = aggregateSamples(
      [
        sample({ day: '2026-08-01', model: 'deepseek/deepseek-flash', inputTokens: 10, outputTokens: 1 }),
        sample({ day: '2026-08-02', model: 'deepseek/deepseek-chat', request: true }),
      ],
      { from: '2026-08-01', to: '2026-08-02' },
    )
    expect(out.requests).toBe(1)
    expect(out.tokens).toBe(11)
    // The marker-only day carries the request but is not an active day, and
    // marker-only rows never appear in the model ranking.
    expect(out.activeDays).toBe(1)
    expect(out.models.map((m) => m.model)).toEqual(['deepseek/deepseek-flash'])
  })

  it('keeps the hit-rate denominators disjoint from the inclusive headline', () => {
    const out = aggregateSamples(
      [sample({ day: '2026-08-01', model: 'm', inputTokens: 100, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 20 })],
      { from: '2026-08-01', to: '2026-08-01' },
    )
    expect(out.tokens).toBe(4170) // 100 miss-input + 50 output + 4000 cached + 20 written
    expect(out.cacheHit).toBe(4000)
    expect(out.cacheMiss).toBe(120) // uncached 100 + cacheWrite 20 — same miss denominator as the official stats line
  })

  it('counts turns separately; turn-only days do not add to active days', () => {
    const samples: UsageSample[] = [
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 10, outputTokens: 5 }),
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', request: true }),
      { day: '2026-08-02', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true },
    ]
    const out = aggregateSamples(samples, { from: '2026-08-01', to: '2026-08-02' })
    expect(out.tokens).toBe(15)
    expect(out.turns).toBe(1)
    // reasonix marks a day active only when it carries a token-bearing row;
    // a turn-only day keeps the active-days count unchanged.
    expect(out.activeDays).toBe(1)
    expect(out.requests).toBe(1)
  })

  it('emits every day of the range with zero totals for inactive days', () => {
    const out = aggregateSamples(
      [sample({ day: '2026-08-01', model: 'm', inputTokens: 1 })],
      { from: '2026-08-01', to: '2026-08-05' },
    )
    expect(out.daily.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'])
    expect(out.daily[4]!.total).toBe(0)
    expect(out.daily[4]!.requests).toBe(0)
  })

  it('ranks models by token volume and derives the top model/provider', () => {
    const samples: UsageSample[] = [
      sample({ day: '2026-08-01', model: 'a/small', inputTokens: 10, outputTokens: 0 }),
      sample({ day: '2026-08-01', model: 'b/big', inputTokens: 500, outputTokens: 0 }),
      sample({ day: '2026-08-01', model: 'c/mid', inputTokens: 100, outputTokens: 0 }),
    ]
    const out = aggregateSamples(samples, { from: '2026-08-01', to: '2026-08-01' })
    expect(out.models.map((m) => m.model)).toEqual(['b/big', 'c/mid', 'a/small'])
    expect(out.topModel).toBe('b/big')
    expect(out.topProvider).toBe('b')
    expect(out.models[0]!.percent).toBeCloseTo((500 / 610) * 100, 5)
    expect(out.providers[0]!.provider).toBe('b')
  })

  it('attributes a bare model name to the default provider', () => {
    const out = aggregateSamples(
      [sample({ day: '2026-08-01', model: 'deepseek-chat', inputTokens: 5 })],
      { from: '2026-08-01', to: '2026-08-01' },
    )
    expect(out.models[0]!.provider).toBe('default')
    expect(out.providers[0]!.provider).toBe('default')
  })

  it('uses the (unknown) bucket for samples without a model', () => {
    const out = aggregateSamples(
      [sample({ day: '2026-08-01', inputTokens: 5 })],
      { from: '2026-08-01', to: '2026-08-01' },
    )
    expect(out.models[0]!.model).toBe('(unknown)')
  })

  it('clamps samples outside the range', () => {
    const samples: UsageSample[] = [
      sample({ day: '2026-07-31', model: 'm', inputTokens: 100 }),
      sample({ day: '2026-08-02', model: 'm', inputTokens: 100 }),
    ]
    const out = aggregateSamples(samples, { from: '2026-08-01', to: '2026-08-01' })
    expect(out.tokens).toBe(0)
    expect(out.daily).toHaveLength(1)
  })

  it('returns an all-zero aggregate for empty input', () => {
    const out = aggregateSamples([], { from: '2026-08-01', to: '2026-08-07' })
    expect(out.tokens).toBe(0)
    expect(out.activeDays).toBe(0)
    expect(out.topModel).toBe('')
    expect(out.daily).toHaveLength(7)
    expect(out.models).toEqual([])
  })
})

describe('aggregateSamples (hour granularity)', () => {
  it('emits 24 empty buckets for one day', () => {
    const out = aggregateSamples([], { from: '2026-08-02', to: '2026-08-02' }, 'hour')
    expect(out.granularity).toBe('hour')
    expect(out.daily).toHaveLength(24)
    expect(out.daily[0]!.day).toBe('2026-08-02T00')
    expect(out.daily[23]!.day).toBe('2026-08-02T23')
    expect(out.daily.every((bucket) => bucket.total === 0)).toBe(true)
  })

  it('emits 72 buckets across three days in order', () => {
    const out = aggregateSamples([], { from: '2026-08-01', to: '2026-08-03' }, 'hour')
    expect(out.daily).toHaveLength(72)
    expect(out.daily[0]!.day).toBe('2026-08-01T00')
    expect(out.daily[24]!.day).toBe('2026-08-02T00')
    expect(out.daily[71]!.day).toBe('2026-08-03T23')
  })

  it('groups samples by hour while keeping the range totals identical', () => {
    const samples: UsageSample[] = [
      sample({ day: '2026-08-02', hour: '2026-08-02T09', model: 'p/m', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }),
      sample({ day: '2026-08-02', hour: '2026-08-02T09', model: 'p/m', inputTokens: 20, outputTokens: 1, cacheReadTokens: 3 }),
      sample({ day: '2026-08-02', hour: '2026-08-02T10', model: 'p/m', inputTokens: 7, outputTokens: 0 }),
      sample({ day: '2026-08-02', hour: '2026-08-02T10', turn: true }),
    ]
    const hours = aggregateSamples(samples, { from: '2026-08-02', to: '2026-08-02' }, 'hour')
    const days = aggregateSamples(samples, { from: '2026-08-02', to: '2026-08-02' })
    const at9 = hours.daily.find((bucket) => bucket.day === '2026-08-02T09')!
    expect(at9.total).toBe(41)
    expect(at9.byModel['p/m']).toBe(41)
    expect(at9.cacheHit).toBe(5)
    expect(at9.cacheMiss).toBe(30)
    expect(hours.daily.find((bucket) => bucket.day === '2026-08-02T10')!.turns).toBe(1)
    expect(hours.tokens).toBe(days.tokens)
    expect(hours.requests).toBe(days.requests)
    expect(hours.turns).toBe(days.turns)
    expect(hours.cacheHit).toBe(days.cacheHit)
    expect(hours.activeDays).toBe(1)
  })

  it('counts active days by date prefix, not by hour bucket', () => {
    const samples = [
      sample({ day: '2026-08-01', hour: '2026-08-01T23', model: 'p/m', inputTokens: 1 }),
      sample({ day: '2026-08-02', hour: '2026-08-02T00', model: 'p/m', inputTokens: 1 }),
    ]
    const out = aggregateSamples(samples, { from: '2026-08-01', to: '2026-08-02' }, 'hour')
    expect(out.activeDays).toBe(2)
  })

  it('ignores samples without an hour key in hour mode', () => {
    const out = aggregateSamples(
      [sample({ day: '2026-08-02', model: 'p/m', inputTokens: 5 })],
      { from: '2026-08-02', to: '2026-08-02' },
      'hour',
    )
    expect(out.tokens).toBe(0)
    expect(out.daily).toHaveLength(24)
  })
})
