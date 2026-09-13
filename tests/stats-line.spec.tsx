/**
 * Tests for StatsLineEnhanced (the shadowing composer.dock entry): with every
 * toggle off the row matches the official StatsPills output - a gauge pill
 * (counts + speed, click opens the time dialog) and a database pill (total +
 * cache hit, click opens the usage dialog). With a toggle on, the cache hit
 * rate gains two decimals, the usage dialog gains the miss row, and the gauge
 * pill's speed figure becomes the live streaming estimate until the step
 * settles. The component is fed by the same projection seats as the official
 * one (tokenUsage / sessionStats), so the tests stub them the way the official
 * suite does. Dialogs portal into document.body; the two pills share one
 * exclusive open slot.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

/** Minimal chat-snapshot stub: the component reads s.legacy.nodes and, for the
 *  live speed estimate, s.legacy.partial. */
function makeSource(nodes: readonly unknown[] = [], partial: unknown = null): {
  source: { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
} {
  const snap = { legacy: { nodes, partial } }
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

/**
 * A store-shaped chat seat: it subscribes the way the real one does, so a test
 * can both replay a chunk frame that swaps only `partial` (the object-layer
 * contract the official suite asserts) and grow a step's output the way a live
 * one actually grows. The plain `makeSource` stub above cannot do either — it
 * never notifies, so only an explicit re-render would be seen.
 */
function liveSeat(nodes: readonly unknown[], initial: unknown = null): {
  useChat: StatsLineEnhancedProps['useChat']
  set(partial: unknown): void
} {
  const box = { partial: initial }
  const listeners = new Set<() => void>()
  return {
    useChat: ((selector: (s: unknown) => unknown) => useSyncExternalStore(
      (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
      () => selector({ legacy: { nodes, partial: box.partial } }),
    )) as StatsLineEnhancedProps['useChat'],
    set(partial: unknown): void {
      box.partial = partial
      for (const notify of [...listeners]) notify()
    },
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

/**
 * The live-speed arm evaluates its quotient at render time off Date.now(), so
 * these cases run on fake timers: advancing the clock and then delivering a
 * delta is what produces a reading. A step's window opens when its output first
 * becomes observable, and the first reading lands on the first delta after the
 * 500ms floor — the deltas drive the figure, the 1s beat only covers a step
 * that has gone quiet.
 *
 * Fixtures hand over the text a steady stream would have produced BY each mark —
 * 100 hanzi/s, i.e. 60 tokens/s at the published density — rather than the whole
 * answer at once. A whole-answer fixture reads high on a short window, which is
 * the burst the floor exists to reject, not the shape a live step has.
 *
 * The official figure in every case is 20 tok/s (20 tokens over 1s of decode
 * wall time), so any other number on screen is the estimate.
 */
describe('StatsLineEnhanced streaming throughput', () => {
  /** Hanzi a steady step has produced `ms` into its window (100/s). */
  const charsBy = (ms: number): number => Math.round(ms / 10)
  /** That output as one text block, pinned to a turn:step. */
  const partialWith = (hanzi: number, turn = 1, step = 1): unknown =>
    ({ turn, step, blocks: [{ kind: 'text', text: '中'.repeat(hanzi) }] })
  const OFFICIAL = '1 轮 · 1 步 · 20 tok/s'
  const pills = { tokenUsage: USAGE, sessionStats: sessionStats({ turns: 1, steps: 1, decodeMs: 1_000, decodeTokens: 20 }) }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Render with the live reading on or off; returns the seat and the gauge pill. */
  function mount(initial: unknown, live = true, nodes: readonly unknown[] = [assistant(1, 1)]): {
    seat: ReturnType<typeof liveSeat>
    pill: HTMLElement
  } {
    statsLineState.setStreamThroughput(live)
    const seat = liveSeat(nodes, initial)
    render(<StatsLineEnhanced useChat={seat.useChat} useProjection={projections(pills)} t={t} />)
    return { seat, pill: screen.getByRole('button', { name: OFFICIAL }) }
  }

  it('publishes the first reading on the first delta past the window', () => {
    const { seat, pill } = mount(partialWith(0))
    // 100ms in: a delta arrives, but the window is not yet trustworthy.
    act(() => { seat.set(partialWith(charsBy(100))) })
    expect(pill.textContent).toContain('20 tok/s')
    // 500ms in: the next delta lands with the window open, and the figure
    // appears on that very frame — no beat, no extra period of dead time.
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(pill.textContent).toContain('60 tok/s')
  })

  it('holds a steady reading while the stream stays steady', () => {
    const { seat, pill } = mount(partialWith(0))
    // 30 tokens over 0.5s, 90 over 1.5s, 150 over 2.5s — one constant rate.
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(pill.textContent).toContain('60 tok/s')
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { seat.set(partialWith(charsBy(1_500))) })
    expect(pill.textContent).toContain('60 tok/s')
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { seat.set(partialWith(charsBy(2_500))) })
    expect(pill.textContent).toContain('60 tok/s')
  })

  it('updates on every delta without the stale-denominator sawtooth', () => {
    // The failure this guards: evaluating the quotient against a stored
    // "refreshed at" timestamp, which pairs a fresh numerator with the previous
    // beat's clock — the figure climbs between refreshes and snaps back. Reading
    // the clock at render time keeps both terms on the same instant, so a steady
    // stream keeps reporting its rate however often a delta lands.
    const { seat, pill } = mount(partialWith(0))
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(pill.textContent).toContain('60 tok/s')
    // Mid-second deltas: 60 tokens at t=1.0s, then 90 at t=1.5s.
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(1_000))) })
    expect(pill.textContent).toContain('60 tok/s')
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(1_500))) })
    expect(pill.textContent).toContain('60 tok/s')
  })

  it('leaves the official figure in place when the preference is off', () => {
    const { seat, pill } = mount(partialWith(0), false)
    act(() => { seat.set(partialWith(charsBy(3_000))) })
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(pill.textContent).toContain('20 tok/s')
    expect(pill.textContent).not.toContain('60 tok/s')
  })

  it('renders the figure in a width-reserved slot the row cannot reflow on', () => {
    // The row is centred, so a figure whose width tracked its digits would
    // re-centre both pills on every refresh — the counts pill would visibly
    // drift along with the speed reading. The slot's width is held by
    // css.speed; this asserts the figure still renders INTO that slot.
    const { seat, pill } = mount(partialWith(0))
    const figure = (): string | null | undefined => pill.querySelector('[data-stats-speed]')?.textContent
    expect(figure()).toBe('20 tok/s')
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(figure()).toBe('60 tok/s')
    // A jump from two digits to three stays inside the same element, so the
    // slot's reserved width — not the digits — is what the row lays out.
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { seat.set(partialWith(charsBy(1_500) * 3)) })
    expect(figure()).toBe('180 tok/s')
    expect(pill.querySelectorAll('[data-stats-speed]')).toHaveLength(1)
  })

  it('hands the reading back to the official figure the moment the step settles', () => {
    const { seat, pill } = mount(partialWith(0))
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(pill.textContent).toContain('60 tok/s')

    // The step settles: the frame itself drops the pill back, without waiting
    // for a beat.
    act(() => { seat.set(null) })
    expect(pill.textContent).toContain('20 tok/s')
    expect(pill.textContent).not.toContain('60 tok/s')
  })

  it('counts reasoning and tool-call arguments alongside the visible answer', () => {
    // 20 + 20 hanzi (12 + 12) plus 20 ASCII argument chars (6) = 30 tokens, the
    // same total a 500ms slice of the steady stream carries.
    const { seat, pill } = mount(partialWith(0))
    act(() => { vi.advanceTimersByTime(500) })
    act(() => {
      seat.set({
        turn: 1,
        step: 1,
        blocks: [
          { kind: 'text', text: '中'.repeat(20) },
          { kind: 'reasoning', text: '中'.repeat(20) },
          { kind: 'tool-call', callId: 'c', name: 'read', argsRaw: 'a'.repeat(20) },
        ],
      })
    })
    expect(pill.textContent).toContain('60 tok/s')
  })

  it('calibrates the estimate against the session own settled steps', () => {
    // A settled step of 200 hanzi reported 180 output tokens: 180 / 120 prior
    // = ×1.5, so the same density on the live step prices 30 → 45 over 0.5s.
    const settled: AssistantMessageNodeLike = {
      ...assistant(1, 1, { outputTokens: 180 }),
      blocks: [{ kind: 'text', text: '中'.repeat(200) }],
    }
    const { seat, pill } = mount(partialWith(0), true, [settled])
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(pill.textContent).toContain('90 tok/s')
  })

  it('keeps one window when the estimate dips mid-step', () => {
    // Block boundaries replace accumulated text wholesale (a reasoning block
    // closes, a retry empties the stream), so the estimate legitimately shrinks
    // inside one step. Re-anchoring the window on every dip would collapse the
    // denominator — the reading would never clear the floor during reasoning and
    // would spike the moment the answer started.
    const { seat, pill } = mount(partialWith(0))
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500))) })
    expect(pill.textContent).toContain('60 tok/s')

    // 30 → 3 estimated tokens: the window keeps running, so t=1.5s reads
    // 3/1.5 = 2, not a re-anchored 3/1 = 3.
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { seat.set(partialWith(5)) })
    expect(pill.textContent).toContain('2 tok/s')

    // Recovery continues the same window: 150/2.5 = 60, not a spike to 150/1.
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { seat.set(partialWith(charsBy(2_500))) })
    expect(pill.textContent).toContain('60 tok/s')
  })

  it('restarts the window when the stream moves to the next step', () => {
    const { seat, pill } = mount(partialWith(0, 1, 1))
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set(partialWith(charsBy(500), 1, 1)) })
    expect(pill.textContent).toContain('60 tok/s')

    // Step 2 opens its own window at t=0.5s: the delta that switches the step
    // arrives with no measurable window yet, so the official figure returns.
    act(() => { seat.set(partialWith(0, 1, 2)) })
    expect(pill.textContent).toContain('20 tok/s')
    // 1s into that window: 100 hanzi = 60 tokens over 1s, the same rate again.
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { seat.set(partialWith(charsBy(1_000), 1, 2)) })
    expect(pill.textContent).toContain('60 tok/s')
  })
});

/**
 * The official StatsPills carries a hard acceptance criterion — "renders ZERO
 * times during streaming chunk frames" — because its row must stay out of the
 * per-frame delta path. A shadowing row owes the same property, so these cases
 * replay real chunk frames against a subscribing seat (a plain selector stub
 * cannot show a re-render count) and count renders on the row itself.
 */
describe('StatsLineEnhanced streaming subscription isolation', () => {
  const pills = { tokenUsage: USAGE, sessionStats: sessionStats({ turns: 1, steps: 1, decodeMs: 1_000, decodeTokens: 20 }) }

  function countRenders(seat: { useChat: StatsLineEnhancedProps['useChat'] }): () => number {
    let renders = 0
    function Counting(p: StatsLineEnhancedProps) {
      renders += 1
      return <StatsLineEnhanced {...p} />
    }
    render(<Counting useChat={seat.useChat} useProjection={projections(pills)} t={t} />)
    return () => renders
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders zero times per chunk frame while the preference is off', () => {
    const seat = liveSeat([assistant(1, 1)])
    const renders = countRenders(seat)
    const before = renders()
    act(() => { seat.set({ turn: 1, step: 2, blocks: [{ kind: 'text', text: 'a' }] }) })
    act(() => { seat.set({ turn: 1, step: 2, blocks: [{ kind: 'text', text: 'ab' }] }) })
    expect(renders()).toBe(before)
  })

  it('keeps the pills out of the delta path while the reading is live', () => {
    statsLineState.setStreamThroughput(true)
    // A step already open — its window anchored at mount — so the frame below is
    // an ordinary delta rather than the one that starts the step.
    const seat = liveSeat([assistant(1, 1)], { turn: 1, step: 1, blocks: [] })
    const renders = countRenders(seat)
    const before = renders()
    // The same frames that must not touch the row do drive the reading.
    act(() => { vi.advanceTimersByTime(500) })
    act(() => { seat.set({ turn: 1, step: 1, blocks: [{ kind: 'text', text: '中'.repeat(50) }] }) })
    expect(renders()).toBe(before)
    expect(screen.getByRole('button', { name: '1 轮 · 1 步 · 20 tok/s' }).textContent).toContain('60 tok/s')
  })
});
