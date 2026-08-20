/**
 * ChartTip renders a chart hover tooltip as a fixed-position portal on
 * document.body. The charts draw in SVG with no DOM wrapper per cell/bar/
 * segment, so the previous absolute-inside-wrap approach could not escape the
 * wrap's clipping (the heatmap's overflow:hidden swallowed the tip entirely)
 * and relied on wrap-relative coordinates that drift under ancestor
 * transforms. This component instead anchors to the hovered SVG element's own
 * viewport rect, clamps inside the settings panel's bounds (falling back to
 * the viewport), and flips above the anchor when there is no room below —
 * re-measuring on scroll (capture phase), resize, and its own size changes
 * while open, mirroring the official ui-primitives useAnchoredPosition/HoverCard
 * pattern.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import css from './UsageStatsPanel.module.css'

export interface ChartTipProps {
  /** The hovered SVG element (cell/bar/segment) the tip is placed from. */
  anchor: Element | null
  /** The settings panel; the tip stays inside its bounds when it fits. */
  panelRef: RefObject<HTMLDivElement | null>
  children: ReactNode
  /** Vertical distance from the anchor edge. */
  gap?: number
  /** Distance kept from the panel edges. */
  margin?: number
}

/** The tip renders only while an anchor is set; null hides it entirely. */
export function ChartTip({ anchor, panelRef, children, gap = 8, margin = 8 }: ChartTipProps) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || anchor === null) {
      setPos(null)
      return
    }
    const place = () => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (w === 0 || h === 0) return // not measured yet; the next pass catches it
      const a = anchor.getBoundingClientRect()
      // The panel is the visible region the tip must stay inside; without it
      // (or while it measures 0) the viewport bounds the tip instead.
      const p = panelRef.current?.getBoundingClientRect()
      const minX = p !== undefined && p.width > 0 ? p.left + margin : margin
      const maxX = p !== undefined && p.width > 0 ? p.right - margin : window.innerWidth - margin
      const minY = p !== undefined && p.height > 0 ? p.top + margin : margin
      const maxY = p !== undefined && p.height > 0 ? p.bottom - margin : window.innerHeight - margin
      let left = a.left + a.width / 2 - w / 2
      left = w <= maxX - minX ? Math.min(Math.max(left, minX), maxX - w) : minX
      const below = a.bottom + gap
      const above = a.top - gap - h
      const fitsBelow = below + h <= maxY
      const fitsAbove = above >= minY
      // Default to below; flip above only when below would overflow. When
      // neither fits (a tip taller than the panel), clamp to the panel's top
      // edge so the tip stays readable — a plain clamp would collapse to a
      // negative top and push the tip off-screen.
      const top = fitsBelow || !fitsAbove
        ? Math.max(Math.min(Math.max(below, minY), maxY - h), minY)
        : Math.max(above, minY)
      setPos((prev) => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
    }
    place()
    // Capture phase: scrollers nested inside the page fire window scroll too.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(place)
      observer.observe(el)
      const panel = panelRef.current
      if (panel !== null) observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor, panelRef, gap, margin])

  return createPortal(
    <div
      ref={ref}
      className={css.tip}
      role="tooltip"
      style={pos === null ? { visibility: 'hidden' } : { left: pos.left, top: pos.top }}
    >
      {children}
    </div>,
    document.body,
  )
}
