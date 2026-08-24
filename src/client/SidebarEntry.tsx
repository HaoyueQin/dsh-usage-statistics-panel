/**
 * The "Usage statistics" quick entry at the sidebar foot, registered into the
 * sidebar's `sidebar.footer.action` list slot so it stacks ABOVE the Settings
 * trigger. It only renders while the user enabled it in the panel's settings
 * row (see sidebarEntryState); the shared state lives in the same bundle, so
 * toggling the preference in Settings mounts/unmounts this entry immediately.
 *
 * Clicking it opens the Settings dialog and selects the "Usage statistics"
 * section. The Settings shell keeps its open state and active section id as
 * component-local state with no public API, so the open is driven through the
 * trigger's real click and the section's nav-row click (the same label-matching
 * convention as settings-nav-icon.ts).
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
// Type-only: pulls the sidebar's SlotMap merge ('sidebar.footer.action') and
// its owner props into this program. Cross-plugin collaboration goes through
// slots, never a value import (client bundle-purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { StatsIcon } from './stats-icon.tsx'
import { sidebarEntryState } from './sidebar-entry-state.ts'
import { LOCALE_NS } from './locales.ts'
import css from './SidebarEntry.module.css'

/** Full component props: the sidebar foot owner share (wide/rail) + the locale seat. */
export type SidebarEntryProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof LOCALE_NS>

/**
 * Open the Settings dialog and jump to the "Usage statistics" section.
 * @param from - this entry's own button; the settings trigger lives in the
 *   same sidebar-foot ancestor (footer actions stack directly above it).
 * @param label - the section's current localized nav label.
 */
export function openUsageStatsSection(from: HTMLElement, label: string): void {
  // The one dialog-trigger button inside the sidebar foot IS the settings
  // trigger. Walk up from this entry's button until an ancestor contains it
  // (the footer-actions wrapper, then the shared foot area).
  let scope: HTMLElement | null = from
  while (scope !== null) {
    const trigger = scope.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
    if (trigger !== null) {
      trigger.click()
      break
    }
    scope = scope.parentElement
  }
  // React 18 flushes the trigger's state update synchronously after the click,
  // but a rAF is a safe margin for the dialog subtree to settle. If the dialog
  // was already open, the trigger click is a no-op and we just switch section.
  requestAnimationFrame(() => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      if ((button.textContent?.trim() ?? '') === label.trim()) {
        button.click()
        return
      }
    }
  })
}

/**
 * Render the sidebar quick entry (a no-op null when the preference is off).
 * @param props - the composed slot props.
 * @returns the entry button, or null while disabled.
 */
export function SidebarEntry({ wide, t }: SidebarEntryProps) {
  const [enabled, setEnabled] = useState(sidebarEntryState.enabled)
  useEffect(() => sidebarEntryState.subscribe(() => { setEnabled(sidebarEntryState.enabled) }), [])
  if (!enabled) return null
  const label = t('nav')
  return (
    <button
      type="button"
      className={clsx(css.entry, !wide && css.rail)}
      aria-label={label}
      title={label}
      onClick={(event) => { openUsageStatsSection(event.currentTarget, label) }}
    >
      <StatsIcon size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{label}</span>}
    </button>
  )
}
