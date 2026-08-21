/**
 * ChartTip placement unit tests. jsdom reports zero layout (offsetWidth,
 * getBoundingClientRect are all 0), so the placement branch (clamp inside the
 * panel, flip above when there is no room below) is exercised by mocking the
 * geometry reads the hook performs: the anchor rect, the panel rect, the tip's
 * own size, and the window dimensions.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { RefObject } from 'react'
import { render, cleanup } from '@testing-library/react'
import { ChartTip } from '../src/client/ChartTip.tsx'

function mockGeometry(overrides: {
  anchor?: Partial<DOMRect>
  panel?: Partial<DOMRect>
  tipSize?: { width: number; height: number }
  window?: { innerWidth: number; innerHeight: number }
}) {
  const anchor = { left: 100, right: 140, top: 300, bottom: 340, width: 40, height: 40, x: 100, y: 300, toJSON: () => ({}), ...overrides.anchor } as DOMRect
  const panel = { left: 50, right: 750, top: 60, bottom: 660, width: 700, height: 600, x: 50, y: 60, toJSON: () => ({}), ...overrides.panel } as DOMRect
  const tipW = overrides.tipSize?.width ?? 200
  const tipH = overrides.tipSize?.height ?? 80

  const anchorEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  vi.spyOn(anchorEl, 'getBoundingClientRect').mockReturnValue(anchor)

  const panelEl = document.createElement('div')
  vi.spyOn(panelEl, 'getBoundingClientRect').mockReturnValue(panel)
  const panelRef = { current: panelEl } as RefObject<HTMLDivElement | null>

  // The tip renders inside a portal on document.body; find it after render and
  // fake its size so the layout effect can place it.
  const tipSize = { width: tipW, height: tipH }

  Object.defineProperty(window, 'innerWidth', { value: overrides.window?.innerWidth ?? 1440, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: overrides.window?.innerHeight ?? 900, configurable: true })

  return { anchorEl, panelRef, tipSize }
}

describe('ChartTip placement', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // jsdom lacks ResizeObserver; the hook guards on its presence.
    vi.stubGlobal('ResizeObserver', undefined)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('places below the anchor, centered, clamped inside the panel', async () => {
    const { anchorEl, panelRef, tipSize } = mockGeometry({})
    render(
      <ChartTip anchor={anchorEl} panelRef={panelRef}>
        <span>tip body</span>
      </ChartTip>,
    )
    // The tip is portaled to body, not inside container.
    const tip = await vi.waitFor(() => {
      const el = document.body.querySelector('[role="tooltip"]') as HTMLElement | null
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    // Fake the size so place() proceeds (it returns early while size is 0).
    Object.defineProperty(tip, 'offsetWidth', { value: tipSize.width, configurable: true })
    Object.defineProperty(tip, 'offsetHeight', { value: tipSize.height, configurable: true })
    // The layout effect ran before the size was faked; trigger a re-run by
    // resizing the window (the hook listens to resize).
    window.dispatchEvent(new Event('resize'))
    await vi.waitFor(() => {
      const style = tip.style
      expect(style.left).not.toBe('')
    })
    // Anchor centre x = 120; tip w=200 → left = 120 - 100 = 20, but the panel
    // min x is panel.left 50 + margin 8 = 58 → clamped to 58. Below: anchor
    // bottom 340 + gap 8 = 348.
    expect(parseFloat(tip.style.left)).toBe(58)
    expect(parseFloat(tip.style.top)).toBe(348)
  })

  it('flips above the anchor when there is no room below', async () => {
    // Anchor near the panel bottom: bottom 640, panel bottom 660 → only 20px
    // below, not enough for an 80px tip.
    const { anchorEl, panelRef, tipSize } = mockGeometry({
      anchor: { left: 100, right: 140, top: 600, bottom: 640, width: 40, height: 40, x: 100, y: 600 },
    })
    render(
      <ChartTip anchor={anchorEl} panelRef={panelRef}>
        <span>tip body</span>
      </ChartTip>,
    )
    const tip = document.body.querySelector('[role="tooltip"]') as HTMLElement
    expect(tip).not.toBeNull()
    Object.defineProperty(tip, 'offsetWidth', { value: tipSize.width, configurable: true })
    Object.defineProperty(tip, 'offsetHeight', { value: tipSize.height, configurable: true })
    window.dispatchEvent(new Event('resize'))
    await vi.waitFor(() => { expect(tip.style.top).not.toBe('') })
    // Above: anchor.top 600 - gap 8 - tipH 80 = 512 (inside panel, >= 60).
    expect(parseFloat(tip.style.top)).toBe(512)
  })

  it('stays inside the panel when neither side fits', async () => {
    // Anchor mid-panel with an oversized tip that fits nowhere cleanly.
    const { anchorEl, panelRef, tipSize } = mockGeometry({
      anchor: { left: 100, right: 140, top: 200, bottom: 240, width: 40, height: 40, x: 100, y: 200 },
      tipSize: { width: 800, height: 700 },
    })
    render(
      <ChartTip anchor={anchorEl} panelRef={panelRef}>
        <span>tip body</span>
      </ChartTip>,
    )
    const tip = document.body.querySelector('[role="tooltip"]') as HTMLElement
    expect(tip).not.toBeNull()
    Object.defineProperty(tip, 'offsetWidth', { value: tipSize.width, configurable: true })
    Object.defineProperty(tip, 'offsetHeight', { value: tipSize.height, configurable: true })
    window.dispatchEvent(new Event('resize'))
    await vi.waitFor(() => { expect(tip.style.top).not.toBe('') })
    // Horizontal: tip w=800 > panel width 700 → pinned to panel min x + margin.
    expect(parseFloat(tip.style.left)).toBe(58)
    // Vertical: below (248+700 > 660) and above (192-700 < 60) both fail →
    // the tip is taller than the panel, so it clamps to the panel top + margin.
    expect(parseFloat(tip.style.top)).toBe(68)
  })

  it('hides (does not place) while the anchor is null', () => {
    const { panelRef } = mockGeometry({})
    render(
      <ChartTip anchor={null} panelRef={panelRef}>
        <span>tip body</span>
      </ChartTip>,
    )
    const tip = document.body.querySelector('[role="tooltip"]') as HTMLElement
    expect(tip).not.toBeNull()
    expect(tip.style.visibility).toBe('hidden')
    expect(tip.style.left).toBe('')
  })
})
