/**
 * Typed fetch wrapper over the usage JSON API. Every call posts to
 * `usage/api/<method>` — DOCUMENT-RELATIVE, never root-absolute — with a JSON
 * body; the host resolves the range and returns the aggregate (or the backfill
 * status). Failures surface as {@link UsageApiError} with the wire code.
 *
 * Relative is the dsh 0.1.7 contract: the served index carries `<base
 * href="./">` (packages/host/frontend-static), so browser references resolve
 * under whatever mount served the page. A root-absolute `/usage/api/...` only
 * works when the shell sits at the origin root and 404s behind a
 * prefix-stripping proxy; the host's own route key stays absolute
 * (`/usage/api` in src/routes.ts), because only the browser half is relative.
 */
import type { UsageStatsRange, UsageStatsRequest } from '../wire.ts'

/** One wire failure. */
export class UsageApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface WireResponse<T> {
  ok: true
  value: T
}

async function post<T>(method: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`usage/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new UsageApiError('network', err instanceof Error ? err.message : String(err))
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new UsageApiError('bad-response', `unexpected response from /usage/api/${method}`)
  }
  const wire = json as WireResponse<T> | { ok: false; error: { code: string; message: string } }
  if (!wire || wire.ok !== true) {
    const failure = wire as { ok: false; error: { code: string; message: string } }
    throw new UsageApiError(failure?.error?.code ?? 'error', failure?.error?.message ?? 'usage api error')
  }
  return wire.value
}

/** Aggregate the usage panel renders for one range. */
export async function fetchRange(req: UsageStatsRequest): Promise<UsageStatsRange> {
  return post<UsageStatsRange>('range', req)
}
