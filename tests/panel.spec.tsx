/**
 * Panel render smoke test: the settings section mounts, the empty state and
 * the toolbar render without crashing (jsdom). Chart internals (SVG math)
 * are covered by the format tests; this guards the composition.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'

const t = ((key: string) => key) as unknown as UsageStatsSectionProps['t']

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UsageStatsSection', () => {
  it('renders the toolbar with range presets and the empty state', () => {
    const props = { t } as UsageStatsSectionProps
    render(<UsageStatsSection {...props} />)
    expect(screen.getByRole('button', { name: 'rangePreset.7' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rangePreset.90' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rangeCustom' })).toBeTruthy()
  })
  it('keeps the content visible while a refresh is in flight (no blank flash)', async () => {
    const RANGE = {
      from: '2026-08-01', to: '2026-08-26', tokens: 12_345, requests: 3, turns: 2,
      cacheHit: 9_000, cacheMiss: 3_345, activeDays: 2, topModel: 'p/m', topProvider: 'p',
      daily: [], models: [], providers: [],
    }
    let rangeCalls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      // The heatmap uses a custom-range request; the data load uses presets.
      if (body?.range === 'custom') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: RANGE }) } as unknown as Response)
      }
      rangeCalls += 1
      if (rangeCalls === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: RANGE }) } as unknown as Response)
      }
      // The second data request (range switch) stays pending forever: the old
      // content must remain on screen until it settles.
      return new Promise<Response>(() => {})
    }))
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(screen.getByText('12,345')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'rangePreset.7' }))
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(screen.getByText('12,345')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'refresh' }).hasAttribute('disabled')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('spans the trend chart across the full container width', async () => {
    const RANGE = {
      from: '2026-08-01', to: '2026-08-10', tokens: 1000, requests: 2, turns: 1,
      cacheHit: 500, cacheMiss: 500, activeDays: 2, topModel: 'p/m', topProvider: 'p',
      daily: Array.from({ length: 10 }, (_, i) => ({
        day: `2026-08-${String(i + 1).padStart(2, '0')}`,
        total: 100, byModel: { 'p/m': 100 }, byProvider: { p: 100 },
        requests: 1, turns: 1, cacheHit: 50, cacheMiss: 50,
      })),
      models: [{ model: 'p/m', provider: 'p', tokens: 1000, percent: 100 }],
      providers: [{ provider: 'p', tokens: 1000, percent: 100 }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ ok: true, value: RANGE }),
    } as unknown as Response)))
    const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    const chart = container.querySelector('svg[class*="chart"]')
    expect(chart).not.toBeNull()
    // width="100%" plus a viewBox built from the measured width is what makes
    // the plot span the container; both must stay.
    expect(chart!.getAttribute('width')).toBe('100%')
    const viewBox = chart!.getAttribute('viewBox')!.split(' ')
    expect(Number(viewBox[2])).toBeGreaterThan(0)
  })
})
