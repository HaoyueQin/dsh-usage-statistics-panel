/**
 * The two icon surfaces issue #12 reviewed: the sidebar row's glyph and the
 * plugin card's artwork. Both are hand-authored, so their shapes are pinned
 * here — the row glyph must keep the official weight in the sidebar's 16px
 * cell, and the card's trend line must stay a two-bend polyline instead of
 * drifting back into a wobbling smooth curve.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatsIcon } from '../src/client/stats-icon.tsx'

const ROOT = join(__dirname, '..')

afterEach(cleanup)

describe('StatsIcon', () => {
  it('renders the 24-unit glyph at the official 1px weight in the 16px cell', () => {
    const { container } = render(<StatsIcon size={16} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('stroke-width')).toBe('1.5')
    // 1.5 on a 24-unit grid scaled to 16px is the 1px the official panel rows
    // draw on their 16-unit grid (ICON_REGULAR_STROKE in ui-primitives).
    expect(1.5 * 16 / 24).toBe(1)
  })
})

describe('icon.svg', () => {
  const svg = readFileSync(join(ROOT, 'icon.svg'), 'utf8')
  const trend = /<path d="([^"]+)"[^>]*stroke-width="1\.7"/u.exec(svg)?.[1]

  it('draws the trend line as a polyline with exactly two bends', () => {
    expect(trend).toBeDefined()
    // Four vertices down straight segments, one command each: no bezier, arc
    // or shorthand command can sneak the wobble back in.
    expect(trend?.match(/[A-Za-z]/gu)).toEqual(['M', 'L', 'L', 'L'])
    expect(trend?.match(/-?\d+(?:\.\d+)?/gu)).toHaveLength(8)
  })
})
