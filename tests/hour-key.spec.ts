/**
 * The hourly bucket key: the host records calls with an exact `ev.time`, so
 * the panel can group by local hour without a separate clock. Kept next to
 * `dayKey` so both keys share one local-time definition.
 */
import { describe, expect, it } from 'vitest'
import { hourKey } from '../src/shared.ts'

describe('hourKey', () => {
  it('pads month, day and hour in local time', () => {
    const ts = new Date(2026, 0, 5, 7, 30).getTime()
    expect(hourKey(ts)).toBe('2026-01-05T07')
  })

  it('keeps the late-night hour on its own day', () => {
    const ts = new Date(2026, 11, 31, 23, 59).getTime()
    expect(hourKey(ts)).toBe('2026-12-31T23')
  })

  it('sorts chronologically as a plain string', () => {
    const early = hourKey(new Date(2026, 2, 1, 8, 0).getTime())
    const late = hourKey(new Date(2026, 2, 1, 9, 0).getTime())
    expect(early < late).toBe(true)
  })
})
