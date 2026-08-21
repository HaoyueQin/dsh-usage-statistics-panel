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
import type { UsageStorageDomain, UsageKvTable, UsageDomain } from './context-types.ts'
import { dayKey } from './query.ts'
import type { UsageSample } from './query.ts'
import { z } from 'zod'

/** True when a KvTable.update() failure is the "no record to update" miss
 *  (the storage-domain error for an absent key) — the retry path seeds the
 *  row and re-applies. */
function isMissingRecord(err: unknown): boolean {
  return err instanceof Error && /no record .* to update/.test(err.message)
}

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

/** The domain's global singleton: the backfill cursor. Session ids already
 *  replayed into the store live here, so a reboot's backfill only folds
 *  sessions it has never seen (a full replay would double every counter —
 *  the fold's replace semantics only dedupe within one pass). */
export const usageHistoryDomain = defineDomain({
  name: 'usage_history',
  version: 1,
  global: {
    schema: z.object({ backfilledSessions: z.array(z.string()) }),
    initial: { backfilledSessions: [] as string[] },
  },
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
  private domainHandle: UsageDomain | null = null
  private ready: Promise<void>

  constructor(ctx: UsageStorageDomain) {
    this.ready = ctx.open(usageHistoryDomain).then((domain) => {
      this.domainHandle = domain
      this.table = domain.table('days') as UsageKvTable<string, UsageDayRow>
    })
  }

  /** Session ids already replayed into the store (the backfill cursor).
   *  A medium without a global (pre-cursor rows) yields an empty set, which
   *  would replay everything once — acceptable only for a fresh install, so
   *  callers pairing this with markSeenSessions still converge after one
   *  pass. */
  async seenSessions(): Promise<Set<string>> {
    await this.ready
    const value = this.domainHandle?.global?.get() as { backfilledSessions?: string[] } | undefined
    return new Set(value?.backfilledSessions ?? [])
  }

  /** Persist session ids as replayed (merges into the cursor). */
  async markSeenSessions(ids: Iterable<string>): Promise<void> {
    await this.ready
    const seen = await this.seenSessions()
    for (const id of ids) seen.add(id)
    await this.domainHandle?.global?.set({ backfilledSessions: [...seen] })
  }

  /** Drop every day row — the one-time rebuild path for a pre-cursor store
   *  (≤0.1.1 rows carry the old request semantics and no turns at all, so a
   *  replay on top of them would double every token). */
  async clearDays(): Promise<void> {
    await this.ready
    const table = this.requireTable()
    for (const key of [...table.keys()]) await table.delete(key)
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
   *  records them per source, not per model).
   *
   *  KvTable.update() requires an existing key ("no record to update"
   *  otherwise), so a miss is retried once after seeding the row with put().
   *  The put/update pair is not atomic against a concurrent writer for the
   *  same key, but the collector's fold dedupes by (turn, step) and the live
   *  listener + backfill never write the same key twice concurrently; the
   *  retry covers the first-writer race. */
  async record(sample: UsageSample): Promise<void> {
    await this.ready
    const table = this.requireTable()
    const day = sample.day
    const provider = sample.turn ? 'default' : providerOf(sample.model && sample.model !== '' ? sample.model : '(unknown)')
    const model = sample.turn ? '(turns)' : sample.model && sample.model !== '' ? sample.model : '(unknown)'
    const key = dayRowKey(day, provider, model)
    const apply = (cur: UsageDayRow | undefined): UsageDayRow => {
      const base = cur ?? emptyRow(day, provider, model)
      if (sample.turn) {
        return { ...base, turns: base.turns + 1, lastSeen: Date.now() }
      }
      if (sample.request) {
        // A provider-call marker (step/start or a started retry): one request,
        // no tokens — reasonix counts failed calls too. Requests are counted
        // ONLY here: a successful call also produces a usage sample, and
        // counting both would double every call.
        return { ...base, requests: base.requests + 1, lastSeen: Date.now() }
      }
      return {
        ...base,
        inputTokens: base.inputTokens + sample.inputTokens,
        outputTokens: base.outputTokens + sample.outputTokens,
        cacheReadTokens: base.cacheReadTokens + sample.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + sample.cacheWriteTokens,
        lastSeen: Date.now(),
      }
    }
    try {
      await table.update(key, apply)
    } catch (err) {
      if (isMissingRecord(err)) {
        await table.put(key, emptyRow(day, provider, model))
        await table.update(key, apply)
        return
      }
      throw err
    }
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
