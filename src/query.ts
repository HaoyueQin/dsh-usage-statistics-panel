/**
 * Range aggregation engine — a TS translation of the reasonix stats query
 * (internal/stats/query.go). It folds raw usage records (per call + per turn)
 * into the RangeStats the panel renders: per-day totals broken down by model
 * and provider, range totals, derived active days / cache hit-rate / top
 * model, and the per-model / per-provider ranked splits.
 *
 * The cache hit-rate is derived only from the input side (cacheHit +
 * cacheMiss), while the token total keeps the provider's totals as-is — the
 * two denominators never mix even when a provider reports totals that omit
 * cache tokens (same rule as the reasonix query).
 */

import type {
  DailyTokenUsage,
  ModelTokenUsage,
  ProviderTokenUsage,
  UsageStatsRange,
} from './wire.ts'

/** Local calendar day key, e.g. "2026-08-02" (no UTC shift). */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** All local-calendar day keys in [from, to], inclusive. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
  }
  return out
}

/** model refs are "provider/model"; a bare model name has no slash and is
 *  attributed to provider "default". */
export function providerOf(modelRef: string): string {
  const i = modelRef.indexOf('/')
  if (i > 0) return modelRef.slice(0, i)
  return 'default'
}

/**
 * One atomic usage sample from a completed model call (or one completed
 * turn). A call sample carries the four token buckets and the model ref; a
 * turn marker carries only the day (the panel's "sessions" metric is one
 * completed turn). A request marker (from `request/context`) counts one
 * provider call with no tokens.
 */
export interface UsageSample {
  day: string // local calendar day the call completed
  model?: string // canonical "provider/model"
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turn?: boolean // true for a completed-turn marker
  request?: boolean // true for a provider-call (request/context) marker
}

export interface RangeFilter {
  from: string // inclusive day key
  to: string // inclusive day key
  source?: string // "" | "all" matches every source
}

/** Aggregate the samples intersecting [from, to]. Missing days yield zero
 *  entries so the trend chart shows the full timeline. */
export function aggregateSamples(samples: Iterable<UsageSample>, filter: RangeFilter): UsageStatsRange {
  const from = filter.from
  const to = filter.to
  const days = daysInRange(from, to)
  const out: UsageStatsRange = {
    from,
    to,
    tokens: 0,
    requests: 0,
    turns: 0,
    cacheHit: 0,
    cacheMiss: 0,
    activeDays: 0,
    topModel: '',
    topProvider: '',
    daily: [],
    models: [],
    providers: [],
  }
  const modelTotals = new Map<string, number>()
  const providerTotals = new Map<string, number>()
  const active = new Set<string>()
  // Per-day accumulation (the reasonix dayTotals): the stacked trend chart
  // reads daily.byModel / daily.byProvider, so every token-bearing sample
  // must land in its day's map — not just in the range totals.
  const dayByModel = new Map<string, Map<string, number>>()
  const dayTotals = new Map<string, number>()
  const dayRequests = new Map<string, number>()
  const dayCacheHit = new Map<string, number>()
  const dayCacheMiss = new Map<string, number>()

  for (const sample of samples) {
    if (sample.day < from || sample.day > to) continue
    if (sample.turn) {
      out.turns++
      continue
    }
    if (sample.request) {
      // A provider call (step/start or a started retry): one request whether
      // or not it produced tokens — reasonix counts failed calls too. The
      // request markers are the ONLY request source: a successful call also
      // yields a usage sample, and counting both would double every call.
      out.requests++
      dayRequests.set(sample.day, (dayRequests.get(sample.day) ?? 0) + 1)
      continue
    }
    const total = sample.inputTokens + sample.outputTokens
    out.tokens += total
    out.cacheHit += sample.cacheReadTokens
    // The uncached input side is the cache miss: DSH's TokenUsage.inputTokens
    // counts input minus cache hits (see llm-deepseek's mapUsage), so it maps
    // to reasonix's cacheMiss without double counting cacheWriteTokens.
    out.cacheMiss += sample.inputTokens
    const model = sample.model && sample.model !== '' ? sample.model : '(unknown)'
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + total)
    providerTotals.set(providerOf(model), (providerTotals.get(providerOf(model)) ?? 0) + total)
    active.add(sample.day)

    let byModel = dayByModel.get(sample.day)
    if (!byModel) {
      byModel = new Map()
      dayByModel.set(sample.day, byModel)
    }
    byModel.set(model, (byModel.get(model) ?? 0) + total)
    dayTotals.set(sample.day, (dayTotals.get(sample.day) ?? 0) + total)
    dayCacheHit.set(sample.day, (dayCacheHit.get(sample.day) ?? 0) + sample.cacheReadTokens)
    dayCacheMiss.set(sample.day, (dayCacheMiss.get(sample.day) ?? 0) + sample.inputTokens)
  }

  out.activeDays = active.size

  // Daily series: emit every day of the range; inactive days carry zero totals.
  for (const day of days) {
    const byModel = dayByModel.get(day)
    const byModelObj: Record<string, number> = {}
    if (byModel) {
      for (const [m, v] of byModel) byModelObj[m] = v
    }
    const byProviderObj: Record<string, number> = {}
    for (const m of Object.keys(byModelObj)) {
      byProviderObj[providerOf(m)] = (byProviderObj[providerOf(m)] ?? 0) + byModelObj[m]!
    }
    out.daily.push({
      day,
      total: dayTotals.get(day) ?? 0,
      byModel: byModelObj,
      byProvider: byProviderObj,
      requests: dayRequests.get(day) ?? 0,
      turns: 0,
      cacheHit: dayCacheHit.get(day) ?? 0,
      cacheMiss: dayCacheMiss.get(day) ?? 0,
    })
  }

  out.models = modelsSorted(modelTotals)
  out.providers = providersSorted(providerTotals)
  const top = out.models[0]
  if (top) {
    out.topModel = top.model
    out.topProvider = top.provider
  }
  if (out.tokens > 0) {
    for (const m of out.models) m.percent = (m.tokens / out.tokens) * 100
    for (const p of out.providers) p.percent = (p.tokens / out.tokens) * 100
  }
  return out
}

function modelsSorted(totals: Map<string, number>): ModelTokenUsage[] {
  const out: ModelTokenUsage[] = []
  for (const [model, tokens] of totals) {
    out.push({ model, provider: providerOf(model), tokens, percent: 0 })
  }
  out.sort((a, b) => b.tokens - a.tokens)
  return out
}

function providersSorted(totals: Map<string, number>): ProviderTokenUsage[] {
  const out: ProviderTokenUsage[] = []
  for (const [provider, tokens] of totals) {
    out.push({ provider, tokens, percent: 0 })
  }
  out.sort((a, b) => b.tokens - a.tokens)
  return out
}
