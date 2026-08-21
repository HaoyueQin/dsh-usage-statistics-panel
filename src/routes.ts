/**
 * The /usage/api route table: a small JSON RPC over the fenced web route.
 * Methods:
 *   - range  { range, from?, to?, source? } -> UsageStatsRange
 *   - status {} -> BackfillStatus
 * The prefix route /usage/api is registered on the webserver; each request
 * passes the browser-trust fence (Host-header loopback or trustedHosts).
 */

import type { Context } from './context-types.ts'
import type { UsageHttpRequest, UsageHttpResponse, UsageWebRoute } from './context-types.ts'
import { UsageStore } from './store.ts'
import { UsageCollector } from './collector.ts'
import { aggregateSamples, daysInRange } from './query.ts'
import type { UsageSample } from './query.ts'
import type { BackfillStatus, UsageStatsRange, UsageStatsRequest } from './wire.ts'
import { UsageError, readJsonBody, writeError, writeJson } from './wire.ts'
import { createTrustFence, type TrustFence } from './trust-fence.ts'

export interface RoutesDeps {
  store: UsageStore
  collector: UsageCollector
  /** Resolve the trusted-host list live (webRuntime.trustedHosts). */
  trustedHosts: () => string[]
}

/** Resolve a request's [from, to] into inclusive local day keys. */
export function resolveRange(req: UsageStatsRequest, now = new Date()): { from: string; to: string } {
  const day = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 0)
  switch (req.range) {
    case '7':
    case '14':
    case '30':
    case '90': {
      const n = Number(req.range)
      const from = new Date(toDate)
      from.setDate(from.getDate() - (n - 1))
      return { from: day(from), to: day(toDate) }
    }
    case 'custom': {
      if (!req.from || !req.to) {
        throw new UsageError(400, 'usage stats: custom range needs valid from/to dates (YYYY-MM-DD)')
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.from) || !/^\d{4}-\d{2}-\d{2}$/.test(req.to)) {
        throw new UsageError(400, 'usage stats: custom range needs valid from/to dates (YYYY-MM-DD)')
      }
      if (req.to < req.from) {
        throw new UsageError(400, 'usage stats: custom to must be >= from')
      }
      return { from: req.from, to: req.to }
    }
    default: {
      // Unknown/empty range defaults to the last 7 days.
      const from = new Date(toDate)
      from.setDate(from.getDate() - 6)
      return { from: day(from), to: day(toDate) }
    }
  }
}

/** Build the aggregate for a range from the store rows. */
export async function aggregateRange(store: UsageStore, from: string, to: string, source?: string): Promise<UsageStatsRange> {
  const rows = await store.rangeRows(from, to)
  const samples: UsageSample[] = []
  for (const row of rows) {
    if (row.inputTokens + row.outputTokens > 0) {
      samples.push({
        day: row.day,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      })
    }
    // Requests live on the row as a count (one per provider call, tokens or
    // not); expand them into request markers for the shared aggregator.
    for (let i = 0; i < row.requests; i++) {
      samples.push({ day: row.day, model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, request: true })
    }
    for (let i = 0; i < row.turns; i++) {
      samples.push({ day: row.day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true })
    }
  }
  return aggregateSamples(samples, { from, to, source })
}

/** Build the single fenced prefix route serving the /usage/api JSON RPC.
 *  The host mounts it via `ctx.webServer.register` (which takes ONE WebRoute,
 *  not an array — matching the real dsh-host-webserver contract). */
export function buildUsageRoute(ctx: Context, deps: RoutesDeps): UsageWebRoute {
  const fence: TrustFence = createTrustFence(deps.trustedHosts)
  const handler = async (req: UsageHttpRequest, res: UsageHttpResponse): Promise<void> => {
    if (!fence.isTrusted(req)) {
      writeJson(res, { ok: false, error: { code: 'forbidden', message: 'untrusted host' } }, 403)
      return
    }
    const url = req.url ?? ''
    const method = req.method ?? 'GET'
    try {
      if (method === 'POST' && url.endsWith('/range')) {
        const body = (await readJsonBody(req)) as Partial<UsageStatsRequest>
        const { from, to } = resolveRange(body as UsageStatsRequest)
        const stats = await aggregateRange(deps.store, from, to, body.source)
        writeJson(res, { ok: true, value: stats })
        return
      }
      if (method === 'POST' && url.endsWith('/status')) {
        writeJson(res, { ok: true, value: deps.collector.status })
        return
      }
      writeJson(res, { ok: false, error: { code: 'not_found', message: `unknown endpoint ${url}` } }, 404)
    } catch (err) {
      writeError(res, err)
    }
  }
  return { kind: 'prefix', path: '/usage/api', handler }
}

export type { BackfillStatus, UsageStatsRange, UsageStatsRequest }
