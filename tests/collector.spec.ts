/**
 * Collector fold tests — the (turn, step) replace semantics that keep
 * replayed/duplicate usage reports from double counting (mirrors reasonix's
 * fix commit and dsh-token-meter's usage projection).
 */
import { describe, expect, it } from 'vitest'
import { UsageFold } from '../src/collector.ts'
import type { UsageSessionEvent } from '../src/context-types.ts'

function event(type: string, turn: number, step: number, time: number, data: Record<string, unknown>): UsageSessionEvent {
  return { type, seq: 0, time, data: { turn, step, ...data } }
}

const T = new Date(2026, 7, 2, 12).getTime() // 2026-08-02 local

describe('UsageFold', () => {
  it('extracts usage from assistant/message and assistant/chunk', () => {
    const fold = new UsageFold()
    const msg = fold.fold(event('assistant/message', 1, 1, T, {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40 },
    }))
    expect(msg).not.toBeNull()
    expect(msg!.day).toBe('2026-08-02')
    expect(msg!.inputTokens).toBe(100)
    expect(msg!.outputTokens).toBe(50)
    expect(msg!.cacheReadTokens).toBe(40)

    const chunk = fold.fold(event('assistant/chunk', 2, 1, T, {
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    }))
    expect(chunk).not.toBeNull()
    expect(chunk!.inputTokens).toBe(10)
  })

  it('ignores events without usage or with zero totals', () => {
    const fold = new UsageFold()
    expect(fold.fold(event('assistant/message', 1, 1, T, { message: {} }))).toBeNull()
    expect(fold.fold(event('assistant/chunk', 1, 1, T, { chunk: { type: 'text-delta' } }))).toBeNull()
    expect(fold.fold(event('assistant/message', 1, 1, T, { usage: { inputTokens: 0, outputTokens: 0 } }))).toBeNull()
    expect(fold.fold(event('request/context', 1, 1, T, { provider: 'deepseek', model: 'chat' }))).toBeNull()
  })

  it('replaces the earlier sample for the same (turn, step) instead of double counting', () => {
    const fold = new UsageFold()
    // Streaming sample first, then the final assistant/message — same (1,1).
    const first = fold.fold(event('assistant/chunk', 1, 1, T, {
      chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
    }))
    expect(first!.inputTokens).toBe(100)
    // The final message carries the authoritative usage; the fold replaces.
    const second = fold.fold(event('assistant/message', 1, 1, T, {
      usage: { inputTokens: 200, outputTokens: 90 },
    }))
    expect(second).toBeNull() // replaced in place, no new sample
    // A later distinct (turn, step) still produces a new sample.
    const third = fold.fold(event('assistant/message', 1, 2, T, {
      usage: { inputTokens: 50, outputTokens: 10 },
    }))
    expect(third).not.toBeNull()
    expect(third!.inputTokens).toBe(50)
  })

  it('treats the same key across different turn/step as distinct', () => {
    const fold = new UsageFold()
    const a = fold.fold(event('assistant/message', 1, 1, T, { usage: { inputTokens: 10, outputTokens: 1 } }))
    const b = fold.fold(event('assistant/message', 2, 1, T, { usage: { inputTokens: 20, outputTokens: 2 } }))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })
})
