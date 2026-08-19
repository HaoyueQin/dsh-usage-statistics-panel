/**
 * Swap this plugin's Settings-nav gear for a lucide icon.
 *
 * DSH 0.1.x projects only `id`, `order`, and `label` from a
 * `settings.section` registration, then chooses icons inside the settings
 * shell from a closed list of built-in ids — a third-party section always
 * gets the fallback gear. Until that public contract grows an icon field,
 * this module finds the nav button whose text equals this plugin's localized
 * label and injects a lucide SVG (BarChart3) in place of the shell's gear
 * glyph. The marker carries no shell structure and is removed on fiber
 * disposal, so the adaptation stays HMR-safe.
 */
import { createElement } from 'react'
import { BarChart3 } from 'lucide-react'

export const SETTINGS_NAV_MARKER = 'data-dsh-usage-stats-nav'

/**
 * Keep the marker on the settings-nav button whose visible text is this
 * plugin's current localized section label, and ensure it shows the lucide
 * icon (removing the shell's gear glyph when present).
 * @param label - locale-aware label resolver used by the section registration.
 * @returns disposer that disconnects observation and removes owned markers.
 */
export function registerSettingsNavIcon(label: () => string): () => void {
  let disposed = false

  const swapIcon = (button: HTMLButtonElement): void => {
    if (disposed) return
    if (button.querySelector('[data-usage-icon]')) return // already swapped
    // The shell renders the gear as an inline SVG; drop it so the lucide
    // icon becomes the button's only glyph.
    const gear = button.querySelector<SVGElement>('svg')
    if (gear) gear.remove()
    const icon = createElement(BarChart3, { size: 16, strokeWidth: 2, 'aria-hidden': true })
    const wrap = createElement('span', {
      'data-usage-icon': '',
      style: 'display:inline-block;vertical-align:-2px;margin-right:6px',
    }, icon)
    button.prepend(wrap as unknown as Node)
  }

  const sync = (): void => {
    if (disposed) return
    const currentLabel = label().trim()
    if (!currentLabel) return
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      const matches = button.textContent?.trim() === currentLabel
      if (matches) {
        button.setAttribute(SETTINGS_NAV_MARKER, '')
        swapIcon(button)
      } else {
        button.removeAttribute(SETTINGS_NAV_MARKER)
      }
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    disposed = true
    observer.disconnect()
    document.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`)
      .forEach((element) => element.removeAttribute(SETTINGS_NAV_MARKER))
  }
}
