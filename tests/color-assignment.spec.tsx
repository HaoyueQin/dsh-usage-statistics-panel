/**
 * Regression test for the chart colour assignment: a model's colour must be
 * its TOKEN rank (--dsw-chart-1..10 by token volume, gray --dsw-chart-other
 * for the collapsed tail), matching reasonix — never the first-seen order of
 * the daily walk, which used to hand the blue to a tail model and gray out a
 * top-10 model.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import type { UsageStatsRange } from '../src/wire.ts'

const t = ((key: string) => key) as unknown as UsageStatsSectionProps['t']

// jsdom has no ResizeObserver; the panel's charts measure their wraps with
// one, so a no-op stub keeps the chart layout effects from throwing.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  // afterEach's unstubAllGlobals() clears fetch stubs; re-stub the chart
  // measurement API for every test that renders the full panel.
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

/**
 * Eleven models ranked by tokens: the top ten take --dsw-chart-1..10 and the
 * tail (m11) collapses into the gray Other bucket. The daily walk deliberately
 * encounters them in a different order than the rank order, so a first-seen
 * assignment would scramble the colours.
 */
const range: UsageStatsRange = {
  from: '2026-08-01',
  to: '2026-08-24',
  tokens: 2040,
  requests: 10,
  turns: 5,
  cacheHit: 800,
  cacheMiss: 100,
  activeDays: 2,
  topModel: 'm01',
  topProvider: 'p1',
  daily: [
    { day: '2026-08-01', total: 770, byModel: { m11: 10, m02: 400, m07: 100, m05: 200, m09: 60 }, byProvider: { p1: 700, p2: 70 }, requests: 1, turns: 1, cacheHit: 400, cacheMiss: 100 },
    { day: '2026-08-02', total: 1270, byModel: { m01: 450, m04: 250, m03: 300, m06: 150, m08: 80, m10: 40 }, byProvider: { p1: 1150, p3: 120 }, requests: 1, turns: 1, cacheHit: 400, cacheMiss: 100 },
  ],
  models: [
    { model: 'm01', provider: 'p1', tokens: 450, percent: 22.06 },
    { model: 'm02', provider: 'p1', tokens: 400, percent: 19.61 },
    { model: 'm03', provider: 'p2', tokens: 300, percent: 14.71 },
    { model: 'm04', provider: 'p2', tokens: 250, percent: 12.25 },
    { model: 'm05', provider: 'p2', tokens: 200, percent: 9.8 },
    { model: 'm06', provider: 'p3', tokens: 150, percent: 7.35 },
    { model: 'm07', provider: 'p1', tokens: 100, percent: 4.9 },
    { model: 'm08', provider: 'p3', tokens: 80, percent: 3.92 },
    { model: 'm09', provider: 'p2', tokens: 60, percent: 2.94 },
    { model: 'm10', provider: 'p3', tokens: 40, percent: 1.96 },
    { model: 'm11', provider: 'p2', tokens: 10, percent: 0.49 },
  ],
  providers: [
    { provider: 'p1', tokens: 950, percent: 46.57 },
    { provider: 'p2', tokens: 820, percent: 40.2 },
    { provider: 'p3', tokens: 270, percent: 13.24 },
  ],
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, value: range }),
  } as unknown as Response)))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('chart colour rank assignment', () => {
  it('colours every segment by token rank, tail models into gray Other', async () => {
    stubFetch()
    const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)

    // Wait for the aggregate to arrive and the chart segments to render.
    await waitFor(() => {
      expect(container.querySelector('svg[aria-label="modelUsage"] [role="img"][aria-label]')).not.toBeNull()
    })

    const chart = container.querySelector('svg[aria-label="modelUsage"]')!
    const segments = new Map<string, string>()
    // Every stack segment carries its own aria-label, which is what this
    // selector keys on.
    for (const seg of Array.from(chart.querySelectorAll('[role="img"][aria-label]'))) {
      const label = seg.getAttribute('aria-label') ?? ''
      const model = label.split(':')[0] ?? ''
      segments.set(model, seg.getAttribute('fill') ?? '')
    }

    // Rank order: m01=1 (blue) .. m10=10; the tail m11 collapses into the gray
    // Other bucket.
    for (let rank = 1; rank <= 10; rank += 1) {
      const model = `m${String(rank).padStart(2, '0')}`
      expect(segments.get(model)).toBe(`var(--dsw-chart-${rank})`)
    }
    expect(segments.get('other')).toBe('var(--dsw-chart-other)')
    expect(segments.get('m11')).toBeUndefined() // absorbed into Other
  })

  it('renders the trend legend with the same rank colours', async () => {
    stubFetch()
    const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)

    await waitFor(() => {
      expect(container.querySelector('svg[aria-label="modelUsage"] [role="img"][aria-label]')).not.toBeNull()
    })

    // The trend legend renders one inline-background swatch per model inside
    // a label span (class names are hashed, so match on structure + text).
    const legendSwatches = Array.from(container.querySelectorAll('span > i[style]'))
    const bgOf = (label: string) => {
      const swatch = legendSwatches.find((el) => (el.parentElement?.textContent ?? '').includes(label))
      return swatch === undefined ? undefined : (swatch as HTMLElement).style.background
    }
    expect(bgOf('m01')).toBe('var(--dsw-chart-1)')
    expect(bgOf('m10')).toBe('var(--dsw-chart-10)')
    expect(bgOf('other')).toBe('var(--dsw-chart-other)')
  })
})
