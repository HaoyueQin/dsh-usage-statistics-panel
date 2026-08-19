/**
 * Swap this plugin's Settings-nav gear for a lucide-style BarChart3 icon.
 *
 * DSH 0.1.x projects only `id`, `order`, and `label` from a
 * `settings.section` registration, then chooses icons inside the settings
 * shell from a closed list of built-in ids — a third-party section always
 * gets the fallback gear. Until that public contract grows an icon field,
 * this module finds the nav button whose text equals this plugin's localized
 * label and injects a BarChart3 SVG in place of the shell's gear glyph. The
 * marker carries no shell structure and is removed on fiber disposal, so the
 * adaptation stays HMR-safe.
 *
 * The SVG is built with the DOM API (createElementNS) — a React element is a
 * plain JS object and cannot be prepended into the live DOM.
 */
export const SETTINGS_NAV_MARKER = 'data-dsh-usage-stats-nav'

/** The lucide BarChart3 path data (24x24 stroke icon). */
const BAR_CHART_PATH =
  'M3 3v18h18 M18 17V9 M13 17V5 M8 17v-3'

function buildIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', BAR_CHART_PATH)
  svg.appendChild(path)
  return svg
}

/**
 * Keep the marker on the settings-nav button whose visible text is this
 * plugin's current localized section label, and ensure it shows the
 * BarChart3 icon (removing the shell's gear glyph when present).
 * @param label - locale-aware label resolver used by the section registration.
 * @returns disposer that disconnects observation and removes owned markers.
 */
export function registerSettingsNavIcon(label: () => string): () => void {
  let disposed = false

  const swapIcon = (button: HTMLButtonElement): void => {
    if (disposed) return
    if (button.querySelector(`[${SETTINGS_NAV_MARKER}-icon]`)) return // already swapped
    // The shell renders the gear as an inline SVG; drop it so the BarChart3
    // becomes the button's only glyph.
    const gear = button.querySelector<SVGElement>('svg')
    if (gear) gear.remove()
    const icon = buildIcon()
    icon.setAttribute(SETTINGS_NAV_MARKER + '-icon', '')
    button.prepend(icon)
  }

  const sync = (): void => {
    if (disposed) return
    const currentLabel = label().trim()
    if (!currentLabel) return
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      // Compare against the button's text EXCLUDING any icon we injected —
      // the previous pass may have already added an SVG whose textContent is
      // empty, so a plain textContent compare stays safe.
      const text = button.textContent?.trim() ?? ''
      const matches = text === currentLabel
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
    document.querySelectorAll(`[${SETTINGS_NAV_MARKER}-icon]`)
      .forEach((element) => element.remove())
  }
}
