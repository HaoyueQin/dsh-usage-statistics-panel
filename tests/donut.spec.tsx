/**
 * The donut's geometry is pure arithmetic, so it is pinned here rather than
 * through the DOM: the ring must stay proportional at every diameter the
 * container can ask for, and the diameter solver must never squeeze the list
 * beside it.
 */
import { describe, expect, it } from 'vitest'
import { donutGeometry, resolveDonutSize } from '../src/client/Donut.tsx'

describe('donutGeometry', () => {
  it('keeps the historical proportions at the 200px floor', () => {
    const g = donutGeometry(200)
    expect(g.cx).toBe(100)
    expect(g.sw).toBeCloseTo(30, 5)
    expect(g.r).toBeCloseTo(80, 5)
    expect(g.circ).toBeCloseTo(2 * Math.PI * 80, 5)
  })

  it('scales every value with the diameter', () => {
    const small = donutGeometry(200)
    const large = donutGeometry(400)
    expect(large.r / small.r).toBeCloseTo(2, 5)
    expect(large.sw / small.sw).toBeCloseTo(2, 5)
  })

  it('leaves the stroke inside the box at any size', () => {
    for (const size of [200, 240, 280]) {
      const g = donutGeometry(size)
      // The ring's outer edge (r + sw/2) must not exceed the half-box.
      expect(g.r + g.sw / 2).toBeLessThanOrEqual(size / 2)
    }
  })
})

describe('resolveDonutSize', () => {
  it('caps at 280px on the wide plugins page', () => {
    expect(resolveDonutSize(960)).toBe(280)
  })

  it('never squeezes the list below its basis', () => {
    const size = resolveDonutSize(500)
    expect(size).toBe(224)
    expect(size + 16 + 260).toBeLessThanOrEqual(500)
  })

  it('holds the 200px floor when the row wraps instead', () => {
    expect(resolveDonutSize(400)).toBe(200)
    expect(resolveDonutSize(0)).toBe(200)
  })
})
