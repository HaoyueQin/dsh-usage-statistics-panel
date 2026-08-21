/**
 * Pure helpers shared by the host aggregation layer and the browser panel.
 * This module MUST stay free of Node.js and DOM types and carry zero
 * imports: both halves import it at runtime (the client bundle-purity gate
 * rejects Node builtins, and a value import of `wire.ts` would drag the
 * host-only HTTP helpers — including `Buffer` — into the browser bundle).
 */

/** Local calendar day key, e.g. "2026-08-02" (no UTC shift). */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** All local-calendar day keys in [from, to], inclusive. Invalid or reversed
 *  bounds yield an empty list. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
  }
  return out
}

/** model refs are "provider/model"; a bare model name has no slash and is
 *  attributed to provider "default". */
export function providerOf(modelRef: string): string {
  const i = modelRef.indexOf('/')
  if (i > 0) return modelRef.slice(0, i)
  return 'default'
}
