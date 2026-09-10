/**
 * The per-model section's row anatomy and its own expansion. The colour
 * assignment has its own suite; this one pins structure the provider section
 * mirrors one dimension up: ranked rows carry a rank number and Other does
 * not, Other opens the models it folded (ONE level — the provider section is
 * the one with two), and its detail wrapper is a SIBLING of the row it
 * belongs to, so opening it leaves the column at the collapsed height.
 *
 * The jsdom column-height case matters for CI: the real-browser check in
 * scripts/verify-models.mjs covers the same ground but never runs there.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import type { UsageStatsRange } from '../src/wire.ts'

const t = ((key: string) => key) as unknown as UsageStatsSectionProps['t']

// jsdom performs no layout, so every rect is 0×0. The column height is the sum
// of the list's top-level ROWS, so give every element a uniform row height and
// replay the resize that expanding Other would cause.
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

/** Eleven models: the top ten are rank rows, m11 folds into the gray Other. */
const range: UsageStatsRange = {
  from: '2026-08-01',
  to: '2026-08-24',
  tokens: 6600,
  requests: 3,
  turns: 2,
  cacheHit: 100,
  cacheMiss: 50,
  activeDays: 2,
  topModel: 'm01',
  topProvider: 'p1',
  daily: [],
  models: Array.from({ length: 11 }, (_, i) => ({
    model: `m${String(i + 1).padStart(2, '0')}`,
    provider: 'p1',
    tokens: (11 - i) * 100,
    percent: 0,
  })),
  providers: [{ provider: 'p1', tokens: 6600, percent: 100 }],
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, value: range }),
  } as unknown as Response)))
}

/** The model section, located by its heading (class names are hashed). */
function modelSection(container: HTMLElement): HTMLElement {
  const section = Array.from(container.querySelectorAll('section'))
    .find((el) => el.querySelector('h3')?.textContent === 'modelUsage')
  if (section === undefined || section === null) throw new Error('model section missing')
  return section as HTMLElement
}

/** Direct children of the list only: a detail row is nested one list deeper. */
function topRows(section: HTMLElement): HTMLElement[] {
  return Array.from(section.querySelectorAll('ul[class*="modelList"] > li[class*="modelRow"]'))
}

function rowNamed(section: HTMLElement, name: string): HTMLElement {
  const row = topRows(section).find((el) => el.querySelector('[class*="modelName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row ${name} missing`)
  return row
}

/** The detail list belonging to `row`: a sibling wrapper, mounted while collapsed. */
function detailOf(row: Element): HTMLElement {
  const el = row.nextElementSibling
  if (el === null || !el.className.includes('modelOther')) throw new Error('detail wrapper missing')
  return el as HTMLElement
}

/** The rows a detail wrapper shows directly, by name line. */
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
    expect(container.querySelector('svg[aria-label="modelUsage"] [role="img"][aria-label]')).not.toBeNull()
  })
  return container
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('model usage section', () => {
  it('numbers the ranked rows and leaves Other unnumbered', async () => {
    const container = await renderPanel()
    const section = modelSection(container)
    const rows = topRows(section)
    // Ten ranked models plus the Other bucket.
    expect(rows.length).toBe(11)

    const ranks = rows.map((row) => row.querySelector('[class*="modelRank"]')?.textContent)
    expect(ranks.slice(0, 10)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(ranks[10]).toBe('')
  })

  it('opens the Other row into the models it folded, one level down', async () => {
    const container = await renderPanel()
    const section = modelSection(container)
    const otherRow = rowNamed(section, 'other')
    const toggle = otherRow.querySelector('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Only m11 sits beyond rank 10, and it must not stand among the rank rows.
    expect(detailNames(detailOf(otherRow))).toEqual(['m11'])
    expect(topRows(section).map((row) => row.querySelector('[class*="modelName"]')?.textContent)).not.toContain('m11')
  })

  it('keeps the column at its collapsed height when Other opens', async () => {
    const container = await renderPanel()
    const section = modelSection(container)
    const svg = section.querySelector('svg[aria-label="modelUsage"]')!
    // Eleven top-level rows; the detail wrapper is not one of them.
    const collapsed = String(11 * ROW_H)
    expect(svg.getAttribute('height')).toBe(collapsed)

    fireEvent.click(rowNamed(section, 'other'))
    await act(async () => { for (const cb of observers) cb() })

    expect(svg.getAttribute('height')).toBe(collapsed)
  })
})
