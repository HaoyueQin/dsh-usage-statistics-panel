/**
 * Manifest consistency guards (mirrors better-sidebar's
 * manifest-consistency.spec.ts): dsh.plugin.json must agree with
 * package.json, the client bundle ids must match their channels, and the
 * built artifacts must exist after `pnpm build`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

describe('manifest consistency', () => {
  const pkg = readJson('package.json')
  const manifest = readJson('dsh.plugin.json')

  it('manifest id uses the dsh-external/ two-segment convention', () => {
    expect(manifest.id).toMatch(/^dsh-external\/[a-z][a-z0-9-]*$/)
  })

  it('manifest version equals package.json version', () => {
    expect(manifest.version).toBe(pkg.version)
  })

  it('manifest main points at the built host entry', () => {
    expect(manifest.main).toBe('./lib/index.js')
    expect(existsSync(join(ROOT, 'lib/index.js'))).toBe(true)
  })

  it('client bundle ids match their install channels', () => {
    // The official profile channel registers with the package name; the
    // registry channel with the manifest id. Assert the built bundles carry
    // the right __ModuleLoader__.load({ id }) heads.
    const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
    const registry = readFileSync(join(ROOT, 'lib/client-registry.js'), 'utf8')
    expect(client).toContain(`id: ${JSON.stringify(pkg.name)}`)
    expect(registry).toContain(`id: ${JSON.stringify(manifest.id)}`)
  })

  it('client bundles exist and are lazy-CJS factories', () => {
    for (const f of ['lib/client.js', 'lib/client-registry.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(src).toContain('window.__ModuleLoader__.load(')
      expect(src).toContain('factory: (require) =>')
    }
  })

  it('cordis.patch.yml mounts the package by name', () => {
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain(`name: '${pkg.name}'`)
  })
})
