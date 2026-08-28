/**
 * Route + range-resolution tests — a TS translation of reasonix's
 * stats_app_test.go (resolveStatsRange branches) plus the aggregate route
 * wiring against an in-memory store.
 */
import { describe, expect, it } from 'vitest'
import { resolveRange, buildUsageRoute } from '../src/routes.ts'

function fixedNow(): Date {
  return new Date(2026, 7, 20, 15, 0, 0) // 2026-08-20 local
}

describe('resolveRange', () => {
  const now = fixedNow()

  it('preset 7 days ends today', () => {
    const { from, to } = resolveRange({ range: '7' }, now)
    expect(to).toBe('2026-08-20')
    expect(from).toBe('2026-08-14')
  })

  it('preset 14 / 30 / 90 days', () => {
    expect(resolveRange({ range: '14' }, now).from).toBe('2026-08-07')
    expect(resolveRange({ range: '30' }, now).from).toBe('2026-07-22')
    expect(resolveRange({ range: '90' }, now).from).toBe('2026-05-23')
  })

  it('custom range with valid dates', () => {
    const { from, to } = resolveRange({ range: 'custom', from: '2026-07-01', to: '2026-07-31' }, now)
    expect(from).toBe('2026-07-01')
    expect(to).toBe('2026-07-31')
  })

  it('custom range rejects missing or malformed dates', () => {
    expect(() => resolveRange({ range: 'custom', to: '2026-07-31' }, now)).toThrow(/valid from\/to/)
    expect(() => resolveRange({ range: 'custom', from: '2026-07-01', to: 'not-a-date' }, now)).toThrow(/valid from\/to/)
  })

  it('custom range rejects to < from', () => {
    expect(() => resolveRange({ range: 'custom', from: '2026-07-31', to: '2026-07-01' }, now)).toThrow(/>= from/)
  })

  it('custom range rejects well-formed but impossible calendar dates', () => {
    // A regex alone passes these; the semantic parse must not.
    expect(() => resolveRange({ range: 'custom', from: '2026-13-01', to: '2026-12-31' }, now)).toThrow(/valid from\/to/)
    expect(() => resolveRange({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }, now)).toThrow(/valid from\/to/)
  })

  it('custom range caps the span at 366 days', () => {
    expect(() => resolveRange({ range: 'custom', from: '2025-01-01', to: '2026-12-31' }, now)).toThrow(/more than 366 days/)
    // Exactly one leap year is accepted.
    const { from, to } = resolveRange({ range: 'custom', from: '2024-01-01', to: '2024-12-31' }, now)
    expect(from).toBe('2024-01-01')
    expect(to).toBe('2024-12-31')
  })

  it('unknown/empty range defaults to the last 7 days', () => {
    expect(resolveRange({ range: '' }, now).from).toBe('2026-08-14')
    expect(resolveRange({ range: '365' }, now).from).toBe('2026-08-14')
  })
})

// A tiny in-memory UsageStore stand-in so the aggregate route test can run
// without the storage domain.
import { aggregateRange } from '../src/routes.ts'
import type { UsageDayRow } from '../src/store.ts'
import { readJsonBody } from '../src/wire.ts'
import type { UsageHttpRequest, UsageHttpResponse } from '../src/context-types.ts'

function memoryStore(rows: UsageDayRow[]): Parameters<typeof aggregateRange>[0] {
  return {
    async rangeRows(from: string, to: string) {
      return rows.filter((r) => r.day >= from && r.day <= to)
    },
  } as Parameters<typeof aggregateRange>[0]
}

describe('aggregateRange', () => {
  it('folds store rows — requests expand from the per-row count', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0, requests: 1, turns: 0, lastSeen: 0 },
      { day: '2026-08-02', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, turns: 2, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-02')
    // Provider-inclusive headline: 150+40 + 200 + nothing = 390.
    expect(out.tokens).toBe(390)
    expect(out.turns).toBe(2)
    expect(out.requests).toBe(2)
    expect(out.cacheMiss).toBe(300)
  })

  it('counts a request-only row (a failed call) as one request with no tokens', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, turns: 0, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    expect(out.requests).toBe(1)
    expect(out.tokens).toBe(0)
  })

  it('keeps a pure-cache call in the aggregate (zero input/output, real cache traffic)', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'deepseek', model: 'deepseek/deepseek-chat', inputTokens: 0, outputTokens: 0, cacheReadTokens: 5000, cacheWriteTokens: 0, requests: 1, turns: 0, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    expect(out.cacheHit).toBe(5000)
    // Provider-inclusive: a pure-cache call's cached tokens ARE the total.
    expect(out.tokens).toBe(5000)
  })

  it('reports per-day turns in the daily series', async () => {
    const store = memoryStore([
      { day: '2026-08-01', provider: 'default', model: '(turns)', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, turns: 3, lastSeen: 0 },
    ])
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    expect(out.turns).toBe(3)
    expect(out.daily[0]!.turns).toBe(3)
    expect(out.daily[0]!.total).toBe(0)
  })
})

describe('readJsonBody', () => {
  function bodyReq(chunks: string[]): UsageHttpRequest {
    return {
      url: '/usage/api/range',
      method: 'POST',
      headers: {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as UsageHttpRequest
  }

  it('parses a small JSON body', async () => {
    expect(await readJsonBody(bodyReq(['{"range":"7"}']))).toEqual({ range: '7' })
  })

  it('rejects an oversized body with 413', async () => {
    await expect(readJsonBody(bodyReq(['x'.repeat(70_000)]))).rejects.toThrow(/exceeds/)
  })

  it('rejects malformed JSON with 400', async () => {
    await expect(readJsonBody(bodyReq(['{nope']))).rejects.toThrow(/invalid json/)
  })
})

// ── POST /usage/api/reset — the store-rebuild escape hatch ─────────────────
describe('POST /usage/api/reset', () => {
  /** A minimal mock res collecting what writeJson wrote. */
  function mockRes(): UsageHttpResponse & { bodyText: string; jsonStatus?: number } {
    const res = {
      statusCode: undefined as number | undefined,
      jsonStatus: undefined as number | undefined,
      bodyText: '',
      writeHead(status: number) {
        res.jsonStatus = status
        return res
      },
      end(payload: string) {
        res.bodyText = payload
      },
    }
    return res as unknown as UsageHttpResponse & { bodyText: string; jsonStatus?: number }
  }

  /** A request the trust fence accepts (loopback Host, no browser markers). */
  function post(url: string): UsageHttpRequest {
    return { url, method: 'POST', headers: { host: '127.0.0.1:8090' } } as unknown as UsageHttpRequest
  }

  function deps() {
    const calls = { resets: 0, rescans: 0 }
    const base = {
      store: {
        reset: async () => { calls.resets++ },
      },
      collector: { running: false, status: { running: false, done: 0, total: 0 } },
      trustedHosts: () => [] as string[],
      isRebuilding: () => false,
      // The host-half coalescing pipeline stands in directly: the route owns
      // the 409 fence, the pipeline owns wipe + rebuild.
      resetAndRescan: async () => { calls.rescans++ },
    }
    return { deps: base as unknown as Parameters<typeof buildUsageRoute>[1], calls }
  }

  it('delegates the wipe+rebuild to the pipeline and answers with status', async () => {
    const route = buildUsageRoute({} as never, deps().deps)
    const res = mockRes()
    await route.handler(post('/usage/api/reset'), res)
    expect(res.jsonStatus).toBe(200)
    const body = JSON.parse(res.bodyText) as { ok: boolean; value: { running: boolean } }
    expect(body.ok).toBe(true)
    expect(body.value.running).toBe(false)
  })

  it('refuses with 409 while a boot scan is in flight and never wipes', async () => {
    const mock = deps()
    ;(mock.deps.collector as unknown as { running: boolean }).running = true
    // isRebuilding stays false: this simulates the boot backfill, which the
    // route must not yank mid-pass.
    const route = buildUsageRoute({} as never, mock.deps)
    const res = mockRes()
    await route.handler(post('/usage/api/reset'), res)
    expect(res.jsonStatus).toBe(409)
    const body = JSON.parse(res.bodyText) as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toMatch(/already running/)
    expect(mock.calls.resets).toBe(0)
    expect(mock.calls.rescans).toBe(0)
  })

  it('coalesces onto an in-flight reset rebuild instead of refusing', async () => {
    const mock = deps()
    // The rebuild pipeline's own backfill makes the collector report
    // running — but isRebuilding is true, so this is not a boot scan:
    // the caller must ride the pipeline, not get a 409.
    ;(mock.deps.collector as unknown as { running: boolean }).running = true
    ;(mock.deps as unknown as { isRebuilding(): boolean }).isRebuilding = () => true
    const route = buildUsageRoute({} as never, mock.deps)
    const res = mockRes()
    await route.handler(post('/usage/api/reset'), res)
    expect(res.jsonStatus).toBe(200)
    expect(JSON.parse(res.bodyText).ok).toBe(true)
    expect(mock.calls.rescans).toBe(1)
  })

  it('keeps untrusted hosts out of the rebuild path', async () => {
    const mock = deps()
    const route = buildUsageRoute({} as never, mock.deps)
    const res = mockRes()
    const req = { url: '/usage/api/reset', method: 'POST', headers: { host: 'evil.example.com' } } as unknown as UsageHttpRequest
    await route.handler(req, res)
    expect(res.jsonStatus).toBe(403)
    expect(mock.calls.rescans).toBe(0)
  })
})

// ── Endpoint matching: exact pathname under the /usage/api prefix ──────────
describe('route path matching', () => {
  function mockRes(): UsageHttpResponse & { bodyText: string; jsonStatus?: number } {
    const res = {
      statusCode: undefined as number | undefined,
      jsonStatus: undefined as number | undefined,
      bodyText: '',
      writeHead(status: number) {
        res.jsonStatus = status
        return res
      },
      end(payload: string) {
        res.bodyText = payload
      },
    }
    return res as unknown as UsageHttpResponse & { bodyText: string; jsonStatus?: number }
  }

  function req(url: string, method = 'POST'): UsageHttpRequest {
    return { url, method, headers: { host: '127.0.0.1:8090' } } as unknown as UsageHttpRequest
  }

  function routeFor(): { handler: (req: UsageHttpRequest, res: UsageHttpResponse) => void | Promise<void> } {
    const base = {
      store: { reset: async () => {} },
      collector: { running: false, status: { running: false, done: 0, total: 0 } },
      trustedHosts: () => [] as string[],
      isRebuilding: () => false,
      resetAndRescan: async () => {},
    } as unknown as Parameters<typeof buildUsageRoute>[1]
    return { handler: buildUsageRoute({} as never, base).handler }
  }

  it('matches the endpoint path even with a query string attached', async () => {
    // The client never sends a query, but a stale bookmark or proxy-added
    // cache-buster must not 404 a legitimate endpoint.
    const { handler } = routeFor()
    const res = mockRes()
    await handler(req('/usage/api/status?cachebust=1'), res)
    expect(res.jsonStatus).toBe(200)
    expect(JSON.parse(res.bodyText).ok).toBe(true)
  })

  it('does not swallow deeper paths under the prefix', async () => {
    // /usage/api/anything/range must NOT reach the range handler (the prefix
    // route registration makes raw endsWith matching too greedy).
    const { handler } = routeFor()
    for (const url of ['/usage/api/x/range', '/usage/api/range/extra', '/usage/apiXrange']) {
      const res = mockRes()
      await handler(req(url), res)
      expect(res.jsonStatus, url).toBe(404)
      expect(JSON.parse(res.bodyText).error.code, url).toBe('not_found')
    }
  })

  it('rejects a wrong-method request to a known endpoint with 404', async () => {
    // The fence still passes (loopback Host); the endpoint is POST-only.
    const { handler } = routeFor()
    const res = mockRes()
    await handler(req('/usage/api/status', 'GET'), res)
    expect(res.jsonStatus).toBe(404)
  })

  it('echos only the request path (not query params) in the 404 body', async () => {
    const { handler } = routeFor()
    const res = mockRes()
    await handler(req('/usage/api/nope?secret=1'), res)
    expect(JSON.parse(res.bodyText).error.message).toBe('unknown endpoint /usage/api/nope')
  })
})
