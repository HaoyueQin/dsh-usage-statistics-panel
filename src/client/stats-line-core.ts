/**
 * Pure folds and formatters for the conversation bottom-bar (stats line),
 * replicated from the official ui-conversation StatsLine (0.1.1-rc.2) —
 * StatsLine.tsx, turn-metrics.ts and message-chrome.ts. The official package
 * is not a client-bundle external, so a shadowing plugin cannot import its
 * internals; these copies keep the "both toggles off" rendering byte-equal to
 * the official line (guarded by the render tests).
 *
 * Two plugin-side readouts: a two-decimal cache-hit rate and a five-item
 * token breakdown (total / input / cache hit / cache miss / output).
 */
/**
 * Minimal structural skeletons of the official assembly types this module
 * folds. The upstream types moved between kernels (0.1.1: ConversationSnapshot
 * under ui-conversation; 0.1.2: ChatSnapshot under ui-chat, both served to
 * this entry through its `useSession`/`useChat` seat), so this module and the
 * tests take the field skeleton they fold rather than any package's type —
 * the same drift containment context-types.ts applies to Context. The index
 * signature keeps object-literal fixtures with extra fields assignable.
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

/** The assembly's conversation nodes, as both kernels serve them. */
export type ConversationNodeLike = AssistantMessageNodeLike | ToolResultNodeLike

/** Minimal skeleton of the ≤0.1.1 ConversationSnapshot (the slice the
 *  rc.2-kernel `useSession` seat selects). */
export interface ConversationSnapshotLike {
  nodes: readonly ConversationNodeLike[]
  [key: string]: unknown
}

/** The projection seats this entry subscribes to (mirror of the official
 *  SessionProjectionMap keys: sessionStats + tokenUsage). */
export interface SessionProjectionMapLike {
  sessionStats: WindowStats
  tokenUsage: TokenUsageLike
}

/** Minimal structural mirror of the framework-injected projection hook
 *  (`useProjection('sessionStats' | 'tokenUsage')` on either kernel). */
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

