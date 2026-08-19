/**
 * The usage-history durable store. Records accumulate into one storage
 * domain (`usage_history`, single table `days`) keyed
 * `YYYY-MM-DD|provider|model` with the four token buckets plus per-day
 * counters (requests, turns) and the uncached-input cache-miss side. Writes
 * go through `KvTable.update()` (atomic read-modify-write queued per key), so
 * concurrent turns never interleave. The backend persists the domain to
 * `$DSH_HOME/storages/usage_history.json` (storage-json).
 *
 * The layout mirrors the reasonix daily-JSONL design (one row per day ×
 * model) with the aggregation moved into the storage layer: a query reads
 * the table entries intersecting the range instead of decoding per-day files.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { UsageStorageDomain, UsageKvTable } from './context-types.ts'
import { dayKey } from './query.ts'
import type { UsageSample } from './query.ts'
import { z } from 'zod'

/** One row: a model's usage on one local calendar day. */
export interface UsageDayRow {
  day: string // "YYYY-MM-DD"
  provider: string
  model: string // canonical "provider/model"; "(unknown)" for unlabelled
  inputTokens: number // uncached input (the cache-miss side)
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number // usage events (API calls) that day, this model
  turns: number // completed turns attributed to this model that day
  lastSeen: number // epoch ms of the newest sample
}

export const usageDayRowSchema = z.object({
  day: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  requests: z.number(),
  turns: z.number(),
  lastSeen: z.number(),
})

export const usageHistoryDomain = defineDomain({
  name: 'usage_history',
  version: 1,
  tables: {
    days: domainTable<string, UsageDayRow>(usageDayRowSchema),
  },
})

/** key: `day|provider|model`. */
export function dayRowKey(day: string, provider: string, model: string): string {
  return `${day}|${provider}|${model}`
}

export function dayRowKeyParts(key: string): { day: string; provider: string; model: string } {
  const [day, provider, model] = key.split('|')
  return { day: day ?? '', provider: provider ?? '', model: model ?? '' }
}

export class UsageStore {
  private table: UsageKvTable<string, UsageDayRow> | null = null
  private ready: Promise<void>

  constructor(ctx: UsageStorageDomain) {
    this.ready = ctx.open(usageHistoryDomain).then((domain) => {
      this.table = domain.table('days') as UsageKvTable<string, UsageDayRow>
    })
  }

  /** Opens the domain (lazily awaited by every operation). */
  async readyPromise(): Promise<void> {
    await this.ready
  }

  private requireTable(): UsageKvTable<string, UsageDayRow> {
    if (!this.table) throw new Error('usage store not ready')
    return this.table
  }

  /** Fold one atomic usage sample (a completed call or a turn marker) into
   *  the day's row. Turn markers carry no model attribution (reasonix
   *  records them per source, not per model). */
  async record(sample: UsageSample): Promise<void> {
    await this.ready
    const table = this.requireTable()
    const day = sample.day
    if (sample.turn) {
      // A turn marker: count it on the day across models by folding into the
      // "(unknown)" row? No — reasonix counts turns per day independent of
      // model. We track turns on the provider/model row only when the turn
      // marker follows a call sample; standalone markers (empty turns) land
      // on a synthetic "(unknown)" row so the daily total stays right.
      const provider = 'default'
      const model = '(turns)'
      const key = dayRowKey(day, provider, model)
      await table.update(key, (cur) => ({
        ...(cur ?? emptyRow(day, provider, model)),
        turns: (cur?.turns ?? 0) + 1,
        lastSeen: Date.now(),
      }))
      return
    }
    const model = sample.model && sample.model !== '' ? sample.model : '(unknown)'
    const provider = providerOf(model)
    const key = dayRowKey(day, provider, model)
    await table.update(key, (cur) => {
      const base = cur ?? emptyRow(day, provider, model)
      return {
        ...base,
        inputTokens: base.inputTokens + sample.inputTokens,
        outputTokens: base.outputTokens + sample.outputTokens,
        cacheReadTokens: base.cacheReadTokens + sample.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + sample.cacheWriteTokens,
        requests: base.requests + (sample.inputTokens + sample.outputTokens > 0 ? 1 : 0),
        lastSeen: Date.now(),
      }
    })
  }

  /** All rows whose day intersects [from, to] (inclusive). */
  async rangeRows(from: string, to: string): Promise<UsageDayRow[]> {
    await this.ready
    const table = this.requireTable()
    const out: UsageDayRow[] = []
    for (const [, row] of table.entries()) {
      if (row.day >= from && row.day <= to) out.push(row)
    }
    return out
  }

  /** Total row count (diagnostics / tests). */
  async count(): Promise<number> {
    await this.ready
    const table = this.requireTable()
    let n = 0
    for (const _ of table.entries()) n++
    return n
  }
}

function emptyRow(day: string, provider: string, model: string): UsageDayRow {
  return {
    day,
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    turns: 0,
    lastSeen: Date.now(),
  }
}

import { providerOf } from './query.ts'
