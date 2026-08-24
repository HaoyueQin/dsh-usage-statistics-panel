/**
 * The shared "usage statistics" glyph — the lucide BarChart3 icon. One path
 * authority for both surfaces that show it: the Settings-nav icon
 * (DOM-injected by settings-nav-icon.ts, which cannot use React elements) and
 * the sidebar quick entry (a React component). Keeping the path in one place
 * guarantees the two surfaces always render the identical SVG.
 */

/** The lucide BarChart3 path data (24x24 stroke icon). */
export const STATS_ICON_PATH = 'M3 3v18h18 M18 17V9 M13 17V5 M8 17v-3'

/** The statistics icon as a React element, styled exactly like the DOM-injected one. */
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
