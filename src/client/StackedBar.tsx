/**
 * StackedBar — the flat stacked column shared by the per-model and
 * per-provider usage sections. Plain SVG: one rounded-rectangle silhouette
 * clipped over a stack of segment rects. No chart library and no 3D shading.
 * The range total is deliberately NOT repeated here — the numeric cards at
 * the top of the panel already carry it.
 *
 * Rise-in animation: an IntersectionObserver starts a rAF-driven 0→1 progress
 * the first time the column enters the viewport, and every vertical value is
 * derived from it, so the column grows out of its base. prefers-reduced-motion
 * — and any environment without IntersectionObserver — jumps straight to the
 * final state.
 *
 * Segment heights carry a floor. A flat proportional stack renders the tail
 * ranks as sub-pixel slivers (in a real range the 10th model can hold 0.12% of
 * the volume, i.e. ~0.5px of a 380px column), so every non-zero segment gets a
 * minimum height and the remainder is shared out by volume. The ordering stays
 * monotonic: a larger segment is never shorter than a smaller one.
 *
 * The column's height is NOT tied to the list's live height: the section
 * measures the COLLAPSED list and passes it in, so expanding the Other bucket
 * never stretches the chart.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type RefCallback } from 'react'
import clsx from 'clsx'
import css from './UsageStatsPanel.module.css'

/** Minimum rendered height of a non-zero segment, in px. */
const MIN_SEGMENT_H = 4

/** Rise-in duration; long enough to read as a lift, short enough not to nag. */
const RISE_MS = 850

/** Column height before the list beside it has been measured. */
const FALLBACK_H = 320

/** Column corner radius. */
const RADIUS = 6

/**
 * Split `totalH` across the segments: every non-zero segment starts at the
 * floor and the remainder is distributed by volume. The floor is itself capped
 * at an even split so a long tail can never overflow the column.
 * @param tokens - per-segment volumes, in stack order.
 * @param totalH - the column height to fill.
 * @param minH - the per-segment floor.
 * @returns one height per input slot (0 for zero-volume segments).
 */
export function layoutBar(tokens: readonly number[], totalH: number, minH: number): number[] {
  const vols = tokens.map((t) => Math.max(0, t))
  const live = vols.filter((t) => t > 0).length
  if (live === 0 || totalH <= 0) return vols.map(() => 0)
  const floor = Math.min(minH, totalH / live)
  const rest = totalH - floor * live
  const sum = vols.reduce((a, b) => a + b, 0)
  return vols.map((t) => (t > 0 ? floor + (t / sum) * rest : 0))
}

/**
 * Track the height of the row list beside a bar. Only the list's OWN rows
 * count: the Other bucket's detail rows live in a nested list whose
 * grid-template-rows animates open and closed, so reading the container's
 * height would let that animation stretch the column (the expand state flips
 * a render before the animation reaches either end). Summing the top-level
 * rows keeps the column pinned to its collapsed size at every frame.
 *
 * The ref is a CALLBACK, not a RefObject: a section stays mounted while the
 * selected range has no models, so its list element appears AFTER this hook's
 * first effect run — and disappears again when a range with data returns. A
 * RefObject read through an empty dependency list would keep observing the
 * element that is gone and never measure the one now on screen: the column
 * then sticks to a stale height, or to the fallback if it mounted empty.
 * @returns the callback ref to put on the list element, and the collapsed height in px.
 */
export function useCollapsedHeight(): [RefCallback<HTMLUListElement>, number] {
  const [el, setEl] = useState<HTMLUListElement | null>(null)
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    if (el === null) return
    const update = (): void => {
      let h = 0
      for (const row of Array.from(el.children)) {
        // Only marked rows count: a detail wrapper carries no marker, so the
        // accordion inside it can never stretch the column. A data attribute,
        // not a class-name substring — a renamed or similarly named class
        // would otherwise change the column height silently.
        if (!row.hasAttribute('data-bar-row')) continue
        h += row.getBoundingClientRect().height
      }
      const style = getComputedStyle(el)
      h += (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      setHeight(h)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])

  return [setEl, height]
}

/** One stack segment of a bar. */
export interface BarSegment {
  /** Stable identity: the model ref, provider name, or the Other sentinel. */
  key: string
  /** Volume this segment represents. */
  tokens: number
  /** Resolved CSS colour. */
  color: string
  /** Accessible name (also the hover/focus tip's title source). */
  label: string
}

export interface StackedBarProps {
  /** Segments in rank order: index 0 sits at the TOP, matching the list. */
  segments: readonly BarSegment[]
  /** Accessible name of the chart (also the test/selector anchor). */
  ariaLabel: string
  /** Currently highlighted key, or null. Owned by the parent so list rows can drive it. */
  hovered: string | null
  /**
   * Highlight request. The anchor element is supplied for pointer/focus
   * entries so the parent can place its tooltip; list-row entries omit it.
   */
  onHover: (key: string | null, anchor?: Element) => void
  /** Column height in px — the collapsed list height measured by the section. */
  height: number
  /** Column width in px. Kept narrow so the detail list beside it gets the
   *  panel's width instead. */
  width?: number
}

export function StackedBar({ segments, ariaLabel, hovered, onHover, height, width = 72 }: StackedBarProps): JSX.Element | null {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [progress, setProgress] = useState(0)
  const rafRef = useRef(0)
  // React's useId emits colons, which url(#…) cannot carry in a CSS selector
  // position; strip them so the clip reference stays resolvable.
  const uid = useId().replace(/:/g, '')
  const clipId = `bar-clip-${uid}`

  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const reduced = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setProgress(1)
      return
    }
    let started = false
    const io = new IntersectionObserver((entries) => {
      if (started || !entries.some((entry) => entry.isIntersecting)) return
      started = true
      io.disconnect()
      const t0 = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / RISE_MS)
        setProgress(1 - (1 - t) ** 3) // easeOutCubic
        if (t < 1) rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    }, { threshold: 0.2 })
    io.observe(el)
    return () => {
      io.disconnect()
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  if (segments.length === 0) return null

  const W = width
  const H = height > 0 ? height : FALLBACK_H
  const heights = layoutBar(segments.map((s) => s.tokens), H, MIN_SEGMENT_H)

  // Rank order runs top-to-bottom, matching the list beside the column: index 0
  // owns the TOP segment and the gray Other bucket ends at the base. The column
  // still grows out of its base, so the stack is offset by whatever height the
  // rise has reached so far.
  let cursor = H - H * progress
  const placed = segments.map((seg, i) => {
    const h = (heights[i] ?? 0) * progress
    const y = cursor
    cursor += h
    return { seg, y, h }
  })

  // Segments share one interaction surface: the column and the list beside it
  // drive the same highlight, and every segment is keyboard reachable. A
  // segment carries role="img" (a named piece of the chart) rather than
  // role="button": focusing one has no activation behaviour to promise, and
  // the SVG around it is a named group — role="img" there would hide every
  // segment from the accessibility tree, aria-labels included.
  const segProps = (seg: BarSegment) => ({
    className: clsx(css.barSeg, hovered !== null && hovered !== seg.key && css.stackDim),
    fill: seg.color,
    tabIndex: 0,
    role: 'img' as const,
    'aria-label': seg.label,
    onMouseEnter: (e: MouseEvent<SVGElement>) => onHover(seg.key, e.currentTarget),
    onMouseLeave: () => onHover(null),
    onFocus: (e: FocusEvent<SVGElement>) => onHover(seg.key, e.currentTarget),
    onBlur: () => onHover(null),
  })

  return (
    <div className={css.barWrap} ref={wrapRef}>
      <svg className={css.stack} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={W} height={H} rx={RADIUS} />
          </clipPath>
        </defs>
        {progress > 0 && (
          <g clipPath={`url(#${clipId})`}>
            {placed.map(({ seg, y, h }) => (
              <rect key={seg.key} x={0} y={y} width={W} height={Math.max(0, h)} {...segProps(seg)} />
            ))}
          </g>
        )}
      </svg>
    </div>
  )
}
