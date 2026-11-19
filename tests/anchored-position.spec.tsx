/**
 * The local port of the official `useAnchoredPosition`.
 *
 * DSH 0.2.2-rc.2 dropped that export from
 * `@deepseek-ai/dsh-client-ui-primitives` (issues #25 / #24), so the dialog
 * seats fall back to this implementation. The algorithm is the official one:
 * place against the anchor's viewport rect, clamp inside the viewport once the
 * panel reports a real size, and re-place on scroll (capture phase), resize and
 * panel resize. jsdom reports zero offset sizes, so the clamp arms are covered
 * here with explicit rects.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, act, render, screen } from '@testing-library/react'
import { type CSSProperties, type RefObject } from 'react'
import { useLocalAnchoredPosition } from '../src/client/stat-dialog.ts'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** A detached element reporting `rect` and sized `width`×`height`. */
function box(rect: Rect): HTMLElement {
  const el = document.createElement('div')
  const { left, top, width, height } = rect
  el.getBoundingClientRect = (() => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({ left, top, width, height }),
  })) as HTMLElement['getBoundingClientRect']
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  return el
}

interface ProbeProps {
  anchor: RefObject<HTMLElement | null>
  panel: RefObject<HTMLElement | null>
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  gap: number
  margin: number
  open?: boolean
}

/** Renders the hook's result as text so a test can read it without a11y noise. */
function Probe({ anchor, panel, side, align, gap, margin, open = true }: ProbeProps): JSX.Element {
  const pos: CSSProperties | null = useLocalAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, side, align, gap, margin })
  return <span data-testid="pos">{pos === null ? 'null' : `${String(pos.left)},${String(pos.top)}`}</span>
}

function place(props: Omit<ProbeProps, 'anchor' | 'panel'>, anchorRect: Rect, panelRect: Rect): string {
  const anchor = { current: box(anchorRect) }
  const panel = { current: box(panelRect) }
  const { unmount } = render(<Probe {...props} anchor={anchor} panel={panel} />)
  const text = screen.getByTestId('pos').textContent ?? ''
  unmount()
  return text
}

afterEach(() => { cleanup() })

describe('useLocalAnchoredPosition', () => {
  it('hangs the panel above the anchor, aligned to its start edge', () => {
    // anchor at (100, 500), 60×20; panel 200×100; gap 8 → top 500-8-100.
    expect(place({ side: 'top', gap: 8, margin: 12 }, { left: 100, top: 500, width: 60, height: 20 }, { left: 0, top: 0, width: 200, height: 100 }))
      .toBe('100,392')
  })

  it('drops the panel below the anchor when asked', () => {
    expect(place({ side: 'bottom', gap: 8, margin: 12 }, { left: 100, top: 500, width: 60, height: 20 }, { left: 0, top: 0, width: 200, height: 100 }))
      .toBe('100,528')
  })

  it('clamps to the viewport margin when the anchor is near the top edge', () => {
    // 5-8-100 = -103 → the margin.
    expect(place({ side: 'top', gap: 8, margin: 12 }, { left: 100, top: 5, width: 60, height: 20 }, { left: 0, top: 0, width: 200, height: 100 }))
      .toBe('100,12')
  })

  it('clamps to the right viewport edge', () => {
    // align start at 900 with a 200-wide panel inside a 1024-wide viewport.
    const text = place({ side: 'top', gap: 8, margin: 12 }, { left: 900, top: 500, width: 60, height: 20 }, { left: 0, top: 0, width: 200, height: 100 })
    expect(text.split(',')[0]).toBe(String(window.innerWidth - 200 - 12))
  })

  it('aligns to the anchor’s end edge when asked', () => {
    // rect.right (160) - 200 = -40 → clamped to the left margin.
    expect(place({ align: 'end', side: 'top', gap: 8, margin: 12 }, { left: 100, top: 500, width: 60, height: 20 }, { left: 0, top: 0, width: 200, height: 100 }))
      .toBe('12,392')
  })

  it('reports nothing while the surface is closed', () => {
    expect(place({ open: false, side: 'top', gap: 8, margin: 12 }, { left: 100, top: 500, width: 60, height: 20 }, { left: 0, top: 0, width: 200, height: 100 }))
      .toBe('null')
  })

  it('re-places on scroll', () => {
    const anchorEl = box({ left: 100, top: 500, width: 60, height: 20 })
    const panelEl = box({ left: 0, top: 0, width: 200, height: 100 })
    const anchor = { current: anchorEl }
    const panel = { current: panelEl }
    render(<Probe side="top" gap={8} margin={12} anchor={anchor} panel={panel} />)
    expect(screen.getByTestId('pos').textContent).toBe('100,392')

    // The page scrolls: the anchor's viewport rect moves up 100px.
    const moved = box({ left: 100, top: 400, width: 60, height: 20 })
    anchorEl.getBoundingClientRect = moved.getBoundingClientRect.bind(moved)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(screen.getByTestId('pos').textContent).toBe('100,292')
  })
})