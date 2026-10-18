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
import { providerOf } from './query.ts'
import { z } from 'zod'

/** True when a KvTable.update() failure is the "no record to update" miss
 *  (the storage-domain error for an absent key) — the retry path seeds the
 *  row and re-applies. */
function isMissingRecord(err: unknown): boolean {
  return err instanceof Error && /no record .* to update/.test(err.message)
}

/** The counters both tables carry: one model's usage over one bucket. */
export interface UsageCounters {
  provider: string
  model: string // canonical "provider/model"; "(unknown)" for unlabelled
  inputTokens: number // uncached input (the cache-miss side)
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number // usage events (API calls) in the bucket
  turns: number // completed turns attributed to this model in the bucket
  lastSeen: number // epoch ms of the newest sample
}

/** One row: a model's usage on one local calendar day. */
export interface UsageDayRow extends UsageCounters {
  day: string // "YYYY-MM-DD"
}

/** One row: a model's usage in one local calendar hour. */
export interface UsageHourRow extends UsageCounters {
  hour: string // "YYYY-MM-DDTHH"
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

export const usageHourRowSchema = z.object({
  hour: z.string(),
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
      // The hour table has its own pair of cursors: the day cursors were
      // already populated when the hour table arrived, so sharing them would
      // make the upgrade pass skip every session. `hoursReady` records that
      // the hour history covers every replayable session.
      hoursBackfilledSessions: z.array(z.string()).optional(),
      hoursLiveFirstSeq: z.record(z.string(), z.number()).optional(),
      hoursReady: z.boolean().optional(),
    }),
    initial: {
      backfilledSessions: [] as string[],
      liveFirstSeq: {},
      hoursBackfilledSessions: [] as string[],
      hoursLiveFirstSeq: {},
    },
  },
  // Two tables, one domain version: storage-domain builds an empty map for a
  // declared table the medium does not carry yet, so adding `hours` needs no
  // version bump (and a bump would reject every existing store outright —
  // the domain format has no migration path).
  tables: {
    days: domainTable<string, UsageDayRow>(usageDayRowSchema),
    hours: domainTable<string, UsageHourRow>(usageHourRowSchema),
  },
})

/** key: `day|provider|model`. */
export function dayRowKey(day: string, provider: string, model: string): string {
  return `${day}|${provider}|${model}`
}

/** key: `hour|provider|model`. */
export function hourRowKey(hour: string, provider: string, model: string): string {
  return `${hour}|${provider}|${model}`
}

/** The domain global's value: the backfill cursor (see the
 *  `usageHistoryDomain` doc for the field semantics). */
interface UsageCursor {
  backfilledSessions?: string[]
  liveFirstSeq?: Record<string, number>
  hoursBackfilledSessions?: string[]
  hoursLiveFirstSeq?: Record<string, number>
  hoursReady?: boolean
}

export class UsageStore {
  private table: UsageKvTable<string, UsageDayRow> | null = null
  private hourTable: UsageKvTable<string, UsageHourRow> | null = null
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
    this.hourTable = domain.table('hours') as UsageKvTable<string, UsageHourRow>
    // One-time rebuild of pre-cursor rows (≤0.1.1 wrote the old request
    // semantics and no turns at all): rows paired with a completely empty
    // cursor cannot be told apart from a half-written new-world store, and
    // both recover by dropping the rows and letting the backfill replay
    // from scratch. The same path also heals a reset() torn by a crash
    // mid-wipe: reset() writes its empty cursor first, so leftover rows
    // always meet an empty cursor here. Running inside ready() means every
    // later record, mark, or cursor read — including the live listener's
    // first writes — lands after the decision, so no ordering race exists.
    const value = domain.global?.get() as { backfilledSessions?: string[] } | undefined
    const cursorEmpty = (value?.backfilledSessions?.length ?? 0) === 0
    if (cursorEmpty && this.table.keys().next().done === false) {
      for (const key of [...this.table.keys()]) await this.table.delete(key)
      for (const key of [...(this.hourTable?.keys() ?? [])]) await this.hourTable?.delete(key)
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
      // Spread the whole cursor: the hour cursors live in the same global, so
      // a day-cursor write that rebuilt the object field-by-field would erase
      // the upgrade pass's progress and rerun it on every boot.
      await this.domainHandle?.global?.set({
        ...value,
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
        ...value,
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

  /** Session ids already replayed into the HOUR table. The hour table
   *  arrived after the day cursors were populated, so it keeps its own seen
   *  set: sharing the day cursor would make the upgrade pass skip every
   *  session and leave the hour table empty forever. */
  async hoursSeenSessions(): Promise<Set<string>> {
    await this.ready
    return new Set(this.cursor()?.hoursBackfilledSessions ?? [])
  }

  /** Per-session seq of the first LIVE-observed event, hour-table share. */
  async hoursLiveSequences(): Promise<Map<string, number>> {
    await this.ready
    return new Map(Object.entries(this.cursor()?.hoursLiveFirstSeq ?? {}))
  }

  /** Persist hour-table replay progress (merges; serialized on the same
   *  chain as every other cursor write). */
  async markHoursSeenSessions(ids: Iterable<string>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      const seen = new Set(value.hoursBackfilledSessions ?? [])
      for (const id of ids) seen.add(id)
      await this.domainHandle?.global?.set({
        ...value,
        backfilledSessions: value.backfilledSessions ?? [],
        hoursBackfilledSessions: [...seen],
      })
    })
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Record the hour-table live boundary per session (earliest wins). */
  async markHoursLiveSequences(entries: Iterable<readonly [string, number]>): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      const merged: Record<string, number> = { ...(value.hoursLiveFirstSeq ?? {}) }
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
        ...value,
        backfilledSessions: value.backfilledSessions ?? [],
        hoursLiveFirstSeq: merged,
      })
    })
    this.markChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }

  /** Whether the hour table covers every replayable session (initial install,
   *  upgrade pass, or a rebuild). */
  async hoursReady(): Promise<boolean> {
    await this.ready
    return this.cursor()?.hoursReady === true
  }

  /** Mark the hour history complete; the upgrade pass then never reruns. */
  async markHoursReady(): Promise<void> {
    const write = this.markChain.then(async () => {
      await this.ready
      const value = this.requireCursor()
      await this.domainHandle?.global?.set({
        ...value,
        backfilledSessions: value.backfilledSessions ?? [],
        hoursReady: true,
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
      const hourTable = this.requireHourTable()
      const liveFirstSeq: Record<string, number> = {}
      if (boundaries) {
        for (const [id, seq] of boundaries) liveFirstSeq[id] = seq
      }
      // Crash-safe order: the cursor lands BEFORE the row wipe. A crash in
      // between then leaves rows behind an EMPTY cursor, which the
      // open-time rebuild drops before any replay; the reverse order would
      // leave an empty store behind an old "already seen" cursor, so the
      // next boot's backfill would skip every session (silent loss).
      //
      // Both tables and both cursor pairs reset together: the rebuild that
      // follows replays every session through `record()`, which writes the
      // day and hour rows in one pass, so the hour table must start empty
      // and the hour boundary must equal the day boundary.
      await this.domainHandle?.global?.set({
        backfilledSessions: [],
        liveFirstSeq,
        hoursBackfilledSessions: [],
        hoursLiveFirstSeq: { ...liveFirstSeq },
        hoursReady: false,
      })
      for (const key of [...table.keys()]) await table.delete(key)
      for (const key of [...hourTable.keys()]) await hourTable.delete(key)
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

  private requireHourTable(): UsageKvTable<string, UsageHourRow> {
    if (this.openError !== undefined) {
      const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
      throw new Error(`usage store degraded (domain unavailable: ${detail})`)
    }
    if (!this.hourTable) throw new Error('usage store not ready')
    return this.hourTable
  }

  /** Fold one atomic usage sample (a completed call or a turn marker) into
   *  the day's row, and into the matching hour row when the sample carries an
   *  hour key. Turn markers carry no model attribution (reasonix records them
   *  per source, not per model).
   *
   *  KvTable.update() requires an existing key ("no record to update"
   *  otherwise), so a miss is retried once after seeding the row with put().
   *  The put/update pair is not atomic against a concurrent writer for the
   *  same key, but the collector's fold dedupes by (turn, step) and the live
   *  listener + backfill never write the same key twice concurrently; the
   *  retry covers the first-writer race. The two writes are NOT transactional:
   *  a day row that lands while its hour row fails only shortens the hourly
   *  view, which is derived data. */
  async record(sample: UsageSample): Promise<void> {
    await this.ready
    const target = this.targetsOf(sample)
    await this.recordInto(
      this.requireTable(),
      dayRowKey(sample.day, target.provider, target.model),
      emptyDayRow(sample.day, target.provider, target.model),
      sample,
    )
    if (sample.hour !== undefined) await this.recordHours(sample)
  }

  /** Fold a sample into the HOUR table only. The upgrade pass uses this: the
   *  day cursors are already advanced, so replaying through `record()` would
   *  double every day row. */
  async recordHours(sample: UsageSample): Promise<void> {
    await this.ready
    const hour = sample.hour
    if (hour === undefined) throw new Error('usage store: recordHours needs sample.hour')
    const target = this.targetsOf(sample)
    await this.recordInto(
      this.requireHourTable(),
      hourRowKey(hour, target.provider, target.model),
      emptyHourRow(hour, target.provider, target.model),
      sample,
    )
  }

  /** The row identity a sample lands on: turn markers use the synthetic
   *  (turns) model, unlabelled calls the (unknown) one. */
  private targetsOf(sample: UsageSample): { provider: string; model: string } {
    return {
      provider: sample.turn ? 'default' : providerOf(sample.model && sample.model !== '' ? sample.model : '(unknown)'),
      model: sample.turn ? '(turns)' : sample.model && sample.model !== '' ? sample.model : '(unknown)',
    }
  }

  private async recordInto<T extends UsageCounters>(
    table: UsageKvTable<string, T>,
    key: string,
    seed: T,
    sample: UsageSample,
  ): Promise<void> {
    const apply = (cur: T | undefined): T => accumulate(cur ?? seed, sample)
    try {
      await table.update(key, apply)
    } catch (err) {
      if (isMissingRecord(err)) {
        await table.put(key, seed)
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

  /** All rows whose hour falls inside the inclusive calendar-day window
   *  [from, to]. Hour keys share one fixed-width shape, so plain string
   *  comparison is chronological. */
  async rangeHourRows(from: string, to: string): Promise<UsageHourRow[]> {
    await this.ready
    const table = this.requireHourTable()
    const lo = `${from}T00`
    const hi = `${to}T23`
    const out: UsageHourRow[] = []
    for (const [, row] of table.entries()) {
      if (row.hour >= lo && row.hour <= hi) out.push(row)
    }
    return out
  }

  /** Whether the day table has any row at all — the upgrade detector that
   *  separates "existing store" from "fresh install". */
  async hasAnyDayRows(): Promise<boolean> {
    await this.ready
    return this.requireTable().keys().next().done === false
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

function emptyDayRow(day: string, provider: string, model: string): UsageDayRow {
  return { ...emptyCounters(provider, model), day }
}

function emptyHourRow(hour: string, provider: string, model: string): UsageHourRow {
  return { ...emptyCounters(provider, model), hour }
}

function emptyCounters(provider: string, model: string): UsageCounters {
  return {
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

/** Fold one sample into a row. The request marker and the token buckets are
 *  ORTHOGONAL: a marker counts one provider call whether or not that call
 *  reported tokens. `step/start` and started retries carry none (reasonix
 *  counts failed calls too); a `compaction/summary` reports usage for the very
 *  call it counts, so it sets both. A plain token sample leaves the marker
 *  unset — its call was already counted by its own step/start, and bumping
 *  requests here too would double every successful call. */
function accumulate<T extends UsageCounters>(base: T, sample: UsageSample): T {
  if (sample.turn) {
    return { ...base, turns: base.turns + 1, lastSeen: Date.now() }
  }
  return {
    ...base,
    requests: base.requests + (sample.request ? 1 : 0),
    inputTokens: base.inputTokens + sample.inputTokens,
    outputTokens: base.outputTokens + sample.outputTokens,
    cacheReadTokens: base.cacheReadTokens + sample.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + sample.cacheWriteTokens,
    lastSeen: Date.now(),
  }
}
