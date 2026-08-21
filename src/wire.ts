/**
 * Wire contract shared by the host aggregation layer and the browser panel,
 * plus the JSON request/response helpers for the /usage/api route handlers.
 * These types mirror the reasonix stats wire (internal/stats/query.go +
 * desktop/stats_app.go): the aggregate response the panel renders maps 1:1
 * to the panel sections (totals, derived stats, daily trend, per-model
 * split). No Node or DOM types leak into the shared declarations — the HTTP
 * helpers are host-only and import the node faces explicitly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UsageHttpRequest, UsageHttpResponse } from './context-types.ts'

/** One day's token usage and turn count in a trend series. */
export interface DailyTokenUsage {
  day: string // "YYYY-MM-DD", local calendar
  total: number
  byModel: Record<string, number> // model ref -> tokens
  byProvider: Record<string, number> // provider name -> tokens
  requests: number // usage events (API calls)
  turns: number // completed turns
  cacheHit: number // cached input tokens that day
  cacheMiss: number // uncached input tokens that day
}

/** One model's aggregate within the range. */
export interface ModelTokenUsage {
  model: string
  provider: string
  tokens: number
  percent: number // 0..100
}

/** One provider's aggregate within the range (each provider may serve several models). */
export interface ProviderTokenUsage {
  provider: string
  tokens: number
  percent: number
}

/** The full aggregate the settings panel renders for one time range and source filter. */
export interface UsageStatsRange {
  from: string // inclusive
  to: string // inclusive
  // Totals
  tokens: number
  requests: number // usage events (API calls)
  turns: number // completed turns
  cacheHit: number
  cacheMiss: number
  // Derived
  activeDays: number
  topModel: string
  topProvider: string
  // Series
  daily: DailyTokenUsage[]
  models: ModelTokenUsage[]
  providers: ProviderTokenUsage[]
}

/** The usage statistics panel aggregate request. */
export interface UsageStatsRequest {
  range: string // "7" | "14" | "30" | "90" | "custom"
  from?: string // "YYYY-MM-DD", custom only
  to?: string // "YYYY-MM-DD", custom only
}

/** The backfill (historical session scan) progress state. */
export interface BackfillStatus {
  running: boolean
  total: number
  done: number
  scannedSessions: number
  lastSessionId?: string
  error?: string
}

// ── HTTP helpers (host half only) ─────────────────────────────────────────

/** Default cap for a JSON request body. The panel posts tiny objects
 *  ({ range, from?, to? }); the cap only bounds a misbehaving trusted
 *  client, so 64 KiB is generous. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** One line of an async-iterable request body read as UTF-8 text. */
export async function readJsonBody(req: UsageHttpRequest, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > maxBytes) {
      throw new UsageError(413, `request body exceeds ${maxBytes} bytes`)
    }
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  if (body === '') return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new UsageError(400, 'invalid json body')
  }
}

/** A user-visible error carrying its HTTP status. */
export class UsageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function writeJson(res: UsageHttpResponse, value: unknown, status = 200): void {
  res.statusCode = status
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export function writeError(res: UsageHttpResponse, err: unknown): void {
  const status = err instanceof UsageError ? err.status : 500
  // Deliberate 4xx carries its user-facing message; an unexpected 500 must
  // not echo internal error text (paths, driver messages) to the client —
  // the route handler logs the real error server-side.
  const message = err instanceof UsageError ? err.message : 'internal error'
  writeJson(res, { ok: false, error: { code: 'usage_api_error', message } }, status)
}

/** Cast a structural response face to the real node ServerResponse. */
export function asServerResponse(res: UsageHttpResponse): ServerResponse {
  return res as ServerResponse
}

/** Cast a structural request face to the real node IncomingMessage. */
export function asIncomingMessage(req: UsageHttpRequest): IncomingMessage {
  return req as IncomingMessage
}
