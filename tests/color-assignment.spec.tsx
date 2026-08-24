/**
 * Regression test for the chart colour assignment: a model's colour must be
 * its TOKEN rank (--dsw-chart-1..5 by token volume, gray --dsw-chart-other for
 * the collapsed tail), matching reasonix — never the first-seen order of the
 * daily walk, which used to hand the blue to a tail model and gray out a
 * top-5 model.
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
 * Five top models (ranked by tokens) plus a tail model that must collapse
 * into the gray Other bucket. The daily walk deliberately encounters them in
 * a different order than the rank order, so a first-seen assignment would
 * scramble the colours.
 */
const range: UsageStatsRange = {
  from: '2026-08-01',
  to: '2026-08-24',
  tokens: 1001,
  requests: 10,
  turns: 5,
  cacheHit: 800,
  cacheMiss: 100,
  activeDays: 3,
  topModel: 'alpha',
  topProvider: 'p1',
  daily: [
    { day: '2026-08-01', total: 500, byModel: { zeta: 10, beta: 400, omega: 1 }, byProvider: { p1: 400, p4: 10, p5: 1 }, requests: 1, turns: 1, cacheHit: 400, cacheMiss: 100 },
    { day: '2026-08-02', total: 501, byModel: { alpha: 450, gamma: 50, delta: 40 }, byProvider: { p1: 450, p2: 50, p3: 40 }, requests: 1, turns: 1, cacheHit: 400, cacheMiss: 100 },
  ],
  models: [
    { model: 'alpha', provider: 'p1', tokens: 450, percent: 45 },
    { model: 'beta', provider: 'p1', tokens: 400, percent: 40 },
    { model: 'gamma', provider: 'p2', tokens: 50, percent: 5 },
    { model: 'delta', provider: 'p3', tokens: 40, percent: 4 },
    { model: 'zeta', provider: 'p4', tokens: 10, percent: 1 },
    { model: 'omega', provider: 'p5', tokens: 1, percent: 0.1 },
  ],
  providers: [{ provider: 'p1', tokens: 850, percent: 85 }],
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
  it('colours the donut by token rank, tail models into gray Other', async () => {
    stubFetch()
    const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)

    // Wait for the aggregate to arrive and the donut segments to render.
    await waitFor(() => {
      expect(container.querySelector('svg[aria-label="modelUsage"] circle[stroke]')).not.toBeNull()
    })

    const donut = container.querySelector('svg[aria-label="modelUsage"]')!
    const segments = new Map<string, string>()
    for (const circle of Array.from(donut.querySelectorAll('circle[stroke]'))) {
      const label = circle.getAttribute('aria-label') ?? ''
      const model = label.split(':')[0] ?? ''
      segments.set(model, circle.getAttribute('stroke') ?? '')
    }

    // Rank order: alpha=1 (blue) ... zeta=5; the tail omega collapses into
    // the gray Other bucket.
    expect(segments.get('alpha')).toBe('var(--dsw-chart-1)')
    expect(segments.get('beta')).toBe('var(--dsw-chart-2)')
    expect(segments.get('gamma')).toBe('var(--dsw-chart-3)')
    expect(segments.get('delta')).toBe('var(--dsw-chart-4)')
    expect(segments.get('zeta')).toBe('var(--dsw-chart-5)')
    expect(segments.get('other')).toBe('var(--dsw-chart-other)')
    expect(segments.get('omega')).toBeUndefined() // absorbed into Other
  })

  it('renders the trend legend with the same rank colours', async () => {
    stubFetch()
    const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)

    await waitFor(() => {
      expect(container.querySelector('svg[aria-label="modelUsage"] circle[stroke]')).not.toBeNull()
    })

    // The trend legend renders one inline-background swatch per model inside
    // a label span (class names are hashed, so match on structure + text).
    const legendSwatches = Array.from(container.querySelectorAll('span > i[style]'))
    const bgOf = (label: string) => {
      const swatch = legendSwatches.find((el) => (el.parentElement?.textContent ?? '').includes(label))
      return swatch === undefined ? undefined : (swatch as HTMLElement).style.background
    }
    expect(bgOf('alpha')).toBe('var(--dsw-chart-1)')
    expect(bgOf('zeta')).toBe('var(--dsw-chart-5)')
    expect(bgOf('other')).toBe('var(--dsw-chart-other)')
  })
})
