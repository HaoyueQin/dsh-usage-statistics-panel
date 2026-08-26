/**
 * Tests for the settings-nav icon swap: on full disposal the shell's original
 * gear glyph must be restored (HMR/unload leaves the nav button unbroken).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { registerSettingsNavIcon, SETTINGS_NAV_MARKER } from '../src/client/settings-nav-icon.ts'

function buildNav(label: string): { dialog: HTMLDivElement; button: HTMLButtonElement; gear: SVGSVGElement } {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const nav = document.createElement('nav')
  const button = document.createElement('button')
  const gear = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  gear.setAttribute('aria-hidden', 'true')
  button.appendChild(gear)
  const text = document.createElement('span')
  text.textContent = label
  button.appendChild(text)
  nav.appendChild(button)
  dialog.appendChild(nav)
  document.body.appendChild(dialog)
  return { dialog, button, gear }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('registerSettingsNavIcon', () => {
  it('swaps the gear for the BarChart3 marker and restores the gear on dispose', async () => {
    const { button, gear } = buildNav('使用统计')
    const dispose = registerSettingsNavIcon(() => '使用统计')
    // sync() runs synchronously at registration.
    expect(button.querySelector(`[${SETTINGS_NAV_MARKER}-icon]`)).not.toBeNull()
    // The original gear lives outside the button now.
    expect(button.contains(gear)).toBe(false)

    dispose()
    expect(button.contains(gear)).toBe(true)
    expect(button.querySelector(`[${SETTINGS_NAV_MARKER}-icon]`)).toBeNull()
    expect(button.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)
    // The gear is back as the button's leading glyph.
    expect(button.firstElementChild).toBe(gear)
  })

  it('leaves unmatched nav buttons untouched', () => {
    const { button, gear } = buildNav('General')
    registerSettingsNavIcon(() => '使用统计')
    expect(button.contains(gear)).toBe(true)
    expect(button.hasAttribute(SETTINGS_NAV_MARKER)).toBe(false)
  })
})
