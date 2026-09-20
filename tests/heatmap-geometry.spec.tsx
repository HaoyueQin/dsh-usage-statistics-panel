/**
 * The heatmap must fill its container edge to edge at every width, and must
 * spend spare width on MORE WEEKS before it grows the cells. The old solver
 * judged "does it fit" against HEAT_WEEKS while the grid actually renders
 * totalWeeks (= HEAT_WEEKS + 1 when the first week is partial), so a container
 * around 900px got a ~23px overflow. These cases pin the corrected solver.
 */
import { describe, expect, it } from 'vitest'
import { HEAT_WEEKS, heatGeometry } from '../src/client/UsageStatsPanel.tsx'

const GAP = 3

describe('heatGeometry', () => {
  it('shows the full year and fills the page width at 960px', () => {
    const g = heatGeometry(958, 0)
    expect(g.cols).toBe(HEAT_WEEKS)
    expect(g.size).toBeGreaterThanOrEqual(14)
    // width = totalWeeks * (size + GAP) + GAP must equal the available width
    expect(g.totalWeeks * (g.size + GAP) + GAP).toBeCloseTo(958, 0)
  })

  it('never overflows when the first week is partial', () => {
    // 881..886 is the band that breaks a naive solver: the window "fits" by a
    // floor() test but the resulting cells fall under the base size, and a
    // max(BASE, size) fallback would then render one column too many.
    for (const avail of [870, 878, 881, 884, 886, 890, 900, 904, 920, 958]) {
      for (const so of [0, 1, 6]) {
        const g = heatGeometry(avail, so)
        expect(g.totalWeeks * (g.size + GAP) + GAP).toBeLessThanOrEqual(avail + 0.5)
      }
    }
  })

  it('trims weeks instead of shrinking cells below the base size', () => {
    const g = heatGeometry(700, 0)
    expect(g.size).toBe(14)
    expect(g.cols).toBeLessThan(HEAT_WEEKS)
    expect(g.cols).toBe(41)
  })

  it('fills the width in the trim branch too, not just the full-window branch', () => {
    // A mid-width pane trims weeks; the cells must then grow back to close the
    // gap, or up to a whole cell of dead space is left on the right (15px was
    // measured at a 732px row before this).
    for (const avail of [300, 500, 700, 732, 900]) {
      const g = heatGeometry(avail, 0)
      expect(g.totalWeeks * (g.size + GAP) + GAP).toBeCloseTo(avail, 0)
    }
  })

  it('keeps at least one week at absurd widths', () => {
    const g = heatGeometry(1, 0)
    expect(g.cols).toBe(1)
    expect(g.size).toBe(14)
  })
})
