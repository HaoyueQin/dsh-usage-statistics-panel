/**
 * Pure folds and formatters for the conversation bottom-bar (stats pills),
 * replicated from the official ui-chat StatsPills (DSH 0.1.5-alpha.1) —
 * StatsPills.tsx, turn-metrics.ts and token-format.ts. The official package
 * is not a client-bundle external, so a shadowing plugin cannot import its
 * internals; these copies keep the "both toggles off" pills identical to
 * the official ones (guarded by the render tests).
 *
 * Three plugin-side readouts: a two-decimal cache-hit rate, a five-item
 * token breakdown (total / input / cache hit / cache miss / output), and the
 * live decode-throughput estimate for the step that is still streaming.
 *
 * The live figure is a rate over observations, not a cumulative quotient:
 * StreamingRateSampler at the bottom of this file carries the reasoning.
 */
/**
 * Minimal structural skeletons of the official assembly types this module
 * folds (ui-chat ChatSnapshot served through this entry's `useChat` seat),
 * so this module and the tests take the field skeleton they fold rather than
 * any package's type — the same drift containment context-types.ts applies
 * to Context. The index signature keeps object-literal fixtures with extra
 * fields assignable.
 */

/** One assistant node's timing facts; null marks an unrecorded part. */
export interface UsageNodeTiming {
  stepStartTime: number | null
  firstTokenTime: number | null
  completedTime: number
}

/** One assistant message node (official `kind: 'assistant'` arm). */
export interface AssistantMessageNodeLike {
  kind: 'assistant'
  turn: number
  time: number
  timing?: UsageNodeTiming
  /** Provider-reported usage (TokenUsage bucket), read via usageOutputTokens. */
  usage?: unknown
  [key: string]: unknown
}

/** One settled tool-result node (official `kind: 'tool-result'` arm). */
export interface ToolResultNodeLike {
  kind: 'tool-result'
  time: number
  callTime: number | null
  [key: string]: unknown
}

/** One conversation node as the ChatSnapshot `legacy.nodes` projection serves it. */
export type ConversationNodeLike = AssistantMessageNodeLike | ToolResultNodeLike

/** The projection seats this entry subscribes to (mirror of the official
 *  SessionProjectionMap keys: sessionStats + tokenUsage). */
export interface SessionProjectionMapLike {
  sessionStats: WindowStats
  tokenUsage: TokenUsageLike
}

/** Minimal structural mirror of the framework-injected projection hook
 *  (`useProjection('sessionStats' | 'tokenUsage')`). */
export type UseProjection = <K extends keyof SessionProjectionMapLike & string>(
  key: K,
) => SessionProjectionMapLike[K] | undefined

/** The token-usage projection shape (dsh-token-meter), kept structural so
 *  this module stays testable without the runtime projection store. */
export interface TokenUsageLike {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The five-item display breakdown; identities: input = hit + miss and
 *  total = input + output (provider-visible billing buckets). */
export interface TokenBreakdown {
  total: number
  input: number
  cacheHit: number
  cacheMiss: number
  output: number
}

/** One assistant step's derivable latency facts; null marks an unrecorded part. */
export interface StepReading {
  ttftMs: number | null
  decodeMs: number | null
  outputTokens: number | null
}

/** Window-scoped session totals (the fallback when no sessionStats
 *  projection is served). */
export interface WindowStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

// ── official replication ──────────────────────────────────────────────────

/** Sum the three disjoint prompt-side billing buckets (official). */
export function billedInputTokens(usage: TokenUsageLike): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Round a cache-read ratio to an integer percentage, ties rounded up (official). */
function roundedIntegerPercent(cacheReadTokens: number, denominator: number): number {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / 200)
    if (cacheReadTokens >= threshold) {
      lower = candidate
    } else {
      upper = candidate - 1
    }
  }
  return lower
}

/**
 * Display-ready cache-hit share of prompt-side input (official replica):
 * integer text when integer rounding stays below 100, otherwise the minimum
 * decimal precision that still rounds below 100; full hit returns 100, and
 * no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageLike): string | null {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return null
  const missedInputTokens = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missedInputTokens === 0) return '100'

  const integerPercent = roundedIntegerPercent(usage.cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)

  // At the first distinguishing precision, the rounded result is 100 minus
  // one to five units in the final decimal place.
  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

/**
 * Plugin readout: the same ratio with exactly two decimals (85.25% → "85.25",
 * full hit → "100.00"); returns the display digits without the percent sign.
 */
export function cacheHitPercentPrecise(usage: TokenUsageLike): string | null {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return null
  const missedInputTokens = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missedInputTokens === 0) return '100.00'
  const percent = Math.round(usage.cacheReadTokens * 10_000 / denominator) / 100
  // Rounding guard, mirroring the official integer path: while ANY miss
  // exists, a 99.995%+ ratio must render 99.99 (its two-decimal ceiling),
  // never the full-hit 100.00 — the precise readout would otherwise claim
  // a perfect hit the data does not have.
  return Math.min(percent, 99.99).toFixed(2)
}

/** Plugin readout: the five-item breakdown of one usage sample. */
export function tokenBreakdown(usage: TokenUsageLike): TokenBreakdown {
  const cacheHit = usage.cacheReadTokens
  const cacheMiss = usage.uncachedInputTokens + usage.cacheWriteTokens
  const input = cacheHit + cacheMiss
  return {
    total: input + usage.outputTokens,
    input,
    cacheHit,
    cacheMiss,
    output: usage.outputTokens,
  }
}

/** Compact token count: 517 / 12.2K / 517K / 1.2M (official formatTokens).
 *  Named formatTokensCompact (not formatTokens) — the panel's format.ts
 *  exports the exact-thousands-separator formatTokens, and the two must not
 *  be confused across modules. */
export function formatTokensCompact(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration: 45.2s under a minute, 2m42s from there on (official). */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Decode-throughput figure: whole tokens from ten up, one decimal below (official). */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Read one assistant node's TTFT, decode wall time and output tokens (official). */
export function assistantStepReading(node: AssistantMessageNodeLike): StepReading {
  const timing = node.timing
  const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
    ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
    : null
  const decodeMs = timing !== undefined && timing.firstTokenTime !== null
    ? Math.max(0, timing.completedTime - timing.firstTokenTime)
    : null
  return { ttftMs, decodeMs, outputTokens: usageOutputTokens(node.usage) }
}

/** Provider-reported completion tokens guarded to finite non-negative numbers (official). */
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the fallback for assemblies without the sessionStats projection (official).
 */
export function deriveStats(nodes: readonly ConversationNodeLike[]): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

// ── streaming throughput (plugin readout) ─────────────────────────────────

/**
 * One assistant output block as the conversation projection serves it. Only
 * the three text-bearing kinds are priced; images and merge-extended blocks
 * carry no readable character count.
 */
export interface AssistantBlockLike {
  kind: string
  /** `text` and `reasoning` blocks. */
  text?: string
  /** `tool-call` blocks: serialized arguments are model output too. */
  argsRaw?: string
}

/** In-progress assistant output (the ChatSnapshot `legacy.partial` value). */
export interface PartialAssistantLike {
  turn: number
  step: number
  blocks: readonly AssistantBlockLike[]
}

/**
 * DeepSeek's published text density (api-docs.deepseek.com, "Token 用量计算"):
 * one Chinese character ≈ 0.6 token, one English character ≈ 0.3 token. Priced
 * per code point with every non-ASCII character taking the denser rate — the
 * conservative side, and the reason this file does not reuse the harness's own
 * four-characters-per-token heuristic, which its README documents as
 * underpricing CJK text.
 */
const CJK_TOKENS_PER_CHAR = 0.6
const ASCII_TOKENS_PER_CHAR = 0.3

/**
 * Shortest observable decode window before a live rate is published, in ms
 * (the same floor MiMo-Code's sidebar tps uses). Below it the first chunk's
 * burst would read as hundreds of tok/s; the sampler also publishes its FIRST
 * reading at exactly this mark rather than at the next steady cadence.
 *
 * The floor is a publishing gate, NOT a rejection gate: it is applied after the
 * plausibility check below, so a backlog frame can never dodge that check by
 * arriving early (see {@link StreamingRateSampler.observe}).
 */
const MIN_STREAM_WINDOW_MS = 500

/**
 * Longest window a live rate may span, in ms. This is the bound the previous
 * cumulative quotient lacked: any artifact inside the window — a frame the UI
 * published late, a retry, a block boundary — leaves the figure within one
 * window instead of distorting the reading for the rest of the step.
 */
const MAX_STREAM_WINDOW_MS = 2_000

/**
 * Hard cap on windowed observations. A 2 s window holds ≈ 40 samples at the
 * stream's own publication cadence and ≈ 125 at 60 fps, so this only ever bites
 * on a synthetic input (a caller observing far faster than any renderer does);
 * it is a backstop against unbounded growth, not a cadence control.
 */
const MAX_WINDOW_SAMPLES = 512

/**
 * Highest decoded rate the sampling can resolve, in tokens per ms: 1_500 tok/s.
 * It sits above anything a real stream produces — measured over a real session,
 * the largest single publication carried 265 tokens and the median 9, i.e. a
 * worst observed slope of ≈ 1.08 tok/ms, and DeepSeek's steady output is two
 * orders of magnitude below that — while a window that DID stream that fast is a
 * measurement artifact: the UI published a count the stream produced earlier
 * (a suspended tab returns with the whole backlog in one frame; a busy main
 * thread batches frames the same way). Such a window is re-anchored instead of
 * published, so the figure resumes from the tokens that actually arrive while
 * the row is watching.
 *
 * This check runs before the observation floor on purpose: a backlog frame that
 * lands less than {@link MIN_STREAM_WINDOW_MS} after the previous one used to be
 * answered by "no reading yet", which left its sample in the window and let the
 * NEXT frame publish the backlog as a rate (1_366 tok/s on a 30 tok/s stream).
 */
const MAX_SAMPLED_TOKENS_PER_MS = 1.5

/**
 * Shortest span the plausibility check may judge, in ms. Two observations can
 * land in the same instant — a step opens and its first block arrives on one
 * frame — and a span that small would turn an ordinary opening chunk into "a
 * rate no provider streams", re-anchoring the window and losing the baseline the
 * whole reading is measured from. Judging against this floor instead still
 * catches what the check exists for: the largest publication a real session
 * produced carried 265 tokens, which is 3 900 tok/s if it lands inside 68 ms.
 */
const MIN_SLOPE_SPAN_MS = 50

/**
 * Time constant of the published figure, in ms. The weight a new reading gets is
 * its own elapsed time over this constant, so the smoothing is a property of the
 * stream's pace rather than of how often the row happens to render: at the
 * measured cadence (≈ 246 ms between publications) each reading takes about a
 * quarter of the figure and three of them carry most of a step change, while a
 * reading that arrives after a long silence is adopted whole instead of being
 * blended with a stale one.
 */
const SMOOTHING_TAU_MS = 1_000

/**
 * Band the measured correction stays inside, so one unrepresentative sample
 * (an aborted step, a step that streamed tool JSON only) cannot scale the
 * estimate away from the published density.
 */
const MIN_MEASURED_SCALE = 0.5
const MAX_MEASURED_SCALE = 2

/**
 * Bounded sliding-window decode-rate estimator for the step currently
 * streaming.
 *
 * Three rules keep the figure honest, and the first two follow from the same
 * mistake the cumulative quotient made — pairing a numerator that covers the
 * whole step with a denominator that starts when the UI first looked:
 *
 * 1. The numerator is the token growth OBSERVED inside the window, never the
 *    step's cumulative estimate. Text produced before the window opened (or
 *    during a frame the UI never published) therefore cannot be charged to it.
 * 2. The window is bounded above as well as below. A rate is a statement about
 *    a span; over an unbounded span it degrades into the step's lifetime
 *    average and any early artifact fades for minutes instead of seconds.
 * 3. The published figure is smoothed, and only a frame that carries growth may
 *    move it. A window average still moves with every publication, and real
 *    publications carry uneven amounts (median 9 tokens, 99th percentile 77 in a
 *    measured session), so an unsmoothed rate jumps by a quarter or more between
 *    adjacent readings; a frame repeating the estimate, on the other hand, says
 *    nothing about the stream and must not age the window either.
 *
 * Every state change happens in `observe`. `ratePerSecond` only reads, which is
 * what lets the row sample during a render it may yet discard: a read that could
 * re-anchor the window would let an abandoned render decide what the next
 * committed one publishes.
 *
 * The window opens at the first observation, so idle time before the first delta
 * stays out of the denominator exactly as the official `decodeMs` keeps
 * first-token latency out of the settled figure. A step change gets a new
 * sampler (a window belongs to one step); a step still running through a change
 * that re-prices its own estimate calls {@link StreamingRateSampler.reset}.
 */
export class StreamingRateSampler {
  /** (time, tokens) observations still inside the window, oldest first. */
  private samples: { at: number; tokens: number }[] = []

  /**
   * Last published figure, in tokens per second; null until the window first
   * carries a usable span. It is held across a window with nothing in it: while
   * a step streams and produces nothing, the row keeps showing the last rate it
   * could measure, instead of falling back to the session average and reading as
   * a jump for no reason.
   */
  private published: number | null = null

  /** Wall clock of that figure, in ms; its age sets the smoothing weight. */
  private publishedAt = 0

  /**
   * Observe one reading of the step's running token estimate, and advance the
   * published figure.
   * @param tokens - the calibrated output-token estimate right now.
   * @param now - the wall clock at the same instant, in ms.
   */
  observe(tokens: number, now: number): void {
    const last = this.samples.at(-1)
    // The first observation anchors the window, and a DROPPED estimate anchors it
    // again: a retry or a block replaced wholesale leaves counts that describe
    // text that is gone, so the window restarts rather than measuring growth the
    // stream never produced. An anchor publishes nothing — it has no span yet.
    if (last === undefined || tokens < last.tokens) {
      this.samples = [{ at: now, tokens }]
      return
    }
    // A frame repeating the estimate carries no information: it would not change
    // the numerator, only push the window's far end forward, and every second it
    // did that the reading would sag toward the step's average for no reason the
    // stream can account for. The beat that re-renders a quiet step lands here,
    // and so does a re-render caused by something else entirely (a preference
    // flip, a sibling's update): neither may move the figure.
    if (tokens === last.tokens) return
    this.samples.push({ at: now, tokens })
    // The window is bounded above, so a long step keeps a rate rather than
    // degrading into its own lifetime average: everything more than a window old
    // leaves with it, including a leading zero anchor whose span measures the
    // step's wait for its first token rather than decode.
    while (this.samples.length > 1 && now - this.samples[0]!.at > MAX_STREAM_WINDOW_MS) {
      this.samples.shift()
    }
    if (this.samples.length >= MAX_WINDOW_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_WINDOW_SAMPLES / 2)
    }
    const first = this.samples[0]!
    const span = now - first.at
    const grown = tokens - first.tokens
    // A window whose slope exceeds what any provider streams did not watch the
    // stream grow: the count it carries was produced before the row was looking.
    // This test runs BEFORE the observation floor, so a backlog frame that lands
    // early cannot slip past by asking for a reading the floor would refuse
    // anyway — it used to stay in the window and let the next frame publish the
    // whole backlog as a rate.
    if (grown > Math.max(span, MIN_SLOPE_SPAN_MS) * MAX_SAMPLED_TOKENS_PER_MS) {
      this.samples = [{ at: now, tokens }]
      return
    }
    // Below the floor: the span is too short to trust, so no reading is published
    // and the one already on screen stays as it is. (Growth is guaranteed here —
    // the estimate only ever moves up inside a step.)
    if (span < MIN_STREAM_WINDOW_MS) return
    const rate = grown / (span / 1_000)
    if (this.published === null) {
      this.published = rate
    } else {
      const weight = Math.min(1, (now - this.publishedAt) / SMOOTHING_TAU_MS)
      this.published += weight * (rate - this.published)
    }
    this.publishedAt = now
  }

  /**
   * The figure to display.
   * @returns the smoothed tokens-per-second reading, or null while the sampler
   *   has never measured one — a fresh step, or a window just re-anchored before
   *   it could publish — leaving the caller to show the official session figure.
   */
  ratePerSecond(): number | null {
    return this.published
  }

  /**
   * Drop the observed window because the step's estimate is priced differently
   * from here on (its measured correction changed). Growth already counted under
   * the old scale must not be measured against the new one. The published figure
   * survives: the step's rate did not change, only the units it is priced in, and
   * falling back to the session average here would be a visible jump.
   */
  reset(): void {
    this.samples = []
  }
}

/** Prior tokens for one string under the published density. */
function priorTokens(text: string): number {
  let tokens = 0
  for (const character of text) {
    tokens += character.codePointAt(0)! <= 0x7f ? ASCII_TOKENS_PER_CHAR : CJK_TOKENS_PER_CHAR
  }
  return tokens
}

/**
 * Prior output-token estimate for one step's blocks. Provider `outputTokens`
 * counts every completion token, so reasoning text and tool-call arguments are
 * priced alongside the visible answer — pricing only the answer would make a
 * tool-heavy step read far below its own settled figure.
 */
export function estimateOutputTokens(blocks: readonly AssistantBlockLike[]): number {
  let tokens = 0
  for (const block of blocks) {
    if (block.kind === 'text' || block.kind === 'reasoning') tokens += priorTokens(block.text ?? '')
    else if (block.kind === 'tool-call') tokens += priorTokens(block.argsRaw ?? '')
  }
  return tokens
}

/**
 * Correction factor from the session's own settled steps: provider-reported
 * output tokens divided by what the published density predicted for the same
 * blocks. The density answers "what does this text cost before anything is
 * known"; this factor carries whatever the live tokenizer does differently, so
 * the estimate converges on the model actually in use. Null while no settled
 * step carries both blocks and usage (the caller falls back to the raw prior).
 */
export function measuredTokenScale(nodes: readonly ConversationNodeLike[]): number | null {
  let prior = 0
  let actual = 0
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const blocks = node.blocks as readonly AssistantBlockLike[] | undefined
    const tokens = usageOutputTokens(node.usage)
    if (blocks === undefined || tokens === null || tokens <= 0) continue
    const estimate = estimateOutputTokens(blocks)
    if (estimate <= 0) continue
    prior += estimate
    actual += tokens
  }
  if (prior <= 0) return null
  return Math.min(MAX_MEASURED_SCALE, Math.max(MIN_MEASURED_SCALE, actual / prior))
}
