/**
 * dsh-usage-statistics-panel host half: the /usage/api fenced JSON routes
 * (range aggregate + backfill status), the durable usage store, and the
 * collector that folds live session events plus the one-time historical
 * session backfill. Every request passes the same browser-trust fence as the
 * /api gateway (Host-header loopback or the web runtime's trustedHosts).
 *
 * The panel's data flow mirrors the reasonix usage stats feature: usage is
 * recorded observationally (never alters the event stream; a bad disk state
 * must never interrupt a turn), aggregated per day × model, and served to
 * the browser half over the fenced route.
 */

import type { Context } from './context-types.ts'
import { UsageStore } from './store.ts'
import { UsageCollector } from './collector.ts'
import { buildUsageRoute } from './routes.ts'

export const name = 'dsh-usage-statistics-panel'

/** Services required before mounting: the webserver routes, the session
 *  persistence + live store (backfill + live events), and the storage domain
 *  hub (durable rows). */
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain']

export interface UsageStatsConfig {
  /** The source label recorded with every live sample ("" = unlabelled). */
  source?: string
  /** Backfill concurrency (default 4). */
  backfillConcurrency?: number
}

/**
 * The store is a PROCESS-level singleton, keyed on globalThis.
 *
 * Why: `storageDomain.open()` allows each domain name to be opened exactly
 * once per process and offers no close. A hot reload (fiber dispose +
 * re-import + fresh `apply()`) therefore constructs a NEW UsageStore whose
 * open('usage_history') hits "DomainError: domain 'usage_history' is already
 * open" — which surfaces as a FATAL host load failure and takes the whole
 * backend down (observed twice, 2026-08-22). The module cache is cleared by
 * every reload, so module-level state cannot carry the instance across; the
 * host's globalThis can. Reusing one store across fibers is safe: the domain
 * handle stays valid for the process lifetime, the collector (whose listeners
 * ride ctx.effect disposers) is per-fiber, and every other resource this
 * plugin mounts is effect-managed.
 */
const STORE_KEY = '__dshUsageStatisticsPanelStore'

/** Reset the process-level store cache (test seam only). */
export function _resetSharedStoreForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[STORE_KEY]
}

function sharedStore(storageDomain: Context['storageDomain']): UsageStore {
  const g = globalThis as unknown as { [STORE_KEY]?: UsageStore }
  const existing = g[STORE_KEY]
  if (existing) return existing
  // The constructor never throws on an unavailable domain — it degrades
  // internally (see UsageStore.initialize) — so caching it here is safe.
  const created = new UsageStore(storageDomain)
  g[STORE_KEY] = created
  return created
}

export function apply(ctx: Context, config: UsageStatsConfig = {}): void {
  const store = sharedStore(ctx.storageDomain)
  const collector = new UsageCollector(ctx, store, {
    source: config.source,
    backfillConcurrency: config.backfillConcurrency,
  })

  // The trusted-host list comes from the web runtime (bound at boot); fall
  // back to loopback-only when the runtime is absent (e.g. headless).
  const trustedHosts = (): string[] => {
    const rt = (ctx as unknown as { webRuntime?: { trustedHosts?: string[] } }).webRuntime
    return rt?.trustedHosts ?? []
  }

  // One abortable scan at a time: the initial boot backfill and any /reset
  // rescan share this controller slot, so a rebuild cancels the scan before
  // it and fiber teardown aborts whatever is in flight.
  let scanController: AbortController | null = null
  const rescan = async (): Promise<void> => {
    scanController?.abort()
    const controller = new AbortController()
    scanController = controller
    await store.readyPromise()
    await collector.backfill(ctx.sessionPersistence, ctx.sessions, controller.signal)
  }

  // The /reset rebuild pipeline. Concurrent callers COALESCE into one
  // in-flight run instead of racing it: two overlapping rebuilds would wipe
  // each other's partial results and could answer ok with a half-scanned
  // store (the second run's backfill call would hit the collector's
  // running guard and no-op). Coalescing keeps exactly one wipe+rebuild in
  // flight; everyone who asked gets its outcome.
  let resetInFlight: Promise<void> | null = null
  const isRebuilding = (): boolean => resetInFlight !== null
  const resetAndRescan = (): Promise<void> => {
    if (resetInFlight) return resetInFlight
    resetInFlight = (async () => {
      // Watermark every LIVE session at wipe time. The wipe destroys the
      // live path's already-recorded samples too, so each open session must
      // be re-bounded at its CURRENT log length — not at its old attach
      // boundary — or the follow-up backfill would rebuild only the
      // pre-attach prefix and strand everything the live pass recorded
      // since. [0, watermark) is then rebuilt from the log exactly once;
      // events from the watermark on stay exclusive to the running live
      // path. A session whose seq cannot be read keeps its previous cursor
      // boundary, or the -1 sentinel when none exists (replay nothing —
      // never risk a duplicate). Dead sessions get no entry: nothing
      // live-owned is outstanding for them, so a full replay is exact.
      const previous = await store.liveSequences()
      const boundaries = new Map<string, number>()
      for (const handle of ctx.sessions.list()) {
        const seq = handle.seq
        if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) {
          boundaries.set(handle.id, seq)
          continue
        }
        const old = previous.get(handle.id)
        boundaries.set(handle.id, typeof old === 'number' ? old : -1)
      }
      await store.reset(boundaries)
      await rescan()
    })().finally(() => {
      resetInFlight = null
    })
    return resetInFlight
  }

  // Mount the fenced route. The disposer runs on fiber teardown (HMR-safe).
  ctx.effect(() => {
    const route = buildUsageRoute(ctx, { store, collector, trustedHosts, isRebuilding, resetAndRescan })
    const dispose = ctx.webServer.register(route as never)
    return dispose
  }, 'dsh-usage-statistics-panel: routes')

  // Start the live event listener and kick off the one-time backfill. The
  // backfill runs after the routes mount so the UI can poll status. The
  // disposer aborts an in-flight scan: without it, a fiber teardown (plugin
  // reload) would leave the scan running fire-and-forget behind the closed
  // domain.
  ctx.effect(() => {
    collector.start()
    void rescan()
    return () => {
      scanController?.abort()
    }
  }, 'dsh-usage-statistics-panel: collector')
}

export type { UsageCollector, UsageFold } from './collector.ts'
export type { UsageStore } from './store.ts'
export type { UsageStatsRange, UsageStatsRequest, DailyTokenUsage, ModelTokenUsage, ProviderTokenUsage, BackfillStatus } from './wire.ts'
