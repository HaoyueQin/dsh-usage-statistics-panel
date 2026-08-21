/**
 * Number/date formatting helpers for the usage panel — a TS translation of
 * reasonix's usageStatsFormat.ts plus the pure chart helpers from the panel
 * component. The locale is explicit so the helpers stay easy to verify.
 *
 * Pure date/model-ref helpers (`providerOf`, `daysBetween`) are re-exported
 * from the shared zero-dependency module so the host and client halves share
 * one implementation.
 */

export type PanelLocale = 'zh' | 'zh-TW' | 'en'

// Shared with the host half (src/shared.ts has no Node/DOM types, so the
// client bundle may import it at runtime).
export { providerOf, modelNameOf, daysInRange as daysBetween } from '../shared.ts'

/** Compact token formatting following the panel's active language: Chinese
 *  locales get 亿/万 (simplified) or 億/萬 (traditional) units, English gets
 *  the k/M/B chart convention. Small numbers carry no suffix. */
export function formatTokens(n: number, locale: PanelLocale = 'en'): string {
  if (locale === 'en') return formatCompact(n)
  const yi = locale === 'zh' ? '亿' : '億'
  const wan = locale === 'zh' ? '万' : '萬'
  if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 1) + yi
  if (n >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + wan
  return String(n)
}

/** English-style compact (B/M/k) for axis labels and the donut centre. */
export function formatCompact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

export function formatPercent(p: number): string {
  return (Math.round(p * 10) / 10).toFixed(1) + '%'
}

/** Prompt-cache hit ratio as 0..100 from cached/missed input tokens, or null
 *  when there is no usage to judge (0/0). */
export function cacheRate(hit: number, miss: number): number | null {
  const total = hit + miss
  if (total <= 0) return null
  return (hit / total) * 100
}

/** Format a hit ratio for display; no data renders as "—". */
export function cacheRateText(hit: number, miss: number): string {
  const r = cacheRate(hit, miss)
  return r === null ? '—' : formatPercent(r)
}

/** Today's local date (plus/minus offsetDays) in "YYYY-MM-DD". */
export function localDay(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 0 = Monday … 6 = Sunday (GitHub-style heatmap rows). */
export function indexOfDay(day: string): number {
  const d = new Date(day + 'T00:00:00')
  return (d.getDay() + 6) % 7
}

export function shortDay(day: string): string {
  const parts = day.split('-')
  const m = parts[1]
  const d = parts[2]
  return `${Number(m)}/${Number(d)}`
}

/** model refs are "provider/model"; a bare model name has no slash.
 *  (Re-exported from ../shared.ts at the top of this file.) */

/** Build a Catmull-Rom spline through the points (converted to cubic
 *  Beziers) so the hit-rate line reads as a smooth curve across data-less
 *  days instead of breaking into segments. */
export function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return ''
  const first = pts[0]!
  if (pts.length === 1) return `M ${first.x} ${first.y}`
  let d = `M ${first.x} ${first.y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

/** Nice axis ticks: 1/2/5 × 10^k steps covering [step, max]. Non-positive
 *  maxima produce no ticks (guards the log10 against 0/NaN and the loop
 *  against a zero step). */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0) || !(count > 0) || !Number.isFinite(max)) return []
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  if (!(step > 0)) return []
  const out: number[] = []
  for (let v = step; v <= max; v += step) out.push(v)
  return out
}
