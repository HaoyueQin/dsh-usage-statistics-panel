/**
 * UsageStatsPanel renders the "usage statistics" settings section. It reads
 * the aggregate from the host (via the fenced /usage/api route) and draws
 * three charts by hand in SVG — a GitHub-style activity heatmap, a stacked
 * per-day token trend with a cache hit-rate curve, and a per-model donut +
 * list. No chart library; model colours come from a fixed two-set palette
 * (--dsw-chart-1..5 + the gray --dsw-chart-other, light/dark variants from
 * GitHub Primer's data-viz tokens, defined in this plugin's module css).
 *
 * The panel follows the DSH client conventions: component styles are a CSS
 * Module (hashed class map imported as `css`), interactive atoms use the
 * ui-primitives Button/Input, and every visual value rides the --dsw-alias-*
 * semantic tokens. The functionality replicates the reasonix usage stats
 * feature; the implementation is DSH-native.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import { Activity, CalendarDays, ChevronDown, ChevronRight, Coins, Cpu, MessageSquare, MessagesSquare } from 'lucide-react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DailyTokenUsage, ModelTokenUsage, UsageStatsRange, UsageStatsRequest } from '../wire.ts'
import { fetchRange, UsageApiError } from './api.ts'
import { formatTokens, formatCompact, formatPercent, cacheRate, cacheRateText, daysBetween, localDay, indexOfDay, shortDay, providerOf, smoothPath, niceTicks } from './format.ts'
import type { UsageStatsKey } from './locales.ts'
import type { UsageStatsTranslator } from './index.tsx'
import css from './UsageStatsPanel.module.css'

type Translator = UsageStatsTranslator

const RANGE_PRESETS = ['7', '14', '30', '90'] as const

// The heatmap always shows a fixed window regardless of the range preset.
// The DSH settings pane is much narrower than the reasonix settings modal,
// so the window is 26 weeks (half a year) and the cells cap at 15px — the
// chart must never overflow the container's sides.
const HEAT_WEEKS = 26

/** The trend chart caps its visible window at 180 days (mirrors reasonix). */
const TREND_MAX_DAYS = 180

/** The top-5 models keep a distinct rank colour; everything beyond collapses
 *  into the gray "Other" step. */
const TOP_MODELS = 5
const OTHER_MODEL = '\u0000other' // sentinel; cannot collide with a real model ref
const OTHER_COLOR = 'var(--dsw-chart-other)'

/** Grouped daily rows: the top models stay individual, the tail collapses
 *  into the OTHER_MODEL bucket with the breakdown kept for tooltips. */
type GroupedDaily = DailyTokenUsage & { otherByModel: Record<string, number> }
type GroupedModel = ModelTokenUsage & { items?: ModelTokenUsage[] }

export function UsageStatsPanel({ t }: { t: Translator }): JSX.Element {
  const [range, setRange] = useState<string>('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [stats, setStats] = useState<UsageStatsRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generationRef = useRef(0)

  // Heatmap window: the last HEAT_WEEKS*7 days, fixed regardless of `range`.
  const heatWindow = useMemo(() => {
    const to = localDay(0)
    const from = localDay(-(HEAT_WEEKS * 7 - 1))
    return { from, to }
  }, [])
  const [heatDaily, setHeatDaily] = useState<DailyTokenUsage[]>([])
  const heatGenRef = useRef(0)

  const loadHeat = useCallback(async () => {
    const generation = ++heatGenRef.current
    try {
      const res = await fetchRange({ range: 'custom', from: heatWindow.from, to: heatWindow.to })
      if (heatGenRef.current !== generation) return
      setHeatDaily(res.daily)
    } catch {
      // The heatmap is auxiliary — a failed fetch just leaves the cells empty.
    }
  }, [heatWindow.from, heatWindow.to])

  useEffect(() => {
    void loadHeat()
  }, [loadHeat])

  const load = useCallback(async () => {
    if (range === 'custom' && (!customFrom || !customTo)) return
    const req: UsageStatsRequest =
      range === 'custom'
        ? { range, from: customFrom, to: customTo }
        : { range }
    const generation = ++generationRef.current
    setLoading(true)
    setError('')
    try {
      const res = await fetchRange(req)
      if (generationRef.current !== generation) return // stale response
      setStats(res)
    } catch (e) {
      if (generationRef.current !== generation) return
      setError(e instanceof UsageApiError ? e.message : String(e))
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [range, customFrom, customTo])

  useEffect(() => {
    void load()
  }, [load])

  // Colours follow the order models were first used (walking the daily series
  // chronologically).
  const modelOrder = useMemo(() => {
    const seen: string[] = []
    for (const d of stats?.daily ?? []) {
      for (const m of Object.keys(d.byModel).sort()) {
        if (!seen.includes(m)) seen.push(m)
      }
    }
    for (const m of stats?.models ?? []) {
      if (!seen.includes(m.model)) seen.push(m.model)
    }
    return seen
  }, [stats])

  const colorForModel = useCallback((model: string): string => {
    if (model === OTHER_MODEL) return OTHER_COLOR
    const rank = modelOrder.indexOf(model)
    if (rank >= 0 && rank < TOP_MODELS) return `var(--dsw-chart-${rank + 1})`
    return OTHER_COLOR
  }, [modelOrder])

  // Top-5 grouping: models beyond the top five by token volume collapse into
  // the OTHER_MODEL bucket for the donut and the daily stacks; the per-day
  // breakdown stays available for the tooltip.
  const groupedStats = useMemo<{ models: GroupedModel[]; daily: GroupedDaily[] } | null>(() => {
    if (!stats) return null
    const top = stats.models.slice(0, TOP_MODELS)
    const rest = stats.models.slice(TOP_MODELS)
    const topSet = new Set(top.map((m) => m.model))
    const models: GroupedModel[] = rest.length > 0
      ? [
          ...top,
          {
            model: OTHER_MODEL,
            provider: '',
            tokens: rest.reduce((sum, m) => sum + m.tokens, 0),
            percent: rest.reduce((sum, m) => sum + m.percent, 0),
            items: rest,
          },
        ]
      : top
    const daily: GroupedDaily[] = stats.daily.map((d) => {
      const otherByModel: Record<string, number> = {}
      const byModel: Record<string, number> = {}
      for (const [m, v] of Object.entries(d.byModel)) {
        if (topSet.has(m)) byModel[m] = v
        else otherByModel[m] = v
      }
      const other = Object.values(otherByModel).reduce((sum, v) => sum + v, 0)
      if (other > 0) byModel[OTHER_MODEL] = other
      return { ...d, byModel, otherByModel }
    })
    return { models, daily }
  }, [stats])

  const trendDaily = groupedStats?.daily ?? []
  const trendModels = groupedStats?.models ?? []

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <div className={css.group} role="group" aria-label={t('range')}>
          {RANGE_PRESETS.map((r) => (
            <Button
              key={r}
              size="sm"
              variant="ghost"
              className={clsx(css.segItem, range === r && css.segActive)}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {t(`rangePreset.${r}` as UsageStatsKey)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className={clsx(css.segItem, range === 'custom' && css.segActive)}
            aria-pressed={range === 'custom'}
            onClick={() => setRange('custom')}
          >
            {t('rangeCustom')}
          </Button>
        </div>
        {range === 'custom' && (
          <div className={css.customRange}>
            <Input
              type="date"
              className={css.dateInput}
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label={t('from')}
            />
            <span className={css.customSep}>–</span>
            <Input
              type="date"
              className={css.dateInput}
              value={customTo}
              min={customFrom || undefined}
              max={localDay(0)}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label={t('to')}
            />
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className={css.refresh}
          onClick={() => { void load(); void loadHeat() }}
          disabled={loading}
        >
          {t('refresh')}
        </Button>
      </div>

      {error && <div className={css.errorBanner}>{error}</div>}
      {loading && !stats && <div className={css.loading}>{t('refresh')}…</div>}
      {!loading && stats && (
        <>
          <StatCards stats={stats} t={t} />
          <Heatmap daily={heatDaily} from={heatWindow.from} to={heatWindow.to} t={t} />
          <DailyTrend stats={stats} models={trendModels} daily={trendDaily} t={t} colorForModel={colorForModel} />
          <ModelUsage models={trendModels} t={t} colorForModel={colorForModel} />
          {stats.to && (
            <div className={css.foot}>
              {t('asOf')} {stats.to}
            </div>
          )}
        </>
      )}
      {!loading && !error && stats && stats.tokens === 0 && (
        <div className={css.empty}>{t('empty')}</div>
      )}
    </div>
  )
}

// ── Section 2+3: numeric cards ────────────────────────────────────────────

function StatCards({ stats, t }: { stats: UsageStatsRange; t: Translator }) {
  const topModel = stats.topModel || '—'
  const cards: Array<{ icon: typeof Coins; label: string; value: string; sm?: boolean; wrap?: boolean; hint?: string }> = [
    { icon: Coins, label: t('tokens'), value: formatTokens(stats.tokens) },
    { icon: MessageSquare, label: t('sessions'), value: String(stats.turns) },
    { icon: MessagesSquare, label: t('requests'), value: String(stats.requests) },
    { icon: CalendarDays, label: t('activeDays'), value: String(stats.activeDays) },
    { icon: Activity, label: t('cacheRate'), value: cacheRateText(stats.cacheHit, stats.cacheMiss), hint: t('cacheRateHint') },
    { icon: Cpu, label: t('topModel'), value: topModel, sm: true, wrap: true, hint: t('topModelHint') },
  ]
  return (
    <div className={css.cards}>
      {cards.map((c) => (
        <div className={css.card} key={c.label} title={c.hint}>
          <div className={css.cardHead}>
            <c.icon className={css.cardIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.cardLabel}>{c.label}</span>
          </div>
          {c.wrap ? (
            <div className={clsx(css.cardValue, css.cardValueSm, css.cardValueWrap)}>{c.value}</div>
          ) : (
            <FitText
              text={c.value}
              className={clsx(css.cardValue, c.sm && css.cardValueSm)}
              maxSize={c.sm ? 14 : 22}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// FitText renders `text` on a single line, shrinking the font until it fits
// the card width (long token numbers never overflow or wrap).
function FitText({ text, className, maxSize }: { text: string; className?: string; maxSize: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(maxSize)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      let s = maxSize
      el.style.fontSize = `${s}px`
      while (el.scrollWidth > el.clientWidth + 1 && s > 11) {
        s -= 0.5
        el.style.fontSize = `${s}px`
      }
      setSize(s)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, maxSize])

  return (
    <div ref={ref} className={className} style={{ fontSize: size }}>
      {text}
    </div>
  )
}

// ── Section 4: GitHub-style activity heatmap ──────────────────────────────

const HEAT_BASE = 12 // cell size at which column trimming starts
const HEAT_GAP = 2 // tight inter-cell gap (a large gap reads as scattered tiles)

function Heatmap({ daily, from, to, t }: { daily: DailyTokenUsage[]; from: string; to: string; t: Translator }) {
  const [tip, setTip] = useState<{ day: string; tokens: number; requests: number; cacheHit: number; cacheMiss: number; x: number; top: number; bottom: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [geom, setGeom] = useState<{ size: number; cols: number }>({ size: HEAT_BASE, cols: HEAT_WEEKS })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth - 2)
      const baseCols = Math.max(1, Math.floor((avail + HEAT_GAP) / (HEAT_BASE + HEAT_GAP)))
      let next: { size: number; cols: number }
      if (baseCols >= HEAT_WEEKS) {
        const so = (indexOfDay(from) + 1) % 7
        const totalWeeks = Math.ceil((HEAT_WEEKS * 7 + so) / 7)
        // Cells grow to fill the full container width — the chart spans edge
        // to edge (no right-hand gap), clamped by the wrap's own width.
        const size = Math.max(HEAT_BASE, avail / totalWeeks - HEAT_GAP)
        next = { size, cols: HEAT_WEEKS }
      } else {
        // Too narrow for the full window at the base size: keep the newest
        // columns at the base size and trim the earliest ones.
        next = { size: HEAT_BASE, cols: baseCols }
      }
      // Only commit when the geometry actually changed — the heatmap SVG
      // width follows `geom.size`, and committing an identical value on
      // every ResizeObserver callback would feed a render loop and jitter.
      setGeom((prev) => (prev.size === next.size && prev.cols === next.cols ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [from])

  const byDay = new Map<string, DailyTokenUsage>()
  for (const d of daily) byDay.set(d.day, d)
  const allDays = daysBetween(from, to)
  if (allDays.length === 0) return null
  const days = allDays.slice(-Math.min(geom.cols * 7, allDays.length))
  const max = Math.max(1, ...days.map((d) => byDay.get(d)?.total ?? 0))

  const rows = 7
  const startOffset = days[0] ? (indexOfDay(days[0]) + 1) % 7 : 0
  const weeks = Math.max(1, Math.ceil((days.length + startOffset) / 7))
  // Tooltip is absolute inside the relative wrap: clamp to the wrap's own
  // width so it never overflows the chart (reasonix behaviour).
  const wrapW = wrapRef.current?.clientWidth ?? 400
  const TIP_W = 240
  const tipX = tip ? Math.max(TIP_W / 2 + 8, Math.min(tip.x, wrapW - TIP_W / 2 - 8)) : 0
  const tipH = 96
  const tipAbove = tip ? tip.top >= tipH + 10 : true
  const tipY = tip ? (tipAbove ? tip.top - 10 : tip.bottom + 10) : 0

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('heatmap')}</h3>
        <div className={css.heatLegend}>
          <span>{t('heatLess')}</span>
          <i className={clsx(css.heatCell, css.heatLevel1)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel2)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel3)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel4)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel5)} style={{ width: geom.size, height: geom.size }} />
          <span>{t('heatMore')}</span>
        </div>
      </div>
      <div className={css.heatWrap} ref={wrapRef}>
        <svg className={css.heatmap} width={weeks * (geom.size + HEAT_GAP) + HEAT_GAP} height={rows * (geom.size + HEAT_GAP) + HEAT_GAP} role="img" aria-label={t('heatmap')}>
          {days.map((day, i) => {
            const col = Math.floor((i + startOffset) / 7)
            const row = (i + startOffset) % 7
            const rec = byDay.get(day)
            const tokens = rec?.total ?? 0
            const level = tokens === 0 ? 0 : 1 + Math.floor((tokens / max) * 4)
            const x = HEAT_GAP + col * (geom.size + HEAT_GAP)
            const y = HEAT_GAP + row * (geom.size + HEAT_GAP)
            return (
              <rect
                key={day}
                className={clsx(css.heatCell, level === 0 && css.heatLevel0, level === 1 && css.heatLevel1, level === 2 && css.heatLevel2, level === 3 && css.heatLevel3, level === 4 && css.heatLevel4, level === 5 && css.heatLevel5)}
                x={x}
                y={y}
                width={geom.size}
                height={geom.size}
                rx={Math.max(1.5, geom.size * 0.2)}
                onMouseEnter={(e) => {
                  const wrap = wrapRef.current
                  if (!wrap) return
                  const wr = wrap.getBoundingClientRect()
                  const r = e.currentTarget.getBoundingClientRect()
                  // Wrap-relative coords for the absolute-positioned tooltip.
                  setTip({ day, tokens, requests: rec?.requests ?? 0, cacheHit: rec?.cacheHit ?? 0, cacheMiss: rec?.cacheMiss ?? 0, x: r.left + r.width / 2 - wr.left, top: r.top - wr.top, bottom: r.bottom - wr.top })
                }}
                onMouseLeave={() => setTip(null)}
              />
            )
          })}
        </svg>
        {tip && (
          <div className={css.tip} style={{ transform: `translate(${tipX}px, ${tipY}px) translate(-50%, ${tipAbove ? '-100%' : '0'})` }}>
            <div className={css.tipTitle}>{tip.day}</div>
            <div>{t('tokens')}: {formatTokens(tip.tokens)}</div>
            <div>{t('requests')}: {tip.requests}</div>
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Section 5: stacked daily token trend ──────────────────────────────────

function DailyTrend({ stats, models, daily, t, colorForModel }: { stats: UsageStatsRange; models: GroupedModel[]; daily: GroupedDaily[]; t: Translator; colorForModel: (m: string) => string }) {
  const [tip, setTip] = useState<{ day: string; total: number; byModel: Record<string, number>; otherByModel?: Record<string, number>; cacheHit: number; cacheMiss: number; cx: number; top: number; bottom: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const W = 720
  const H = 220
  const padL = 46
  const padR = 65
  const padB = 26
  const padT = 10
  const plotH = H - padT - padB
  const MIN_COL = 14

  const [view, setView] = useState<{ avail: number; trimN: number | null }>({ avail: W, trimN: null })

  useEffect(() => {
    const el = wrapRef.current
    if (!el || daily.length === 0) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth)
      let next: { avail: number; trimN: number | null }
      if (avail >= W) {
        next = { avail, trimN: null }
      } else {
        const maxN = Math.max(1, Math.floor((avail - padL - padR) / MIN_COL) + 1)
        next = { avail, trimN: Math.min(daily.length, maxN) }
      }
      setView((prev) => (prev.avail === next.avail && prev.trimN === next.trimN ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [daily.length])

  if (daily.length === 0) return null

  const visible = view.trimN !== null ? daily.slice(-Math.min(view.trimN, TREND_MAX_DAYS)) : daily.slice(-TREND_MAX_DAYS)
  const trendCapped = daily.length > TREND_MAX_DAYS
  const n = visible.length
  const step =
    n > 1
      ? view.trimN !== null
        ? MIN_COL
        : (view.avail - padL - padR) / (n - 1)
      : Math.max(1, view.avail - padL - padR)
  const barW = Math.max(3, Math.min(30, step * 0.62))
  const barHalf = barW / 2
  const plotWUsed = view.trimN !== null ? padL + (n - 1) * step + barW + padR : view.avail
  const maxTotal = Math.max(1, ...visible.map((d) => d.total))
  const ticks = niceTicks(maxTotal, 4)

  const trendPoints: Array<{ x: number; y: number }> = []
  const trendPointByDay = new Map<string, { x: number; y: number }>()
  visible.forEach((d, i) => {
    const rate = cacheRate(d.cacheHit, d.cacheMiss)
    if (rate === null) return
    const pt = { x: padL + barHalf + i * step, y: padT + plotH - (rate / 100) * plotH }
    trendPoints.push(pt)
    trendPointByDay.set(d.day, pt)
  })
  const trendPath = smoothPath(trendPoints)
  const trendTipPt = tip ? trendPointByDay.get(tip.day) : undefined
  const rateTicks = [0, 25, 50, 75, 100]

  // Legend and bar stacks follow the overall usage ranking (not the per-day
  // leader), so a model's colour stays in the same position every day and the
  // aggregated "Other" step always sits on top.
  const legendAgg = aggregateByModel(daily)
  const legendModels = modelOrderOf(models, legendAgg)

  // Tooltip is absolute inside the relative wrap: clamp to the wrap width so
  // it never overflows the chart (reasonix behaviour).
  const wrapW = wrapRef.current?.clientWidth ?? 720
  const TIP_W = 260
  const tipX = tip ? Math.max(TIP_W / 2 + 8, Math.min(tip.cx, wrapW - TIP_W / 2 - 8)) : 0
  const tipRows = tip ? Object.keys(tip.byModel).length + 1 + (tip.otherByModel ? Object.keys(tip.otherByModel).length : 0) : 0
  const tipH = 46 + 18 * tipRows
  const tipAbove = tip ? tip.top >= tipH + 10 : true
  let tipY = tip ? (tipAbove ? tip.top - 10 : tip.bottom + 10) : 0
  if (tip && !tipAbove && tipY + tipH > (wrapRef.current?.clientHeight ?? 220) - 8) tipY = tip.top - 10

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('dailyTrend')}</h3>
        {trendCapped && <span className={css.trendNote}>{t('trendLimited')}</span>}
      </div>
      <div className={css.chartWrap} ref={wrapRef}>
        <svg className={css.chart} width="100%" height={H} viewBox={`0 0 ${plotWUsed} ${H}`} onMouseLeave={() => { setTip(null); setHover(null) }}>
          {ticks.map((tk) => {
            const y = padT + plotH - (tk / maxTotal) * plotH
            return (
              <g key={tk}>
                <line className={css.grid} x1={padL} y1={y} x2={padL + (n - 1) * step + barW} y2={y} />
                <text className={css.axis} x={padL - 6} y={y + 3} textAnchor="end">{formatCompact(tk)}</text>
              </g>
            )
          })}
          {visible.map((d, i) => {
            const x = padL + barHalf + i * step - barW / 2
            const dayOrder = legendModels.filter((m) => d.byModel[m] !== undefined)
            let yBottom = padT + plotH
            const bars = dayOrder.map((model) => {
              const tokens = d.byModel[model]!
              const h = (tokens / maxTotal) * plotH
              const y = yBottom - h
              yBottom = y
              return { model, tokens, x, y, h, color: colorForModel(model), dimmed: hover !== null && hover !== model }
            })
            const hovered = tip?.day === d.day
            return (
              <g key={d.day}>
                {bars.map((b) => (
                  <rect
                    key={`${d.day}-${b.model}`}
                    className={clsx(css.bar, b.dimmed && css.barDim)}
                    x={b.x}
                    y={b.y}
                    width={barW}
                    height={b.h}
                    fill={b.color}
                    style={hovered ? { transform: `scaleX(${(barW + 3) / barW})` } : undefined}
                  />
                ))}
                <rect
                  className={css.barHit}
                  x={x}
                  y={padT}
                  width={barW}
                  height={plotH}
                  onMouseEnter={(e) => {
                    const wrap = wrapRef.current
                    if (!wrap) return
                    const wr = wrap.getBoundingClientRect()
                    const r = e.currentTarget.getBoundingClientRect()
                    // Wrap-relative coords for the absolute-positioned tooltip.
                    setTip({ day: d.day, total: d.total, byModel: d.byModel, otherByModel: d.otherByModel, cacheHit: d.cacheHit, cacheMiss: d.cacheMiss, cx: r.left + r.width / 2 - wr.left, top: r.top - wr.top, bottom: r.bottom - wr.top })
                  }}
                  onMouseLeave={() => setTip(null)}
                />
                {(i % Math.max(1, Math.floor(n / 8)) === 0 || i === n - 1) && (
                  <text className={css.axis} x={padL + barHalf + i * step} y={H - 8} textAnchor="middle">{shortDay(d.day)}</text>
                )}
              </g>
            )
          })}
          <path className={css.trend} d={trendPath} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {trendTipPt && (
            <circle className={css.trendDot} cx={trendTipPt.x} cy={trendTipPt.y} r={4} />
          )}
          {rateTicks.map((p) => {
            const y = padT + plotH - (p / 100) * plotH
            return (
              <g key={`rate-${p}`}>
                <text className={clsx(css.axis, css.axisRate)} x={padL + (n - 1) * step + barW + 8} y={y + 3}>{p}%</text>
              </g>
            )
          })}
        </svg>
        {tip && (
          <div className={css.tip} style={{ transform: `translate(${tipX}px, ${tipY}px) translate(-50%, ${tipAbove ? '-100%' : '0'})` }}>
            <div className={css.tipTitle}>{tip.day}</div>
            <div>{t('total')}: {formatTokens(tip.total)}</div>
            {legendModels.filter((m) => tip.byModel[m] !== undefined).map((m) => (
              <div key={m} className={css.tipRow}><i className={css.legendSwatch} style={{ background: colorForModel(m) }} />{m === OTHER_MODEL ? t('other') : m}: {formatTokens(tip.byModel[m]!)}</div>
            ))}
            {tip.otherByModel && Object.entries(tip.otherByModel).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className={clsx(css.tipRow, css.tipRowOther)}><i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />{m}: {formatTokens(v)}</div>
            ))}
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </div>
        )}
        <div className={css.legend}>
          {legendModels.map((model) => (
            <span key={model} className={css.legendItem} onMouseEnter={() => setHover(model)} onMouseLeave={() => setHover(null)}>
              <i className={css.legendSwatch} style={{ background: colorForModel(model) }} />
              {model === OTHER_MODEL ? t('other') : model}
            </span>
          ))}
          <span className={css.legendItem} aria-hidden="true">
            <i className={clsx(css.legendSwatch, css.legendTrend)} />
            {t('hitRateLegend')}
          </span>
        </div>
      </div>
    </section>
  )
}

// ── Section 6: per-model donut + list ─────────────────────────────────────

function ModelUsage({ models, t, colorForModel }: { models: GroupedModel[]; t: Translator; colorForModel: (m: string) => string }) {
  const [tip, setTip] = useState<{ model: string; tokens: number; percent: number; x: number; y: number; items?: ModelTokenUsage[] } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [expandedOther, setExpandedOther] = useState(false)
  const donutRef = useRef<HTMLDivElement>(null)

  if (models.length === 0) return null
  const other = models.find((m) => m.model === OTHER_MODEL)

  // The ring leaves a margin inside the fixed 240px viewBox at rest, so the
  // hover-grow of the stroke never overflows into a clipped square.
  const OUTER = 114
  const SW = 36
  const R = OUTER - SW / 2
  const CX = 120
  const CIRC = 2 * Math.PI * R
  const total = Math.max(1, models.reduce((sum, m) => sum + m.tokens, 0))
  let offset = 0

  const tipAbove = tip ? tip.y >= 100 : true
  const tipY = tip ? (tipAbove ? tip.y - 14 : tip.y + 14) : 0

  // Tooltip is absolute inside the relative donut wrap: clamp to the wrap's
  // own size (reasonix behaviour).
  const dw = donutRef.current?.clientWidth ?? 240
  const donutTipW = 240
  const donutTipX = tip ? Math.max(donutTipW / 2 + 8, Math.min(tip.x, dw - donutTipW / 2 - 8)) : 0

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('modelUsage')}</h3>
      <div className={css.models}>
        <div className={css.donutWrap} ref={donutRef}>
          <svg className={css.donut} width={CX * 2} height={CX * 2} viewBox={`0 0 ${CX * 2} ${CX * 2}`} role="img" aria-label={t('modelUsage')}>
            <circle className={css.donutTrack} cx={CX} cy={CX} r={R} fill="none" strokeWidth={SW} />
            {models.map((m) => {
              const frac = m.tokens / total
              const dash = frac * CIRC
              const active = hover === m.model || tip?.model === m.model
              const el = (
                <circle
                  key={m.model}
                  className={clsx(css.donutSeg, hover !== null && !active && css.donutDim)}
                  cx={CX}
                  cy={CX}
                  r={R}
                  fill="none"
                  stroke={colorForModel(m.model)}
                  strokeDasharray={`${dash} ${CIRC - dash}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${CX} ${CX})`}
                  style={{ strokeWidth: active ? SW + 5 : SW, transition: 'stroke-width 0.12s ease' }}
                  onMouseEnter={(e) => {
                    const dw = donutRef.current
                    setHover(m.model)
                    if (!dw) return
                    const dr = dw.getBoundingClientRect()
                    // Wrap-relative coords for the absolute-positioned tooltip.
                    setTip({ model: m.model, tokens: m.tokens, percent: m.percent, x: e.clientX - dr.left, y: e.clientY - dr.top, items: m.items })
                  }}
                  onMouseLeave={() => { setHover(null); setTip(null) }}
                />
              )
              offset += dash
              return el
            })}
            <text className={css.donutCenter} x={CX} y={CX + 8} textAnchor="middle">{formatCompact(total)}</text>
            <text className={css.donutLabel} x={CX} y={CX + 26} textAnchor="middle">{t('tokens')}</text>
          </svg>
          {tip && (
            <div className={css.tip} style={{ transform: `translate(${donutTipX}px, ${tipY}px) translate(-50%, ${tipAbove ? '-100%' : '0'})` }}>
              <div className={css.tipTitle}>{tip.model === OTHER_MODEL ? t('other') : tip.model}</div>
              <div>{t('total')}: {formatTokens(tip.tokens)}</div>
              <div>{t('percent')}: {formatPercent(tip.percent)}</div>
              {tip.items && tip.items.length > 0 && (
                <div className={css.tipBreakdown}>
                  {tip.items.map((it) => (
                    <div key={it.model} className={clsx(css.tipRow, css.tipRowOther)}><i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />{it.model}: {formatTokens(it.tokens)}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <ul className={css.modelList}>
          {models.map((m) => {
            const isOther = m.model === OTHER_MODEL
            return (
              <li
                key={m.model}
                className={clsx(css.modelRow, isOther && css.modelRowExpandable)}
                onMouseEnter={() => setHover(m.model)}
                onMouseLeave={() => setHover(null)}
                {...(isOther
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => setExpandedOther(!expandedOther),
                      onKeyDown: (e: ReactKeyboardEvent<HTMLLIElement>) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpandedOther(!expandedOther)
                        }
                      },
                    }
                  : {})}
              >
                <i className={css.legendSwatch} style={{ background: colorForModel(m.model) }} />
                <span className={css.modelName}>
                  {isOther && (
                    <button
                      type="button"
                      className={css.modelToggle}
                      onClick={(e) => { e.stopPropagation(); setExpandedOther(!expandedOther) }}
                      aria-expanded={expandedOther}
                      aria-label={t('other')}
                    >
                      {expandedOther ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  )}
                  {isOther ? t('other') : m.model}
                </span>
                <span className={css.modelProvider}>{isOther ? '' : providerOf(m.model)}</span>
                <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                <span className={css.modelPct}>{formatPercent(m.percent)}</span>
              </li>
            )
          })}
          {other?.items && other.items.length > 0 && (
            <li className={clsx(css.modelOtherWrap, expandedOther && css.modelOtherOpen)}>
              <ul className={css.modelOtherList}>
                {other.items.map((it) => (
                  <li key={it.model} className={clsx(css.modelRow, css.modelRowSub)}>
                    <i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />
                    <span className={css.modelName}>{it.model}</span>
                    <span className={css.modelProvider}>{providerOf(it.model)}</span>
                    <span className={css.modelTokens}>{formatTokens(it.tokens)}</span>
                    <span className={css.modelPct}>{formatPercent(it.percent)}</span>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────

function aggregateByModel(daily: Array<{ byModel: Record<string, number> }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of daily) {
    for (const [m, v] of Object.entries(d.byModel)) out[m] = (out[m] ?? 0) + v
  }
  return out
}

/** The legend model order follows the overall usage ranking, with the Other
 *  bucket pinned last (it sits on top of the stacks). */
function modelOrderOf(models: GroupedModel[], dailyAgg: Record<string, number>): string[] {
  const ranked = models
    .filter((m) => m.model !== OTHER_MODEL && dailyAgg[m.model] !== undefined)
    .map((m) => m.model)
  if (models.some((m) => m.model === OTHER_MODEL)) ranked.push(OTHER_MODEL)
  return ranked
}
