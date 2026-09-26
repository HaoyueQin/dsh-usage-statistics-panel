/**
 * The frosted-glass bridge published by the `deepseek-harness-background`
 * plugin, wrapped so this plugin can join that glass sheet.
 *
 * Registered surfaces receive exactly the recipe the background plugin's own
 * glass faces carry: a translucent white fill, the wet-glass sheen gradient,
 * and the shared `backdrop-filter` chain driven by the user's blur slider —
 * all behind its `data-dsh-bg-glass` body gate, so a user who disables the
 * wallpaper, clears the image, or drags the panel opacity to 100% gets this
 * panel back on its own paint with no coordination from us.
 *
 * Zero dependency by construction: the contract is one browser global plus one
 * ready event, never an import (importing the background plugin would break
 * every user who has not installed it, and DSH's frozen module table forbids
 * cross-plugin value imports anyway). When that plugin is absent neither
 * channel ever appears, {@link whenGlassReady} resolves `null`, and this
 * plugin renders exactly as it does today.
 *
 * Contract v1: `docs/GLASS_API.zh.md` in the deepseek-harness-background repo.
 * The global key and event name are stable across versions; the version is
 * checked before registering so a breaking v2 degrades to opaque instead of
 * half-applying.
 */

/** Registration payload accepted by the bridge. */
export interface GlassSurfaceSpec {
  /** Caller identity; convention is the npm package name. Diagnostics only. */
  plugin: string
  /**
   * Selectors matching elements THIS plugin renders (max 64, 500 chars each,
   * no `{ } ; @ < > ,` or backslashes). Invalid entries are dropped
   * individually with a console warning; valid siblings still apply.
   */
  selectors: string | readonly string[]
  /**
   * `token` adds only the sheen and blur (for a surface already filled with an
   * overridden `--dsw-*` token); `fill` also takes `background-color` over.
   * Defaults to `token`.
   */
  mode?: 'token' | 'fill'
}

/** The bridge the background plugin publishes on `window`. */
export interface BackgroundGlassApi {
  /** Contract version; only 1 is understood here. */
  readonly version: number
  /** Publisher identity — assert this before trusting the global. */
  readonly bridgeId: string
  /** Whether the glass is on right now (the body gate attribute is present). */
  isActive(): boolean
  /** Register surfaces; returns an idempotent unregister handle. */
  register(spec: GlassSurfaceSpec): () => void
}

declare global {
  interface Window {
    __DSH_BACKGROUND_GLASS__?: BackgroundGlassApi
  }
}

/** The global key and event name — fixed for the life of the contract. */
const GLASS_GLOBAL = '__DSH_BACKGROUND_GLASS__'
const GLASS_EVENT = 'dsh-background-glass:ready'

/** The publisher this plugin expects to find behind the global. */
export const GLASS_BRIDGE_ID = 'deepseek-harness-background'

/** The contract version this helper knows how to drive. */
export const GLASS_BRIDGE_VERSION = 1

/**
 * How long to wait for the bridge before giving up and staying opaque. The
 * bridge is published during the background plugin's client apply, so this
 * only has to cover a bundle that is still parsing; a user without that plugin
 * pays this once and never again.
 */
export const GLASS_READY_TIMEOUT_MS = 10_000

/**
 * Resolve the glass bridge, or `null` when the background plugin is absent.
 *
 * Both arrival orders are handled, because DSH loads client bundles in an
 * unspecified order: the global is polled first (the bridge may already be
 * up), then the ready event is awaited (ours may have loaded first). The
 * listener and the timer are torn down on whichever path wins, so a resolved
 * promise never leaves a stray timeout behind.
 *
 * The event fires again after a hot reload of the background plugin; callers
 * that registered once may simply re-register on that signal — this helper
 * deliberately resolves only the first arrival, and the panel's own effect
 * re-runs on reload.
 *
 * @param timeoutMs - how long to wait for the event before resolving `null`.
 * @returns the bridge, or `null` when nothing published one in time.
 */
export function whenGlassReady(timeoutMs: number = GLASS_READY_TIMEOUT_MS): Promise<BackgroundGlassApi | null> {
  // Non-browser shells (a test running in plain node) have no bridge and no
  // event target to listen on: stay opaque rather than throwing.
  if (typeof window === 'undefined') return Promise.resolve(null)
  const existing = window[GLASS_GLOBAL]
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const onReady = (event: Event): void => {
      clearTimeout(timer)
      window.removeEventListener(GLASS_EVENT, onReady)
      resolve((event as CustomEvent<BackgroundGlassApi>).detail ?? null)
    }
    const timer = setTimeout(() => {
      window.removeEventListener(GLASS_EVENT, onReady)
      resolve(null)
    }, timeoutMs)
    window.addEventListener(GLASS_EVENT, onReady)
  })
}

/**
 * Whether a resolved bridge is the one this helper can drive.
 * @param glass - the value resolved by {@link whenGlassReady}.
 * @returns true when the identity and contract version both match.
 */
export function isCompatibleGlass(glass: BackgroundGlassApi | null): glass is BackgroundGlassApi {
  return glass !== null
    && glass.bridgeId === GLASS_BRIDGE_ID
    && glass.version === GLASS_BRIDGE_VERSION
}
