/**
 * Host teardown safety (issue #24).
 *
 * A plugin reload used to take the whole host down two ways:
 *   1. the collector effect's disposer called `scanController.abort()`, and
 *      `abort()` dispatches the signal's listeners synchronously — a listener
 *      that throws surfaced out of the disposer and was reported as a fatal
 *      load failure ("dsh desktop host exited with 1 / AbortError");
 *   2. the boot scan ran fire-and-forget with no rejection handler.
 * Both are now funnelled through the two guards pinned here.
 */
import { describe, expect, it } from 'vitest'
import { abortQuietly, runBootScan } from '../src/index.ts'

describe('abortQuietly', () => {
  it('does not let a throwing abort() escape', () => {
    // The guard's job is exactly this: `abort()` dispatched a listener that
    // threw, and the throw (which Node also reports to its uncaught handler)
    // must not reach the cordis disposer that called us. Modelled with a stub
    // rather than a real listener so Node's own uncaught report does not fail
    // the run.
    const controller = {
      abort: () => { throw new Error('listener blew up') },
      signal: { aborted: false },
    } as unknown as AbortController
    expect(() => { abortQuietly(controller) }).not.toThrow()
  })

  it('accepts a null controller (nothing in flight)', () => {
    expect(() => { abortQuietly(null) }).not.toThrow()
  })

  it('still aborts a controller whose listener is clean', () => {
    const controller = new AbortController()
    let seen = 0
    controller.signal.addEventListener('abort', () => { seen++ })
    abortQuietly(controller)
    expect(controller.signal.aborted).toBe(true)
    expect(seen).toBe(1)
  })
})

describe('runBootScan', () => {
  it('routes a rejection to onError instead of leaving it unhandled', async () => {
    const seen: unknown[] = []
    runBootScan(
      async () => { throw new Error('backfill failed') },
      (error) => { seen.push(error) },
    )
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('backfill failed')
  })

  it('stays quiet when the scan resolves', async () => {
    const seen: unknown[] = []
    let ran = false
    runBootScan(
      async () => { ran = true },
      (error) => { seen.push(error) },
    )
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(ran).toBe(true)
    expect(seen).toHaveLength(0)
  })
})