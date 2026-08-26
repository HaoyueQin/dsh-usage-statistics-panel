/**
 * Tests for the two bottom-bar enhancement preference rows in the usage panel:
 * they sit below the sidebar quick-entry row, share its framed look (title +
 * subtitle + switch) and persist through statsLineState/localStorage.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import { resetStatsLineStateForTests, statsLineState } from '../src/client/stats-line-state.ts'
import { resetSidebarEntryStateForTests } from '../src/client/sidebar-entry-state.ts'

const STORAGE_KEY = 'dsh-usage-statistics-panel:stats-line'

const t = ((key: string) => key) as unknown as UsageStatsSectionProps['t']

beforeEach(() => {
  window.localStorage.clear()
  resetStatsLineStateForTests()
  resetSidebarEntryStateForTests()
})

afterEach(() => {
  cleanup()
})

describe('bottom-bar preference rows', () => {
  it('renders three framed switches: sidebar entry plus the two toggles', () => {
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    expect(screen.getByText('sidebarEntry')).toBeTruthy()
    expect(screen.getByText('sidebarEntryDesc')).toBeTruthy()
    expect(screen.getByText('cachePrecision')).toBeTruthy()
    expect(screen.getByText('cachePrecisionDesc')).toBeTruthy()
    expect(screen.getByText('tokenDetail')).toBeTruthy()
    expect(screen.getByText('tokenDetailDesc')).toBeTruthy()
  })

  it('toggles the precise cache hit rate and persists it as JSON', () => {
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[1]!)
    expect(switches[1]!.getAttribute('aria-checked')).toBe('true')
    expect(statsLineState.cachePrecision).toBe(true)
    expect(statsLineState.tokenDetail).toBe(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"cachePrecision":true,"tokenDetail":false}')

    fireEvent.click(switches[1]!)
    expect(switches[1]!.getAttribute('aria-checked')).toBe('false')
    expect(statsLineState.cachePrecision).toBe(false)
  })

  it('toggles the token breakdown and keeps the sibling preference untouched', () => {
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[2]!)
    expect(switches[2]!.getAttribute('aria-checked')).toBe('true')
    expect(statsLineState.tokenDetail).toBe(true)
    expect(statsLineState.cachePrecision).toBe(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"cachePrecision":false,"tokenDetail":true}')
  })

  it('updates the row live when the shared store changes', () => {
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    const switches = screen.getAllByRole('switch')
    expect(switches[1]!.getAttribute('aria-checked')).toBe('false')
    act(() => { statsLineState.setCachePrecision(true) })
    expect(switches[1]!.getAttribute('aria-checked')).toBe('true')
    act(() => { statsLineState.setTokenDetail(true) })
    expect(switches[2]!.getAttribute('aria-checked')).toBe('true')
  })
})
