/**
 * Number/date formatting helpers for the usage panel — a TS translation of
 * reasonix's usageStatsFormat.ts plus the pure chart helpers from the panel
 * component. The locale is explicit so the helpers stay easy to verify.
 */

export type PanelLocale = 'zh' | 'zh-TW' | 'en'

/** Compact number formatting following the panel's active language (Chinese
 *  users get zh-CN compact units instead of leaking English suffixes). */
export function formatUsageTokens(n: number, locale: PanelLocale = 'en'): string {
  const languageTag = locale === 'zh' ? 'zh-CN' : locale === 'zh-TW' ? 'zh-TW' : 'en-US'
  return new Intl.NumberFormat(languageTag, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n)
}

/** Chinese-style compact tokens (亿/万) for the tooltip values. */
export function formatTokens(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + '万'
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

/** Local-calendar date strings (no UTC shift) so the keys match the
 *  backend's "YYYY-MM-DD" day keys. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
  }
  return out
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

/** model refs are "provider/model"; a bare model name has no slash. */
export function providerOf(model: string): string {
  const i = model.indexOf('/')
  if (i > 0) return model.slice(0, i)
  return 'default'
}

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

/** Nice axis ticks: 1/2/5 × 10^k steps covering [step, max]. */
export function niceTicks(max: number, count: number): number[] {
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = step; v <= max; v += step) out.push(v)
  return out
}
