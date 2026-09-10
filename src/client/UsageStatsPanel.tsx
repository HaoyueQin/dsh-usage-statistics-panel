/**
 * UsageStatsPanel renders the "usage statistics" settings section. It reads
 * the aggregate from the host (via the fenced /usage/api route) and draws
 * every chart by hand in SVG — a GitHub-style activity heatmap, a stacked
 * per-day token trend with a cache hit-rate curve, and two ranked sections
 * (models and providers) that each pair a stacked column with a detail list.
 * No chart library; colours come from a fixed two-series palette
 * (--dsw-chart-1..10 + the gray --dsw-chart-other for models,
 * --dsw-provider-1..5 + the gray --dsw-provider-other for providers, the
 * reasonix usage-stats palette with a lifted dark variant, defined in this
 * plugin's module css).
 *
 * The panel follows the DSH client conventions: component styles are a CSS
 * Module (hashed class map imported as `css`), interactive atoms use the
 * ui-primitives Button/Input, and every visual value rides the --dsw-alias-*
 * semantic tokens. The functionality replicates the reasonix usage stats
 * feature; the implementation is DSH-native.
 */
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import clsx from 'clsx'
import { Activity, CalendarDays, ChevronDown, ChevronRight, Coins, Cpu, MessageSquare, MessagesSquare } from 'lucide-react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DailyTokenUsage, ModelTokenUsage, ProviderTokenUsage, UsageStatsRange, UsageStatsRequest } from '../wire.ts'
import { fetchRange, UsageApiError } from './api.ts'
import { ChartTip } from './ChartTip.tsx'
import { StackedBar, useCollapsedHeight } from './StackedBar.tsx'
import { formatTokens, formatCompact, formatPercent, cacheRate, cacheRateText, daysBetween, localDay, indexOfDay, shortDay, providerOf, modelNameOf, smoothPath, niceTicks } from './format.ts'
import type { UsageStatsKey } from './locales.ts'
import type { UsageStatsTranslator } from './index.tsx'
import { sidebarEntryState } from './sidebar-entry-state.ts'
import { statsLineState } from './stats-line-state.ts'
import css from './UsageStatsPanel.module.css'

type Translator = UsageStatsTranslator

const RANGE_PRESETS = ['7', '14', '30', '90'] as const

// The heatmap always shows a fixed window regardless of the range preset.
// The DSH settings pane is much narrower than the reasonix settings modal,
// so the window is 26 weeks (half a year) and the cells cap at 16px — the
// chart must never overflow the container's sides.
const HEAT_WEEKS = 26

/** The trend chart caps its visible window at 180 days (mirrors reasonix). */
const TREND_MAX_DAYS = 180

/** The top-10 models keep a distinct rank colour; everything beyond collapses
 *  into the gray "Other" step. */
const TOP_MODELS = 10
const OTHER_MODEL = '\u0000other' // sentinel; cannot collide with a real model ref
const OTHER_COLOR = 'var(--dsw-chart-other)'

/** The top-5 providers keep a distinct rank colour from the provider series;
 *  everything beyond collapses into the gray "Other" step, mirroring the
 *  model chart's shape at the provider dimension. */
const TOP_PROVIDERS = 5
const OTHER_PROVIDER = '\u0000pother' // sentinel; cannot collide with a real provider name
const OTHER_PROVIDER_COLOR = 'var(--dsw-provider-other)'

/** Shared empty key set: one stable identity for a collapsed expand state. */
const NO_KEYS: ReadonlySet<string> = new Set()

/** Grouped daily rows: the top models stay individual, the tail collapses
 *  into the OTHER_MODEL bucket with the breakdown kept for tooltips. */
type GroupedDaily = DailyTokenUsage & { otherByModel: Record<string, number> }
type GroupedModel = ModelTokenUsage & { items?: ModelTokenUsage[] }
/** A provider folded into the aggregated Other bucket, carrying the models it
 *  served so its own row can open that breakdown. */
type FoldedProvider = ProviderTokenUsage & { models: ModelTokenUsage[] }
/** One provider row: its own volume plus every model it served, so the hover
 *  tip and the expandable detail list show the breakdown behind the number.
 *  The Other row additionally carries the providers it folded, so opening it
 *  lists PROVIDERS — their models sit one level further down, behind each of
 *  those rows, not flattened into this one. */
type GroupedProvider = ProviderTokenUsage & {
  models: ModelTokenUsage[]
  /** Folded providers behind the Other bucket; absent on a ranked row. */
  folded?: FoldedProvider[]
}

export function UsageStatsPanel({ t }: { t: Translator }): JSX.Element {
  const [range, setRange] = useState<string>('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [stats, setStats] = useState<UsageStatsRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generationRef = useRef(0)
  // The panel bounds the chart tooltips: a tip must never leave the settings
  // panel even when the hovered cell sits near its edge.
  const panelRef = useRef<HTMLDivElement>(null)

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

  // A model's colour is its TOKEN rank (the host returns `models` sorted by
  // token volume), matching reasonix: rank 1..10 take --dsw-chart-1..10 and the
  // aggregated tail is the gray --dsw-chart-other. First-seen order would
  // scramble the rank colours (the top model could lose its blue, and a
  // top-10 model could fall into the gray bucket), so the rank is looked up in
  // `stats.models`, never in the daily walk.
  const colorForModel = useCallback((model: string): string => {
    if (model === OTHER_MODEL) return OTHER_COLOR
    const slot = (stats?.models ?? []).findIndex((m) => m.model === model)
    const rank = Math.min(slot < 0 ? 0 : slot, TOP_MODELS - 1) + 1
    return `var(--dsw-chart-${rank})`
  }, [stats])

  // Top-10 grouping: models beyond the top ten by token volume collapse into
  // the OTHER_MODEL bucket for the bar and the daily stacks; the per-day
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

  // Provider colours are the provider's own rank — a palette separate from the
  // model series, so a provider never wears a model's hue.
  const providerRank = useMemo(
    () => (stats?.providers ?? []).filter((p) => p.tokens > 0).slice(0, TOP_PROVIDERS).map((p) => p.provider),
    [stats],
  )
  const colorForProvider = useCallback((provider: string): string => {
    if (provider === OTHER_PROVIDER) return OTHER_PROVIDER_COLOR
    const slot = providerRank.indexOf(provider)
    return `var(--dsw-provider-${Math.min(slot < 0 ? 0 : slot, TOP_PROVIDERS - 1) + 1})`
  }, [providerRank])

  // Top-5 providers by token volume with the tail aggregated into one gray
  // bucket. Providers carrying no tokens in the range are dropped: a
  // request-only provider (calls that produced nothing) has no usage to rank.
  const groupedProviders = useMemo<GroupedProvider[] | null>(() => {
    if (!stats) return null
    const modelsOf = new Map<string, ModelTokenUsage[]>()
    for (const m of stats.models) {
      const list = modelsOf.get(m.provider)
      if (list === undefined) modelsOf.set(m.provider, [m])
      else list.push(m)
    }
    const ranked = stats.providers.filter((p) => p.tokens > 0)
    const top = ranked.slice(0, TOP_PROVIDERS)
    // The tail keeps its own rows (each with the models it served) instead of
    // being flattened into one model list: the Other bucket stands for
    // PROVIDERS, and expanding it must answer "which providers, and how much
    // each" before "which models".
    const folded: FoldedProvider[] = ranked
      .slice(TOP_PROVIDERS)
      .map((p) => ({ ...p, models: modelsOf.get(p.provider) ?? [] }))
    const out: GroupedProvider[] = top.map((p) => ({ ...p, models: modelsOf.get(p.provider) ?? [] }))
    if (folded.length > 0) {
      out.push({
        provider: OTHER_PROVIDER,
        tokens: folded.reduce((sum, p) => sum + p.tokens, 0),
        percent: folded.reduce((sum, p) => sum + p.percent, 0),
        models: folded.flatMap((p) => p.models),
        folded,
      })
    }
    return out
  }, [stats])

  const trendDaily = groupedStats?.daily ?? []
  const trendModels = groupedStats?.models ?? []

  return (
    <div className={css.panel} ref={panelRef}>
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
      {loading && !stats && <div className={css.loading}>{t('loading')}…</div>}
      {/* Content stays mounted across refreshes (stats keeps its last value):
          only the FIRST load shows the spinner, so a range switch or a manual
          refresh never blanks the whole data area. */}
      {stats && (
        <>
          <StatCards stats={stats} t={t} />
          <Heatmap daily={heatDaily} from={heatWindow.from} to={heatWindow.to} t={t} panelRef={panelRef} />
          <DailyTrend models={trendModels} daily={trendDaily} t={t} colorForModel={colorForModel} panelRef={panelRef} />
          <ModelUsage models={trendModels} t={t} colorForModel={colorForModel} panelRef={panelRef} />
          <ProviderUsage providers={groupedProviders ?? []} t={t} colorForProvider={colorForProvider} panelRef={panelRef} />
          {stats.to && (
            <div className={css.foot}>
              {t('asOf')} {stats.to}
            </div>
          )}
        </>
      )}
      {!error && stats && isEmptyRange(stats) && (
        <div className={css.empty}>{t('empty')}</div>
      )}
      <div className={css.prefGroup}>
        <EntryOption t={t} />
        <StatsLineOptions t={t} />
      </div>
    </div>
  )
}

// ── Section 2+3: numeric cards ────────────────────────────────────────────

/** A range is empty only when NOTHING was recorded in it: a pure-cache day
 *  (zero input/output but real cache hits) or a failed-call day (requests
 *  but no tokens) both carry real usage and must not read as "no data". */
function isEmptyRange(stats: UsageStatsRange): boolean {
  return stats.tokens === 0 && stats.cacheHit === 0 && stats.requests === 0 && stats.turns === 0
}

// ── Sidebar quick-entry preference ────────────────────────────────────────

/**
 * One framed preference row: title + subtitle on the left, the switch on the
 * right. The switch mirrors the official DSH switch (role=switch, track +
 * thumb); the shared store keeps the settings row and the consumer in sync
 * instantly because both run in the same client bundle.
 */
function SettingToggle({ title, desc, checked, ariaLabel, onChange }: {
  title: string
  desc: string
  checked: boolean
  ariaLabel: string
  onChange: (next: boolean) => void
}) {
  // One description id per row; the switch names it so a screen reader
  // announces the explanation alongside the title.
  const descId = useId()
  return (
    <div className={css.prefRow}>
      <div className={css.entryOptionText}>
        <div className={css.entryOptionTitle}>{title}</div>
        <div className={css.entryOptionDesc} id={descId}>{desc}</div>
      </div>
      <button
        type="button"
        className={css.switch}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-describedby={descId}
        onClick={() => { onChange(!checked) }}
      >
        <span className={css.switchTrack} data-on={checked || undefined} aria-hidden="true">
          <span className={css.switchThumb} />
        </span>
      </button>
    </div>
  )
}

/**
 * The framed preference at the bottom of the panel: toggling it shows a
 * "Usage statistics" shortcut above the Settings button in the left sidebar.
 */
function EntryOption({ t }: { t: Translator }) {
  const [enabled, setEnabled] = useState(sidebarEntryState.enabled)
  useEffect(() => sidebarEntryState.subscribe(() => { setEnabled(sidebarEntryState.enabled) }), [])
  return (
    <SettingToggle
      title={t('sidebarEntry')}
      desc={t('sidebarEntryDesc')}
      checked={enabled}
      ariaLabel={t('sidebarEntry')}
      onChange={(next) => { sidebarEntryState.setEnabled(next) }}
    />
  )
}

/**
 * The two bottom-bar enhancement preferences, below the sidebar entry:
 * "Precise cache hit rate" (two decimals on the usage pill and dialog) and
 * "Session token breakdown" (an extra cache-miss row in the usage dialog).
 */
function StatsLineOptions({ t }: { t: Translator }) {
  const [cachePrecision, setCachePrecision] = useState(statsLineState.cachePrecision)
  const [tokenDetail, setTokenDetail] = useState(statsLineState.tokenDetail)
  useEffect(() => statsLineState.subscribe(() => {
    setCachePrecision(statsLineState.cachePrecision)
    setTokenDetail(statsLineState.tokenDetail)
  }), [])
  return (
    <>
      <SettingToggle
        title={t('cachePrecision')}
        desc={t('cachePrecisionDesc')}
        checked={cachePrecision}
        ariaLabel={t('cachePrecision')}
        onChange={(next) => { statsLineState.setCachePrecision(next) }}
      />
      <SettingToggle
        title={t('tokenDetail')}
        desc={t('tokenDetailDesc')}
        checked={tokenDetail}
        ariaLabel={t('tokenDetail')}
        onChange={(next) => { statsLineState.setTokenDetail(next) }}
      />
    </>
  )
}

function StatCards({ stats, t }: { stats: UsageStatsRange; t: Translator }) {
  const cards: Array<{ icon: typeof Coins; label: string; value: string; sm?: boolean; wrap?: boolean; hint?: string; modelRef?: boolean; sub?: string }> = [
    // The headline is provider-inclusive (uncached input + output + cached
    // tokens) — the number a provider dashboard reports for the same calls.
    { icon: Coins, label: t('tokens'), value: formatTokens(stats.tokens), hint: t('tokensHint') },
    { icon: MessageSquare, label: t('sessions'), value: String(stats.turns) },
    { icon: MessagesSquare, label: t('requests'), value: String(stats.requests) },
    // The two long-valued cards (tokens, top model) bookend the grid's first
    // column: tokens leads row one, the model name leads row two directly
    // under it — both get the wide track, the four short numerics fill the
    // rest (mirrors the reasonix card sizing).
    { icon: Cpu, label: t('topModel'), value: stats.topModel || '—', hint: t('topModelHint'), modelRef: true },
    {
      icon: Activity,
      label: t('cacheRate'),
      value: cacheRateText(stats.cacheHit, stats.cacheMiss),
      hint: t('cacheRateHint'),
      // The absolute cached volume lives under the percentage: the rate
      // alone hides how many tokens the cache actually served.
      sub: `${formatCompact(stats.cacheHit)} ${t('cachedTokens')}`,
    },
    { icon: CalendarDays, label: t('activeDays'), value: String(stats.activeDays) },
  ]
  return (
    <div className={css.cards}>
      {cards.map((c) => (
        <div className={css.card} key={c.label} title={c.hint}>
          <div className={css.cardHead}>
            <c.icon className={css.cardIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.cardLabel}>{c.label}</span>
          </div>
          {c.modelRef ? (
            // The model card mirrors the per-model list rows: model name on
            // line one, provider on line two in the muted small style — not
            // the raw "provider/model" ref.
            <div className={clsx(css.cardValue, css.cardValueSm, css.cardModelLines)}>
              {stats.topModel ? (
                <>
                  <span className={css.modelName}>{modelNameOf(stats.topModel)}</span>
                  <span className={css.modelProvider}>{providerOf(stats.topModel)}</span>
                </>
              ) : '—'}
            </div>
          ) : c.wrap ? (
            <div className={clsx(css.cardValue, css.cardValueSm, css.cardValueWrap)}>{c.value}</div>
          ) : c.sub !== undefined ? (
            <div className={clsx(css.cardValue, css.cardModelLines)}>
              <FitText text={c.value} className={css.cardValue} maxSize={22} />
              <div className={css.cardSub}>{c.sub}</div>
            </div>
          ) : (
            <FitText text={c.value} className={clsx(css.cardValue, c.sm && css.cardValueSm)} maxSize={c.sm ? 14 : 22} />
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

// Cell/gap ratio follows reasonix (base 13 / gap 3): a 1px gap against a
// ~20px grown cell read as tiles touching edge to edge. The gap also equals
// the legend's own 3px swatch spacing, and the fixed rx matches the legend
// swatch border-radius, so the key renders at exactly the chart's geometry.
const HEAT_BASE = 14 // cell size at which column trimming starts
const HEAT_GAP = 3 // breathing gap between cells; mirrors the legend swatch gap
const HEAT_RX = 3 // cell corner radius; matches the legend swatch (css .heatCell)

function Heatmap({ daily, from, to, t, panelRef }: { daily: DailyTokenUsage[]; from: string; to: string; t: Translator; panelRef: RefObject<HTMLDivElement | null> }) {
  // Memoized so a hover/tip state change re-renders without rebuilding the
  // per-day lookup (the daily array is stable between fetches).
  const byDay = useMemo(() => {
    const map = new Map<string, DailyTokenUsage>()
    for (const d of daily) map.set(d.day, d)
    return map
  }, [daily])
  const [tip, setTip] = useState<{ day: string; tokens: number; requests: number; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)
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

  const allDays = daysBetween(from, to)
  if (allDays.length === 0) return null
  const days = allDays.slice(-Math.min(geom.cols * 7, allDays.length))
  const max = Math.max(1, ...days.map((d) => byDay.get(d)?.total ?? 0))

  const rows = 7
  const startOffset = days[0] ? (indexOfDay(days[0]) + 1) % 7 : 0
  const weeks = Math.max(1, Math.ceil((days.length + startOffset) / 7))

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
                rx={HEAT_RX}
                onMouseEnter={(e) => {
                  // The tip anchors to the hovered cell's viewport rect, so it
                  // can escape the wrap's overflow clipping and follow scroll.
                  setTip({ day, tokens, requests: rec?.requests ?? 0, cacheHit: rec?.cacheHit ?? 0, cacheMiss: rec?.cacheMiss ?? 0, anchor: e.currentTarget })
                }}
                onMouseLeave={() => setTip(null)}
              />
            )
          })}
        </svg>
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{tip.day}</div>
            <div>{t('tokens')}: {formatTokens(tip.tokens)}</div>
            <div>{t('requests')}: {tip.requests}</div>
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
        )}
      </div>
    </section>
  )
}

// ── Section 5: stacked daily token trend ──────────────────────────────────

function DailyTrend({ models, daily, t, colorForModel, panelRef }: { models: GroupedModel[]; daily: GroupedDaily[]; t: Translator; colorForModel: (m: string) => string; panelRef: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<{ day: string; total: number; byModel: Record<string, number>; otherByModel?: Record<string, number>; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const W = 720
  const H = 220
  const padL = 46
  const padR = 65
  const padB = 26
  const padT = 10
  const plotH = H - padT - padB
  // The smallest column pitch that still reads as separate bars; below it
  // (very long custom ranges on a narrow pane) the oldest days drop off.
  const MIN_PITCH = 4

  const [view, setView] = useState<{ avail: number; trimN: number }>({ avail: W, trimN: TREND_MAX_DAYS })

  useEffect(() => {
    const el = wrapRef.current
    if (!el || daily.length === 0) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth)
      const maxN = Math.floor((avail - padL - padR) / MIN_PITCH) + 1
      const trimN = Math.max(1, Math.min(daily.length, TREND_MAX_DAYS, maxN))
      setView((prev) => (prev.avail === avail && prev.trimN === trimN ? prev : { avail, trimN }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [daily.length])

  if (daily.length === 0) return null

  const visible = daily.slice(-view.trimN)
  // The note is honest about whatever window actually rendered (the 180-day
  // cap, or a narrower pane's minimum-pitch trim).
  const trendCapped = daily.length > view.trimN
  const n = visible.length
  // Columns always spread over the full plot width: pinning a minimum pitch
  // for the step itself letterboxes the chart (the viewBox, narrower than
  // the svg box, centres with empty flanks) when few days are in range —
  // 7/14-day presets used to huddle in the middle. The pitch floor above
  // only caps how many days show.
  const step =
    n > 1
      ? (view.avail - padL - padR) / (n - 1)
      : Math.max(1, view.avail - padL - padR)
  const barW = Math.max(3, Math.min(30, step * 0.62))
  const barHalf = barW / 2
  const plotWUsed = view.avail
  const maxTotal = Math.max(1, ...visible.map((d) => d.total))
  const ticks = niceTicks(maxTotal, 4)
  // X labels keep at least ~46px between their columns — a fixed "every Nth
  // day" count collided when few days stretched across the whole plot
  // (7/14-day presets labelled every bar).
  const labelEvery = Math.max(1, Math.ceil(46 / step))

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

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('dailyTrend')}</h3>
        {trendCapped && <span className={css.trendNote}>{t('trendLimited').replace('{n}', String(view.trimN))}</span>}
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
                    // The tip anchors to the hovered day column's viewport
                    // rect, so it can escape wrap clipping and follow scroll.
                    setTip({ day: d.day, total: d.total, byModel: d.byModel, otherByModel: d.otherByModel, cacheHit: d.cacheHit, cacheMiss: d.cacheMiss, anchor: e.currentTarget })
                  }}
                  onMouseLeave={() => setTip(null)}
                />
                {(i % labelEvery === 0 || i === n - 1) && (
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
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{tip.day}</div>
            <div>{t('total')}: {formatTokens(tip.total)}</div>
            {legendModels.filter((m) => tip.byModel[m] !== undefined).map((m) => (
              <div key={m} className={css.tipRow}><i className={css.legendSwatch} style={{ background: colorForModel(m) }} />{m === OTHER_MODEL ? t('other') : m}: {formatTokens(tip.byModel[m]!)}</div>
            ))}
            {tip.otherByModel && Object.entries(tip.otherByModel).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className={clsx(css.tipRow, css.tipRowOther)}><i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />{m}: {formatTokens(v)}</div>
            ))}
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
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

// ── Section 6: per-model bar + list ──────────────────────────────────────

function ModelUsage({ models, t, colorForModel, panelRef }: { models: GroupedModel[]; t: Translator; colorForModel: (m: string) => string; panelRef: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<{ model: string; tokens: number; percent: number; anchor: Element; items?: ModelTokenUsage[] } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [expandedOther, setExpandedOther] = useState(false)
  // The column is sized to the rows alone, so expanding Other never stretches
  // the chart.
  const [listRef, barH] = useCollapsedHeight()

  if (models.length === 0) return null
  const other = models.find((m) => m.model === OTHER_MODEL)

  // Stack order is the host's rank order, laid out top-to-bottom like the
  // list beside it: rank 1 owns the TOP segment and the aggregated tail (the
  // gray Other bucket) ends at the base.
  const segments = models.map((m) => ({
    key: m.model,
    tokens: m.tokens,
    color: colorForModel(m.model),
    label: `${m.model === OTHER_MODEL ? t('other') : m.model}: ${formatTokens(m.tokens)} (${formatPercent(m.percent)})`,
  }))

  // A bar segment and its list row drive the same highlight; only the
  // segment carries an anchor, so only it raises the tooltip.
  const highlight = (key: string | null, anchor?: Element): void => {
    setHover(key)
    const m = key === null ? undefined : models.find((x) => x.model === key)
    setTip(m !== undefined && anchor !== undefined
      ? { model: m.model, tokens: m.tokens, percent: m.percent, anchor, items: m.items }
      : null)
  }

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('modelUsage')}</h3>
      <div className={css.models}>
        <StackedBar
          segments={segments}
          ariaLabel={t('modelUsage')}
          height={barH}
          hovered={hover}
          onHover={highlight}
        />
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
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
          </ChartTip>
        )}
        <ul className={css.modelList} ref={listRef}>
          {models.map((m, rank) => {
            const isOther = m.model === OTHER_MODEL
            return (
              <li
                key={m.model}
                data-bar-row=""
                className={clsx(css.modelRow, isOther && css.modelRowExpandable)}
                onMouseEnter={() => highlight(m.model)}
                onMouseLeave={() => highlight(null)}
                {...(isOther
                  ? {
                      // Mouse convenience only: the keyboard path is the real
                      // modelToggle button inside (aria-expanded + Enter/Space),
                      // so the row itself carries no role/tabIndex — a
                      // role=button li would nest two interactive elements.
                      onClick: () => setExpandedOther(!expandedOther),
                    }
                  : {})}
              >
                <span className={css.modelRank} aria-hidden="true">{isOther ? '' : rank + 1}</span>
                <i className={css.legendSwatch} style={{ background: colorForModel(m.model) }} />
                <div className={css.modelId}>
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
                    {isOther ? t('other') : modelNameOf(m.model)}
                  </span>
                  {!isOther && <span className={css.modelProvider}>{providerOf(m.model)}</span>}
                </div>
                <div className={css.modelValues}>
                  <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                  <span className={css.modelPct}>{formatPercent(m.percent)}</span>
                </div>
              </li>
            )
          })}
          {other?.items && other.items.length > 0 && (
            <li className={clsx(css.modelOtherWrap, expandedOther && css.modelOtherOpen)}>
              <ul className={css.modelOtherList}>
                {other.items.map((it) => (
                  <li key={it.model} data-bar-row="" className={clsx(css.modelRow, css.modelRowSub)}>
                    <i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />
                    <div className={css.modelId}>
                      <span className={css.modelName}>{modelNameOf(it.model)}</span>
                      <span className={css.modelProvider}>{providerOf(it.model)}</span>
                    </div>
                    <div className={css.modelValues}>
                      <span className={css.modelTokens}>{formatTokens(it.tokens)}</span>
                      <span className={css.modelPct}>{formatPercent(it.percent)}</span>
                    </div>
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

// ── Section 7: per-provider bar + list ───────────────────────────────────
//
// The same anatomy as the model section one dimension up: a stacked column
// on the left, the ranked list on the right, and one shared highlight so
// hovering either side lights the other. Every row opens a detail list of its
// own — a ranked provider opens the models it served, the Other bucket opens
// the providers it folded, and each of those opens ITS models (two levels).
// The hover tip carries the same breakdown for the bar's segments.

function ProviderUsage({ providers, t, colorForProvider, panelRef }: { providers: GroupedProvider[]; t: Translator; colorForProvider: (p: string) => string; panelRef: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<{ provider: string; tokens: number; percent: number; anchor: Element; models: ModelTokenUsage[] } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  // Two independent expand sets: `openRanked` holds ranked providers — and the
  // Other bucket — opening their own detail list, `openFolded` holds providers
  // folded inside Other opening theirs. Sets, not one key each, because several
  // rows may stand open at once and the two levels nest.
  const [openRanked, setOpenRanked] = useState<ReadonlySet<string>>(NO_KEYS)
  const [openFolded, setOpenFolded] = useState<ReadonlySet<string>>(NO_KEYS)
  // The column is sized to the ROWS alone (a detail wrapper carries no row
  // class), so expanding a row at either level never stretches the chart.
  const [listRef, barH] = useCollapsedHeight()

  if (providers.length === 0) return null

  const flipRanked = (key: string): void => { setOpenRanked((prev) => toggleIn(prev, key)) }
  const flipFolded = (key: string): void => { setOpenFolded((prev) => toggleIn(prev, key)) }

  const segments = providers.map((p) => ({
    key: p.provider,
    tokens: p.tokens,
    color: colorForProvider(p.provider),
    label: `${p.provider === OTHER_PROVIDER ? t('other') : p.provider}: ${formatTokens(p.tokens)} (${formatPercent(p.percent)})`,
  }))

  const highlight = (key: string | null, anchor?: Element): void => {
    setHover(key)
    const p = key === null ? undefined : providers.find((x) => x.provider === key)
    setTip(p !== undefined && anchor !== undefined
      ? { provider: p.provider, tokens: p.tokens, percent: p.percent, anchor, models: p.models }
      : null)
  }

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('providerUsage')}</h3>
      <div className={css.models}>
        <StackedBar
          segments={segments}
          ariaLabel={t('providerUsage')}
          height={barH}
          hovered={hover}
          onHover={highlight}
        />
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{tip.provider === OTHER_PROVIDER ? t('other') : tip.provider}</div>
            <div>{t('total')}: {formatTokens(tip.tokens)}</div>
            <div>{t('percent')}: {formatPercent(tip.percent)}</div>
            {tip.models.length > 0 && (
              <div className={css.tipBreakdown}>
                {tip.models.map((m) => (
                  <div key={m.model} className={clsx(css.tipRow, css.tipRowOther)}>
                    <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                    {modelNameOf(m.model)}: {formatTokens(m.tokens)}
                  </div>
                ))}
              </div>
            )}
          </ChartTip>
        )}
        <ul className={css.modelList} ref={listRef}>
          {providers.map((p, rank) => {
            const isOther = p.provider === OTHER_PROVIDER
            const folded = p.folded ?? []
            const open = openRanked.has(p.provider)
            const hasDetail = isOther ? folded.length > 0 : p.models.length > 0
            return (
              <Fragment key={p.provider}>
                {/* The ranked row (and the Other bucket): mouse convenience
                    only. The keyboard path is the real toggle button inside
                    (aria-expanded + Enter/Space), so the row carries no
                    role/tabIndex — a role=button li would nest two
                    interactive elements. */}
                <li
                  data-bar-row=""
                  className={clsx(css.modelRow, css.modelRowExpandable)}
                  onMouseEnter={() => highlight(p.provider)}
                  onMouseLeave={() => highlight(null)}
                  onClick={() => flipRanked(p.provider)}
                >
                  <span className={css.modelRank} aria-hidden="true">{isOther ? '' : rank + 1}</span>
                  <i className={css.legendSwatch} style={{ background: colorForProvider(p.provider) }} />
                  <div className={css.modelId}>
                    <span className={css.modelName}>
                      <button
                        type="button"
                        className={css.modelToggle}
                        onClick={(e) => { e.stopPropagation(); flipRanked(p.provider) }}
                        aria-expanded={open}
                        aria-label={isOther ? t('other') : p.provider}
                      >
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      {isOther ? t('other') : p.provider}
                    </span>
                    {!isOther && <span className={css.modelProvider}>{t('providerModels', { n: p.models.length })}</span>}
                  </div>
                  <div className={css.modelValues}>
                    <span className={css.modelTokens}>{formatTokens(p.tokens)}</span>
                    <span className={css.modelPct}>{formatPercent(p.percent)}</span>
                  </div>
                </li>
                {/* The detail list is a SIBLING of the row and never carries a
                    row class, so the collapsed-height measure beside the bar
                    keeps counting rows only — opening it cannot stretch the
                    column. It stays mounted (the accordion animates a grid
                    track) and is simply skipped when the row has nothing to
                    show. */}
                {hasDetail && (
                  <li className={clsx(css.modelOtherWrap, open && css.modelOtherOpen)}>
                    <ul className={css.modelOtherList}>
                      {isOther
                        ? folded.map((f) => {
                            const openSub = openFolded.has(f.provider)
                            return (
                              <Fragment key={f.provider}>
                                <li
                                  data-bar-row=""
                                  className={clsx(css.modelRow, css.modelRowSub, css.modelRowExpandable)}
                                  onClick={() => flipFolded(f.provider)}
                                >
                                  <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                                  <div className={css.modelId}>
                                    <span className={css.modelName}>
                                      <button
                                        type="button"
                                        className={css.modelToggle}
                                        onClick={(e) => { e.stopPropagation(); flipFolded(f.provider) }}
                                        aria-expanded={openSub}
                                        aria-label={f.provider}
                                      >
                                        {openSub ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                      </button>
                                      {f.provider}
                                    </span>
                                    <span className={css.modelProvider}>{t('providerModels', { n: f.models.length })}</span>
                                  </div>
                                  <div className={css.modelValues}>
                                    <span className={css.modelTokens}>{formatTokens(f.tokens)}</span>
                                    <span className={css.modelPct}>{formatPercent(f.percent)}</span>
                                  </div>
                                </li>
                                {f.models.length > 0 && (
                                  <li className={clsx(css.modelOtherWrap, openSub && css.modelOtherOpen)}>
                                    <ul className={css.modelOtherList}>
                                      {f.models.map((m) => (
                                        <li key={m.model} data-bar-row="" className={clsx(css.modelRow, css.modelRowSub, css.modelRowDeep)}>
                                          <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                                          <div className={css.modelId}>
                                            <span className={css.modelName}>{modelNameOf(m.model)}</span>
                                          </div>
                                          <div className={css.modelValues}>
                                            <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                                            <span className={css.modelPct}>{formatPercent(m.percent)}</span>
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  </li>
                                )}
                              </Fragment>
                            )
                          })
                        // A ranked provider opens the models it served, each
                        // wearing that provider's own hue so the row group reads
                        // as one block.
                        : p.models.map((m) => (
                            <li key={m.model} className={clsx(css.modelRow, css.modelRowSub)}>
                              <i className={css.legendSwatch} style={{ background: colorForProvider(p.provider) }} />
                              <div className={css.modelId}>
                                <span className={css.modelName}>{modelNameOf(m.model)}</span>
                              </div>
                              <div className={css.modelValues}>
                                <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                                <span className={css.modelPct}>{formatPercent(m.percent)}</span>
                              </div>
                            </li>
                          ))}
                    </ul>
                  </li>
                )}
              </Fragment>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Toggle one key in an immutable string set (a fresh Set every call, so React
 *  sees a state change and unrelated keys keep their state). */
function toggleIn(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

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
