/**
 * Tests for the sidebar quick-entry feature: the framed preference row in the
 * panel (title + subtitle + switch) and the sidebar footer action button
 * (renders only while enabled, opens the Settings dialog at the usage-stats
 * section).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UsageStatsSection, type UsageStatsSectionProps } from '../src/client/index.tsx'
import { SidebarEntry, openUsageStatsSection, type SidebarEntryProps } from '../src/client/SidebarEntry.tsx'
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
    const sw = screen.getByRole('switch')
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

describe('openUsageStatsSection', () => {
  it('clicks the settings trigger and then the matching nav row', () => {
    // Sidebar-foot structure: the entry lives in the footer-actions wrapper,
    // the settings trigger in the settings seat beside it.
    const foot = document.createElement('div')
    const entry = document.createElement('button')
    const settingsSeat = document.createElement('div')
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-haspopup', 'dialog')
    foot.appendChild(entry)
    settingsSeat.appendChild(trigger)
    foot.appendChild(settingsSeat)
    document.body.appendChild(foot)

    // A dialog with the section nav already open.
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = document.createElement('nav')
    const general = document.createElement('button')
    general.textContent = 'General'
    const usage = document.createElement('button')
    usage.textContent = 'Usage statistics'
    nav.appendChild(general)
    nav.appendChild(usage)
    dialog.appendChild(nav)
    document.body.appendChild(dialog)

    const triggerClick = vi.spyOn(trigger, 'click')
    const usageClick = vi.spyOn(usage, 'click')
    const generalClick = vi.spyOn(general, 'click')
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })

    openUsageStatsSection(entry, 'Usage statistics')

    expect(triggerClick).toHaveBeenCalledOnce()
    expect(usageClick).toHaveBeenCalledOnce()
    expect(generalClick).not.toHaveBeenCalled()
  })
})
