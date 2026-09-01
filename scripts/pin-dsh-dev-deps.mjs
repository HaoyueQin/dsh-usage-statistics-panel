/**
 * CI matrix seam: rewrite every @deepseek-ai/* devDependency to ONE exact
 * version so the dual-host regression workflow (.github/workflows/test.yml)
 * can run the suite against an older host line while the repo default builds
 * against the newest validated alpha. package.json is rewritten in place and
 * never committed (CI-only); pnpm-workspace.yaml's minimumReleaseAgeExclude
 * list covers both the current and the re-pinned specs.
 *
 * Usage: node scripts/pin-dsh-dev-deps.mjs <version>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!version || !/^[\w.-]+$/.test(version)) {
  console.error('usage: node scripts/pin-dsh-dev-deps.mjs <version>')
  process.exit(1)
}

const pkgPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
let pinned = 0
for (const name of Object.keys(pkg.devDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/')) {
    pkg.devDependencies[name] = version
    pinned++
  }
}
if (pinned === 0) {
  console.error('no @deepseek-ai/* devDependencies found — refusing to continue')
  process.exit(1)
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`pinned ${pinned} @deepseek-ai/* devDependencies to ${version}`)
