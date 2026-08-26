/**
 * Tests for the bundle double-mount guard in cordis.patch.yml: the `!!js`
 * disabled expression must evaluate to false when NO other enabled entry
 * mounts this package (the patch row owns the panel) and true when one does
 * (the aggregate/other instance owns it — the patch row backs off). The
 * expression is re-evaluated here through the same JS surface the harness
 * evaluates, with stub loader entry tables.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface StubEntry {
  options: { name: string; id: string }
  disabled?: boolean
}

function loadGuard(): (ctx: { loader: { entries: () => StubEntry[] } }) => boolean {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const match = patch.match(/disabled: !!js "([^"]+)"/)
  expect(match).not.toBeNull()
  const expr = match![1]!
  // Same evaluation shape as the harness's `!!js` string expression.
  return new Function('ctx', 'return (' + expr + ')') as (ctx: { loader: { entries: () => StubEntry[] } }) => boolean
}

const NAME = 'dsh-usage-statistics-panel'

describe('cordis.patch.yml double-mount guard', () => {
  it('is disabled=false when this patch row is the only mount', () => {
    const guard = loadGuard()
    expect(guard({
      loader: { entries: () => [{ options: { name: NAME, id: 'usage-stats' } }] },
    })).toBe(false)
  })

  it('is disabled=true when another enabled entry already mounts the package', () => {
    const guard = loadGuard()
    expect(guard({
      loader: {
        entries: () => [
          { options: { name: NAME, id: 'usage-stats' } },
          { options: { name: NAME, id: 'aggregate-mount' } },
        ],
      },
    })).toBe(true)
  })

  it('ignores same-name entries that are themselves disabled', () => {
    const guard = loadGuard()
    expect(guard({
      loader: {
        entries: () => [
          { options: { name: NAME, id: 'usage-stats' } },
          { options: { name: NAME, id: 'aggregate-mount' }, disabled: true },
        ],
      },
    })).toBe(false)
  })
})
