/**
 * Tests for the bottom-bar enhancement preference store: two boolean toggles
 * (cache-hit-rate precision, detailed token breakdown) persisted as one JSON
 * blob in localStorage, with module-store subscription so the settings panel
 * and the stats line stay in sync inside the same client bundle.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStatsLineStateForTests, statsLineState } from '../src/client/stats-line-state.ts'

const STORAGE_KEY = 'dsh-usage-statistics-panel:stats-line'

beforeEach(() => {
  window.localStorage.clear()
  resetStatsLineStateForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('statsLineState', () => {
  it('defaults both toggles to off and persists each flip as JSON', () => {
    expect(statsLineState.cachePrecision).toBe(false)
    expect(statsLineState.tokenDetail).toBe(false)

    statsLineState.setCachePrecision(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"cachePrecision":true,"tokenDetail":false}')

    statsLineState.setTokenDetail(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"cachePrecision":true,"tokenDetail":true}')

    statsLineState.setCachePrecision(false)
    expect(statsLineState.cachePrecision).toBe(false)
    expect(statsLineState.tokenDetail).toBe(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"cachePrecision":false,"tokenDetail":true}')
  })

  it('re-reads a persisted JSON value on load and ignores corrupt storage', () => {
    window.localStorage.setItem(STORAGE_KEY, '{"cachePrecision":true,"tokenDetail":true}')
    resetStatsLineStateForTests()
    expect(statsLineState.cachePrecision).toBe(true)
    expect(statsLineState.tokenDetail).toBe(true)

    window.localStorage.setItem(STORAGE_KEY, '{not json')
    resetStatsLineStateForTests()
    expect(statsLineState.cachePrecision).toBe(false)
    expect(statsLineState.tokenDetail).toBe(false)
  })

  it('notifies subscribers only on change', () => {
    const fn = vi.fn()
    const off = statsLineState.subscribe(fn)
    statsLineState.setCachePrecision(true)
    expect(fn).toHaveBeenCalledTimes(1)
    statsLineState.setCachePrecision(true) // no-op: unchanged value
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    statsLineState.setTokenDetail(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('falls back to in-memory state when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    resetStatsLineStateForTests()
    expect(statsLineState.cachePrecision).toBe(false)
    statsLineState.setCachePrecision(true)
    expect(statsLineState.cachePrecision).toBe(true)
    statsLineState.setTokenDetail(true)
    expect(statsLineState.tokenDetail).toBe(true)
  })
  it('syncs from a storage event written by another bundle instance or tab', () => {
    const fn = vi.fn()
    statsLineState.subscribe(fn)
    // The other instance already persisted the new blob; this instance's
    // in-memory store is still the old default.
    window.localStorage.setItem(STORAGE_KEY, '{"cachePrecision":true,"tokenDetail":false}')
    window.dispatchEvent(new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: '{"cachePrecision":true,"tokenDetail":false}',
    }))
    expect(statsLineState.cachePrecision).toBe(true)
    expect(statsLineState.tokenDetail).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ignores storage events for unrelated keys or unchanged values', () => {
    const fn = vi.fn()
    statsLineState.subscribe(fn)
    window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key', newValue: 'x' }))
    expect(fn).not.toHaveBeenCalled()
    // Same persisted value: no state change, no notification.
    window.localStorage.setItem(STORAGE_KEY, '{"cachePrecision":false,"tokenDetail":false}')
    window.dispatchEvent(new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: '{"cachePrecision":false,"tokenDetail":false}',
    }))
    expect(fn).not.toHaveBeenCalled()
  })
})
