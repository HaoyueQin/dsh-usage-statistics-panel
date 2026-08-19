/**
 * Formatting helper tests — a TS translation of reasonix's
 * usage-stats-format.test.ts plus the pure chart helpers.
 */
import { describe, expect, it } from 'vitest'
import {
  cacheRate,
  cacheRateText,
  daysBetween,
  formatCompact,
  formatPercent,
  formatTokens,
  formatUsageTokens,
  indexOfDay,
  niceTicks,
  providerOf,
  shortDay,
  smoothPath,
} from '../src/client/format.ts'

describe('formatUsageTokens', () => {
  it('uses compact notation', () => {
    expect(formatUsageTokens(1234, 'en')).toBe('1.2K')
    expect(formatUsageTokens(12345, 'en')).toBe('12.3K')
  })
  it('uses zh-CN units for Chinese', () => {
    expect(formatUsageTokens(12345, 'zh')).toBe('1.2万')
  })
  it('renders small numbers without a suffix', () => {
    expect(formatUsageTokens(999, 'en')).toBe('999')
  })
})

describe('formatTokens', () => {
  it('uses 万/亿 for Chinese-style values', () => {
    expect(formatTokens(15000)).toBe('1.5万')
    expect(formatTokens(200000000)).toBe('2亿')
    expect(formatTokens(999)).toBe('999')
  })
})

describe('formatCompact', () => {
  it('uses k/M/B suffixes', () => {
    expect(formatCompact(1200)).toBe('1.2k')
    expect(formatCompact(1500000)).toBe('1.5M')
    expect(formatCompact(2500000000)).toBe('2.5B')
  })
})

describe('formatPercent', () => {
  it('rounds to one decimal, always showing the decimal', () => {
    // reasonix behavior: (Math.round(p*10)/10).toFixed(1) keeps the ".0".
    expect(formatPercent(42.55)).toBe('42.6%')
    expect(formatPercent(100)).toBe('100.0%')
  })
})

describe('cacheRate', () => {
  it('computes the input-side hit ratio', () => {
    expect(cacheRate(75, 25)).toBeCloseTo(75, 5)
  })
  it('returns null for 0/0', () => {
    expect(cacheRate(0, 0)).toBeNull()
  })
  it('handles a 100% hit day', () => {
    expect(cacheRate(40, 0)).toBe(100)
  })
})

describe('cacheRateText', () => {
  it('renders the ratio (with the .0) or an em dash', () => {
    expect(cacheRateText(75, 25)).toBe('75.0%')
    expect(cacheRateText(0, 0)).toBe('—')
  })
})

describe('daysBetween', () => {
  it('lists inclusive local days without UTC shift', () => {
    expect(daysBetween('2026-08-01', '2026-08-03')).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
  })
})

describe('indexOfDay', () => {
  it('maps Monday to 0 and Sunday to 6', () => {
    expect(indexOfDay('2026-08-03')).toBe(0) // Monday
    expect(indexOfDay('2026-08-09')).toBe(6) // Sunday
  })
})

describe('shortDay', () => {
  it('formats as M/D', () => {
    expect(shortDay('2026-08-02')).toBe('8/2')
  })
})

describe('providerOf', () => {
  it('splits a ref and defaults a bare name', () => {
    expect(providerOf('deepseek/deepseek-chat')).toBe('deepseek')
    expect(providerOf('deepseek-chat')).toBe('default')
  })
})

describe('niceTicks', () => {
  it('produces 1/2/5-step ticks from the reasonix algorithm', () => {
    // reasonix: raw=max/count; mag=10^floor(log10(raw)); norm=raw/mag;
    // step = (1|2|5|10)*mag. For 100/4: raw=25, mag=10, norm=2.5 → step=50.
    expect(niceTicks(100, 4)).toEqual([50, 100])
    expect(niceTicks(1000, 4)).toEqual([500, 1000])
  })
  it('handles a tiny max', () => {
    expect(niceTicks(3, 4)).toEqual([1, 2, 3])
  })
})

describe('smoothPath', () => {
  it('returns empty for no points and a move for one', () => {
    expect(smoothPath([])).toBe('')
    expect(smoothPath([{ x: 1, y: 2 }])).toBe('M 1 2')
  })
  it('builds a Catmull-Rom bezier path for multiple points', () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }])
    expect(d.startsWith('M 0 0')).toBe(true)
    expect(d).toContain('C ')
  })
})
