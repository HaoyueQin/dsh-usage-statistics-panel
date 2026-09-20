/**
 * The "Usage statistics" panel's browser half. The panel lives on the Plugins
 * page, inside this bundle's own detail page: it registers into the keyed
 * `plugins.bundle.config` slot declared by ui-plugin-manager, under this
 * bundle's npm package name — the key that page matches on. The component
 * stays a pure renderer fed by the translator seat; the host half owns the
 * collector + store and the browser half only reads through the plugin's
 * /usage/api route.
 *
 * Two more seats ride the same bundle: the optional sidebar quick entry, and
 * the composer-dock takeover.
 *
 * Type note: the Plugins page's slot contract is mirrored in
 * src/context-types.ts rather than imported from ui-plugin-manager. That is
 * this plugin's standing convention for host contracts — a third-party plugin
 * resolves outside the DSH monorepo's declaration graph — and it keeps the
 * dependency list free of a package used for nothing but a two-field type.
 * Runtime collaboration stays on cordis services.
 */
import type { Context, UsagePluginConfigOwnerProps } from '../context-types.ts'
// Type-only: pulls the sidebar's SlotMap merge ('sidebar.footer.action') into
// this program so the quick-entry registration below typechecks against the
// shell's declared hole. Cross-plugin collaboration goes through cordis
// services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the composer.dock SlotMap merge (conversation contract) so
// the stats-line takeover registration below typechecks against the declared hole.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageStatsPanel } from './UsageStatsPanel.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { StatsLineEnhanced } from './StatsLineEnhanced.tsx'
import { LOCALE_NS, en, zh, zhTW, type UsageStatsKey } from './locales.ts'

/** This bundle's npm package name — the key the Plugins page matches on. */
export const BUNDLE_NAME = 'dsh-usage-statistics-panel'

/** The Plugins page's main-panel id. It has no value export this plugin may
 *  import (a cross-plugin value import fails the client bundle-purity gate),
 *  so the id is restated here. */
export const PLUGINS_PANEL_ID = 'plugins'

/** How long the quick entry waits for the bundle card to appear. */
const CARD_WAIT_MS = 1500

export interface UsageStatsInjected {
  /** Switch to the Plugins page and open this bundle's detail page. */
  openPanel: () => void
}

/** The typed translator seat the framework injects for this namespace. */
export type UsageStatsTranslator = TranslateNS<typeof LOCALE_NS>

export type UsageStatsSectionProps =
  UsagePluginConfigOwnerProps
  & PropsLocale<typeof LOCALE_NS>
  & InjectFace<UsageStatsInjected>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'usageStats': UsageStatsKey
  }
}

export const inject = ['slots', 'locale', 'layout']

/** The panel renderer. The Plugins page renders it as its own detail page
 *  (`view: 'page'`) and draws the title, the icon, and the crumb itself. */
export function UsageStatsSection(props: UsageStatsSectionProps): JSX.Element {
  return <UsageStatsPanel t={props.t} />
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

  // The panel: the Plugins page declares this keyed slot and renders the entry
  // on the page of the bundle whose package name equals the key. The
  // registration lives exactly as long as this bundle's row stays enabled.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    locale: LOCALE_NS,
  }, UsageStatsSection))

  // The sidebar quick entry: registered into the sidebar's footer-action list
  // slot so it stacks above the Settings trigger. The component itself returns
  // null until the user enables the preference in the panel, so the slot stays
  // declared and the button appears/disappears reactively. The navigation
  // rides the inject face so the component never reaches for a global context.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'usage-statistics',
    order: 0,
    locale: LOCALE_NS,
    inject: (): UsageStatsInjected => ({
      openPanel: () => { openBundlePage(ctx) },
    }),
  }, SidebarEntry))

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

/**
 * Switch to the Plugins page and open this bundle's detail page.
 *
 * The page keeps "which view is open" as component-local state with no public
 * API, so the only way in is to click the card the page itself renders. That
 * card carries `data-plugin-package`, a stable hook the page owns.
 * @param ctx - the browser plugin context, for the layout service.
 */
function openBundlePage(ctx: Context): void {
  try {
    ctx.layout.selectPanel(PLUGINS_PANEL_ID)
  } catch {
    // The Plugins page is not registered (its bundle is off): stay put.
    return
  }
  clickWhenPresent(`[data-plugin-package="${BUNDLE_NAME}"] button`)
}

/**
 * Click the first element matching `selector` as soon as it exists.
 * @param selector - CSS selector for the target control.
 * @param timeoutMs - give up after this long. The card never appears when the
 *   page is parked on another bundle's detail page, so this is best-effort by
 *   design (see docs/design-panel-migration.md §6.3).
 */
function clickWhenPresent(selector: string, timeoutMs = CARD_WAIT_MS): void {
  const hit = (): boolean => {
    const el = document.querySelector<HTMLButtonElement>(selector)
    if (el === null) return false
    el.click()
    return true
  }
  if (hit()) return
  const observer = new MutationObserver(() => {
    if (hit()) observer.disconnect()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  setTimeout(() => { observer.disconnect() }, timeoutMs)
}
