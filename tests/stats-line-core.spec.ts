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
  measuredTokenScale, StreamingRateSampler, tokenBreakdown,
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
})

/**
 * The live figure is a rate over what the sampler watched, not the step's
 * cumulative estimate over an ever-growing span. Every case below pins one
 * consequence of that definition; the second one is the reported defect.
 */
describe('StreamingRateSampler (live decode throughput)', () => {
  /** Feed one frame at `at` ms carrying the step's running estimate. */
  const frame = (sampler: StreamingRateSampler, at: number, tokens: number): void => {
    sampler.observe(tokens, at)
  }

  it('withholds a reading until the window spans the observation floor', () => {
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    // The step is open and output has started, but the window is only 100 ms.
    frame(sampler, 100, 20)
    expect(sampler.ratePerSecond()).toBeNull()
    // First published window: the 200 tokens the stream has produced so far
    // over the 500 ms since the step opened — the same quotient the settled
    // figure uses, which is why the startup delay is the floor and nothing more.
    frame(sampler, 500, 200)
    expect(sampler.ratePerSecond()).toBeCloseTo(400)
  })

  it('keeps a steady stream on its rate while the window grows and slides', () => {
    const sampler = new StreamingRateSampler()
    // 60 tokens/s: 6 tokens per 100 ms frame.
    for (let at = 0; at <= 6_000; at += 100) frame(sampler, at, at * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60)
  })

  it('bounds the window, so an old artifact cannot distort the reading forever', () => {
    const sampler = new StreamingRateSampler()
    // A 240-token backlog lands at t=2_500 on a plausible frame, then the
    // stream continues at 60 tokens/s. The backlog lifts the reading while the
    // window still contains it and leaves with it — inside one window, never
    // decaying across the rest of the step.
    for (let at = 0; at <= 2_400; at += 600) frame(sampler, at, at * 0.06)
    frame(sampler, 2_500, 384)
    const spiked = sampler.ratePerSecond()!
    // The backlog lifts the figure it enters — 183 tok/s over the window — but the
    // 100 ms since the last publication give the new reading only a tenth of the
    // smoothed result, so a single bad frame cannot swing it.
    expect(spiked).toBeGreaterThan(70)
    for (let at = 3_100; at <= 8_000; at += 600) frame(sampler, at, 384 + (at - 2_500) * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
  })

  it('re-anchors instead of publishing a backlog the sampler could not have watched', () => {
    // The reported defect: a backgrounded tab suspends animation frames while
    // the stream keeps running, so the first frame after a return carries the
    // whole backlog. Charging it to a window that just opened read as thousands
    // of tok/s and then decayed for the rest of the step.
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    frame(sampler, 400, 1_500)
    expect(sampler.ratePerSecond()).toBeNull()
    // The re-anchored window reports the growth observed from here on, so the
    // backlog never enters the figure at all — before the fix this read 3_000
    // and then decayed for the rest of the step as the denominator grew.
    for (let at = 900; at <= 2_900; at += 500) frame(sampler, at, 1_500 + (at - 400) * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60)
  })

  it('re-anchors a backlog that arrives inside the observation floor', () => {
    // The floor is a publishing gate, not a rejection gate. A backlog frame that
    // lands 400 ms after the previous observation used to be answered with "no
    // reading yet" — which left its 1 500 tokens in the window, so the NEXT frame
    // published 1 366 tok/s (1 530 tokens over the 900 ms window) on a stream
    // running at 60. The plausibility check therefore runs before the floor.
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    frame(sampler, 400, 1_500)
    expect(sampler.ratePerSecond()).toBeNull()
    frame(sampler, 900, 1_530)
    // Re-anchored, so the window holds the backlog's own count as its baseline:
    // this reads the stream's rate, where the old order published 1 366 tok/s
    // (1 530 tokens over the 900 ms window).
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
    for (let at = 1_400; at <= 3_400; at += 500) frame(sampler, at, 1_530 + (at - 900) * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
  })

  it('holds the last reading while a quiet step adds nothing', () => {
    // A step can go quiet mid-answer (the model is thinking, a tool is about to
    // start). Frames that repeat the estimate carry no information, so they must
    // not age the window into publishing a lower rate: the row keeps the last
    // figure it could measure until the step settles and the official one returns.
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    for (let at = 500; at <= 3_000; at += 500) frame(sampler, at, at * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
    for (let at = 3_500; at <= 8_000; at += 500) frame(sampler, at, 180)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
  })

  it('drops the window but keeps the figure when the measured scale moves', () => {
    // The correction measured from settled steps re-prices the whole estimate, so
    // growth already counted under the old scale must not be measured against the
    // new one — but the step's rate did not change, only its units.
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    for (let at = 500; at <= 1_500; at += 500) frame(sampler, at, at * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
    sampler.reset()
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
    // The next observations anchor on the new scale and measure from there.
    frame(sampler, 2_000, 400)
    frame(sampler, 2_500, 430)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
  })

  it('damps a single overshooting publication instead of following it', () => {
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    frame(sampler, 1_000, 60)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
    // 500 tokens on the next frame one window later: 454 tok/s over the window,
    // of which the smoothed figure takes a tenth.
    frame(sampler, 1_100, 560)
    expect(sampler.ratePerSecond()).toBeLessThan(120)
  })

  it('publishes a fast stream and re-anchors a backlog past 1_500 tok/s', () => {
    // The plausibility threshold sits at 1.5 tokens per ms — above the largest
    // slope a real session produced (265 tokens in 246 ms ≈ 1.08 tok/ms) while
    // still rejecting what only looks fast because the count was published late.
    // The fast-stream arm is a 1 500 tok/s decode, exactly at the threshold, which
    // a "greater than" test lets through.
    const fast = new StreamingRateSampler()
    frame(fast, 0, 0)
    frame(fast, 1_000, 1_500)
    frame(fast, 2_000, 3_000)
    expect(fast.ratePerSecond()).toBeCloseTo(1_500)

    // The backlog case the threshold exists for: a suspended tab hands over a
    // whole step's output in one frame, so a 400 ms window would report
    // 3 750 tok/s of output the sampler could not have watched.
    const backlog = new StreamingRateSampler()
    frame(backlog, 0, 0)
    frame(backlog, 400, 1_500)
    expect(backlog.ratePerSecond()).toBeNull()
  })

  it('re-anchors when the running estimate drops (retry or block replacement)', () => {
    const sampler = new StreamingRateSampler()
    for (let at = 0; at <= 1_000; at += 500) frame(sampler, at, at * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60)
    // Blocks were replaced wholesale: the old counts describe text that is gone.
    frame(sampler, 1_500, 3)
    // The window restarts, but the figure on screen does not: the step is still
    // streaming and its rate did not change, so falling back to the session
    // average here would be a jump the stream cannot account for.
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
    for (let at = 2_000; at <= 4_000; at += 500) frame(sampler, at, 3 + (at - 1_500) * 0.06)
    expect(sampler.ratePerSecond()).toBeCloseTo(60, -1)
  })

  it('returns null instead of a rate over no growth', () => {
    const sampler = new StreamingRateSampler()
    frame(sampler, 0, 0)
    frame(sampler, 5_000, 0)
    expect(sampler.ratePerSecond()).toBeNull()
    expect(new StreamingRateSampler().ratePerSecond()).toBeNull()
  })
})