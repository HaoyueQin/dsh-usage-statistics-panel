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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-usage-statistics-panel'

/** The settings namespace pairing host and browser halves. */
export const USAGE_STATS_NS = settingsNamespace('usage-statistics')

/** Services required before mounting: the webserver routes, the session
 *  persistence + live store (backfill + live events), the storage domain
 *  hub (durable rows), and the settings seam (namespace registration). */
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain', 'settings']

export interface UsageStatsConfig {
  /** The source label recorded with every live sample ("" = unlabelled). */
  source?: string
  /** Backfill concurrency (default 4). */
  backfillConcurrency?: number
}

export function apply(ctx: Context, config: UsageStatsConfig = {}): void {
  const store = new UsageStore(ctx.storageDomain)
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

  // Mount the fenced route. The disposer runs on fiber teardown (HMR-safe).
  ctx.effect(() => {
    const route = buildUsageRoute(ctx, { store, collector, trustedHosts })
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
    const controller = new AbortController()
    void store.readyPromise().then(() => {
      if (!controller.signal.aborted) {
        void collector.backfill(ctx.sessionPersistence, ctx.sessions, controller.signal)
      }
    })
    return () => {
      controller.abort()
    }
  }, 'dsh-usage-statistics-panel: collector')
}

export type { UsageCollector, UsageFold } from './collector.ts'
export type { UsageStore } from './store.ts'
export type { UsageStatsRange, UsageStatsRequest, DailyTokenUsage, ModelTokenUsage, ProviderTokenUsage, BackfillStatus } from './wire.ts'
