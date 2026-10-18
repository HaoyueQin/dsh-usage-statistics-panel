/**
 * Panel render smoke test: both mounts render without crashing — the Plugins
 * page's `UsageStatsSection` and the standalone `UsageStatsPanelPage` (the
 * sidebar row's target), the toolbar and the empty state included (jsdom).
 * Chart internals (SVG math) are covered by the format tests; this guards the
 * composition and the 960px content column the main panel wraps it in.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UsageStatsPanelPage, UsageStatsSection, type UsageStatsPanelPageProps, type UsageStatsSectionProps } from '../src/client/index.tsx'

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
    expect(screen.getByRole('button', { name: 'rangePreset.today' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rangePreset.3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rangePreset.7' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rangePreset.90' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rangeCustom' })).toBeTruthy()
  })

  it('switches the trend title and axis to hourly buckets on a short range', async () => {
    const hourBuckets = Array.from({ length: 24 }, (_, h) => {
      const key = `2026-10-19T${String(h).padStart(2, '0')}`
      const active = h === 9
      return {
        day: key,
        total: active ? 1000 : 0,
        byModel: active ? { 'p/m': 1000 } : {},
        byProvider: active ? { p: 1000 } : {},
        requests: active ? 1 : 0,
        turns: 0,
        cacheHit: active ? 500 : 0,
        cacheMiss: active ? 500 : 0,
      }
    })
    const DAY_RANGE = {
      from: '2026-08-01', to: '2026-08-26', tokens: 12_345, requests: 3, turns: 2,
      cacheHit: 9_000, cacheMiss: 3_345, activeDays: 2, topModel: 'p/m', topProvider: 'p',
      granularity: 'day',
      daily: ['2026-08-01', '2026-08-02'].map((day) => ({
        day, total: 100, byModel: { 'p/m': 100 }, byProvider: { p: 100 },
        requests: 1, turns: 0, cacheHit: 50, cacheMiss: 50,
      })),
      models: [{ model: 'p/m', provider: 'p', tokens: 200, percent: 100 }],
      providers: [{ provider: 'p', tokens: 200, percent: 100 }],
    }
    const HOUR_RANGE = {
      ...DAY_RANGE,
      from: '2026-10-19', to: '2026-10-19', tokens: 1000, requests: 1, turns: 0,
      activeDays: 1, granularity: 'hour', daily: hourBuckets,
      models: [{ model: 'p/m', provider: 'p', tokens: 1000, percent: 100 }],
      providers: [{ provider: 'p', tokens: 1000, percent: 100 }],
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      const value = body?.range === 'today' ? HOUR_RANGE : DAY_RANGE
      return { ok: true, json: async () => ({ ok: true, value }) } as unknown as Response
    }))
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(720)
    const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(screen.getByText('dailyTrend')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'rangePreset.today' }))
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(screen.getByText('hourlyTrend')).toBeTruthy()
    // The trend chart labels the day boundary with the date and the other
    // ticks with their hour.
    const axisLabels = [...container.querySelectorAll('text')].map((node) => node.textContent)
    expect(axisLabels).toContain('10/19')
    expect(axisLabels).toContain('02:00')
    width.mockRestore()
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

describe('UsageStatsPanelPage', () => {
  const RANGE = {
    from: '2026-08-01', to: '2026-08-26', tokens: 12_345, requests: 3, turns: 2,
    cacheHit: 9_000, cacheMiss: 3_345, activeDays: 2, topModel: 'p/m', topProvider: 'p',
    daily: [], models: [], providers: [],
  }

  it('wraps the panel in the content column the Plugins page gives it, with the back control', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ ok: true, value: RANGE }),
    } as unknown as Response)))
    const goBack = vi.fn()
    const { container } = render(<UsageStatsPanelPage {...({ t, goBack } as UsageStatsPanelPageProps)} />)
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    // The sidebar row selects this mount; it must render the SAME panel, wrapped
    // so the charts get the Plugins page's content column instead of stretching
    // to the centre column's width.
    const page = container.firstElementChild as HTMLElement
    expect(page.className).toContain('page')
    expect(page.querySelector('[class*="toolbar"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'rangePreset.7' })).toBeTruthy()
    // The standalone entry — and only it — carries the back control: the Plugins
    // page entry sits in that page's own chrome, which draws its own crumb back
    // to the bundle list.
    fireEvent.click(screen.getByRole('button', { name: 'back' }))
    expect(goBack).toHaveBeenCalledTimes(1)
  })
})

describe('rebuild action', () => {
  const RANGE = {
    from: '2026-08-01', to: '2026-08-26', tokens: 12_345, requests: 3, turns: 2,
    cacheHit: 9_000, cacheMiss: 3_345, activeDays: 2, topModel: 'p/m', topProvider: 'p',
    daily: [], models: [], providers: [],
  }

  /** A fetch stub that records every path the panel asks for. */
  function stubFetch(paths: string[]): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      paths.push(url)
      return { ok: true, json: async () => ({ ok: true, value: RANGE }) } as unknown as Response
    }))
  }

  const settle = async (): Promise<void> => {
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
  }

  it('clears the store only on the second press', async () => {
    const paths: string[] = []
    stubFetch(paths)
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await settle()
    const resets = (): number => paths.filter((p) => p === 'usage/api/reset').length

    // One press arms the action and sends nothing: the rebuild is destructive,
    // so it must take a deliberate second press.
    fireEvent.click(screen.getByRole('button', { name: 'rebuild' }))
    expect(screen.getByRole('button', { name: 'rebuildConfirm' })).toBeTruthy()
    expect(resets()).toBe(0)

    // The second press is the confirmation.
    fireEvent.click(screen.getByRole('button', { name: 'rebuildConfirm' }))
    await settle()
    expect(resets()).toBe(1)
    // Settling disarms it again, and both surfaces read the rebuilt store.
    expect(screen.getByRole('button', { name: 'rebuild' })).toBeTruthy()
    expect(paths.filter((p) => p === 'usage/api/range').length).toBeGreaterThan(1)
  })

  it('disarms on blur, so a primed destructive control is never left behind', async () => {
    const paths: string[] = []
    stubFetch(paths)
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'rebuild' }))
    expect(screen.getByRole('button', { name: 'rebuildConfirm' })).toBeTruthy()
    fireEvent.blur(screen.getByRole('button', { name: 'rebuildConfirm' }))
    expect(screen.getByRole('button', { name: 'rebuild' })).toBeTruthy()
    expect(paths.filter((p) => p === 'usage/api/reset')).toHaveLength(0)
  })

  it('keeps both toolbar actions in one flex item, so a narrow toolbar cannot split them', async () => {
    stubFetch([])
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await settle()

    const refresh = screen.getByRole('button', { name: 'refresh' })
    const rebuild = screen.getByRole('button', { name: 'rebuild' })
    // A Tooltip clones its child instead of wrapping it, so each button's own
    // parent is the pair container. That container is what carries the trailing
    // auto margin: were the buttons siblings of the wrapping toolbar, a narrow
    // panel could wrap them apart and strand the rebuild button alone.
    expect(refresh.parentElement).toBe(rebuild.parentElement)
    expect(refresh.parentElement?.className).toContain('actions')
    expect(refresh.parentElement?.parentElement?.className).toContain('toolbar')
  })

  it('holds the in-flight label and stays locked until the rebuild settles', async () => {
    const gate: { release?: () => void } = {}
    const scan = { running: true, total: 0, done: 0, scannedSessions: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== 'usage/api/reset') {
        return { ok: true, json: async () => ({ ok: true, value: RANGE }) } as unknown as Response
      }
      await new Promise<void>((resolve) => { gate.release = resolve })
      return { ok: true, json: async () => ({ ok: true, value: scan }) } as unknown as Response
    }))
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'rebuild' }))
    fireEvent.click(screen.getByRole('button', { name: 'rebuildConfirm' }))

    // Still in flight: the label says so (the dictionary word plus the ellipsis
    // the panel glues on) and a second press cannot slip in.
    const pending = screen.getByRole('button', { name: 'rebuilding…' })
    expect(pending.hasAttribute('disabled')).toBe(true)

    await act(async () => { gate.release?.(); await new Promise((r) => { setTimeout(r, 0) }) })
    expect(screen.getByRole('button', { name: 'rebuild' })).toBeTruthy()
  })
})
