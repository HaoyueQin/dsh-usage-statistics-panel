/**
 * The stacked bar's segment layout carries the real arithmetic: a flat
 * proportional split renders the tail ranks as sub-pixel slivers (in a real
 * range the 10th model holds ~0.12% of the volume, i.e. ~0.5px of a 380px
 * column), so the floor and the stack order are worth pinning down. The
 * component cases cover the rise-in trigger, the shared hover channel, and
 * the fact that the column height is the CALLER's — never a live measurement
 * of the list, so expanding Other cannot stretch the chart.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { layoutBar, StackedBar, useCollapsedHeight, type BarSegment } from '../src/client/StackedBar.tsx'

describe('layoutBar', () => {
  it('fills exactly the available column height', () => {
    const h = layoutBar([500, 300, 200], 380, 4)
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(380, 6)
  })

  it('gives every non-zero segment at least the floor', () => {
    // The distribution that motivated the floor: 28.55% down to 0.12%.
    const tokens = [2855, 2326, 1412, 1262, 658, 643, 287, 254, 251, 12]
    const h = layoutBar(tokens, 380, 4)
    for (const [i, v] of h.entries()) expect(v, `segment ${i}`).toBeGreaterThanOrEqual(4)
    // The 0.12% tail renders ~0.47px without the floor; with it, it is legible.
    expect(h[9]).toBeGreaterThan(4)
    expect(h[9]!).toBeLessThan(6)
  })

  it('never lets a smaller segment outgrow a larger one', () => {
    const h = layoutBar([500, 300, 200, 1], 380, 4)
    for (let i = 1; i < h.length; i += 1) expect(h[i - 1]).toBeGreaterThanOrEqual(h[i]!)
  })

  it('gives a zero-volume slot no height', () => {
    expect(layoutBar([100, 0, 50], 300, 4)[1]).toBe(0)
  })

  it('caps the floor at an even split so a long tail cannot overflow', () => {
    // Eight segments in a 16px column: an uncapped 4px floor would need 32px.
    const h = layoutBar([1, 1, 1, 1, 1, 1, 1, 1], 16, 4)
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(16, 6)
    expect(Math.max(...h)).toBeCloseTo(2, 6)
  })

  it('returns nothing to draw for empty, all-zero or zero-height input', () => {
    expect(layoutBar([], 300, 4)).toEqual([])
    expect(layoutBar([0, 0], 300, 4)).toEqual([0, 0])
    expect(layoutBar([5], 0, 4)).toEqual([0])
  })
})

const SEGMENTS: BarSegment[] = [
  { key: 'a', tokens: 60, color: 'rgb(1, 1, 1)', label: 'a: 60 (60%)' },
  { key: 'b', tokens: 40, color: 'rgb(2, 2, 2)', label: 'b: 40 (40%)' },
]

function renderBar(overrides: Partial<Parameters<typeof StackedBar>[0]> = {}) {
  return render(
    <StackedBar
      segments={SEGMENTS}
      ariaLabel="testBar"
      height={320}
      hovered={null}
      onHover={() => {}}
      {...overrides}
    />,
  )
}

describe('StackedBar', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders one focusable segment per stack entry, keyed by its label', () => {
    const { container } = renderBar()
    const rects = container.querySelectorAll('svg[aria-label="testBar"] [role="img"]')
    expect(rects.length).toBe(2)
    expect(rects[0]!.getAttribute('aria-label')).toBe('a: 60 (60%)')
    expect(rects[0]!.getAttribute('tabindex')).toBe('0')
  })

  it('draws the height it is given, so a caller can pin it', () => {
    const { container } = renderBar({ height: 444 })
    const svg = container.querySelector('svg[aria-label="testBar"]')!
    expect(svg.getAttribute('height')).toBe('444')
  })

  it('falls back to a default height before the list has been measured', () => {
    const { container } = renderBar({ height: 0 })
    const svg = container.querySelector('svg[aria-label="testBar"]')!
    expect(Number(svg.getAttribute('height'))).toBeGreaterThan(0)
  })

  it('stacks rank order top-to-bottom, so index 0 owns the top segment', () => {
    const { container } = renderBar()
    const segs = [...container.querySelectorAll('svg[aria-label="testBar"] [role="img"]')]
    const top = (el: Element): number => Number(el.getAttribute('y'))
    expect(top(segs[0]!)).toBe(0)
    expect(top(segs[1]!)).toBeGreaterThan(0)
  })

  it('reports hover and focus through the shared channel', () => {
    const onHover = vi.fn()
    const { container } = renderBar({ onHover })
    const seg = container.querySelector('[role="img"][aria-label="a: 60 (60%)"]')!
    fireEvent.mouseEnter(seg)
    expect(onHover).toHaveBeenCalledWith('a', seg)
    fireEvent.mouseLeave(seg)
    expect(onHover).toHaveBeenLastCalledWith(null)
    fireEvent.focus(seg)
    expect(onHover).toHaveBeenLastCalledWith('a', seg)
  })

  it('dims every segment that is not the highlighted one', () => {
    const { container } = renderBar({ hovered: 'a' })
    // Class names are CSS-module hashes, so match on the local-name suffix.
    expect(container.querySelector('[aria-label="b: 40 (40%)"][class*="stackDim"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="a: 60 (60%)"][class*="stackDim"]')).toBeNull()
  })

  it('grows only once the column enters the viewport', async () => {
    let fire: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null
    class IntersectionObserverStub {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { fire = cb }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)

    const { container } = renderBar()
    // Nothing is drawn before the observer reports an intersection.
    expect(container.querySelectorAll('[role="img"]').length).toBe(0)

    await act(async () => {
      fire?.([{ isIntersecting: true }])
      await new Promise((resolve) => { requestAnimationFrame(() => resolve(undefined)) })
    })

    await waitFor(() => {
      expect(container.querySelectorAll('[role="img"]').length).toBe(2)
    }, { timeout: 3000 })
  })
})

/**
 * The section stays mounted while a range has no models, so the list element
 * appears LATER than the hook's first effect run — and then disappears again
 * when a range with data returns. Reading the height must follow the element
 * through both, or the column keeps a stale (or fallback) height.
 */
function HeightProbe({ rows }: { rows: number }): JSX.Element {
  const [ref, height] = useCollapsedHeight()
  return (
    <>
      <span data-testid="height">{height}</span>
      {rows > 0 && (
        <ul ref={ref}>
          {Array.from({ length: rows }, (_, i) => <li key={i} data-bar-row="" className="modelRow" />)}
        </ul>
      )}
    </>
  )
}

describe('useCollapsedHeight', () => {
  const ROW_H = 40
  const observers: Array<() => void> = []
  class RecordingResizeObserver {
    constructor(cb: () => void) { observers.push(cb) }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  afterEach(() => {
    observers.length = 0
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubLayout(rowHeight: number): void {
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      height: rowHeight, width: 200, top: 0, left: 0, right: 200, bottom: rowHeight, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  }

  it('measures rows that only appear after the first render', () => {
    stubLayout(ROW_H)
    const { getByTestId, rerender } = render(<HeightProbe rows={0} />)
    expect(getByTestId('height').textContent).toBe('0')

    rerender(<HeightProbe rows={3} />)

    expect(Number(getByTestId('height').textContent)).toBe(3 * ROW_H)
  })

  it('re-measures a list that was replaced by a differently sized one', () => {
    stubLayout(ROW_H)
    const { getByTestId, rerender } = render(<HeightProbe rows={2} />)
    expect(Number(getByTestId('height').textContent)).toBe(2 * ROW_H)

    // A range with no usage empties the section, then a range with data comes
    // back with a different row count.
    rerender(<HeightProbe rows={0} />)
    rerender(<HeightProbe rows={5} />)

    expect(Number(getByTestId('height').textContent)).toBe(5 * ROW_H)
  })

  it('follows a resize the observer reports', () => {
    // The positive control for the "expanding never changes the height" cases
    // at the section level: those assert an UNCHANGED number, which a frozen
    // measurement would also satisfy. Here the number must move.
    stubLayout(ROW_H)
    const { getByTestId } = render(<HeightProbe rows={2} />)
    expect(Number(getByTestId('height').textContent)).toBe(2 * ROW_H)

    // A taller row (a wrapped name, a longer provider label) resizes the list.
    stubLayout(60)
    act(() => { for (const cb of observers) cb() })

    expect(Number(getByTestId('height').textContent)).toBe(2 * 60)
  })
})
