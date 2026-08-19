/**
 * Typed fetch wrapper over the /usage JSON API. Every call posts to
 * `/usage/api/<method>` with a JSON body; the host resolves the range and
 * returns the aggregate (or the backfill status). Failures surface as
 * {@link UsageApiError} with the wire code.
 */
import type { BackfillStatus, UsageStatsRange, UsageStatsRequest } from '../wire.ts'

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
    res = await fetch(`/usage/api/${method}`, {
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

/** The backfill (historical session scan) progress state. */
export async function fetchStatus(): Promise<BackfillStatus> {
  return post<BackfillStatus>('status', undefined)
}
