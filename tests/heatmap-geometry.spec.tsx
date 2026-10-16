/**
 * The heatmap must fill its container edge to edge at every width, and must
 * spend spare width on MORE WEEKS before it grows the cells.
 *
 * Two defects are pinned here:
 *  - the trim branch returned `totalWeeks: cols` although `cols * 7` days
 *    behind a leading partial week lay out `cols + 1` tracks, so the SVG
 *    viewport was one column narrower than the grid and the newest week was
 *    pushed outside the viewBox, surviving only as a sliver at the right edge;
 *  - the original "does it fit" judge compared the window against `totalWeeks`
 *    while the render used `cols`, so the band where the cells dropped under
 *    the base size slipped through (measured: 19.7px of overflow, 4704 of 6167
 *    width/offset combinations).
 *
 * `laidOut()` below is deliberately computed from the DATA WINDOW, never from
 * the solver's own answer: asserting `totalWeeks * (size + GAP) + GAP` against
 * `totalWeeks` is self-consistent and cannot catch a wrong track count.
 */
import { describe, expect, it } from 'vitest'
import { HEAT_WEEKS, heatGeometry, type HeatGeometry } from '../src/client/UsageStatsPanel.tsx'

const GAP = 3
const BASE = 14

/** Tracks the render actually lays out for `cols` weeks behind `so` blanks. */
const laidOut = (cols: number, so: number): number => Math.ceil((cols * 7 + so) / 7)

/** Width the SVG must cover for the weeks the solver asked it to draw. */
const drawnWidth = (g: HeatGeometry, so: number): number =>
  laidOut(g.cols, so) * (g.size + GAP) + GAP

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

  // ── the track-count defect ───────────────────────────────────────────────

  it('reports a viewport that covers every column it lays out', () => {
    // The regression: `totalWeeks` came back as `cols` while the render needed
    // one more track for the partial leading week, at every offset but 0.
    for (let so = 0; so <= 6; so++) {
      for (const avail of [300, 500, 700, 860, 881, 890, 900, 904, 958]) {
        const g = heatGeometry(avail, so)
        expect(laidOut(g.cols, so)).toBeLessThanOrEqual(g.totalWeeks)
      }
    }
  })

  it('never clips the newest column at any width or weekday offset', () => {
    // Sweeps the whole width range against a viewport computed from the data
    // window, so a wrong `totalWeeks` cannot hide behind its own definition.
    for (let so = 0; so <= 6; so++) {
      for (let avail = 120; avail <= 1000; avail++) {
        const g = heatGeometry(avail, so)
        expect(drawnWidth(g, so)).toBeLessThanOrEqual(avail + 0.5)
      }
    }
  })

  it('leaves no dead space once the cells are above the base size', () => {
    for (let so = 0; so <= 6; so++) {
      for (let avail = 120; avail <= 1000; avail++) {
        const g = heatGeometry(avail, so)
        if (g.size > BASE + 0.01) {
          expect(avail - drawnWidth(g, so)).toBeLessThanOrEqual(0.5)
        }
      }
    }
  })

  it('drops the oldest week rather than clipping the newest', () => {
    const so = 6
    const g = heatGeometry(886, so)
    expect(g.cols).toBeLessThan(HEAT_WEEKS)
    // and the grid it lays out still respects the base-cell budget
    expect(laidOut(g.cols, so)).toBeLessThanOrEqual(Math.floor((886 - GAP) / (BASE + GAP)))
  })
})
