/**
 * The "usage statistics" glyph — the lucide BarChart3 icon, used by the
 * sidebar's panel row. Kept as its own module so the path data has a single
 * authority and the SVG stays identical wherever it is rendered.
 */

/** The lucide BarChart3 path data (24x24 stroke icon). */
export const STATS_ICON_PATH = 'M3 3v18h18 M18 17V9 M13 17V5 M8 17v-3'

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
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={STATS_ICON_PATH} />
    </svg>
  )
}
