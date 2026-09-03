/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context augmentation both halves share. A third-party plugin resolves
 * outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module 'cordis'` augmentations do not reach this Context — and
 * the npm cordis package does not declare the DSH-vendored runtime members
 * (`ctx.effect`, service properties). The members below mirror the actual
 * runtime shapes this plugin touches:
 * - sessionPersistence: @deepseek-ai/dsh-session-persistence (SessionPersistence)
 * - sessions: host side @deepseek-ai/dsh-session (SessionStore), client side
 *   the runtime sessions list feed
 * - storageDomain: @deepseek-ai/dsh-storage-domain (domain hub)
 * - webServer: @deepseek-ai/dsh-host-webserver (the WebServer)
 * - settings: @deepseek-ai/dsh-settings (settings namespace seam)
 * - slots: the client slot registry (ui-slots)
 * - locale: the client locale service
 * - connection: the client connection handle
 * Drift from upstream is contained to this file.
 *
 * This file must stay FREE of Node.js types (`node:http`, `node:stream`,
 * `Buffer`): it is part of the CLIENT-reachable declaration graph (the
 * `Context` in client components), so a Node import here would leak into
 * browser-only consumer builds. The webServer faces below are therefore
 * structural mirrors with plain interfaces.
 */
import type { Context } from 'cordis'

/** The request face route handlers see (structural subset of node's
 *  IncomingMessage: the URL/method/header reads and the async body
 *  iteration `readJsonBody` uses). */
export interface UsageHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/** The response face route handlers write to (structural subset of node's
 *  ServerResponse: the status/header/body writes the routes use). */
export interface UsageHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface UsageWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: UsageHttpRequest, res: UsageHttpResponse) => void | Promise<void>
}

/** The webserver service (mirror of @deepseek-ai/dsh-host-webserver). */
export interface UsageWebServer {
  register(route: UsageWebRoute): () => void
}

/** A session header row (mirror of @deepseek-ai/dsh-session-persistence). */
export interface UsageSessionHeader {
  version?: number
  id: string
  createdAt?: number
  cwd?: string
  parentSession?: string
  delegationDepth?: number
}

/** A session event (mirror of @deepseek-ai/dsh-session SessionEvent). */
export interface UsageSessionEvent<T = unknown> {
  type: string
  seq: number
  time: number
  data: T
}

/** Token usage attached to assistant messages (mirror of dsh-llm TokenUsage). */
export interface UsageTokens {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** One persistence inspection (mirror of dsh-session-persistence's
 *  SessionInspection, DSH >= 0.1.2-rc.1). `inheritedEventCount` is the exact
 *  fork-inherited prefix length — 0 for a non-forked session — and is always
 *  reported by this host line. */
export interface UsageSessionInspection {
  meta: UsageSessionHeader
  events: UsageSessionEvent[]
  /** Number of leading events this forked session copied from its parent. */
  inheritedEventCount: number
}

/** The session persistence service (mirror of @deepseek-ai/dsh-session-persistence). */
export interface UsageSessionPersistence {
  list(signal?: AbortSignal): Promise<UsageSessionHeader[]>
  inspect(id: string, signal?: AbortSignal): Promise<UsageSessionInspection>
}

/** The route a session's log records for its model calls (mirror of
 *  dsh-agent-loop RequestContext). */
export interface UsageSessionRoute {
  provider?: string
  model?: string
  contextWindow?: number
}

/** A live session handle (mirror of @deepseek-ai/dsh-session SessionStore
 *  members this plugin touches; `requestContext` is the authoritative fold
 *  of the log's `request/context` events and `seq` the log's next-sequence
 *  watermark — both exposed by every real Session). */
export interface UsageSessionHandle {
  id: string
  cwd?: string
  createdAt?: number
  requestContext?(): UsageSessionRoute | undefined
  /** The session log's next event seq (= its current length; the real
   *  Session exposes this as a getter). /reset captures it as the wipe-time
   *  rebuild watermark. */
  seq?: number
}

/** The live session store (mirror of @deepseek-ai/dsh-session SessionStore). */
export interface UsageSessionStore {
  list(): UsageSessionHandle[]
  get(id: string): UsageSessionHandle | undefined
}

/** A storage domain table (mirror of @deepseek-ai/dsh-storage-domain KvTable). */
export interface UsageKvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** A storage domain handle (mirror of @deepseek-ai/dsh-storage-domain Domain). */
export interface UsageDomain {
  table(name: string): UsageKvTable<string, unknown>
  global: { get(): unknown; set(value: unknown): Promise<void> }
}

/** The storage domain service (mirror of @deepseek-ai/dsh-storage-domain). */
export interface UsageStorageDomain {
  open(spec: { name: string; version: number; tables: Record<string, unknown> }): Promise<UsageDomain>
}

/** A settings namespace (mirror of @deepseek-ai/dsh-settings). */
export interface UsageSettingsNamespace {
  (id: string): string
}

/** The settings service (mirror of @deepseek-ai/dsh-settings). */
export interface UsageSettingsService {
  scope(namespace: string): {
    get(): unknown
    set(value: unknown): Promise<void>
  }
}

/** One slots.register spec (mirror of the client ui-slots registration shape). */
export interface UsageSlotEntrySpec {
  name: string
  id?: string
  order?: number
  priority?: number
  label?: () => string
  locale?: string
  inject?: () => object
}

/** The client slot registry service (mirror of the client store/ui-slots). */
export interface UsageSlotsService {
  /** Wait for (or run against) the named slot's declaration. The callback
   *  returns one disposer or an iterable of disposers (a generator yield
   *  several register calls as one transaction). */
  inject(
    name: string,
    callback: () => void | (() => void) | Iterable<() => void>,
  ): void
  register(spec: UsageSlotEntrySpec, component: unknown): () => void
}

/** The client-side locale service (mirror of @deepseek-ai/dsh-client-locale). */
export interface UsageLocaleService {
  /** Single-locale form: one dictionary for one locale tag. */
  register(namespace: string, locale: string, dict: Record<string, string>): () => void
  /** All-locales form: complete dictionaries keyed by built-in locale id. */
  register(namespace: string, dicts: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
  /** The active locale id ("zh" | "zh-TW" | "en"), for locale-aware formatting. */
  getLocale(): { active: string }
}

/** The client connection handle (mirror of @deepseek-ai/dsh-client-connection). */
export interface UsageConnection {
  api: {
    call(method: string, params: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
  }
}

declare module 'cordis' {
  interface Context {
    effect(dispose: () => void | (() => void), label?: string): void
    sessionPersistence: UsageSessionPersistence
    sessions: UsageSessionStore
    storageDomain: UsageStorageDomain
    webServer: UsageWebServer
    settings: UsageSettingsService
    slots: UsageSlotsService
    locale: UsageLocaleService
    connection: UsageConnection
  }
}

/** The augmented cordis Context (host + client halves). */
export type { Context }
