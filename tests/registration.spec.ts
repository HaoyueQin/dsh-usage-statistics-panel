/**
 * Client-half registration surface: the panel must live on the Plugins page
 * (`plugins.bundle.config`, keyed by this bundle's npm name), and the retired
 * Settings section must be gone. A fake ctx records every registration, so a
 * future edit that silently re-adds `settings.section` or changes the key
 * fails here instead of in the browser.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, BUNDLE_NAME, PLUGINS_PANEL_ID, type UsageStatsInjected } from '../src/client/index.tsx'
import type { Context, UsageSlotEntrySpec } from '../src/context-types.ts'

interface Recorded extends UsageSlotEntrySpec {
  inject?: () => object
}

function fakeCtx(): { ctx: Context; recorded: Recorded[]; selected: string[] } {
  const recorded: Recorded[] = []
  const selected: string[] = []
  const ctx = {
    effect: (fn: () => void | (() => void)) => { fn() },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    layout: {
      selectPanel: (panelId: string | null) => { if (panelId !== null) selected.push(panelId) },
      toggleSidebar: () => {},
    },
    slots: {
      // The framework defers the factory until the slot is declared; the fake
      // declares every slot immediately, which is the steady state.
      inject: (_name: string, callback: () => void | (() => void)) => { callback() },
      register: (spec: Recorded) => { recorded.push(spec); return () => {} },
    },
  } as unknown as Context
  return { ctx, recorded, selected }
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

  it('no longer registers a Settings section', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'settings.section')).toBe(false)
  })

  it('keeps the sidebar quick entry and the composer-dock takeover', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'sidebar.footer.action')).toBe(true)
    expect(recorded.some((r) => r.name === 'conversation.composer.dock')).toBe(true)
  })

  it('the quick entry inject face switches to the Plugins panel', () => {
    const { ctx, recorded, selected } = fakeCtx()
    apply(ctx)
    const entry = recorded.find((r) => r.name === 'sidebar.footer.action')!
    const face = entry.inject?.() as UsageStatsInjected | undefined
    expect(face).toBeDefined()
    face!.openPanel()
    expect(selected).toEqual([PLUGINS_PANEL_ID])
    expect(PLUGINS_PANEL_ID).toBe('plugins')
  })
})
