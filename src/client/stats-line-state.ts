/**
 * Client preferences for the conversation bottom-bar (stats line) enhancements,
 * persisted in localStorage as one JSON blob.
 *
 * Three toggles share one blob so a single read covers all of them:
 * - `cachePrecision`: render the cache-hit rate with two decimals (e.g.
 *   "85.25%") instead of the default integer percentage;
 * - `tokenDetail`: add the input (cache miss) row to the usage dialog's
 *   input / cache-read / cache-write / output breakdown;
 * - `streamThroughput`: while a step streams, replace the pill's speed figure
 *   with the live estimate and fall back to the official session figure the
 *   moment it settles.
 *
 * The panel row and the stats line live in two different slot trees but inside
 * the SAME client bundle instance, so a tiny module store keeps them in sync
 * without touching the host or the settings document. Reads are defensive
 * (private mode / quota make storage throw); partial or corrupt blobs fall
 * back to defaults value by value.
 */

const STORAGE_KEY = 'dsh-usage-statistics-panel:stats-line'

export interface StatsLinePrefs {
  cachePrecision: boolean
  tokenDetail: boolean
  streamThroughput: boolean
}

const DEFAULTS: StatsLinePrefs = { cachePrecision: false, tokenDetail: false, streamThroughput: false }

function readStored(): StatsLinePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<StatsLinePrefs>
    return {
      cachePrecision: parsed.cachePrecision === true,
      tokenDetail: parsed.tokenDetail === true,
      streamThroughput: parsed.streamThroughput === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let prefs: StatsLinePrefs = readStored()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function persist(next: StatsLinePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable (private mode / quota): the in-memory value still
    // drives this page load.
  }
}

export const statsLineState = {
  get cachePrecision(): boolean {
    return prefs.cachePrecision
  },
  get tokenDetail(): boolean {
    return prefs.tokenDetail
  },
  get streamThroughput(): boolean {
    return prefs.streamThroughput
  },
  setCachePrecision(next: boolean): void {
    if (next === prefs.cachePrecision) return
    prefs = { ...prefs, cachePrecision: next }
    persist(prefs)
    notify()
  },
  setTokenDetail(next: boolean): void {
    if (next === prefs.tokenDetail) return
    prefs = { ...prefs, tokenDetail: next }
    persist(prefs)
    notify()
  },
  setStreamThroughput(next: boolean): void {
    if (next === prefs.streamThroughput) return
    prefs = { ...prefs, streamThroughput: next }
    persist(prefs)
    notify()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

// Cross-instance sync: the official channel (lib/client.js) and the plugin
// registry channel (lib/client-registry.js) each carry their own module store,
// and separate browser tabs do too. storage events fire on OTHER instances'
// writes, so this listener re-reads and notifies; same-instance writes never
// fire it (no double notify).
function samePrefs(left: StatsLinePrefs, right: StatsLinePrefs): boolean {
  return left.cachePrecision === right.cachePrecision
    && left.tokenDetail === right.tokenDetail
    && left.streamThroughput === right.streamThroughput
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    const next = readStored()
    if (samePrefs(next, prefs)) return
    prefs = next
    notify()
  })
}

/** Test-only: re-read persisted storage so a fresh test starts clean. */
export function resetStatsLineStateForTests(): void {
  prefs = readStored()
}
