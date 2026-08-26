/**
 * The "Usage statistics" settings section. The section registers into the
 * `settings.section` slot (a nav row in the Settings shell) with a locale
 * seat and an injected data face: the component fetches through the plugin's
 * /usage/api route instead of touching ctx directly, so the panel stays a
 * pure renderer. The host half owns the collector + store; this browser half
 * only reads.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the keyed slot's declaration. Cross-plugin collaboration goes
// through cordis services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the sidebar's SlotMap merge ('sidebar.footer.action') into
// this program so the quick-entry registration below typechecks against the
// shell's declared hole.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the composer.dock SlotMap merge (conversation contract) so
// the stats-line takeover registration below typechecks against the declared hole.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageStatsPanel } from './UsageStatsPanel.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { StatsLineEnhanced } from './StatsLineEnhanced.tsx'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { LOCALE_NS, en, zh, zhTW, type UsageStatsKey } from './locales.ts'

export interface UsageStatsInjected {
  /** Refresh the aggregate after the backfill completes. */
  backfill?: () => void
}

/** The typed translator seat the framework injects for this namespace. */
export type UsageStatsTranslator = TranslateNS<typeof LOCALE_NS>

export type UsageStatsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<typeof LOCALE_NS>
  & InjectFace<UsageStatsInjected>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'usageStats': UsageStatsKey
  }
}

export const inject = ['slots', 'locale']

/** The settings-section renderer: the panel is a pure renderer fed by the
 *  translator seat (the language switch re-renders the section through the
 *  locale seat). */
export function UsageStatsSection(props: UsageStatsSectionProps): JSX.Element {
  return <UsageStatsPanel t={props.t} />
}

export function apply(ctx: ClientContext): void {
  // Register the three dictionaries into the shared locale registry; the
  // disposers run on fiber disposal so re-activation (HMR) re-registers.
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    const offZhTw = ctx.locale.register(LOCALE_NS, 'zh-TW', zhTW)
    return () => { offZh(); offEn(); offZhTw() }
  }, 'dsh-usage-statistics-panel: dictionaries')

  const t = ctx.locale.bind(LOCALE_NS)

  // The Settings shell has no public icon field for third-party sections;
  // swap the fallback gear for a lucide BarChart3 on our localized nav row
  // (marker + inject, HMR-safe).
  ctx.effect(
    () => registerSettingsNavIcon(() => t('nav')),
    'dsh-usage-statistics-panel: settings navigation icon',
  )

  // The "Usage statistics" settings section: appears in the DSH Settings
  // shell once the shell's declaration is on the ledger (slots.inject waits
  // for it). The section renders the panel; the panel fetches through the
  // /usage/api route.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage-statistics',
    order: 30,
    label: () => t('nav'),
    locale: LOCALE_NS,
    inject: (): UsageStatsInjected => ({}),
  }, UsageStatsSection))

  // The sidebar quick entry: registered into the sidebar's footer-action list
  // slot so it stacks above the Settings trigger. The component itself returns
  // null until the user enables the preference in the panel's settings row, so
  // the slot stays declared and the button appears/disappears reactively.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'usage-statistics',
    order: 0,
    locale: LOCALE_NS,
  }, SidebarEntry))

  // The bottom-bar takeover: shadow the official StatsLine entry (same id
  // 'stats', lower priority — the slot's lowest live entry renders) so the
  // official line stays byte-equal while both toggles are off and gains the
  // two readouts (two-decimal cache hit rate, five-item token breakdown) when
  // they are on. Disposal restores the official entry automatically.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'stats',
    order: 0,
    priority: -1,
    locale: LOCALE_NS,
  }, StatsLineEnhanced))
}
