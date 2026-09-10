/**
 * The provider section mirrors the model one one dimension up: top-5 rank
 * colours from the PROVIDER series (never a model hue), everything beyond in
 * the gray Other bucket, and one shared highlight between the bar and the
 * the list. Providers that produced no tokens in the range must not enter the
 * ranking at all — a request-only provider has no usage to rank.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import type { UsageStatsRange } from '../src/wire.ts'

const t = ((key: string) => key) as unknown as UsageStatsSectionProps['t']

// jsdom performs no layout, so every rect is 0×0. The column height is the sum
// of the list's top-level ROWS — the expanded Other detail rows live in a
// nested list and must never count — so give every element a uniform row
// height and replay the resize that expanding Other would cause.
const ROW_H = 40
const observers: Array<() => void> = []

class ResizeObserverStub {
  constructor(cb: () => void) { observers.push(cb) }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    height: ROW_H, width: 200, top: 0, left: 0, right: 200, bottom: ROW_H, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect)
})

/**
 * Eight providers, seven of them with volume: pa..pe take the five rank
 * colours, pf/pg collapse into Other, and pz carries requests but no tokens.
 */
const range: UsageStatsRange = {
  from: '2026-08-01',
  to: '2026-08-24',
  tokens: 1580,
  requests: 10,
  turns: 5,
  cacheHit: 800,
  cacheMiss: 200,
  activeDays: 2,
  topModel: 'pb/m3',
  topProvider: 'pa',
  daily: [
    { day: '2026-08-01', total: 580, byModel: { 'pa/m1': 300, 'pb/m3': 280 }, byProvider: { pa: 300, pb: 280 }, requests: 1, turns: 1, cacheHit: 400, cacheMiss: 100 },
    { day: '2026-08-02', total: 1000, byModel: { 'pb/m3': 120, 'pc/m4': 300, 'pa/m2': 200, 'pd/m5': 200, 'pe/m6': 100, 'pf/m7': 50, 'pg/m8': 30 }, byProvider: { pa: 200, pb: 120, pc: 300, pd: 200, pe: 100, pf: 50, pg: 30 }, requests: 1, turns: 1, cacheHit: 400, cacheMiss: 100 },
  ],
  models: [
    { model: 'pb/m3', provider: 'pb', tokens: 400, percent: 25.32 },
    { model: 'pa/m1', provider: 'pa', tokens: 300, percent: 18.99 },
    { model: 'pc/m4', provider: 'pc', tokens: 300, percent: 18.99 },
    { model: 'pa/m2', provider: 'pa', tokens: 200, percent: 12.66 },
    { model: 'pd/m5', provider: 'pd', tokens: 200, percent: 12.66 },
    { model: 'pe/m6', provider: 'pe', tokens: 100, percent: 6.33 },
    { model: 'pf/m7', provider: 'pf', tokens: 50, percent: 3.16 },
    { model: 'pg/m8', provider: 'pg', tokens: 30, percent: 1.9 },
  ],
  providers: [
    { provider: 'pa', tokens: 500, percent: 31.65 },
    { provider: 'pb', tokens: 400, percent: 25.32 },
    { provider: 'pc', tokens: 300, percent: 18.99 },
    { provider: 'pd', tokens: 200, percent: 12.66 },
    { provider: 'pe', tokens: 100, percent: 6.33 },
    { provider: 'pf', tokens: 50, percent: 3.16 },
    { provider: 'pg', tokens: 30, percent: 1.9 },
    { provider: 'pz', tokens: 0, percent: 0 },
  ],
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, value: range }),
  } as unknown as Response)))
}

/** The provider section, located by its heading (class names are hashed). */
function providerSection(container: HTMLElement): HTMLElement {
  const section = Array.from(container.querySelectorAll('section'))
    .find((el) => el.querySelector('h3')?.textContent === 'providerUsage')
  if (section === undefined || section === null) throw new Error('provider section missing')
  return section as HTMLElement
}

function segmentColors(section: HTMLElement): Map<string, string> {
  const chart = section.querySelector('svg[aria-label="providerUsage"]')!
  const out = new Map<string, string>()
  for (const seg of Array.from(chart.querySelectorAll('[role="button"][aria-label]'))) {
    out.set(seg.getAttribute('aria-label')!.split(':')[0]!, seg.getAttribute('fill') ?? '')
  }
  return out
}

/** The section's top-level rows only — a detail row is nested one list deeper. */
function topRows(section: HTMLElement): HTMLElement[] {
  return Array.from(section.querySelectorAll('ul[class*="modelList"] > li[class*="modelRow"]'))
}

/** The top-level row whose name line reads exactly `name`. */
function rowNamed(section: HTMLElement, name: string): HTMLElement {
  const row = topRows(section).find((el) => el.querySelector('[class*="modelName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row ${name} missing`)
  return row
}

/** The detail list belonging to `row`: a SIBLING wrapper, mounted even while
 *  collapsed (the accordion animates a grid track rather than unmounting). */
function detailOf(row: Element): HTMLElement {
  const el = row.nextElementSibling
  if (el === null || !el.className.includes('modelOther')) throw new Error('detail wrapper missing')
  return el as HTMLElement
}

/** The rows a detail wrapper shows DIRECTLY, by name line. A nested detail list
 *  (a folded provider's own models) sits one level deeper and stays excluded. */
function detailNames(detail: HTMLElement): Array<string | null | undefined> {
  const list = detail.querySelector('ul[class*="modelOtherList"]')
  if (list === null) return []
  return Array.from(list.children)
    .filter((el) => el.className.includes('modelRow'))
    .map((el) => el.querySelector('[class*="modelName"]')?.textContent)
}

async function renderPanel() {
  stubFetch()
  const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
  await waitFor(() => {
    expect(container.querySelector('svg[aria-label="providerUsage"] [role="button"][aria-label]')).not.toBeNull()
  })
  return container
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('provider usage section', () => {
  it('colours the top five from the provider series and folds the tail into gray Other', async () => {
    const container = await renderPanel()
    const colors = segmentColors(providerSection(container))

    for (let rank = 1; rank <= 5; rank += 1) {
      const provider = `p${String.fromCharCode(96 + rank)}` // pa..pe
      expect(colors.get(provider)).toBe(`var(--dsw-provider-${rank})`)
    }
    expect(colors.get('other')).toBe('var(--dsw-provider-other)')
    expect(colors.get('pf')).toBeUndefined() // absorbed into Other
    expect(colors.get('pg')).toBeUndefined()
    expect(colors.get('pz')).toBeUndefined() // zero volume: never ranked
  })

  it('never wears a model colour in the provider series', async () => {
    const container = await renderPanel()
    for (const color of segmentColors(providerSection(container)).values()) {
      expect(color.startsWith('var(--dsw-provider-')).toBe(true)
    }
  })

  it('lists the five ranked providers plus the Other bucket only', async () => {
    const container = await renderPanel()
    // Direct children of the list: the collapsed Other detail rows stay in the
    // DOM (the accordion animates grid-template-rows), so they must not count.
    const rows = providerSection(container).querySelectorAll('ul[class*="modelList"] > li[class*="modelRow"]')
    // pa..pe + Other; pf/pg are inside Other and pz is dropped.
    expect(rows.length).toBe(6)
    expect(rows[5]!.textContent).toContain('other')
  })

  it('shows every model behind the hovered provider in the tip', async () => {
    const container = await renderPanel()
    const seg = providerSection(container).querySelector('[role="button"][aria-label^="pa:"]')!
    fireEvent.mouseEnter(seg)

    await waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
    })
    const tip = document.querySelector('[role="tooltip"]')!
    expect(tip.textContent).toContain('pa')
    expect(tip.textContent).toContain('total')
    // pa served two models; both must be listed with their own volumes.
    expect(tip.textContent).toContain('m1')
    expect(tip.textContent).toContain('m2')
    expect(tip.textContent).not.toContain('m4') // another provider's model
  })

  it('sizes the column to the list rows and keeps it there when Other expands', async () => {
    const container = await renderPanel()
    const section = providerSection(container)
    const svg = section.querySelector('svg[aria-label="providerUsage"]')!
    // Six top-level rows: pa..pe plus the Other row (its wrapper is not a row).
    const collapsed = String(6 * ROW_H)
    expect(svg.getAttribute('height')).toBe(collapsed)

    // The Other row's own twisty — the folded providers live behind it.
    const toggle = rowNamed(section, 'other').querySelector('button[aria-expanded]')!
    fireEvent.click(toggle)
    await act(async () => { for (const cb of observers) cb() })

    expect(svg.getAttribute('height')).toBe(collapsed)
  })

  it('lights the matching bar segment when a list row is hovered', async () => {
    const container = await renderPanel()
    const section = providerSection(container)
    const firstRow = section.querySelector('li[class*="modelRow"]')!
    expect(firstRow.textContent).toContain('pa')

    fireEvent.mouseEnter(firstRow)
    await waitFor(() => {
      expect(section.querySelectorAll('[class*="barDim"]').length).toBeGreaterThan(0)
    })
    // The hovered provider keeps full opacity; the rest dim.
    expect(section.querySelector('[role="button"][aria-label^="pa:"][class*="barDim"]')).toBeNull()
    expect(section.querySelector('[role="button"][aria-label^="pb:"][class*="barDim"]')).not.toBeNull()
  })

  it('opens the Other bucket into the providers it folded, not their models', async () => {
    const container = await renderPanel()
    const section = providerSection(container)
    const otherRow = rowNamed(section, 'other')
    const toggle = otherRow.querySelector('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // pf and pg are the folded PROVIDERS in rank order; their models sit one
    // level deeper, behind each of those rows.
    expect(detailNames(detailOf(otherRow))).toEqual(['pf', 'pg'])
  })

  it('opens a ranked provider into the models it served', async () => {
    const container = await renderPanel()
    const section = providerSection(container)
    const row = rowNamed(section, 'pa')
    const detail = detailOf(row)

    expect(detailNames(detail)).toEqual(['m1', 'm2']) // pa served both, in rank order
    expect(detailNames(detail)).not.toContain('m3') // another provider's model

    const toggle = row.querySelector('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('opens a folded provider into its own models, one level deeper', async () => {
    const container = await renderPanel()
    const section = providerSection(container)
    const pfRow = Array.from(detailOf(rowNamed(section, 'other')).querySelectorAll('li[class*="modelRow"]'))[0]!
    expect(pfRow.querySelector('[class*="modelName"]')?.textContent).toBe('pf')

    const toggle = pfRow.querySelector('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(detailNames(detailOf(pfRow))).toEqual(['m7'])
  })

  it('keeps the column at its collapsed height as rows open at either level', async () => {
    const container = await renderPanel()
    const section = providerSection(container)
    const svg = section.querySelector('svg[aria-label="providerUsage"]')!
    const collapsed = String(6 * ROW_H)

    // A ranked row, then the Other bucket, then a provider two levels in: the
    // column is sized to the ROWS alone, and none of these adds one.
    for (const row of [rowNamed(section, 'pa'), rowNamed(section, 'other')]) {
      fireEvent.click(row)
      await act(async () => { for (const cb of observers) cb() })
      expect(svg.getAttribute('height')).toBe(collapsed)
    }
    const pfRow = Array.from(detailOf(rowNamed(section, 'other')).querySelectorAll('li[class*="modelRow"]'))[0]!
    fireEvent.click(pfRow)
    await act(async () => { for (const cb of observers) cb() })
    expect(svg.getAttribute('height')).toBe(collapsed)
  })
})
