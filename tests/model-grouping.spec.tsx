/**
 * The model dimension's two grouping modes. "By source" (default) keeps the
 * host's raw `provider/model` rows; "By model" folds rows that share a
 * fingerprint together while the provider section stays per-source, so the
 * source view is never lost. The preference is persisted in localStorage.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import type { UsageStatsRange } from '../src/wire.ts'

const GROUPING_KEY = 'dsh-usage.grouping'

/** Translates the key and appends the interpolation payload, so a row's
 *  "N sources" subtitle is assertable. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params && 'n' in params ? `${key}:${String(params.n)}` : key) as unknown as UsageStatsSectionProps['t']

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Two providers serving the same model, plus one unrelated model. */
const range: UsageStatsRange = {
  from: '2026-08-01',
  to: '2026-08-24',
  tokens: 1000,
  requests: 4,
  turns: 2,
  cacheHit: 100,
  cacheMiss: 50,
  activeDays: 2,
  topModel: 'deepseek-official/deepseek-flash',
  topProvider: 'deepseek-official',
  granularity: 'day',
  daily: [],
  models: [
    { model: 'deepseek-official/deepseek-flash', provider: 'deepseek-official', tokens: 600, percent: 60 },
    { model: 'dsh-api-free/deepseek-v4.1-flash', provider: 'dsh-api-free', tokens: 300, percent: 30 },
    { model: 'qodercn/qmodel_38max', provider: 'qodercn', tokens: 100, percent: 10 },
  ],
  providers: [
    { provider: 'deepseek-official', tokens: 600, percent: 60 },
    { provider: 'dsh-api-free', tokens: 300, percent: 30 },
    { provider: 'qodercn', tokens: 100, percent: 10 },
  ],
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  window.localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, value: range }),
  } as unknown as Response)))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function sectionByTitle(container: HTMLElement, title: string): HTMLElement {
  const section = Array.from(container.querySelectorAll('section'))
    .find((el) => el.querySelector('h3')?.textContent === title)
  if (section === undefined || section === null) throw new Error(`section ${title} missing`)
  return section as HTMLElement
}

function modelRows(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll('ul[class*="modelList"] > li[class*="modelRow"]'))
    .map((el) => el.querySelector('[class*="modelName"]')?.textContent ?? '')
}

function providerRows(section: HTMLElement): string[] {
  const list = section.querySelector('ul[class*="modelList"]')
  if (list === null) throw new Error('provider list missing')
  return Array.from(list.children)
    .filter((el) => !el.className.includes('modelOther'))
    .map((el) => el.querySelector('[class*="modelName"]')?.textContent ?? '')
}

function subtitles(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll('[class*="modelProvider"]')).map((el) => el.textContent ?? '')
}

async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
  await waitFor(() => expect(container.querySelector('section')).not.toBeNull())
  return container
}

describe('model grouping', () => {
  it('groups raw provider/model refs by source by default', async () => {
    const container = await renderPanel()
    expect(modelRows(sectionByTitle(container, 'modelUsage'))).toEqual([
      'deepseek-flash',
      'deepseek-v4.1-flash',
      'qmodel_38max',
    ])
  })

  it('folds the same model from different providers into one row', async () => {
    const container = await renderPanel()
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'groupByModel')!)

    await waitFor(() => expect(modelRows(sectionByTitle(container, 'modelUsage'))).toEqual([
      'deepseek-flash',
      'qmodel_38max',
    ]))
    const merged = sectionByTitle(container, 'modelUsage')
    expect(subtitles(merged)).toContain('sources:2')
    expect(window.localStorage.getItem(GROUPING_KEY)).toBe('model')
  })

  it('keeps the provider section per-source in the merged view', async () => {
    window.localStorage.setItem(GROUPING_KEY, 'model')
    const container = await renderPanel()
    const providers = sectionByTitle(container, 'providerUsage')
    expect(providerRows(providers)).toEqual(['deepseek-official', 'dsh-api-free', 'qodercn'])
    expect(modelRows(sectionByTitle(container, 'modelUsage'))).toEqual(['deepseek-flash', 'qmodel_38max'])
  })

  it('switching back restores the per-source rows', async () => {
    window.localStorage.setItem(GROUPING_KEY, 'model')
    const container = await renderPanel()
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'groupBySource')!)
    await waitFor(() => expect(modelRows(sectionByTitle(container, 'modelUsage'))).toHaveLength(3))
  })
})