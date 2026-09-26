/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose
 * BUILT lib bundles css side-effect imports (e.g. `dsh-client-ui-primitives`
 * imports `katex/dist/katex.min.css` at the top of its `lib/index.js`).
 * Inlining routes them through Vite's transform, which stubs css imports
 * (the default `css: false`).
 *
 * Inlining also forces Vite to resolve the inlined package's OWN bare
 * imports: `dsh-client-ui-primitives@0.1.7-rc.2` ships a `lib/index.js`
 * with runtime imports (anser, clsx, diff, shiki, katex, simple-icons,
 * micromark-*, mdast-*) while its package.json declares them under
 * devDependencies. This package therefore lists those in its own
 * devDependencies so the test graph resolves; the shipped bundle never
 * resolves them (ui-primitives is a platform external), so this is a
 * test-only concern. That mirror list tracks the host line — `diff` joined
 * it in 0.1.6-alpha.1 (DiffBlock's `structuredPatch`), `simple-icons` in
 * 0.1.6-alpha.2 (LinkIcon's site marks), and 0.1.7-rc.2 added three
 * `@deepseek-ai/*` imports (`dsh-client-store`, `dsh-util-code-language`,
 * `dsh-util-workspace-path`) whose own built entries in turn pull `zustand`
 * and `immer` — both also declared by `dsh-client-store` under
 * devDependencies, so they are mirrored here too.
 *
 * Maintenance note: this list is the minimal set for the CURRENT tests. If a
 * future test value-imports another `@deepseek-ai/*` package whose built
 * lib/ brings a css side-effect import (e.g. dsh-client-ui-slots), add it
 * here or the css parsing fails.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    // `exclude` REPLACES vitest's defaults, so the standard
    // node_modules/dist/etc. excludes must be restated here.
    exclude: [
      'tests/e2e/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
})
