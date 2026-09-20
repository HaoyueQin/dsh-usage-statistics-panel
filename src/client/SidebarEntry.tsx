/**
 * The "Usage statistics" quick entry at the sidebar foot, registered into the
 * sidebar's `sidebar.footer.action` list slot so it stacks above the Settings
 * trigger. It renders only while the user enabled it in the panel (see
 * sidebarEntryState); the shared state lives in the same bundle, so toggling
 * the preference mounts/unmounts this entry immediately.
 *
 * Clicking it opens the Plugins page on this bundle's detail page. The
 * navigation itself rides the registration's injected face (see index.tsx), so
 * this component owns nothing but its button.
 *
 * Sizing note: the seat is a plain flex row shared with every other plugin's
 * footer action, so this button must NOT opt out of shrinking — a `flex: none`
 * here makes the neighbours absorb the whole overflow and collapse them (see
 * docs/design-panel-migration.md §7).
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
// Type-only: pulls the sidebar's SlotMap merge ('sidebar.footer.action') and
// its owner props into this program. Cross-plugin collaboration goes through
// cordis services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageStatsInjected } from './index.tsx'
import { StatsIcon } from './stats-icon.tsx'
import { sidebarEntryState } from './sidebar-entry-state.ts'
import { LOCALE_NS } from './locales.ts'
import css from './SidebarEntry.module.css'

/** Full component props: the sidebar foot owner share (wide/rail), the locale
 *  seat, and the injected navigation face. */
export type SidebarEntryProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof LOCALE_NS>
  & InjectFace<UsageStatsInjected>

/**
 * Render the sidebar quick entry (a no-op null when the preference is off).
 * @param props - the composed slot props.
 * @returns the entry button, or null while disabled.
 */
export function SidebarEntry({ wide, t, openPanel }: SidebarEntryProps) {
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
      onClick={() => { openPanel() }}
    >
      <StatsIcon size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{label}</span>}
    </button>
  )
}
