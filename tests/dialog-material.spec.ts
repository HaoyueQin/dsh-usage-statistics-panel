/**
 * The stat dialogs' menu material, pinned against host drift.
 *
 * The official ui-chat stat-dialog.module.css paints its panel with a PAIR
 * of declarations — `background: var(--dsw-specific-menu)` plus
 * `backdrop-filter: var(--dsw-menu-backdrop-filter)` — ever since the dsh
 * 0.1.7 menu redesign split the material into a translucent fill and a blur
 * chain. Copying only the fill (the 0.1.5-era opaque single-line recipe)
 * reads as bare transparency over the page (issue #6). One parsed rule
 * asserts the pairing stays intact.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  new URL('../src/client/StatsLineEnhanced.module.css', import.meta.url),
  'utf8',
)

/** The `.dialogPanel` rule body (a flat module sheet, no nested braces). */
const dialogPanel = css.match(/\.dialogPanel\s*\{([^}]*)\}/)

describe('stat dialog material', () => {
  it('pairs the official menu fill with the official blur', () => {
    expect(dialogPanel).not.toBeNull()
    expect(dialogPanel![1]).toContain('background: var(--dsw-specific-menu)')
    expect(dialogPanel![1]).toContain('backdrop-filter: var(--dsw-menu-backdrop-filter)')
  })
})
