/**
 * Host-surface guard.
 *
 * This plugin ships ONE build against every supported DSH line, so the only
 * thing standing between a host release and a crashed slot is whether every
 * symbol it imports from a platform external still exists. `0.2.2-rc.2`
 * removed `useAnchoredPosition` from
 * `@deepseek-ai/dsh-client-ui-primitives` and nothing noticed until a user's
 * composer-dock slot threw (issues #24 / #25).
 *
 * `src/client/stat-dialog.ts` reads that one hook as a PROPERTY with a local
 * fallback, so it is exempt here; everything else is imported by name and is
 * asserted against the primitives package the current install resolved. CI
 * runs this suite twice (the pinned floor line and the newest published line),
 * which turns "adapt to the latest version" into something a machine checks on
 * every push instead of something a user reports.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

const SRC = join(process.cwd(), 'src')

/** Every .ts/.tsx file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

interface NamedImport {
  file: string
  symbol: string
}

/** Value (non-type) symbols imported by name from the primitives package. */
function namedPrimitiveImports(): NamedImport[] {
  const found: NamedImport[] = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/g)) {
      const list = match[1] ?? ''
      for (const raw of list.split(',')) {
        const clause = raw.trim()
        if (clause === '') continue
        // `type Foo` imports exist only in the type space; they are the
        // typings' problem, not the runtime's.
        if (clause.startsWith('type ')) continue
        const symbol = clause.split(/\s+as\s+/)[0]?.trim()
        if (symbol !== undefined && symbol !== '') {
          found.push({ file: relative(SRC, file).replace(/\\/g, '/'), symbol })
        }
      }
    }
  }
  return found
}

describe('primitives surface', () => {
  it('finds the imports it is meant to check', () => {
    // A guard against the guard silently matching nothing (e.g. an import
    // style change that would also defeat it below).
    expect(namedPrimitiveImports().length).toBeGreaterThan(0)
  })

  it('still exports every symbol this plugin imports by name', () => {
    const exports = primitives as unknown as Record<string, unknown>
    const missing = namedPrimitiveImports()
      .filter(({ symbol }) => exports[symbol] === undefined)
      .map(({ file, symbol }) => `${file} → ${symbol}`)
    expect(missing).toEqual([])
  })

  it('reads the removed anchored hook as a property, never as a named import', () => {
    // Named-importing it again would fail the typecheck on 0.2.2+ (the export
    // is gone) and throw at render time on the same line.
    const source = readFileSync(join(SRC, 'client/stat-dialog.ts'), 'utf8')
    expect(source).not.toMatch(/import\s*\{[^}]*\buseAnchoredPosition\b/)
    expect(source).toMatch(/primitives\.useAnchoredPosition|primitives_\s*\.useAnchoredPosition|\buseAnchoredPosition\?:/)
  })
})