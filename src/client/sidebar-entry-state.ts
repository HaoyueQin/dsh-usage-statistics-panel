/**
 * Client preference for the sidebar quick entry, persisted in localStorage.
 *
 * The settings row (UsageStatsPanel) and the sidebar footer action
 * (SidebarEntry) live in two different slot trees but run inside the SAME
 * client bundle instance, so a tiny module store keeps them in sync without
 * touching the host or the settings document. The value is a plain boolean
 * ("1"/"0" in localStorage); reads are defensive (private mode / quota make
 * storage throws).
 */

const STORAGE_KEY = 'dsh-usage-statistics-panel:sidebar-entry'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

let enabled = readStored()
const listeners = new Set<() => void>()

export const sidebarEntryState = {
  get enabled(): boolean {
    return enabled
  },
  setEnabled(next: boolean): void {
    if (next === enabled) return
    enabled = next
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // Storage unavailable (private mode / quota): the in-memory value still
      // drives this page load.
    }
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

// Cross-instance sync (dual-channel bundles / multiple tabs): a storage event
// from another instance re-reads the value; same-instance writes never fire it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    const next = readStored()
    if (next === enabled) return
    enabled = next
    for (const listener of listeners) listener()
  })
}

/** Test-only: re-read persisted storage so a fresh test starts clean. */
export function resetSidebarEntryStateForTests(): void {
  enabled = readStored()
}
