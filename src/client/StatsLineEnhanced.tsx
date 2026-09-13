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
 * The third toggle, streaming throughput, replaces the gauge pill's speed
 * figure with a live estimate while a step is still streaming and drops back to
 * the official session figure the moment it settles. That subscription lives in
 * its own child component so stream deltas never re-render the pills.
 *
 * Kernel contract (DSH >= 0.1.2-rc.1): the slot's standard session selector
 * is injected as `useChat` over the ui-chat ChatSnapshot; the `legacy.nodes`
 * compatibility projection carries the ConversationNode[] that officially
 * backs the pills, `legacy.partial` the in-flight assistant output, and the
 * durable sessionStats projection stays the primary source.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutline16, IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS } from './locales.ts'
import { statsLineState } from './stats-line-state.ts'
import { MEASURE_STYLE, useStatDialog, type StatDialogSeat } from './stat-dialog.ts'
import {
  billedInputTokens, cacheHitPercent, cacheHitPercentPrecise, deriveStats,
  estimateOutputTokens, formatDuration, formatTokensCompact, formatTokensPerSecond,
  measuredTokenScale, streamingTokensPerSecond, tokenBreakdown,
  type ConversationNodeLike, type PartialAssistantLike, type UseProjection, type WindowStats,
} from './stats-line-core.ts'
import { formatTokens } from './format.ts'
import css from './StatsLineEnhanced.module.css'

/**
 * Structural type for the `useChat` seat: the standard snapshot selector over
 * the ui-chat ChatSnapshot, whose `legacy.nodes` compatibility projection
 * carries the ConversationNode[] the official pills read and whose
 * `legacy.partial` carries the in-flight assistant output. Declared locally
 * because the seat is consumed structurally at runtime (injected by the slot
 * declaration) and never value-imported.
 */
type ChatSnapshotSelectorHook = SnapshotSelectorHook<{
  legacy: {
    nodes?: readonly ConversationNodeLike[]
    partial?: PartialAssistantLike | null
  }
}>

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

/** The separator + figure shape both speed arms render into the gauge pill.
 *  The figure sits in a width-reserved slot (css.speed): the live reading
 *  changes every second, and a slot that tracked its digits would reflow the
 *  centred row — and with it the counts pill — on every refresh. */
function SpeedFigure({ text }: { text: string | null }) {
  if (text === null) return null
  return (
    <>
      <span className={css.sep} aria-hidden>·</span>
      <span className={css.speed} data-stats-speed>{text}</span>
    </>
  )
}

/**
 * How often the live reading is recomputed while a step streams. Deltas arrive
 * every animation frame, but a decode rate is a quotient over a growing window:
 * refreshing it once a second keeps the figure stable and matches the reference
 * implementation this replicates (MiMo-Code's sidebar tps).
 */
const LIVE_SPEED_REFRESH_MS = 1_000

/**
 * The gauge pill's speed slot while the streaming-throughput preference is on.
 *
 * It subscribes to `legacy.partial` itself, and mounting is what turns that
 * subscription on — so with the preference off the pills stay entirely out of
 * the per-frame delta path, which is the same care the official StatsPills
 * takes. Until the streaming step has a measurable window the official session
 * figure stays on screen, so the slot is never empty and the handover at
 * settle is a plain value change.
 *
 * One window covers a whole step, across every output kind the accumulator
 * carries — reasoning, answer text, and Tool-call arguments — because the
 * provider bills all three as completion tokens and a step emits them in
 * sequence. Between steps the partial is gone (the step's assistant/message
 * settles it and the next step has not begun), so Tool execution shows the
 * official figure until the next step opens its own window.
 */
function LiveSpeed({ useChat, scale, fallback, t }: {
  useChat: ChatSnapshotSelectorHook
  /** Correction measured from this session's settled steps (1 = raw prior). */
  scale: number
  /** The official session figure, shown until the estimate means something. */
  fallback: string | null
  t: T
}) {
  const partial = useChat(s => s.legacy.partial)
  const key = partial == null ? null : `${partial.turn}:${partial.step}`
  const tokens = useMemo(
    () => (partial == null ? 0 : estimateOutputTokens(partial.blocks) * scale),
    [partial, scale],
  )
  // The decode window opens when this step's output first becomes observable and
  // closes when the step leaves the partial slot — nothing else re-anchors it.
  //
  // In particular it must NOT restart when the estimate dips. The accumulator
  // replaces a block wholesale at block boundaries (`block-start` empties the
  // index, `block-end` swaps in the settled block) and a retry empties the
  // stream, so a shrinking estimate mid-step is ordinary. Re-anchoring on each
  // dip collapses the denominator: the reading then never clears the minimum
  // window during the reasoning phase and spikes the moment the answer starts.
  const probe = useRef<{ key: string; startedAt: number } | null>(null)
  useEffect(() => {
    if (key === null) {
      probe.current = null
      return
    }
    if (probe.current?.key === key) return
    probe.current = { key, startedAt: Date.now() }
  }, [key])
  // The quotient is evaluated at render time with the clock read at that very
  // instant, so numerator and denominator always describe the same moment. That
  // is what lets every delta update the figure honestly: evaluating it against a
  // stored "last refreshed at" timestamp instead would pair a fresh numerator
  // with a stale denominator, and the figure would climb between refreshes then
  // snap back — a sawtooth that reads as jitter.
  //
  // So the deltas drive the reading, which is what makes it a streaming figure
  // at all; the beat below only covers a step that has gone quiet mid-answer,
  // where the denominator keeps growing while no frame arrives.
  const reading = probe.current === null || probe.current.key !== key
    ? null
    : streamingTokensPerSecond(tokens, Date.now() - probe.current.startedAt)
  // Keyed on "a step is streaming", not on the step identity: switching steps
  // must not tear the beat down and defer the next one by a full period.
  const streaming = key !== null
  const [, setBeat] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const handle = setInterval(() => { setBeat(Date.now()) }, LIVE_SPEED_REFRESH_MS)
    return () => { clearInterval(handle) }
  }, [streaming])
  return <SpeedFigure text={reading === null
    ? fallback
    : t('stats.tokensPerSecond', { throughput: formatTokensPerSecond(reading) })} />
}

function TimePill({ stats, t, dialog, useChat, scale, liveSpeed }: {
  stats: WindowStats
  t: T
  dialog: PillDialog
  useChat: ChatSnapshotSelectorHook
  /** Correction measured from this session's settled steps (1 = raw prior). */
  scale: number
  /** Whether the streaming-throughput preference is on. */
  liveSpeed: boolean
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  // The pill's accessible name stays on the official figure: a screen reader
  // gets the durable session reading rather than a value that changes every
  // second while a step streams.
  const officialTps = stats.decodeMs > 0
    ? t('stats.tokensPerSecond', {
      throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
    })
    : null
  const label = (
    <span className={css.label}>
      {counts}
      {liveSpeed
        ? <LiveSpeed useChat={useChat} scale={scale} fallback={officialTps} t={t} />
        : <SpeedFigure text={officialTps} />}
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
        aria-label={officialTps === null ? counts : counts + ' · ' + officialTps}
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
  const [streamThroughput, setStreamThroughput] = useState(statsLineState.streamThroughput)
  useEffect(() => statsLineState.subscribe(() => {
    setCachePrecision(statsLineState.cachePrecision)
    setTokenDetail(statsLineState.tokenDetail)
    setStreamThroughput(statsLineState.streamThroughput)
  }), [])
  // The live estimate's correction, measured once per settled-node change: the
  // session's own reported output tokens against what the published text
  // density predicted for the same text. 1 (the raw prior) until a settled step
  // carries both, so the first stream of a session still reads sensibly.
  const tokenScale = useMemo(() => measuredTokenScale(settledNodes ?? []) ?? 1, [settledNodes])
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
          useChat={useChat}
          scale={tokenScale}
          liveSpeed={streamThroughput}
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
