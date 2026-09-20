/**
 * Donut — the responsive ring shared by the per-model and per-provider usage
 * sections. Plain SVG: one track circle plus one dash-offset arc per segment,
 * rotated so rank 1 starts at twelve o'clock. No chart library.
 *
 * Size is NOT a constant. The row this sits in also holds a detail list that
 * needs its width, so the caller resolves a diameter from the measured
 * container (see resolveDonutSize) and every geometric value is derived from
 * that diameter — the ring keeps identical proportions at any size.
 *
 * Accessibility follows the convention this panel already set with its former
 * stacked column: each segment is `role="img"` with an `aria-label` and is
 * keyboard focusable, because focusing a piece of a chart has no activation to
 * promise. `role="button"` would promise one; `role="img"` on the SVG itself
 * would collapse the whole chart into one node and hide every labelled
 * segment, hence the outer `role="group"`.
 */
import { useEffect, useState, type FocusEvent, type MouseEvent, type RefObject } from 'react'
import clsx from 'clsx'
import css from './UsageStatsPanel.module.css'

/** Smallest diameter the ring renders at. */
export const DONUT_MIN = 200
/** Largest diameter; past this the ring stops growing and the list takes the rest. */
export const DONUT_MAX = 280
/** The detail list's flex basis, mirrored from the module css. */
export const LIST_BASIS = 260
/** The row's gap, mirrored from the module css. */
export const MODELS_GAP = 16

/** Ring geometry derived from one diameter. */
export interface DonutGeometry {
  /** Diameter in px. */
  size: number
  /** Centre coordinate; the viewBox is square, so x and y share it. */
  cx: number
  /** Stroke width of the ring. */
  sw: number
  /** Radius of the stroke's centre line. */
  r: number
  /** Circumference of that centre line — the dash total. */
  circ: number
}

/**
 * Derive the ring's geometry from its diameter.
 * @param size - rendered diameter in px.
 * @returns every value the SVG needs, in user units.
 */
export function donutGeometry(size: number): DonutGeometry {
  const cx = size / 2
  const sw = size * 0.15
  const outer = size * 0.475
  const r = outer - sw / 2
  return { size, cx, sw, r, circ: 2 * Math.PI * r }
}

/**
 * Resolve the ring's diameter from the row's measured width: grow with the
 * container up to the cap, and never take so much that the list beside it
 * drops under its basis. Below that the row wraps and the floor applies.
 * @param containerWidth - measured width of the row element, in px.
 * @returns the diameter to render at.
 */
export function resolveDonutSize(containerWidth: number): number {
  const cap = Math.min(DONUT_MAX, Math.max(0, containerWidth - MODELS_GAP - LIST_BASIS))
  return Math.max(DONUT_MIN, cap)
}

/**
 * Track the row's width and resolve the ring's diameter from it.
 *
 * The observed element is the ROW, whose width the ring cannot influence, so
 * the measurement can never feed back into itself. State is committed only
 * when the resolved diameter actually changes — committing an identical value
 * on every ResizeObserver callback would drive a render loop.
 * @param ref - the row element holding the ring and the list.
 * @returns the current diameter in px.
 */
export function useDonutSize(ref: RefObject<HTMLElement | null>): number {
  const [size, setSize] = useState(DONUT_MIN)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const update = (): void => {
      const next = resolveDonutSize(el.clientWidth)
      setSize((prev) => (prev === next ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

/** One ring segment. */
export interface DonutSegment {
  /** Stable identity: the model ref, provider name, or the Other sentinel. */
  key: string
  /** Volume this segment represents. */
  tokens: number
  /** Resolved CSS colour. */
  color: string
  /** Accessible name (also the hover/focus tip's title source). */
  label: string
}

export interface DonutProps {
  /** Segments in rank order: index 0 starts at twelve o'clock. */
  segments: readonly DonutSegment[]
  /** Diameter in px, resolved by the caller via useDonutSize. */
  size: number
  /** Accessible name of the chart. */
  ariaLabel: string
  /** Big line in the middle (already formatted). */
  centerValue: string
  /** Small caption under it. */
  centerCaption: string
  /** Currently highlighted key, or null. Owned by the parent so list rows can drive it. */
  hovered: string | null
  /** Highlight request; the anchor is supplied for pointer/focus entries. */
  onHover: (key: string | null, anchor?: Element) => void
}

export function Donut({
  segments, size, ariaLabel, centerValue, centerCaption, hovered, onHover,
}: DonutProps): JSX.Element | null {
  if (segments.length === 0) return null
  const { cx, sw, r, circ } = donutGeometry(size)
  const total = Math.max(1, segments.reduce((sum, s) => sum + s.tokens, 0))

  // Rank order runs clockwise from twelve o'clock: each segment's dash starts
  // where the previous one ended, so the offsets are resolved before render.
  let cursor = 0
  const placed = segments.map((seg) => {
    const dash = (seg.tokens / total) * circ
    const entry = { seg, dash, start: cursor }
    cursor += dash
    return entry
  })

  return (
    <svg
      className={css.donut}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="group"
      aria-label={ariaLabel}
    >
      <circle className={css.donutTrack} cx={cx} cy={cx} r={r} fill="none" strokeWidth={sw} />
      {placed.map(({ seg, dash, start }) => {
        const active = hovered === seg.key
        return (
          <circle
            key={seg.key}
            className={clsx(css.donutSeg, hovered !== null && !active && css.donutDim)}
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke={seg.color}
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeDashoffset={-start}
            transform={`rotate(-90 ${cx} ${cx})`}
            style={{ strokeWidth: active ? sw * 1.16 : sw, transition: 'stroke-width 0.12s ease' }}
            tabIndex={0}
            role="img"
            aria-label={seg.label}
            onMouseEnter={(e: MouseEvent<SVGElement>) => onHover(seg.key, e.currentTarget)}
            onMouseLeave={() => onHover(null)}
            onFocus={(e: FocusEvent<SVGElement>) => onHover(seg.key, e.currentTarget)}
            onBlur={() => onHover(null)}
          />
        )
      })}
      <text className={css.donutCenter} x={cx} y={cx + size * 0.04} textAnchor="middle">{centerValue}</text>
      <text className={css.donutLabel} x={cx} y={cx + size * 0.13} textAnchor="middle">{centerCaption}</text>
    </svg>
  )
}
