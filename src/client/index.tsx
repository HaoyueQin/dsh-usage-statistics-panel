/**
 * The "Usage statistics" panel's browser half.
 *
 * The panel renders in TWO places, both fed by the same component:
 *  - the Plugins page, inside this bundle's own detail page (the keyed
 *    `plugins.bundle.config` slot, keyed by this bundle's npm package name);
 *  - a global main panel of its own, reached from the "Usage statistics" row
 *    the sidebar draws under New Session beside the shipped global panels.
 *
 * The sidebar row is the quick way in, and it deliberately does NOT ride
 * `sidebar.footer.action`: that seat is a single flex row shared with every
 * other plugin's footer action, so an entry there competes for width with its
 * neighbours instead of getting a row of its own. A `sidebar.panellist` row is
 * a seat no other plugin shares, and the row is always present (like the
 * shipped panel rows), so there is no preference to control it.
 *
 * Type note: the host slot contracts this file needs are mirrored in
 * src/context-types.ts rather than imported from the owning packages, which is
 * this plugin's standing convention for host contracts.
 */
import type { Context, UsagePluginConfigOwnerProps } from '../context-types.ts'
// Type-only: pulls the sidebar's SlotMap merge ('sidebar.panellist') into this
// program so the row registration below typechecks against the shell's
// declared hole. Cross-plugin collaboration goes through cordis services; a
// value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the composer.dock SlotMap merge (conversation contract) so
// the stats-line takeover registration below typechecks against the declared hole.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageStatsPanel } from './UsageStatsPanel.tsx'
import { StatsIcon } from './stats-icon.tsx'
import { StatsLineEnhanced } from './StatsLineEnhanced.tsx'
import { LOCALE_NS, en, zh, zhTW, type UsageStatsKey } from './locales.ts'
import { isCompatibleGlass, whenGlassReady } from './glass.ts'
import css from './UsageStatsPanel.module.css'

/** This bundle's npm package name — the key the Plugins page matches on. */
export const BUNDLE_NAME = 'dsh-usage-statistics-panel'

/** The id shared by the sidebar row and the main panel it selects. */
export const PANEL_ID = 'usage-stats'

/** Where the row sits among the global panels: after the shipped ones. */
const PANEL_ORDER = 30

/** The attribute every glass-eligible surface in this bundle carries. The
 *  panel's class names are CSS Module hashes (`[hash]_local`), so a static
 *  selector cannot name them; this attribute is the stable handle the
 *  background plugin's glass registry matches on. The value only labels which
 *  surface it is — the registry rule is one recipe for all of them. */
const GLASS_SURFACE_SELECTOR = '[data-dsh-usage-glass]'

/** The typed translator seat the framework injects for this namespace. */
export type UsageStatsTranslator = TranslateNS<typeof LOCALE_NS>

export type UsageStatsSectionProps =
  UsagePluginConfigOwnerProps
  & PropsLocale<typeof LOCALE_NS>

/** The main-panel share: no owner props, only the locale seat. */
export type UsageStatsPanelPageProps = PropsLocale<typeof LOCALE_NS>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'usageStats': UsageStatsKey
  }
}

export const inject = ['slots', 'locale']

/** The panel as the Plugins page renders it: the page owns the title, the
 *  icon, and the crumb, so this is the bare panel. */
export function UsageStatsSection(props: UsageStatsSectionProps): JSX.Element {
  return <UsageStatsPanel t={props.t} />
}

/** The panel as a standalone main panel, wrapped in the same 960px content
 *  column the Plugins page gives it so both entries look identical. */
export function UsageStatsPanelPage(props: UsageStatsPanelPageProps): JSX.Element {
  return (
    <div className={css.page}>
      <UsageStatsPanel t={props.t} />
    </div>
  )
}

/** The sidebar row's glyph; the sidebar owns the button, the label, and the
 *  selected state around it. */
export function StatsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): JSX.Element {
  return <StatsIcon size={size} />
}

export function apply(ctx: Context): void {
  // Register the three dictionaries into the shared locale registry; the
  // disposers run on fiber disposal so re-activation (HMR) re-registers.
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    const offZhTw = ctx.locale.register(LOCALE_NS, 'zh-TW', zhTW)
    return () => { offZh(); offEn(); offZhTw() }
  }, 'dsh-usage-statistics-panel: dictionaries')

  // Join the background plugin's frosted-glass sheet when it is installed.
  // `fill` is the right mode for these surfaces: the panel paints with
  // `--dsw-alias-bg-layer-*` and `--dsw-alias-bg-overlay`, none of which the
  // bridge's `token` list covers, so the registry has to take the fill over as
  // well as add the sheen and blur. Nothing is value-imported from that
  // plugin — the contract is a browser global plus a ready event — so a user
  // who does not have it resolves null here and every surface keeps its own
  // paint. The handle is disposed with the fiber, which is also what retracts
  // the rules on uninstall.
  ctx.effect(() => {
    let unregister: (() => void) | undefined
    let disposed = false
    void whenGlassReady().then((glass) => {
      if (disposed || !isCompatibleGlass(glass)) return
      unregister = glass.register({
        plugin: BUNDLE_NAME,
        selectors: [GLASS_SURFACE_SELECTOR],
        mode: 'fill',
      })
    })
    return () => {
      disposed = true
      unregister?.()
    }
  }, 'dsh-usage-statistics-panel: frosted-glass surfaces')

  const t = ctx.locale.bind(LOCALE_NS)

  // The panel on the Plugins page: the page declares this keyed slot and
  // renders the entry on the page of the bundle whose package name equals the
  // key. The registration lives as long as this bundle's row stays enabled.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    locale: LOCALE_NS,
  }, UsageStatsSection))

  // The panel as a global main panel: it belongs to the profile, not to a
  // Session, and the sidebar row below addresses it by this key.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE_NS,
  }, UsageStatsPanelPage))

  // The sidebar row, under New Session beside the shipped global panels. A
  // panel row rather than a footer action: the footer seat is one shared flex
  // row where this entry would compete for width with every other plugin's.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => t('nav'),
    locale: LOCALE_NS,
  }, StatsPanelIcon))

  // The bottom-bar takeover: shadow the official StatsPills entry (same id
  // 'stats', lower priority — the slot's lowest live entry renders) so the
  // pills match the official ones while both toggles are off and gain the
  // two readouts when they are on. Disposal restores the official entry.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'stats',
    order: 0,
    priority: -1,
    locale: LOCALE_NS,
  }, StatsLineEnhanced))
}
