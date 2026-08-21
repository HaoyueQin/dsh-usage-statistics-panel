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
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageStatsPanel } from './UsageStatsPanel.tsx'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { LOCALE_NS, en, zh, zhTW, type UsageStatsKey } from './locales.ts'
import type { PanelLocale } from './format.ts'

export interface UsageStatsInjected {
  /** Refresh the aggregate after the backfill completes. */
  backfill?: () => void
  /** The active locale id ("zh" | "zh-TW" | "en"), read live at render time
   *  so number formatting follows the language switch. */
  locale?: () => string
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

/** Map the locale service's active id onto the panel's formatter locales. */
function panelLocaleOf(active: string | undefined): PanelLocale {
  return active === 'zh' ? 'zh' : active === 'zh-TW' ? 'zh-TW' : 'en'
}

/** The settings-section renderer: hands the locale seat and the active
 *  language to the panel (the language switch re-renders the section through
 *  the locale seat, so reading the getter at render time stays current). */
export function UsageStatsSection(props: UsageStatsSectionProps): JSX.Element {
  const locale = panelLocaleOf(props.locale?.())
  return <UsageStatsPanel t={props.t} locale={locale} />
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
  // for it). The section renders the panel; the injected face carries no
  // state beyond the locale (the panel fetches through the /usage/api route).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage-statistics',
    order: 30,
    label: () => t('nav'),
    locale: LOCALE_NS,
    inject: (): UsageStatsInjected => ({
      locale: () => ctx.locale.getLocale().active,
    }),
  }, UsageStatsSection))
}
