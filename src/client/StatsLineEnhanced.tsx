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
 */
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSnapshot, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
// Type-only: merges the tokenUsage key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-token-meter/client'
// Type-only: pulls the composer.dock SlotMap merge (conversation contract) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LOCALE_NS } from './locales.ts'
import { statsLineState } from './stats-line-state.ts'
import {
  billedInputTokens, cacheHitPercent, cacheHitPercentPrecise, deriveStats,
  formatDuration, formatTokens, formatTokensPerSecond, tokenBreakdown,
} from './stats-line-core.ts'
import css from './StatsLineEnhanced.module.css'

/** Full props: the standard session kit (hook-shaped selector + projection
 *  seat) plus the locale seat this entry declares. */
export interface StatsLineEnhancedProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  t: PropsLocale<typeof LOCALE_NS>['t']
}

export const StatsLineEnhanced = memo(function StatsLineEnhanced(
  { useSession, useProjection, t }: StatsLineEnhancedProps,
) {
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names).
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])

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
        total: formatTokens(b.total),
        input: formatTokens(b.input),
        hit: formatTokens(b.cacheHit),
        miss: formatTokens(b.cacheMiss),
        output: formatTokens(b.output),
      }))
    } else {
      groups.push(t('stats.tokens', {
        input: formatTokens(billedInputTokens(usage)),
        output: formatTokens(usage.outputTokens),
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
