/**
 * Range aggregation engine — a TS translation of the reasonix stats query
 * (internal/stats/query.go). It folds raw usage records (per call + per turn)
 * into the RangeStats the panel renders: per-day totals broken down by model
 * and provider, range totals, derived active days / cache hit-rate / top
 * model, and the per-model / per-provider ranked splits.
 *
 * The cache hit-rate is derived only from the input side (cacheHit +
 * cacheMiss), while the headline token total is PROVIDER-INCLUSIVE —
 * uncached input + output + cache reads + cache writes. That is the number
 * a provider dashboard reports for the same calls (and reasonix's
 * TotalTokens): DSH's TokenUsage splits DeepSeek's prompt_tokens into
 * disjoint input/cacheRead buckets, so the naive input+output sum would
 * hide the (typically dominant) cached share. The two rate denominators
 * never mix with the total.
 */

import type {
  ModelTokenUsage,
  ProviderTokenUsage,
  UsageStatsRange,
} from './wire.ts'

// Pure date/model-ref helpers live in the shared (host+client, zero-dep)
// module; imported for local use AND re-exported so the host-side import
// surface is unchanged.
import { dayKey, daysInRange, hourKey, providerOf } from './shared.ts'
export { dayKey, daysInRange, hourKey, providerOf }

/**
 * One atomic usage sample from a completed model call (or one completed
 * turn). A call sample carries the four token buckets and the model ref; a
 * turn marker carries only the day (the panel's "sessions" metric is one
 * completed turn). The request marker is ORTHOGONAL to the buckets: it counts
 * one provider call, and it rides alone on a call that reported no tokens
 * (`step/start`, a started retry) or alongside the buckets when the call
 * reports its own usage (`compaction/summary` — a call no `step/start`
 * opened).
 */
export interface UsageSample {
  day: string // local calendar day the call completed
  /** Local calendar-hour key ("YYYY-MM-DDTHH"). Live and backfill samples
   *  always carry it; the aggregate's day-mode series ignores it. */
  hour?: string
  model?: string // canonical "provider/model"
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turn?: boolean // true for a completed-turn marker
  request?: boolean // true when this sample also counts one provider call
}

export interface RangeFilter {
  from: string // inclusive day key
  to: string // inclusive day key
}

/** Data granularity of the trend series: per local day, or per local hour
 *  for the short-range presets. */
export type Granularity = 'day' | 'hour'

/** The bucket keys covering [from, to]: one per day, or 24 per day in hour
 *  mode (empty buckets included, so the chart keeps a full timeline). */
function bucketsInRange(from: string, to: string, granularity: Granularity): string[] {
  const days = daysInRange(from, to)
  if (granularity === 'day') return days
  const out: string[] = []
  for (const day of days) {
    for (let hour = 0; hour < 24; hour++) out.push(`${day}T${String(hour).padStart(2, '0')}`)
  }
  return out
}

/** The bucket a sample belongs to, or null when it falls outside the window
 *  (or carries no hour in hour mode). Hour keys are fixed-width, so plain
 *  string comparison is chronological. */
function bucketOf(sample: UsageSample, from: string, to: string, granularity: Granularity): string | null {
  if (granularity === 'day') {
    return sample.day >= from && sample.day <= to ? sample.day : null
  }
  const hour = sample.hour
  if (hour === undefined) return null
  return hour >= `${from}T00` && hour <= `${to}T23` ? hour : null
}

/** Aggregate the samples intersecting [from, to]. Missing buckets yield zero
 *  entries so the trend chart shows the full timeline. */
export function aggregateSamples(
  samples: Iterable<UsageSample>,
  filter: RangeFilter,
  granularity: Granularity = 'day',
): UsageStatsRange {
  const from = filter.from
  const to = filter.to
  const buckets = bucketsInRange(from, to, granularity)
  const out: UsageStatsRange = {
    from,
    to,
    granularity,
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
  // Per-bucket accumulation (the reasonix dayTotals): the stacked trend chart
  // reads the bucket's byModel / byProvider, so every token-bearing sample
  // must land in its bucket's map — not just in the range totals.
  const bucketByModel = new Map<string, Map<string, number>>()
  const bucketTotals = new Map<string, number>()
  const bucketRequests = new Map<string, number>()
  const bucketTurns = new Map<string, number>()
  const bucketCacheHit = new Map<string, number>()
  const bucketCacheMiss = new Map<string, number>()

  for (const sample of samples) {
    const bucket = bucketOf(sample, from, to, granularity)
    if (bucket === null) continue
    if (sample.turn) {
      out.turns++
      bucketTurns.set(bucket, (bucketTurns.get(bucket) ?? 0) + 1)
      continue
    }
    // Provider-inclusive headline (dashboard parity): every bucket the
    // provider billed for this call — uncached input, output, cache reads
    // and writes. The hit/miss rate denominators below stay input-side only.
    const total = sample.inputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
    if (sample.request) {
      // One provider call, whether or not it produced tokens — reasonix counts
      // failed calls too. A marker with no buckets is a request and nothing
      // else: it must not create a model row, mark its day active, or open an
      // empty daily bucket. A marker that DOES carry buckets
      // (`compaction/summary` states the call and its usage in one sample) is
      // counted here and again through the token accounting below — the two
      // count different things, so neither doubles the other.
      out.requests++
      bucketRequests.set(bucket, (bucketRequests.get(bucket) ?? 0) + 1)
      if (total <= 0) continue
    }
    out.tokens += total
    out.cacheHit += sample.cacheReadTokens
    // The miss side is everything prompt-side that was NOT a cache read:
    // uncached input plus cache writes. (This matches the official stats
    // line's billedInputTokens split — cacheHit/(cacheHit+cacheMiss) is the
    // same ratio on both surfaces; for DeepSeek cacheWrite is always 0.) */
    out.cacheMiss += sample.inputTokens + sample.cacheWriteTokens
    const model = sample.model && sample.model !== '' ? sample.model : '(unknown)'
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + total)
    providerTotals.set(providerOf(model), (providerTotals.get(providerOf(model)) ?? 0) + total)
    // Active days stay a day metric even in hour mode: the key's date prefix
    // is the day the bucket belongs to.
    active.add(bucket.slice(0, 10))

    let byModel = bucketByModel.get(bucket)
    if (!byModel) {
      byModel = new Map()
      bucketByModel.set(bucket, byModel)
    }
    byModel.set(model, (byModel.get(model) ?? 0) + total)
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + total)
    bucketCacheHit.set(bucket, (bucketCacheHit.get(bucket) ?? 0) + sample.cacheReadTokens)
    bucketCacheMiss.set(bucket, (bucketCacheMiss.get(bucket) ?? 0) + sample.inputTokens + sample.cacheWriteTokens)
  }

  out.activeDays = active.size

  // Bucket series: emit every bucket of the range; inactive buckets carry
  // zero totals.
  for (const bucket of buckets) {
    const byModel = bucketByModel.get(bucket)
    const byModelObj: Record<string, number> = {}
    if (byModel) {
      for (const [m, v] of byModel) byModelObj[m] = v
    }
    const byProviderObj: Record<string, number> = {}
    for (const m of Object.keys(byModelObj)) {
      byProviderObj[providerOf(m)] = (byProviderObj[providerOf(m)] ?? 0) + byModelObj[m]!
    }
    out.daily.push({
      day: bucket,
      total: bucketTotals.get(bucket) ?? 0,
      byModel: byModelObj,
      byProvider: byProviderObj,
      requests: bucketRequests.get(bucket) ?? 0,
      turns: bucketTurns.get(bucket) ?? 0,
      cacheHit: bucketCacheHit.get(bucket) ?? 0,
      cacheMiss: bucketCacheMiss.get(bucket) ?? 0,
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
