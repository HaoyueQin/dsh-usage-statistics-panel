/**
 * tsdown build for dsh-usage-statistics-panel: the host-half lib
 * (lib/index.js, ESM node) plus the two browser client bundles
 * (lib/client.js and lib/client-registry.js, CJS closure factory) — one per
 * install channel:
 *
 * - `lib/client.js` serves the official profile channel, registering with
 *   the package-name id `dsh-usage-statistics-panel` (the client-modules
 *   compose keys on the package name),
 * - `lib/client-registry.js` serves the plugin-registry channel
 *   (dsh.plugin.json), registering with the manifest id
 *   `dsh-external/dsh-usage-statistics-panel` (the registry browser-side
 *   `arrive()` check requires bundle id === plugin id).
 *
 * Both bundles replicate the official DSH client-bundle preset
 * (packages/client/tsdown.client.ts): externals resolve through the loader
 * module table at runtime (the PLATFORM_MODULES seed list), everything else
 * is inlined, the purity gate rejects any non-whitelisted @deepseek-ai value
 * import, CSS Modules compile to hashed class maps and inject
 * <style data-plugin> tags, and each artifact registers itself via
 * window.__ModuleLoader__.load({id, factory}) with the (require) => exports
 * CJS closure shape.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list, plus preloaded client externals). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  // The client store module id (DSH >= 0.1.2-rc.1): this plugin only
  // TYPE-imports the store face today, so it never reaches the built bundle —
  // it is listed so a future value import is kept external (never inlined).
  '@deepseek-ai/dsh-client-store',
]

/**
 * Wire/type layers a client bundle may inline (mirror of the official
 * INLINE_SAFE list): browser-safe contract surfaces with no runtime identity
 * to share. Everything else under @deepseek-ai/* is either a module-table
 * entry (external) or a leak the purity gate rejects.
 */
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-agent-presets\/display$)/

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** The style-injection prologue shared by module css and plain css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing: the official channel uses the package name
 * (`dsh-usage-statistics-panel`) and the registry channel uses the manifest
 * id (`dsh-external/dsh-usage-statistics-panel`).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value and the
 *   data-plugin style-tag prefix of this bundle.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin(), makeCssPlugin(pluginId), stableRegionCommentsPlugin()],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries
      // (react, cordis, ...); it cannot load relative chunk URLs in the browser.
      // Disable code splitting so every artifact is one script.
      codeSplitting: false,
    },
  }
}

/** The shared client-bundle purity gate (see the clientBundle doc). */
function purityGatePlugin(): NonNullable<UserConfig['plugins']> {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      if (INLINE_SAFE.test(source)) return null // wire/type layer: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/**
 * Rolldown stamps every module with a `//#region <module-id>` comment. The
 * CSS virtual modules' ids embed the build-machine absolute path (the
 * CSS_VIRTUAL_PREFIX form), so each stylesheet left one machine-specific
 * comment line in the bundle even after the class-hash fix above — the npm
 * and GitHub tarballs of one version differed by exactly those lines (all
 * three diffs across the whole artifact were comment lines; the code itself
 * was already byte-equal). Normalize the comment to a fixed machine-free
 * form so the artifact is truly byte-identical across build machines.
 */
function stableRegionCommentsPlugin(): NonNullable<UserConfig['plugins']> {
  return {
    name: 'dsh-stable-region-comments',
    renderChunk(code: string) {
      // Bundle text escapes the NUL of the virtual prefix as the two
      // characters `\0`. Regular modules already carry machine-independent
      // ids, so only the virtual-CSS region lines need rewriting.
      if (!code.includes('\\0dsh-css:')) return null
      return code.replace(/^\/\/#region \\0dsh-css:.*$/gm, '//#region dsh-css')
    },
  }
}

/** The shared CSS-inline virtual-module plugin (one <style data-plugin> per file). */
function makeCssPlugin(pluginId: string): NonNullable<UserConfig['plugins']> {
  return {
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      let abs: string
      if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
        abs = importer === undefined ? source : resolvePath(dirname(importer), source)
      } else {
        abs = resolvePath(process.cwd(), 'node_modules', source)
      }
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // CSS Modules (x.module.css) become hashed class maps; plain css is
      // inlined verbatim.
      if (fileId.endsWith('.module.css')) {
        // The CSS Modules `[hash]` mixes the transform's `filename` STRING into
        // the hash (verified against lightningcss directly). Feeding the
        // absolute path made the class names differ per build machine — the
        // npm and GitHub-release tarballs of one version shipped non-identical
        // bundles (observed: `D:\Project\...` vs `/home/runner/...` produced
        // different `[hash]_local` names for the identical stylesheet). Feed
        // the repository-relative POSIX path instead: the string is identical
        // on every machine, so the hash depends only on the file's own
        // identity and content, and every build of one source tree is
        // reproducible.
        const stableFileId = relative(REPOSITORY_ROOT, fileId).split(sep).join('/')
        const { code, exports: cssExports } = transform({
          filename: stableFileId,
          code: source,
          cssModules: { pattern: `[hash]_[local]` },
          minify: true,
        })
        // lightningcss returns the exports map in Rust-HashMap order, which is
        // randomized per build — sort the keys so the generated class-map
        // literal (and thus the whole bundle) is byte-reproducible.
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          classMap[local] = exp.name
        }
        return [
          injectTag(pluginId, fileId, code.toString()),
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      }
      return [
        injectTag(pluginId, fileId, source.toString('utf8')),
        'export default "";',
      ].join('\n')
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // clean stays off: the build script removes lib/ wholesale before tsc, so
    // a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted.
    clean: false,
  },
  // Official profile channel: bundle id = package name (package.json `name`).
  clientBundle('dsh-usage-statistics-panel', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-usage-statistics-panel', 'client-registry.js'),
] satisfies UserConfig[]
