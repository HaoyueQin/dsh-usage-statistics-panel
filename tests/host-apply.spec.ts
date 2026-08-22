/**
 * Host-half apply() regression tests for the hot-reload crash (2026-08-22):
 * re-applying the plugin — what a reload does — must NOT open the storage
 * domain a second time ("DomainError: domain 'usage_history' is already
 * open" used to surface as a fatal host load failure and take the backend
 * down). The store is a process-level singleton; an unavailable domain
 * degrades the STORE instead of failing the load.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { apply, _resetSharedStoreForTests } from '../src/index.ts'

function fakeCtx(openImpl: () => Promise<unknown> ): { ctx: unknown; opens: () => number } {
  let opens = 0
  const ctx = {
    effect: (_fn: unknown, _label?: string) => {},
    webServer: { register: (_route: unknown) => () => {} },
    sessionPersistence: { list: async () => [], inspect: async () => ({ meta: {}, events: [] }) },
    sessions: { list: () => [], get: () => undefined },
    storageDomain: {
      open: async () => {
        opens++
        return openImpl()
      },
    },
  }
  return { ctx, opens: () => opens }
}

/** A minimal but FUNCTIONAL domain stand-in (rows live in a throwaway map),
 *  so the happy path exercises real store behavior without persistence. */
function memoryDomain(): unknown {
  const rows = new Map<string, unknown>()
  return {
    table: () => ({
      get: (k: string) => rows.get(k),
      entries: () => rows.entries(),
      keys: () => rows.keys(),
      size: rows.size,
      put: async (k: string, v: unknown) => { rows.set(k, v) },
      delete: async (k: string) => rows.delete(k),
      update: async (k: string, fn: (cur: unknown) => unknown) => {
        const cur = rows.get(k)
        if (cur === undefined) throw new Error(`no record '${k}' to update`)
        const next = fn(cur)
        rows.set(k, next)
        return next
      },
    }),
    global: { get: () => undefined, set: async () => {} },
  }
}

describe('apply(): hot-reload safety', () => {
  beforeEach(() => {
    _resetSharedStoreForTests()
  })

  it('opens the storage domain exactly once across repeated applies (reload simulation)', async () => {
    const { ctx, opens } = fakeCtx(async () => memoryDomain())
    apply(ctx as never)
    // Let the store's internal initialization settle before re-applying.
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Simulate a hot reload: the module was freshly re-imported, so apply()
    // runs again against the SAME host process.
    apply(ctx as never)
    apply(ctx as never)
    expect(opens()).toBe(1)
  })

  it('degrades in the store instead of failing the load when open rejects', async () => {
    const { ctx, opens } = fakeCtx(async () => {
      throw Object.assign(new Error("domain 'usage_history' is already open"), { name: 'DomainError' })
    })
    expect(() => apply(ctx as never)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opens()).toBe(1)
    // Another simulated reload keeps working through the degraded store —
    // and still does not re-open the domain.
    expect(() => apply(ctx as never)).not.toThrow()
    expect(opens()).toBe(1)
  })

  it('degrades in the store when the domain facility throws SYNCHRONOUSLY', async () => {
    // The production DomainFacility.open throws synchronously (observed in
    // the crash stack); the constructor path must absorb that too.
    const ctx = {
      effect: () => {},
      webServer: { register: () => () => {} },
      sessionPersistence: { list: async () => [], inspect: async () => ({ meta: {}, events: [] }) },
      sessions: { list: () => [], get: () => undefined },
      storageDomain: {
        open: (() => {
          throw Object.assign(new Error("domain 'usage_history' is already open"), { name: 'DomainError' })
        }) as unknown as () => Promise<unknown>,
      },
    }
    expect(() => apply(ctx as never)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})


// ── /reset rebuild pipeline: watermark reset + concurrent-call coalescing ──
describe('/reset rebuild pipeline (host half)', () => {
  interface CapturedRoute {
    handler: (req: unknown, res: unknown) => Promise<void>
  }

  function resetCtx() {
    const routes: CapturedRoute[] = []
    let listCalls = 0
    const gates: Array<() => void> = []
    const ctx = {
      effect: (fn: () => () => void) => { fn() },
      on: () => {},
      webServer: {
        register: (route: never) => {
          routes.push(route as unknown as CapturedRoute)
          return () => {}
        },
      },
      sessionPersistence: {
        // Every backfill pass blocks on a gate so the test can observe the
        // exact moment a scan is in flight — and prove a second overlapping
        // /reset starts NO second pass.
        list: async () => {
          listCalls++
          await new Promise<void>((resolve) => gates.push(resolve))
          return []
        },
        inspect: async () => ({ meta: {}, events: [] }),
      },
      sessions: { list: () => [], get: () => undefined },
      storageDomain: { open: async () => memoryDomain() },
    }
    return { ctx: ctx as unknown as Record<string, unknown>, routes, gates, listCalls: () => listCalls }
  }

  function callRoute(route: CapturedRoute, url: string): Promise<{ status?: number; body: string }> {
    let captured: { status?: number; body: string } = { body: '' }
    const res = {
      writeHead: (status: number) => {
        captured.status = status
        return res
      },
      end: (payload: string) => {
        captured.body = payload
      },
    }
    return route.handler(
      { url, method: 'POST', headers: { host: '127.0.0.1:8090' } },
      res,
    ).then(() => captured)
  }

  it('coalesces overlapping resets into one wipe+rebuild pass', async () => {
    _resetSharedStoreForTests()
    const { ctx, routes, gates, listCalls } = resetCtx()
    apply(ctx as never)
    expect(routes).toHaveLength(1)
    const route = routes[0]!

    // Boot scan: the chain from apply() to persistence.list() is async, so
    // wait for the gate to be registered, then release it and let the scan
    // unwind.
    for (let i = 0; i < 100 && gates.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(gates.length).toBeGreaterThan(0)
    gates.shift()!()
    for (let i = 0; i < 200; i++) {
      const status = JSON.parse((await callRoute(route, '/usage/api/status')).body) as { value: { running: boolean } }
      if (!status.value.running) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const idle = JSON.parse((await callRoute(route, '/usage/api/status')).body) as { value: { running: boolean } }
    expect(idle.value.running).toBe(false)

    // Reset A reaches its own (gated) rebuild scan…
    const promiseA = callRoute(route, '/usage/api/reset')
    for (let i = 0; i < 100 && listCalls() < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(listCalls()).toBe(2)
    // …then reset B arrives while that scan is in flight: it must ride the
    // SAME pipeline (one wipe+rebuild), not start a second pass nor 409.
    const promiseB = callRoute(route, '/usage/api/reset')
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(listCalls()).toBe(2)

    gates.shift()!()
    const [a, b] = await Promise.all([promiseA, promiseB])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(JSON.parse(a.body).ok).toBe(true)
    expect(JSON.parse(b.body).ok).toBe(true)
    expect(listCalls()).toBe(2) // exactly one rebuild pass ran
  })
})
