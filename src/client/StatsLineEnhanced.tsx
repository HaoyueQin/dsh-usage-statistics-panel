/**
 * StatsLineEnhanced — the shadowing entry for `conversation.composer.dock`
 * (id 'stats', priority -1): with both toggles off it replicates the official
 * ui-conversation StatsLine byte-for-byte (the replication is exercised by
 * the render tests); with the "precise cache hit rate" toggle on the
 * cache-hit group gains two decimals, and with the "session token breakdown"
 * toggle on the input/output pair becomes the five-item readout
 * (total / input / cache hit / cache miss / output).
 *
 * The official package is not a client-bundle external, so its internals
 * cannot be imported; the replicated pure functions live in stats-line-core
 * (official 0.1.1-rc.2), and the copy ships in this plugin's own locale
 * namespace (stats.* keys mirror the official conversation dictionary).
 *
 * Kernel tolerance (one bundle, two DSH generations): the slot's standard
 * session selector is injected as `useSession` on ≤0.1.1 (rc.2, snapshot path
 * `s.chat.legacy.nodes`) and as `useChat` on ≥0.1.2 (snapshot path
 * `s.legacy.nodes` — the ui-chat compatibility projection that officially
 * backs StatsLine). Both seats are optional props resolved at render time;
 * the same ConversationNode[] feeds deriveStats either way, and the durable
 * sessionStats projection stays the primary source on both kernels.
 */
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS } from './locales.ts'
import { statsLineState } from './stats-line-state.ts'
import {
  billedInputTokens, cacheHitPercent, cacheHitPercentPrecise, deriveStats,
  formatDuration, formatTokensCompact, formatTokensPerSecond, tokenBreakdown,
  type ConversationNodeLike, type ConversationSnapshotLike, type UseProjection,
} from './stats-line-core.ts'
import css from './StatsLineEnhanced.module.css'

/**
 * Structural type for the ≥0.1.2 `useChat` seat: the standard snapshot
 * selector over the ui-chat ChatSnapshot, whose `legacy.nodes` compatibility
 * projection carries the same ConversationNode[] the rc.2 ConversationSnapshot
 * nested at `chat.legacy.nodes`. Declared locally because no single kernel's
 * contract ships beside both generations — the seat is consumed structurally
 * at runtime and never value-imported.
 */
type ChatSnapshotSelectorHook = SnapshotSelectorHook<{ legacy?: { nodes?: readonly ConversationNodeLike[] } }>

/**
 * Full props: the standard session kit (hook-shaped selector + projection
 * seat) plus the locale seat this entry declares.
 *
 * Exactly one selector seat is injected per kernel generation (≤0.1.1:
 * `useSession`; ≥0.1.2: `useChat`), but both are optional here and resolved
 * defensively — a future kernel dropping both degrades the fallback fold to
 * an empty window instead of crashing the composer dock.
 */
export interface StatsLineEnhancedProps {
  /** ≤0.1.1 seat: the ConversationSnapshot selector (path `chat.legacy.nodes`). */
  useSession?: SnapshotSelectorHook<ConversationSnapshotLike>
  /** ≥0.1.2 seat: the chat-view snapshot selector (path `legacy.nodes`). */
  useChat?: ChatSnapshotSelectorHook
  useProjection: UseProjection
  t: PropsLocale<typeof LOCALE_NS>['t']
}

/**
 * Read the legacy ConversationNode list from either kernel's snapshot:
 * the ≥0.1.2 ChatSnapshot nests it at `legacy.nodes`, the ≤0.1.1
 * ConversationSnapshot at `chat.legacy.nodes`. The two paths never collide
 * (neither snapshot type declares the other's key). Returns undefined when
 * neither shape is present — a defensive tail, never observed in practice.
 */
function legacyNodesOf(snap: unknown): readonly ConversationNodeLike[] | undefined {
  if (snap === null || typeof snap !== 'object') return undefined
  const direct = (snap as { legacy?: { nodes?: unknown } }).legacy?.nodes
  if (Array.isArray(direct)) return direct as readonly ConversationNodeLike[]
  const nested = (snap as { chat?: { legacy?: { nodes?: unknown } } }).chat?.legacy?.nodes
  return Array.isArray(nested) ? (nested as readonly ConversationNodeLike[]) : undefined
}

export const StatsLineEnhanced = memo(function StatsLineEnhanced(
  { useChat, useSession, useProjection, t }: StatsLineEnhancedProps,
) {
  // Kernel-tolerant snapshot read: ≥0.1.2 injects `useChat`, ≤0.1.1 injects
  // `useSession`; the injected seat is a per-kernel constant, so the ?? pick
  // is stable across renders of one host. `?? []` only fires when neither
  // seat arrived — deriveStats then folds an empty window instead of throwing.
  const settledNodes = (useChat ?? useSession)?.(legacyNodesOf)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names).
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes ?? []), [projected, settledNodes])

  // Toggles live in the same client bundle as the settings panel; subscribe so
  // a flip in Settings updates the bottom bar immediately.
  const [cachePrecision, setCachePrecision] = useState(statsLineState.cachePrecision)
  const [tokenDetail, setTokenDetail] = useState(statsLineState.tokenDetail)
  useEffect(() => statsLineState.subscribe(() => {
    setCachePrecision(statsLineState.cachePrecision)
    setTokenDetail(statsLineState.tokenDetail)
  }), [])

  // Pipe-separated groups; a group with no data drops out whole.
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) {
      speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    }
    if (stats.decodeMs > 0) {
      speeds.push(t('stats.tokensPerSecond', {
        throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
      }))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  // Billing rides the durable projection, so these survive paging and
  // compaction. Gated on actual token activity: a session whose steps all
  // settled without billing shows its counts without a zero-token group.
  if (usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cachePrecision ? cacheHitPercentPrecise(usage) : cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    if (tokenDetail) {
      const b = tokenBreakdown(usage)
      groups.push(t('stats.tokensDetail', {
        total: formatTokensCompact(b.total),
        input: formatTokensCompact(b.input),
        hit: formatTokensCompact(b.cacheHit),
        miss: formatTokensCompact(b.cacheMiss),
        output: formatTokensCompact(b.output),
      }))
    } else {
      groups.push(t('stats.tokens', {
        input: formatTokensCompact(billedInputTokens(usage)),
        output: formatTokensCompact(usage.outputTokens),
      }))
    }
  }
  const line = groups.join(' | ')
  // The row elides with ellipsis when overlong; a delayed hover tooltip carries
  // the full line, enabled only while content is actually clipped.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return
    const measure = () => { setTruncated(el.scrollWidth > el.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [line])
  if (groups.length === 0) return null
  return (
    <Tooltip label={line} side="top" delayMs={500} disabled={!truncated}>
      <div ref={rootRef} className={css.root}>
        {groups.map((group, i) => (
          <Fragment key={group}>
            {i > 0 && <><span className={css.sep} aria-hidden>|</span>{' '}</>}
            <span>{group}</span>
          </Fragment>
        ))}
      </div>
    </Tooltip>
  )
})