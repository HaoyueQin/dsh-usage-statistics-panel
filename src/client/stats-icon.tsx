/**
 * The "usage statistics" glyph — the lucide BarChart3 icon, used by the
 * sidebar's panel row. Kept as its own module so the path data has a single
 * authority and the SVG stays identical wherever it is rendered.
 */

/** The lucide BarChart3 path data (24x24 stroke icon). */
export const STATS_ICON_PATH = 'M3 3v18h18 M18 17V9 M13 17V5 M8 17v-3'

/**
 * Lucide's default weight is 2 on its 24-unit grid, which the sidebar's 16px
 * cell scales to 1.33px — a third heavier than the shipped panel rows, whose
 * glyphs draw on a 16-unit grid at stroke 1 (`ICON_REGULAR_STROKE`). At 1.5
 * the same 16px cell renders exactly 1px, so this row reads at the weight of
 * the Plugins and Schedules rows beside it (issue #12).
 */
const ICON_STROKE_WIDTH = 1.5

/** The statistics icon as a React element, sized by the sidebar's icon share. */
export function StatsIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={STATS_ICON_PATH} />
    </svg>
  )
}
