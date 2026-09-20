/**
 * Tests for the sidebar quick-entry feature: the framed preference row in the
 * panel (title + subtitle + switch) and the sidebar footer action button
 * (renders only while enabled; clicking it asks the injected face to open the
 * panel's page on the Plugins page).
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import { SidebarEntry, type SidebarEntryProps } from '../src/client/SidebarEntry.tsx'
import { resetSidebarEntryStateForTests, sidebarEntryState } from '../src/client/sidebar-entry-state.ts'

const STORAGE_KEY = 'dsh-usage-statistics-panel:sidebar-entry'

const t = ((key: string) => key) as unknown as UsageStatsSectionProps['t']
const entryT = ((key: string) => key) as unknown as SidebarEntryProps['t']

beforeEach(() => {
  window.localStorage.clear()
  resetSidebarEntryStateForTests()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('panel quick-entry preference', () => {
  it('renders the framed option with a switch and persists the toggle', () => {
    render(<UsageStatsSection {...({ t } as UsageStatsSectionProps)} />)
    // Three rows now share the row family; the sidebar entry is the first.
    const sw = screen.getAllByRole('switch')[0]!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('sidebarEntry')).toBeTruthy()
    expect(screen.getByText('sidebarEntryDesc')).toBeTruthy()

    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    expect(sidebarEntryState.enabled).toBe(true)

    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('0')
  })
})

describe('sidebarEntryState cross-instance sync', () => {
  it('syncs from a storage event written by another bundle instance or tab', () => {
    const fn = vi.fn()
    sidebarEntryState.subscribe(fn)
    window.localStorage.setItem(STORAGE_KEY, '1')
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: '1' }))
    expect(sidebarEntryState.enabled).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    window.localStorage.setItem(STORAGE_KEY, '0')
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: '0' }))
    expect(sidebarEntryState.enabled).toBe(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('SidebarEntry', () => {
  it('renders nothing while the preference is off', () => {
    render(<SidebarEntry {...({ wide: true, t: entryT } as SidebarEntryProps)} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the labeled button with the stats icon once enabled', () => {
    sidebarEntryState.setEnabled(true)
    render(<SidebarEntry {...({ wide: true, t: entryT } as SidebarEntryProps)} />)
    const button = screen.getByRole('button', { name: 'nav' })
    expect(button.querySelector('svg path')).not.toBeNull()
    expect(button.textContent).toContain('nav')
  })

  it('renders the icon-only rail button when the sidebar is collapsed', () => {
    sidebarEntryState.setEnabled(true)
    const { container } = render(<SidebarEntry {...({ wide: false, t: entryT } as SidebarEntryProps)} />)
    const button = screen.getByRole('button', { name: 'nav' })
    expect(container.querySelector('button')).toBe(button)
    // Rail keeps the icon but drops the wide label.
    expect(button.textContent).not.toContain('nav')
  })

  it('mounts and unmounts live with the shared state', () => {
    sidebarEntryState.setEnabled(true)
    const { container } = render(<SidebarEntry {...({ wide: true, t: entryT } as SidebarEntryProps)} />)
    expect(container.querySelector('button')).not.toBeNull()
    act(() => { sidebarEntryState.setEnabled(false) })
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('SidebarEntry navigation', () => {
  it('calls the injected openPanel when clicked', () => {
    sidebarEntryState.setEnabled(true)
    const openPanel = vi.fn()
    render(<SidebarEntry {...({ wide: true, t: entryT, openPanel } as SidebarEntryProps)} />)
    fireEvent.click(screen.getByRole('button', { name: 'nav' }))
    expect(openPanel).toHaveBeenCalledOnce()
  })

  it('does not opt out of flex shrinking (the footer seat is shared)', () => {
    // The regression this guards: `flex: none` kept this button at its full
    // width and pushed every neighbour in the shared footer row to zero.
    const css = readFileSync(join(__dirname, '..', 'src', 'client', 'SidebarEntry.module.css'), 'utf8')
    const entryRule = css.slice(css.indexOf('.entry {'), css.indexOf('.entry:hover'))
    expect(entryRule).not.toContain('flex: none')
  })
})
