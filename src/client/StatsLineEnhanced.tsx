/**
 * StatsLineEnhanced - the shadowing entry for `conversation.composer.dock`
 * (id 'stats', priority -1): replicates the official ui-chat StatsPills
 * (DSH 0.1.5-alpha.1) - a gauge pill (turn/step counts + output speed,
 * click opens the time-and-speed dialog) and a database pill (total tokens
 * + cache hit, click opens the token-usage dialog). The official package is
 * not a client-bundle external, so its internals cannot be imported; the
 * replicated pure folds live in stats-line-core (same derivation, covered by
 * the core tests) and the dialog seat in stat-dialog.ts.
 *
 * Two plugin-side readouts ride the same pills: with precise cache hit rate
 * on, the hit figure renders two decimals; with the session token breakdown
 * on, the usage dialog gains the cache-miss row. Both toggles live in
 * stats-line-state.ts (shared with the settings panel) and apply instantly.
 *
 * Kernel contract (DSH >= 0.1.2-rc.1): the slot's standard session selector
 * is injected as `useChat` over the ui-chat ChatSnapshot; the `legacy.nodes`
 * compatibility projection carries the ConversationNode[] that officially
 * backs the pills, and the durable sessionStats projection stays the primary
 * source.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutline16, IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS } from './locales.ts'
import { statsLineState } from './stats-line-state.ts'
import { MEASURE_STYLE, useStatDialog, type StatDialogSeat } from './stat-dialog.ts'
import {
  billedInputTokens, cacheHitPercent, cacheHitPercentPrecise, deriveStats,
  formatDuration, formatTokensCompact, formatTokensPerSecond, tokenBreakdown,
  type ConversationNodeLike, type UseProjection, type WindowStats,
} from './stats-line-core.ts'
import { formatTokens } from './format.ts'
import css from './StatsLineEnhanced.module.css'

/**
 * Structural type for the `useChat` seat: the standard snapshot selector over
 * the ui-chat ChatSnapshot, whose `legacy.nodes` compatibility projection
 * carries the ConversationNode[] the official pills read. Declared locally
 * because the seat is consumed structurally at runtime (injected by the slot
 * declaration) and never value-imported.
 */
type ChatSnapshotSelectorHook = SnapshotSelectorHook<{ legacy: { nodes?: readonly ConversationNodeLike[] } }>

/**
 * Full props: the standard session kit (selector + projection seat) plus the
 * locale seat this entry declares. `useChat` is injected by the slot
 * declaration on DSH >= 0.1.2-rc.1.
 */
export interface StatsLineEnhancedProps {
  /** The chat-view snapshot selector (path `legacy.nodes`). */
  useChat: ChatSnapshotSelectorHook
  useProjection: UseProjection
  t: PropsLocale<typeof LOCALE_NS>['t']
}

type T = StatsLineEnhancedProps['t']

/** External open state one pill's dialog reads and writes (the row's exclusive slot). */
type PillDialog = Pick<StatDialogSeat, 'open' | 'setOpen'>

function TimePill({ stats, t, dialog }: {
  stats: WindowStats
  t: T
  dialog: PillDialog
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  const tps = stats.decodeMs > 0
    ? t('stats.tokensPerSecond', {
      throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
    })
    : null
  const label = (
    <span className={css.label}>
      {counts}
      {tps !== null && (
        <>
          <span className={css.sep} aria-hidden>·</span>
          {tps}
        </>
      )}
    </span>
  )
  // A window without one timed figure has no dialog rows to show, so the pill
  // stays a plain reading instead of a button opening an empty dialog.
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && stats.decodeMs <= 0) {
    return (
      <span className={css.anchor}>
        <span className={css.pill}>
          <IconGaugeOutline16 />
          {label}
        </span>
      </span>
    )
  }
  return (
    <span ref={rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={tps === null ? counts : counts + ' · ' + tps}
        onClick={() => { setOpen(!open) }}
      >
        <IconGaugeOutline16 />
        {label}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.dialogPanel}
          role="dialog"
          aria-label={t('stats.dialog.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.dialogTitle}>
            <span className={css.dialogTitleLabel}>
              <IconGaugeOutline16 />
              {t('stats.dialog.title')}
            </span>
          </div>
          <div className={css.dialogTitleRule} aria-hidden />
          <dl className={css.dialogDetails} data-session-stats-details>
            {stats.llmMs > 0 && (
              <>
                <dt>{t('stats.dialog.llmTime')}</dt>
                <dd>{formatDuration(stats.llmMs)}</dd>
              </>
            )}
            {stats.toolMs > 0 && (
              <>
                <dt>{t('stats.dialog.toolTime')}</dt>
                <dd>{formatDuration(stats.toolMs)}</dd>
              </>
            )}
            {stats.ttftSteps > 0 && (
              <>
                <dt>{t('stats.dialog.ttft')}</dt>
                <dd>{formatDuration(stats.ttftMs / stats.ttftSteps)}</dd>
              </>
            )}
            {stats.decodeMs > 0 && (
              <>
                <dt>{t('stats.dialog.speed')}</dt>
                <dd>{t('stats.tokensPerSecond', {
                  throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
                })}</dd>
              </>
            )}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

function UsagePill({ usage, t, dialog, cachePrecision, tokenDetail }: {
  usage: Parameters<typeof billedInputTokens>[0]
  t: T
  dialog: PillDialog
  cachePrecision: boolean
  tokenDetail: boolean
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  // Same aggregate as the official pill total: every prompt-side billing bucket plus output.
  const total = billedInputTokens(usage) + usage.outputTokens
  const totalText = t('message.turnUsage.count', { count: formatTokensCompact(total) })
  const cacheHit = cachePrecision ? cacheHitPercentPrecise(usage) : cacheHitPercent(usage)
  const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
  const exactCount = (value: number): string =>
    t('message.turnUsage.count', { count: formatTokens(value) })
  return (
    <span ref={rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={cacheHitText === null ? totalText : totalText + ' · ' + cacheHitText}
        onClick={() => { setOpen(!open) }}
      >
        <IconDatabaseOutline16 />
        <span className={css.label}>
          {totalText}
          {cacheHitText !== null && (
            <>
              <span className={css.sep} aria-hidden>·</span>
              {cacheHitText}
            </>
          )}
        </span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.dialogPanel}
          role="dialog"
          aria-label={t('stats.dialog.usageTitle')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.dialogTitle}>
            <span className={css.dialogTitleLabel}>
              <IconDatabaseOutline16 />
              {t('stats.dialog.usageTitle')}
            </span>
            <span className={css.dialogTitleValue}>{exactCount(total)}</span>
          </div>
          <div className={css.dialogTitleRule} aria-hidden />
          <dl className={css.dialogDetails} data-session-stats-usage>
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{cacheHit + '%'}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{exactCount(usage.uncachedInputTokens)}</dd>
            <dt>{t('message.turnUsage.cacheRead')}</dt>
            <dd>{exactCount(usage.cacheReadTokens)}</dd>
            <dt>{t('message.turnUsage.cacheWrite')}</dt>
            <dd>{exactCount(usage.cacheWriteTokens)}</dd>
            {tokenDetail && (
              <>
                <dt>{t('stats.cacheMiss')}</dt>
                <dd>{exactCount(tokenBreakdown(usage).cacheMiss)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>{exactCount(usage.outputTokens)}</dd>
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

export const StatsLineEnhanced = memo(function StatsLineEnhanced(
  { useChat, useProjection, t }: StatsLineEnhancedProps,
) {
  const settledNodes = useChat(s => s.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // One exclusive slot for both dialogs: opening either pill closes the other.
  const [openPill, setOpenPill] = useState<'time' | 'usage' | null>(null)
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
  // Gated on actual token activity: a session whose steps all settled without
  // billing (e.g. every request failed) shows its counts without a usage pill.
  const hasTokens = usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  if (stats.steps === 0 && !hasTokens) return null
  // data-composer-stats: InputBar tightens the composer bottom clearance only
  // while this row renders (same contract as the official pills).
  return (
    <div className={css.root} data-composer-stats>
      {stats.steps > 0 && (
        <TimePill
          stats={stats}
          t={t}
          dialog={{
            open: openPill === 'time',
            setOpen: (open) => { setOpenPill(open ? 'time' : null) },
          }}
        />
      )}
      {hasTokens && (
        <UsagePill
          usage={usage}
          t={t}
          dialog={{
            open: openPill === 'usage',
            setOpen: (open) => { setOpenPill(open ? 'usage' : null) },
          }}
          cachePrecision={cachePrecision}
          tokenDetail={tokenDetail}
        />
      )}
    </div>
  )
})
