/**
 * Client-half registration surface: the panel must be reachable from two
 * places — the Plugins page (`plugins.bundle.config`, keyed by this bundle's
 * npm name) and its own sidebar row (`sidebar.panellist` plus the global main
 * panel that row selects) — and the retired seats must stay retired. A fake
 * ctx records every registration, so a future edit that silently re-adds a
 * Settings section, or moves the entry back into the shared footer row, fails
 * here instead of in the browser.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, BUNDLE_NAME, PANEL_ID } from '../src/client/index.tsx'
import type { Context, UsageSlotEntrySpec } from '../src/context-types.ts'

function fakeCtx(): { ctx: Context; recorded: UsageSlotEntrySpec[] } {
  const recorded: UsageSlotEntrySpec[] = []
  const ctx = {
    effect: (fn: () => void | (() => void)) => { fn() },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      // The framework defers the factory until the slot is declared; the fake
      // declares every slot immediately, which is the steady state.
      inject: (_name: string, callback: () => void | (() => void)) => { callback() },
      register: (spec: UsageSlotEntrySpec) => { recorded.push(spec); return () => {} },
    },
  } as unknown as Context
  return { ctx, recorded }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('client registration surface', () => {
  it('registers the panel on the Plugins page, keyed by the bundle name', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    const panel = recorded.find((r) => r.name === 'plugins.bundle.config')
    expect(panel).toBeDefined()
    expect(panel!.key).toBe(BUNDLE_NAME)
    expect(BUNDLE_NAME).toBe('dsh-usage-statistics-panel')
  })

  it('registers a global main panel and the sidebar row that selects it', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    const main = recorded.find((r) => r.name === 'main')
    const row = recorded.find((r) => r.name === 'sidebar.panellist')
    expect(main).toBeDefined()
    expect(row).toBeDefined()
    // The row addresses the panel by the same key the main slot declares.
    expect(main!.key).toBe(PANEL_ID)
    expect(row!.id).toBe(PANEL_ID)
  })

  it('keys the Plugins-page entry by the package name, not a copied literal', () => {
    // The page renders a bundle's own entry only when the registration key
    // EQUALS the bundle's npm package name, so a rename in package.json that
    // misses BUNDLE_NAME would silently drop the panel from the Plugins page.
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { name: string }
    expect(BUNDLE_NAME).toBe(pkg.name)
  })

  it('orders the sidebar row after the shipped panel rows, labelled from the dictionary', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    const row = recorded.find((r) => r.name === 'sidebar.panellist')!
    // The shipped Plugins page row registers at order 0 (ui-plugin-manager);
    // ours must sort after it, and its label must resolve through the bound
    // locale dictionary (the fake t returns the key verbatim).
    expect(row.order).toBe(30)
    expect(row.locale).toBe('usageStats')
    expect(row.label?.()).toBe('nav')
  })

  it('does not register into the shared footer row', () => {
    // That seat is one flex row shared with every other plugin's action, where
    // an entry competes for width instead of getting a row of its own.
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'sidebar.footer.action')).toBe(false)
  })

  it('no longer registers a Settings section', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'settings.section')).toBe(false)
  })

  it('keeps the composer-dock takeover', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'conversation.composer.dock')).toBe(true)
  })
})
