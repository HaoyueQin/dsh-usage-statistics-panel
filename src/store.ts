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
 *  the fold's replace semantics only dedupe within one pass).
 *
 *  `liveFirstSeq` records, per session, the EXCLUSIVE END of the range a
 *  backfill may replay: [0, value) is backfill-owned, [value, ∞) is
 *  live-path-owned. It is written at two moments — when the live listener
 *  first observes a session (that first event's seq, or -1 when the boundary
 *  was unknown), and by /reset (the session's wipe-time log length, because
 *  the wipe destroyed everything below it and the rebuild must reconstruct
 *  exactly that span from the log). The next boot's backfill replays exactly
 *  the prefix before the boundary. */
export const usageHistoryDomain = defineDomain({
  name: 'usage_history',
  version: 1,
  global: {
    schema: z.object({
      backfilledSessions: z.array(z.string()),
      liveFirstSeq: z.record(z.string(), z.number()).optional(),
    }),
    initial: { backfilledSessions: [] as string[], liveFirstSeq: {} },
  },
  tables: {
    days: domainTable<string, UsageDayRow>(usageDayRowSchema),
  },
})

/** key: `day|provider|model`. */
export function dayRowKey(day: string, provider: string, model: string): string {
  return `${day}|${provider}|${model}`
}

/** The domain global's value: the backfill cursor (see the
 *  `usageHistoryDomain` doc for the field semantics). */
interface UsageCursor {
  backfilledSessions?: string[]
  liveFirstSeq?: Record<string, number>
}

export class UsageStore {
  private table: UsageKvTable<string, UsageDayRow> | null = null
  private domainHandle: UsageDomain | null = null
  private ready: Promise<void>
  /** Set when the domain could not be opened (already-open race, corrupted
   *  file, ...). The store then runs DEGRADED: every operation fails
   *  per-call with a clear error and nothing persists, but no rejecting
   *  promise is ever left unobserved — an escaping rejection here used to
   *  be able to take the whole host down. */
  private openError?: unknown
  /** Serializes read-modify-write cycles on the backfill cursor. The domain
   *  only guarantees single-write ordering on its chain — a global.set is a
   *  whole-value overwrite, so two concurrent markSeenSessions calls would
   *  interleave get→set and lose one caller's ids (lost update). Chaining
   *  through this promise makes every get→set pair atomic within the
   *  process, which is the only concurrency that exists here. */
  private markChain: Promise<void> = Promise.resolve()

  constructor(ctx: UsageStorageDomain) {
    // initialize() absorbs EVERY failure (sync throw surfaced through an
    // async boundary included): this.ready must always resolve, so awaiting
    // it can never itself become the unhandled rejection that kills the
    // process. Callers observe degradation per operation via requireTable().
    this.ready = this.initialize(ctx)
      .catch((err) => { this.openError = err })
  }

  private async initialize(ctx: UsageStorageDomain): Promise<void> {
    const domain = await ctx.open(usageHistoryDomain)
    this.domainHandle = domain
    this.table = domain.table('days') as UsageKvTable<string, UsageDayRow>
    // One-time rebuild of pre-cursor rows (≤0.1.1 wrote the old request
    // semantics and no turns at all): rows paired with a completely empty
    // cursor cannot be told apart from a half-written new-world store, and
    // both recover by dropping the rows and letting the backfill replay
    // from scratch. Running inside ready() means every later record, mark,
    // or cursor read — including the live listener's first writes — lands
    // after the decision, so no ordering race exists.
    const value = domain.global?.get() as { backfilledSessions?: string[] } | undefined
    const cursorEmpty = (value?.backfilledSessions?.length ?? 0) === 0
    if (cursorEmpty && this.table.keys().next().done === false) {
      for (const key of [...this.table.keys()]) await this.table.delete(key)
    }
  }

  /** The open failure when running degraded, else undefined (diagnostics). */
  get degradation(): unknown {
    return this.openError
  }

  /** Session ids already replayed into the store (the backfill cursor).
   *  A medium without a global (pre-cursor rows) yields an empty set, which
   *  would replay everything once — acceptable only for a fresh install, so
   *  callers pairing this with markSeenSessions still converge after one
   *  pass. */
  async seenSessions(): Promise<Set<string>> {
    await this.ready
    const value = this.cursor()
    return new Set(value?.backfilledSessions ?? [])
  }

  /** Per-session seq of the first LIVE-observed event (see the domain's
   *  `liveFirstSeq` doc). -1 = observed with an unknown boundary. */
  async liveSequences(): Promise<Map<string, number>> {
    await this.ready
    const value = this.cursor()
    return new Map(Object.entries(value?.liveFirstSeq ?? {}))
  }

  private cursor(): UsageCursor | undefined {
    return this.domainHandle?.global?.get() as UsageCursor | undefined
  }

  /** The cursor value for a read-modify-write cycle. Degraded stores fail
   *  here too: the cursor-writing methods must honor the same per-call
   *  failure contract as record() — silently succeeding while persisting
   *  nothing would make callers believe a replay boundary was durable. */
  private requireCursor(): UsageCursor {
    if (this.openError !== undefined) {
      const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
      throw new Error(`usage store degraded (domain unavailable: ${detail})`)
    }
    return this.cursor() ?? {}
  }

  /** Persist session ids as replayed (merges into the cursor). Calls are
   *  serialized through {@link markChain} so concurrent workers never lose
   *  each other's ids in a get→set interleaving. */
  async markSeenSessions(ids: Iterable<string>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      const seen = new Set(value.backfilledSessions ?? [])
      for (const id of ids) seen.add(id)
      await this.domainHandle?.global?.set({
        backfilledSessions: [...seen],
        liveFirstSeq: value.liveFirstSeq ?? {},
      })
    })
    // Keep the chain alive regardless of failure: one rejected write must
    // not poison every later mark (the caller observes the rejection).
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Record the first LIVE-observed seq per session (merges; the EARLIEST
   *  boundary wins — it is the safe partition point for prefix replays).
   *  Serialized through {@link markChain} like every other global rewrite. */
  async markLiveSequences(entries: Iterable<readonly [string, number]>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      const merged: Record<string, number> = { ...(value.liveFirstSeq ?? {}) }
      let changed = false
      for (const [id, seq] of entries) {
        const prev = merged[id]
        if (prev === undefined || seq < prev) {
          merged[id] = seq
          changed = true
        }
      }
      if (!changed) return
      await this.domainHandle?.global?.set({
        backfilledSessions: value.backfilledSessions ?? [],
        liveFirstSeq: merged,
      })
    })
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Drop every row and the whole cursor, re-bounding each named session at
   *  its WIPE-TIME WATERMARK (the store-rebuild escape hatch for corrupted
   *  history or attribution-logic upgrades).
   *
   *  The watermark matters because the wipe destroys the live path's already-
   *  recorded samples too: a still-open session's post-attach usage exists in
   *  no log-replay-free zone — it MUST be reconstructed from the persisted
   *  log like everything else. Bounding that session at its old attach
   *  boundary would make the follow-up backfill replay only the pre-attach
   *  prefix and strand the live-recorded span forever; bounding it at the
   *  log length captured at wipe time makes the backfill rebuild exactly the
   *  destroyed range [0, watermark) once, while events from the watermark on
   *  stay exclusive to the still-running live path. Sessions without a
   *  usable watermark carry the -1 sentinel (replay nothing — never risk a
   *  duplicate). */
  async reset(boundaries?: ReadonlyMap<string, number>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const table = this.requireTable()
      for (const key of [...table.keys()]) await table.delete(key)
      const liveFirstSeq: Record<string, number> = {}
      if (boundaries) {
        for (const [id, seq] of boundaries) liveFirstSeq[id] = seq
      }
      await this.domainHandle?.global?.set({ backfilledSessions: [], liveFirstSeq })
    })
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Opens the domain (lazily awaited by every operation). */
  async readyPromise(): Promise<void> {
    await this.ready
  }

  private requireTable(): UsageKvTable<string, UsageDayRow> {
    if (this.openError !== undefined) {
      const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
      throw new Error(`usage store degraded (domain unavailable: ${detail})`)
    }
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
