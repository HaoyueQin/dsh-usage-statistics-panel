/**
 * Tests for StatsLineEnhanced (the shadowing composer.dock entry): with both
 * toggles off the rendered line matches the official StatsLine output; with
 * either toggle on, the cache-hit rate gains two decimals and/or the token
 * group becomes the five-item breakdown. The component is prefed by the same
 * projection seats as the official one (tokenUsage / sessionStats), so the
 * tests stub them the way the official suite does.
 *
 * The `useChat` seat reads the ui-chat ChatSnapshot `legacy.nodes`
 * compatibility projection (DSH >= 0.1.2-rc.1), exactly like the official
 * StatsLine.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type {
  AssistantMessageNodeLike, ToolResultNodeLike,
} from '../src/client/stats-line-core.ts'
import { StatsLineEnhanced, type StatsLineEnhancedProps } from '../src/client/StatsLineEnhanced.tsx'
import { zh } from '../src/client/locales.ts'
import { resetStatsLineStateForTests, statsLineState } from '../src/client/stats-line-state.ts'

/** The plugin's zh dictionary through a minimal template translator. */
const t = ((key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return Object.entries(params ?? {}).reduce(
    (text, [k, v]) => text.replaceAll(`{${k}}`, String(v)),
    template,
  )
}) as unknown as StatsLineEnhancedProps['t']

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  window.localStorage.clear()
  resetStatsLineStateForTests()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNodeLike => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

const tool = (): ToolResultNodeLike => ({
  kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
  isError: false, callView: null, resultView: null, subCalls: [],
})

/** Minimal chat-snapshot stub: the component reads s.legacy.nodes. */
function chatSnapshot(nodes: readonly unknown[]) {
  return { legacy: { nodes } }
}

function makeSource(nodes: readonly unknown[] = []): {
  source: { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
} {
  const snap = chatSnapshot(nodes)
  return {
    source: {
      getSnapshot: () => snap,
      subscribe: () => () => {},
    },
  }
}

/** The projection seat: a key-addressed table of whole values. */
function projections(values: Record<string, unknown>): StatsLineEnhancedProps['useProjection'] {
  return ((key: string) => values[key]) as unknown as StatsLineEnhancedProps['useProjection']
}

function props(
  source: { getSnapshot(): unknown; subscribe(fn: () => void): () => void },
  values: Record<string, unknown> = { tokenUsage: USAGE },
): StatsLineEnhancedProps {
  return {
    useChat: ((selector: (s: unknown) => unknown) => selector(source.getSnapshot())) as StatsLineEnhancedProps['useChat'],
    useProjection: projections(values),
    t,
  }
}

const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }

function sessionStats(overrides: Record<string, number>): Record<string, number> {
  return {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    ...overrides,
  }
}

describe('StatsLineEnhanced', () => {
  it('renders the official line with both toggles off', () => {
    const { source } = makeSource([assistant(1, 1), tool()])
    const view = render(<StatsLineEnhanced {...props(source)} />)
    expect(view.container.textContent)
      .toBe('1 轮 · 1 步| 缓存命中 90%| 输入 100 tok · 输出 5 tok')
  })

  it('shows the two-decimal cache hit rate when the precision toggle is on', () => {
    statsLineState.setCachePrecision(true)
    const { source } = makeSource([assistant(1, 1)])
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 59, outputTokens: 5, cacheReadTokens: 341, cacheWriteTokens: 0 },
    })} />)
    expect(view.container.textContent)
      .toBe('1 轮 · 1 步| 缓存命中 85.25%| 输入 400 tok · 输出 5 tok')
  })

  it('shows the five-item breakdown when the token-detail toggle is on', () => {
    statsLineState.setTokenDetail(true)
    const { source } = makeSource([assistant(1, 1)])
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 90, cacheWriteTokens: 5 },
    })} />)
    expect(view.container.textContent)
      .toBe('1 轮 · 1 步| 缓存命中 86%| 总 125 tok · 输入 105 tok · 命中缓存 90 tok · 未命中缓存 15 tok · 输出 20 tok')
  })

  it('composes both enhancements', () => {
    statsLineState.setCachePrecision(true)
    statsLineState.setTokenDetail(true)
    const { source } = makeSource([assistant(1, 1)])
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 59, outputTokens: 5, cacheReadTokens: 341, cacheWriteTokens: 0 },
    })} />)
    expect(view.container.textContent)
      .toBe('1 轮 · 1 步| 缓存命中 85.25%| 总 405 tok · 输入 400 tok · 命中缓存 341 tok · 未命中缓存 59 tok · 输出 5 tok')
  })

  it('renders nothing for a brand-new empty session', () => {
    const { source } = makeSource()
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })} />)
    expect(view.container.textContent).toBe('')
  })

  it('keeps durable token groups after the visible step window is empty', () => {
    const { source } = makeSource()
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 7, steps: 44 }),
    })} />)
    expect(view.container.textContent)
      .toBe('7 轮 · 44 步| 缓存命中 90%| 输入 100 tok · 输出 5 tok')
  })

  it('drops every token group when no projection is composed', () => {
    const { source } = makeSource([assistant(1, 1)])
    const view = render(<StatsLineEnhanced {...props(source, {})} />)
    expect(view.container.textContent).toBe('1 轮 · 1 步')
  })

  it('hides the zero-token group when steps closed without any billed activity', () => {
    const { source } = makeSource()
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    expect(view.container.textContent).toBe('1 轮 · 1 步')
  })
})
