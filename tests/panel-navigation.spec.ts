/**
 * The standalone panel's back control: the history it reconstructs.
 *
 * The shell keeps no navigation history — `ctx.layout.selectPanel` writes a
 * selection and nothing else — so this bundle reconstructs "where the reader
 * came from" by watching the selection and remembering what it displaced.
 * These tests pin that reconstruction and its failure mode: a remembered panel
 * that has since been unregistered makes `selectPanel` throw, and a throw would
 * strand the reader on this panel behind a control that does nothing, so the
 * action has to fall back to the Conversation instead.
 *
 * The control's rendering is covered by panel.spec.tsx, which already mounts
 * this entry for the content-column assertion.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { apply, inject, PANEL_ID } from '../src/client/index.tsx'
import type { Context, UsageSlotEntrySpec } from '../src/context-types.ts'

interface FakeLayout {
  active: string | null
  /** Every selection this fake was asked for, in order. */
  selected: Array<string | null>
  /** Keys that throw when selected, standing in for an unregistered panel. */
  unregistered: Set<string>
  selectPanel(panelId: string | null): void
}

function fakeCtx(initialPanel: string | null = null): {
  ctx: Context
  layout: FakeLayout
  specs: UsageSlotEntrySpec[]
} {
  const listeners: Array<() => void> = []
  const specs: UsageSlotEntrySpec[] = []
  const layout: FakeLayout = {
    active: initialPanel,
    selected: [],
    unregistered: new Set(),
    selectPanel(panelId: string | null): void {
      // The real controller throws on an unknown key and keeps the selection.
      if (panelId !== null && layout.unregistered.has(panelId)) {
        throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
      }
      layout.selected.push(panelId)
      layout.active = panelId
      for (const listener of [...listeners]) listener()
    },
  }

  const ctx = {
    effect: (fn: () => void | (() => void)) => { fn() },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, callback: () => void | (() => void)) => { callback() },
      register: (spec: UsageSlotEntrySpec) => { specs.push(spec); return () => {} },
    },
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: layout.active }),
        subscribe: (listener: () => void) => {
          listeners.push(listener)
          return () => {
            const at = listeners.indexOf(listener)
            if (at >= 0) listeners.splice(at, 1)
          }
        },
      },
      selectPanel: (panelId: string | null) => { layout.selectPanel(panelId) },
    },
  } as unknown as Context

  return { ctx, layout, specs }
}

/** Pull the action the main-panel registration injects into its component. */
function goBackOf(specs: UsageSlotEntrySpec[]): () => void {
  const main = specs.find((spec) => spec.name === 'main')
  expect(main).toBeDefined()
  expect(typeof main!.inject).toBe('function')
  return (main!.inject!() as { goBack: () => void }).goBack
}

describe('panel history', () => {
  it('requires the layout service', () => {
    expect(inject).toContain('layout')
  })

  it('returns to the Conversation when the reader came from there', () => {
    const { ctx, layout, specs } = fakeCtx(null)
    apply(ctx)
    layout.selectPanel(PANEL_ID)
    goBackOf(specs)()
    expect(layout.selected.at(-1)).toBeNull()
  })

  it('returns to the panel the reader came from', () => {
    const { ctx, layout, specs } = fakeCtx('plugins')
    apply(ctx)
    layout.selectPanel(PANEL_ID)
    goBackOf(specs)()
    expect(layout.selected.at(-1)).toBe('plugins')
  })

  it('records the panel it displaced, not an earlier one', () => {
    // a -> b -> this panel must come back to b, not a.
    const { ctx, layout, specs } = fakeCtx('session')
    apply(ctx)
    layout.selectPanel('plugins')
    layout.selectPanel(PANEL_ID)
    goBackOf(specs)()
    expect(layout.selected.at(-1)).toBe('plugins')
  })

  it('falls back to the Conversation when the remembered panel is gone', () => {
    const { ctx, layout, specs } = fakeCtx('plugins')
    apply(ctx)
    layout.selectPanel(PANEL_ID)
    layout.unregistered.add('plugins')
    expect(() => goBackOf(specs)()).not.toThrow()
    expect(layout.selected.at(-1)).toBeNull()
  })

  it('never records this panel itself as the target', () => {
    // Re-selecting the same panel is not a navigation: pressing back must still
    // leave the panel rather than no-op on itself.
    const { ctx, layout, specs } = fakeCtx('plugins')
    apply(ctx)
    layout.selectPanel(PANEL_ID)
    layout.selectPanel(PANEL_ID)
    goBackOf(specs)()
    expect(layout.selected.at(-1)).toBe('plugins')
  })
})
