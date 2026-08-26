/**
 * Client preferences for the conversation bottom-bar (stats line) enhancements,
 * persisted in localStorage as one JSON blob.
 *
 * Two toggles share one blob so a single read covers both:
 * - `cachePrecision`: render the cache-hit rate with two decimals (e.g.
 *   "85.25%") instead of the default integer percentage;
 * - `tokenDetail`: replace the default "input/output" pair with a five-item
 *   breakdown — total, input, input (cache hit), input (cache miss) and output.
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
}

const DEFAULTS: StatsLinePrefs = { cachePrecision: false, tokenDetail: false }

function readStored(): StatsLinePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<StatsLinePrefs>
    return {
      cachePrecision: parsed.cachePrecision === true,
      tokenDetail: parsed.tokenDetail === true,
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
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/** Test-only: re-read persisted storage so a fresh test starts clean. */
export function resetStatsLineStateForTests(): void {
  prefs = readStored()
}
