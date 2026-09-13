/**
 * Tests for the stats-line core: pure folds and formatters replicated from the
 * official ui-chat StatsLine (0.1.2-rc.1) — so the shadowing component
 * can render the exact official line with both toggles off — plus the two
 * enhancement readouts: two-decimal cache-hit rate and the five-item token
 * breakdown.
 */
import { describe, expect, it } from 'vitest'
import type { AssistantMessageNodeLike } from '../src/client/stats-line-core.ts'
import {
  assistantStepReading, billedInputTokens, cacheHitPercent, cacheHitPercentPrecise,
  deriveStats, estimateOutputTokens, formatDuration, formatTokensCompact, formatTokensPerSecond,
  measuredTokenScale, streamingTokensPerSecond, tokenBreakdown,
  type StepReading, type TokenUsageLike, type WindowStats,
} from '../src/client/stats-line-core.ts'

const usage = (over: Partial<TokenUsageLike>): TokenUsageLike => ({
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
})

describe('billedInputTokens / tokenBreakdown', () => {
  it('sums the three disjoint prompt-side buckets', () => {
    const u = usage({ uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 20 })
    expect(billedInputTokens(u)).toBe(105)
    expect(tokenBreakdown(u)).toEqual({ total: 125, input: 105, cacheHit: 90, cacheMiss: 15, output: 20 })
  })

  it('keeps the identities: input = cache hit + cache miss, total = input + output', () => {
    const u = usage({ uncachedInputTokens: 7, cacheReadTokens: 42, cacheWriteTokens: 3, outputTokens: 51 })
    const b = tokenBreakdown(u)
    expect(b.input).toBe(b.cacheHit + b.cacheMiss)
    expect(b.total).toBe(b.input + b.output)
    expect(b.cacheMiss).toBe(7 + 3)
  })
})

describe('cacheHitPercent (official integer floor, replicated)', () => {
  it('replicates the official rounding ties', () => {
    expect(cacheHitPercent(usage({ uncachedInputTokens: 14, cacheReadTokens: 986 }))).toBe('99')
    expect(cacheHitPercent(usage({ uncachedInputTokens: 5, cacheReadTokens: 995 }))).toBe('99.5')
    expect(cacheHitPercent(usage({ uncachedInputTokens: 1, cacheReadTokens: 9_999 }))).toBe('99.99')
    expect(cacheHitPercent(usage({ uncachedInputTokens: 5, cacheReadTokens: 9_995 }))).toBe('99.95')
    expect(cacheHitPercent(usage({ uncachedInputTokens: 0, cacheReadTokens: 10_000 }))).toBe('100')
  })

  it('returns null when no billed input exists', () => {
    expect(cacheHitPercent(usage({}))).toBeNull()
  })
})

describe('cacheHitPercentPrecise', () => {
  it('formats a ratio with exactly two decimals', () => {
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 59, cacheReadTokens: 341 }))).toBe('85.25')
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 1, cacheReadTokens: 9_999 }))).toBe('99.99')
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 0, cacheReadTokens: 10_000 }))).toBe('100.00')
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 40, cacheReadTokens: 0 }))).toBe('0.00')
  })

  it('rounds to two decimals instead of truncating, and counts cache writes as miss', () => {
    // 34.567% rounds to 34.57; cacheWrite joins the miss side.
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 1_627, cacheWriteTokens: 1_555, cacheReadTokens: 1_683 })))
      .toBe('34.59') // 1683 / (1683 + 1627 + 1555) = 34.594% → 34.59
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 0, cacheWriteTokens: 10, cacheReadTokens: 90 })))
      .toBe('90.00')
  })

  it('never claims a full 100.00 while any miss exists (rounding guard)', () => {
    // 99.996% must not read as 100.00 — the official line keeps 99.9x while
    // missedInputTokens > 0, so the precise readout must too.
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 4, cacheReadTokens: 99_996 }))).toBe('99.99')
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 1, cacheReadTokens: 99_999 }))).toBe('99.99')
    // A真 100% (miss = 0) still renders as 100.00.
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 0, cacheReadTokens: 10_000 }))).toBe('100.00')
    // Just below the rounding boundary stays exact.
    expect(cacheHitPercentPrecise(usage({ uncachedInputTokens: 421, cacheReadTokens: 99_579 }))).toBe('99.58')
  })

  it('returns null when no billed input exists', () => {
    expect(cacheHitPercentPrecise(usage({}))).toBeNull()
  })
})

describe('official formatters (replicated)', () => {
  it('formats token counts compactly, mirroring the official boundary behavior', () => {
    expect(formatTokensCompact(517)).toBe('517')
    expect(formatTokensCompact(12_240)).toBe('12.2K')
    expect(formatTokensCompact(517_000)).toBe('517K')
    expect(formatTokensCompact(1_230_000)).toBe('1.2M')
    // Official edge: 999_999 rounds to '1000K' (the official scaled() has no
    // carry-merge), so this locks the replication rather than "fixing" it.
    expect(formatTokensCompact(999_999)).toBe('1000K')
    expect(formatTokensCompact(1_000_000)).toBe('1M')
    expect(formatTokensCompact(1_999_000)).toBe('2M')
  })

  it('formats durations and throughput', () => {
    expect(formatDuration(45_230)).toBe('45.2s')
    expect(formatDuration(162_000)).toBe('2m42s')
    expect(formatTokensPerSecond(20)).toBe('20')
    expect(formatTokensPerSecond(5.55)).toBe('5.6')
    expect(formatTokensPerSecond(9.94)).toBe('9.9')
  })
})

describe('assistantStepReading / deriveStats (replicated window fold)', () => {
  const assistant = (seq: number, turn: number, extra: Record<string, unknown> = {}): AssistantMessageNodeLike => ({
    kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: 'x' }], ...extra,
  })

  it('reads ttft, decode and output tokens with nulls for unrecorded parts', () => {
    const reading: StepReading = assistantStepReading({
      ...assistant(1, 1),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
      usage: { outputTokens: 40 },
    })
    expect(reading).toEqual({ ttftMs: 800, decodeMs: 3_000, outputTokens: 40 })
    expect(assistantStepReading(assistant(1, 1))).toEqual({ ttftMs: null, decodeMs: null, outputTokens: null })
  })

  it('counts turns and steps, ignoring tool results without call time', () => {
    const stats: WindowStats = deriveStats([
      assistant(1, 1), assistant(2, 1), assistant(3, 2),
      { kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [], isError: false, callView: null, resultView: null, subCalls: [] },
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    expect(stats.toolMs).toBe(0)
    expect(Object.keys(stats).sort()).toEqual(
      ['decodeMs', 'decodeTokens', 'llmMs', 'steps', 'toolMs', 'ttftMs', 'ttftSteps', 'turns'],
    )
  })

  it('sums llm wall time from timed steps and tool wall time from call/result pairs', () => {
    const stats: WindowStats = deriveStats([
      {
        ...assistant(1, 1),
        timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 3_500 },
      },
      {
        ...assistant(2, 1),
        timing: { stepStartTime: null, firstTokenTime: null, completedTime: 9_000 },
      },
      { kind: 'tool-result', seq: 5, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [], isError: false, callView: null, resultView: null, subCalls: [] },
    ])
    expect(stats.llmMs).toBe(2_500)
    expect(stats.toolMs).toBe(3_000)
  })

  it('sums ttft per recorded step and decode throughput inputs per usage-carrying step', () => {
    const stats: WindowStats = deriveStats([
      {
        ...assistant(1, 1, { usage: { outputTokens: 40 } }),
        timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
      },
      {
        ...assistant(2, 1),
        timing: { stepStartTime: 5_000, firstTokenTime: 5_400, completedTime: 7_400 },
      },
      assistant(3, 2),
    ])
    expect(stats.ttftMs).toBe(1_200)
    expect(stats.ttftSteps).toBe(2)
    // The usage-less step contributes no decode share, keeping the ratio honest.
    expect(stats.decodeMs).toBe(3_000)
    expect(stats.decodeTokens).toBe(40)
  })
})

describe('streaming throughput (plugin readout)', () => {
  const ascii = (n: number): string => 'a'.repeat(n)
  const hanzi = (n: number): string => '中'.repeat(n)
  /** A settled assistant node with explicit blocks and optional usage. */
  const step = (
    seq: number,
    blocks: readonly unknown[],
    outputTokens?: number,
  ): AssistantMessageNodeLike => ({
    kind: 'assistant', seq, time: seq * 1_000, turn: 1, step: seq, blocks,
    ...(outputTokens === undefined ? {} : { usage: { outputTokens } }),
  })

  it('prices text and reasoning at the published density, tool arguments with them', () => {
    // DeepSeek's published density: 0.3 token per ASCII char, 0.6 per CJK char.
    expect(estimateOutputTokens([{ kind: 'text', text: ascii(10) }])).toBeCloseTo(3)
    expect(estimateOutputTokens([{ kind: 'text', text: hanzi(10) }])).toBeCloseTo(6)
    expect(estimateOutputTokens([{ kind: 'reasoning', text: hanzi(5) }])).toBeCloseTo(3)
    expect(estimateOutputTokens([{ kind: 'tool-call', argsRaw: ascii(20) }])).toBeCloseTo(6)
    // Reasoning and the visible answer both bill, so a stream carrying both adds up.
    expect(estimateOutputTokens([
      { kind: 'text', text: hanzi(10) },
      { kind: 'reasoning', text: hanzi(10) },
    ])).toBeCloseTo(12)
  })

  it('prices blocks that carry no readable text as zero', () => {
    expect(estimateOutputTokens([])).toBe(0)
    expect(estimateOutputTokens([{ kind: 'image' }, { kind: 'other' }])).toBe(0)
    expect(estimateOutputTokens([{ kind: 'tool-call' }])).toBe(0)
  })

  it('measures the correction from a settled step carrying both blocks and usage', () => {
    // 100 hanzi price as 60 prior tokens; the provider reported 90 → ×1.5.
    expect(measuredTokenScale([step(1, [{ kind: 'text', text: hanzi(100) }], 90)])).toBeCloseTo(1.5)
  })

  it('returns null without a usable settled sample', () => {
    expect(measuredTokenScale([])).toBeNull()
    // Blocks without usage, usage without blocks, and a zero-token sample are
    // all excluded rather than dragging the factor to its floor.
    expect(measuredTokenScale([step(1, [{ kind: 'text', text: hanzi(10) }])])).toBeNull()
    expect(measuredTokenScale([step(1, [], 50)])).toBeNull()
    expect(measuredTokenScale([step(1, [{ kind: 'text', text: hanzi(10) }], 0)])).toBeNull()
    // Tool results and user turns are not assistant output.
    expect(measuredTokenScale([
      { kind: 'tool-result', seq: 3, time: 3_000, callId: 'c', call: null, callTime: null, content: [], isError: false, callView: null, resultView: null, subCalls: [] },
    ])).toBeNull()
  })

  it('keeps one unrepresentative sample inside the correction band', () => {
    expect(measuredTokenScale([step(1, [{ kind: 'text', text: hanzi(100) }], 6_000)])).toBe(2)
    expect(measuredTokenScale([step(1, [{ kind: 'text', text: hanzi(100) }], 3)])).toBe(0.5)
  })

  it('pools every settled sample instead of trusting the last one', () => {
    // 180 reported tokens over 120 prior ones → 1.5, not either sample's own ratio.
    expect(measuredTokenScale([
      step(1, [{ kind: 'text', text: hanzi(100) }], 120),
      step(2, [{ kind: 'text', text: hanzi(100) }], 60),
    ])).toBeCloseTo(1.5)
  })

  it('withholds a live rate until the window is long enough to mean something', () => {
    expect(streamingTokensPerSecond(200, 499)).toBeNull()
    expect(streamingTokensPerSecond(200, 500)).toBeCloseTo(400)
    expect(streamingTokensPerSecond(200, 2_000)).toBeCloseTo(100)
  })

  it('returns null instead of a rate over zero tokens', () => {
    expect(streamingTokensPerSecond(0, 5_000)).toBeNull()
    expect(streamingTokensPerSecond(-1, 5_000)).toBeNull()
  })
})