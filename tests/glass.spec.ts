/**
 * The frosted-glass bridge handshake.
 *
 * The panel only ever touches the background plugin through a browser global
 * and a ready event, so these tests pin the two things that can silently break
 * a user's install: that a missing plugin leaves the panel exactly as it was
 * (nothing registered, nothing thrown), and that the registration carries the
 * identity, version and fill mode the bridge documents. The dispose path is
 * covered too, because the handle is what retracts the rules on uninstall.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, BUNDLE_NAME } from '../src/client/index.tsx'
import {
  GLASS_BRIDGE_ID,
  GLASS_BRIDGE_VERSION,
  GLASS_READY_TIMEOUT_MS,
  isCompatibleGlass,
  whenGlassReady,
  type BackgroundGlassApi,
  type GlassSurfaceSpec,
} from '../src/client/glass.ts'
import type { Context } from '../src/context-types.ts'

/** A ctx stand-in that records the fiber disposers `apply` installs. */
function fakeCtx(): { ctx: Context; disposers: Array<() => void> } {
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (fn: () => void | (() => void)) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, callback: () => void | (() => void)) => { callback() },
      register: () => () => {},
    },
    // `apply` also reads the layout service for the panel's back control; no
    // panel moves in this spec, so a stationary stub is enough.
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: null }),
        subscribe: () => () => {},
      },
      selectPanel: () => {},
    },
  } as unknown as Context
  return { ctx, disposers }
}

/** Publish a bridge on the global, recording every registration. */
function publishBridge(): { specs: GlassSurfaceSpec[]; unregisters: number[] } {
  const specs: GlassSurfaceSpec[] = []
  const unregisters: number[] = []
  const api: BackgroundGlassApi = {
    version: GLASS_BRIDGE_VERSION,
    bridgeId: GLASS_BRIDGE_ID,
    isActive: () => true,
    register: (spec) => {
      specs.push(spec)
      return () => { unregisters.push(specs.indexOf(spec)) }
    },
  }
  window.__DSH_BACKGROUND_GLASS__ = api
  return { specs, unregisters }
}

/** Let the resolved-promise continuation inside `apply` run. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

afterEach(() => {
  delete window.__DSH_BACKGROUND_GLASS__
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('whenGlassReady', () => {
  it('resolves immediately when the bridge is already published', async () => {
    const { specs } = publishBridge()
    expect(specs).toEqual([])
    const glass = await whenGlassReady()
    expect(glass).not.toBeNull()
    expect(glass!.bridgeId).toBe(GLASS_BRIDGE_ID)
  })

  it('resolves from the ready event when this bundle loads first', async () => {
    const api = {
      version: GLASS_BRIDGE_VERSION,
      bridgeId: GLASS_BRIDGE_ID,
      isActive: () => true,
      register: () => () => {},
    } satisfies BackgroundGlassApi
    const pending = whenGlassReady()
    window.dispatchEvent(new CustomEvent('dsh-background-glass:ready', { detail: api }))
    expect(await pending).toBe(api)
  })

  it('resolves null when nothing publishes a bridge in time', async () => {
    vi.useFakeTimers()
    const pending = whenGlassReady()
    await vi.advanceTimersByTimeAsync(GLASS_READY_TIMEOUT_MS)
    expect(await pending).toBeNull()
  })

  it('resolves null outside a browser shell', async () => {
    // A plain-node run has no window: stay opaque instead of throwing.
    vi.stubGlobal('window', undefined)
    expect(await whenGlassReady()).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('isCompatibleGlass', () => {
  const api = (over: Partial<BackgroundGlassApi>): BackgroundGlassApi => ({
    version: GLASS_BRIDGE_VERSION,
    bridgeId: GLASS_BRIDGE_ID,
    isActive: () => true,
    register: () => () => {},
    ...over,
  })

  it('accepts the documented bridge', () => {
    expect(isCompatibleGlass(api({}))).toBe(true)
  })

  it('rejects a foreign publisher and a breaking contract version', () => {
    expect(isCompatibleGlass(null)).toBe(false)
    expect(isCompatibleGlass(api({ bridgeId: 'someone-else' }))).toBe(false)
    expect(isCompatibleGlass(api({ version: 2 }))).toBe(false)
  })
})

describe('apply: glass registration', () => {
  it('registers the panel surfaces as one fill-mode selector set', async () => {
    const { specs } = publishBridge()
    const { ctx } = fakeCtx()
    apply(ctx)
    await flush()

    expect(specs).toHaveLength(1)
    expect(specs[0]!.plugin).toBe(BUNDLE_NAME)
    expect(specs[0]!.mode).toBe('fill')
    // A single anchor attribute, so one registration covers both places the
    // panel renders (its own main panel and the Plugins page).
    expect(specs[0]!.selectors).toEqual(['[data-dsh-usage-glass]'])
  })

  it('registers nothing while the background plugin is absent', async () => {
    vi.useFakeTimers()
    const { ctx } = fakeCtx()
    apply(ctx)
    await vi.advanceTimersByTimeAsync(GLASS_READY_TIMEOUT_MS)
    // No bridge means no registration and no leftover bridge global.
    expect(window.__DSH_BACKGROUND_GLASS__).toBeUndefined()
  })

  it('unregisters through the fiber disposer', async () => {
    const { specs, unregisters } = publishBridge()
    const { ctx, disposers } = fakeCtx()
    apply(ctx)
    await flush()
    expect(specs).toHaveLength(1)

    for (const dispose of disposers) dispose()
    expect(unregisters).toEqual([0])
  })

  it('never registers when the fiber is disposed before the bridge arrives', async () => {
    vi.useFakeTimers()
    const { ctx, disposers } = fakeCtx()
    apply(ctx)
    for (const dispose of disposers) dispose()

    // The bridge shows up only after disposal.
    const { specs } = publishBridge()
    await vi.advanceTimersByTimeAsync(GLASS_READY_TIMEOUT_MS)
    expect(specs).toEqual([])
  })
})
