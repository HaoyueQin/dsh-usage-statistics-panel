/**
 * Tests for StatsLineEnhanced (the shadowing composer.dock entry): with both
 * toggles off the row matches the official StatsPills output - a gauge pill
 * (counts + speed, click opens the time dialog) and a database pill (total +
 * cache hit, click opens the usage dialog). With either toggle on, the cache
 * hit rate gains two decimals and/or the usage dialog gains the miss row.
 * The component is fed by the same projection seats as the official one
 * (tokenUsage / sessionStats), so the tests stub them the way the official
 * suite does. Dialogs portal into document.body; the two pills share one
 * exclusive open slot.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    (text, [k, v]) => text.replaceAll('{' + k + '}', String(v)),
    template,
  )
}) as unknown as StatsLineEnhancedProps['t']

beforeEach(() => {
  window.localStorage.clear()
  resetStatsLineStateForTests()
})

afterEach(() => {
  cleanup()
})

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNodeLike => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: 't' + seq }],
  ...(usage === undefined ? {} : { usage }),
})

const tool = (): ToolResultNodeLike => ({
  kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
  isError: false, callView: null, resultView: null, subCalls: [],
})

/** Minimal chat-snapshot stub: the component reads s.legacy.nodes. */
function makeSource(nodes: readonly unknown[] = []): {
  source: { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
} {
  const snap = { legacy: { nodes } }
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

describe('StatsLineEnhanced pills', () => {
  it('renders gauge and database pills with both toggles off', () => {
    const { source } = makeSource([assistant(1, 1), tool()])
    const view = render(<StatsLineEnhanced {...props(source)} />)
    expect(view.container.querySelector('[data-composer-stats]')).not.toBeNull()
    // No timed figures: the gauge pill is a static reading, the usage pill a button.
    expect(screen.getByText('1 轮 · 1 步')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '105 tok · 缓存命中 90%' })).toBeTruthy()
  })

  it('renders nothing for a brand-new empty session', () => {
    const { source } = makeSource()
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })} />)
    expect(view.container.textContent).toBe('')
  })

  it('keeps durable pills after the visible step window is empty', () => {
    const { source } = makeSource()
    const view = render(<StatsLineEnhanced {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 7, steps: 44 }),
    })} />)
    expect(view.container.querySelector('[data-composer-stats]')).not.toBeNull()
    expect(screen.getByText('7 轮 · 44 步')).toBeTruthy()
    expect(screen.getByRole('button', { name: '105 tok · 缓存命中 90%' })).toBeTruthy()
  })

  it('drops the usage pill when no projection is composed', () => {
    const { source } = makeSource([assistant(1, 1)])
    render(<StatsLineEnhanced {...props(source, {})} />)
    expect(screen.getByText('1 轮 · 1 步')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('hides the usage pill when steps closed without any billed activity', () => {
    const { source } = makeSource()
    render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    expect(screen.getByText('1 轮 · 1 步')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the time dialog with timed rows on click', () => {
    const { source } = makeSource()
    render(<StatsLineEnhanced {...props(source, {
      sessionStats: sessionStats({ turns: 1, steps: 1, llmMs: 1100, toolMs: 2000, ttftMs: 100, ttftSteps: 1, decodeMs: 1000, decodeTokens: 22 }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '1 轮 · 1 步 · 22 tok/s' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('用时与速度')
    expect(dialog.textContent).toContain('LLM 用时')
    expect(dialog.textContent).toContain('1.1s')
    expect(dialog.textContent).toContain('工具用时')
    expect(dialog.textContent).toContain('2s')
    expect(dialog.textContent).toContain('首 token 平均')
    expect(dialog.textContent).toContain('0.1s')
    expect(dialog.textContent).toContain('解码速度')
    expect(dialog.textContent).toContain('22 tok/s')
  })

  it('keeps the two dialogs mutually exclusive', () => {
    const { source } = makeSource()
    render(<StatsLineEnhanced {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 1, steps: 1, llmMs: 1100 }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '1 轮 · 1 步' }))
    expect(screen.getByRole('dialog').textContent).toContain('用时与速度')
    fireEvent.click(screen.getByRole('button', { name: '105 tok · 缓存命中 90%' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Token 用量')
    expect(dialog.textContent).not.toContain('用时与速度')
  })

  it('shows the precise rate and the miss row with both toggles on', () => {
    statsLineState.setCachePrecision(true)
    statsLineState.setTokenDetail(true)
    const { source } = makeSource([assistant(1, 1)])
    render(<StatsLineEnhanced {...props(source, {
      tokenUsage: { uncachedInputTokens: 59, outputTokens: 5, cacheReadTokens: 341, cacheWriteTokens: 0 },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '405 tok · 缓存命中 85.25%' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('85.25%')
    expect(dialog.textContent).toContain('未命中缓存')
    expect(dialog.textContent).toContain('59 tok')
    expect(dialog.textContent).toContain('405 tok')
  })

  it('closes the open dialog on Escape', () => {
    const { source } = makeSource([assistant(1, 1)])
    render(<StatsLineEnhanced {...props(source, { tokenUsage: USAGE })} />)
    fireEvent.click(screen.getByRole('button', { name: '105 tok · 缓存命中 90%' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
});
