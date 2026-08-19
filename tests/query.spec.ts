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
    ]
    const out = aggregateSamples(samples, { from: '2026-08-01', to: '2026-08-02' })
    expect(out.tokens).toBe(750)
    expect(out.requests).toBe(3)
    expect(out.cacheHit).toBe(220)
    // The uncached input side is the cache miss: inputTokens (100+200+300).
    expect(out.cacheMiss).toBe(600)
    expect(out.activeDays).toBe(2)
    expect(out.turns).toBe(0)
  })

  it('counts turns separately; turn-only days do not add to active days', () => {
    const samples: UsageSample[] = [
      sample({ day: '2026-08-01', model: 'deepseek/deepseek-chat', inputTokens: 10, outputTokens: 5 }),
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
