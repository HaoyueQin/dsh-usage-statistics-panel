> 中文说明在前，English notes below / Chinese first, then English.

## 中文 · v0.1.10 更新说明

本版本把支持基线收敛到 DeepSeek Harness 0.1.2-rc.1 单一版本线，并移除为 0.1.1-rc.2 与 0.1.2-alpha.* 双代兼容保留的全部容错代码。

> ⚠️ **支持范围变更**：本版本起仅支持 DeepSeek Harness `>= 0.1.2-rc.1`。使用 `0.1.1-rc.2` 或 `0.1.2-alpha.*` 的用户请继续使用本插件 `0.1.9` 及之前。

### 兼容 · 单一基线 DSH 0.1.2-rc.1

- peer 范围从双分支 `^0.1.1-rc.2 || ^0.1.2-alpha.1` 收敛为 `>=0.1.2-rc.1`（11 条 dsh peer）；15 个 dev 依赖升 `0.1.2-rc.1`；release-age 豁免清单收敛 rc.1 并为传递依赖补齐豁免条目；overrides 升 rc.1。
- 移除双代容错代码：`StatsLineEnhanced` 的 `useSession` seat 与双快照路径（现与 rc.1 官方 ui-chat StatsLine 同款直读 `s.legacy.nodes`）；collector 对 `inheritedEventCount` 的垃圾值防御回退（rc.1 契约下该字段恒为非负 safe integer、0 表示非 fork 会话，已对照官方 session-persistence 源码逐点验证）；`context-types.ts` 对应字段改为必填。
- tsdown `CLIENT_EXTERNALS` 收敛为官方 `PLATFORM_MODULES`（`packages/client/web/src/platform.ts`，0.1.2-rc.1）的精确镜像：删除 0.1.1 代残留的 `cordis`/`@deepseek-ai/dsh-client-web-react`/`@deepseek-ai/dsh-client-schema-form` 与 rc.2 时代的 `@deepseek-ai/dsh-client-runtime/client`，补上 `@deepseek-ai/cordis`。
- CI 删除 alpha.4/alpha.5 双版本回归矩阵与钉版脚本（`scripts/pin-dsh-dev-deps.mjs`），单基线 `0.1.2-rc.1` 全量 build+test 回归（`--frozen-lockfile`）。

### 保留未动（有意为之）

- 插件自身的 ≤0.1.1 旧库一次性重建（存储口径迁移，与宿主版本无关）。
- `context-types.ts` 结构镜像架构与 cordis peer 声明。

### 验证

- 本地：typecheck 通过；19 个测试文件 173 个用例全绿（178 → 173，恰为移除的 5 个双代用例）；lockfile 全新解析，alpha 残留 0 行。
- 真机挂载：DSH 0.1.2-rc.1 源码构建实例（tag `dsh-v0.1.2-rc.1`，独立家目录、3090 端口）挂载本版 tgz，逐项核验通过：boot 注入表含本插件、client bundle 加载（`style[data-plugin]` ×3）、`/usage/api/status` 与 `/usage/api/range` 返回真值（回扫 16 会话、0 失败）、真实会话 StatsLine 影子行渲染（"90 轮 · 90 步 | LLM 3m0s"）、设置页"使用统计"面板全量渲染（热力图 / 按天趋势 / 缓存命中率 / 区间切换），全程 0 条插件相关控制台错误。

### 升级须知

- ⚠️ 使用 DeepSeek Harness `0.1.1-rc.2` 或 `0.1.2-alpha.*` 的用户请继续使用本插件 `0.1.9` 及之前；`0.1.10` 起仅对 `>= 0.1.2-rc.1` 提供支持与验证。
- 存储格式未变，无需 reset。

---

## English · v0.1.10 Release Notes

This release converges the supported baseline to a single DeepSeek Harness line, 0.1.2-rc.1, and drops every tolerance shim kept for two-generation (0.1.1-rc.2 / 0.1.2-alpha.*) compatibility.

> ⚠️ **Support range change**: from this release the plugin supports DeepSeek Harness `>= 0.1.2-rc.1` only. Users on `0.1.1-rc.2` or `0.1.2-alpha.*` should stay on plugin `0.1.9` or earlier.

### Compatibility — single baseline DSH 0.1.2-rc.1

- The 11 dsh peer ranges collapse from `^0.1.1-rc.2 || ^0.1.2-alpha.1` to `>=0.1.2-rc.1`; 15 dev dependencies move to `0.1.2-rc.1`; the release-age exclude list converges on rc.1 (with transitive-dependency entries added); overrides move to rc.1.
- Two-generation tolerance removed: the `useSession` seat and dual snapshot path in `StatsLineEnhanced` (now the exact `s.legacy.nodes` read of the official ui-chat StatsLine); the garbage-value fallback around `inheritedEventCount` in the collector (on rc.1 the field is always a non-negative safe integer, 0 for a non-forked session — verified point-by-point against the official session-persistence source); the matching mirror type in `context-types.ts` becomes required.
- tsdown `CLIENT_EXTERNALS` becomes an exact mirror of the official `PLATFORM_MODULES` (`packages/client/web/src/platform.ts`, 0.1.2-rc.1): drops the 0.1.1-era `cordis`/`@deepseek-ai/dsh-client-web-react`/`@deepseek-ai/dsh-client-schema-form` and the rc.2-era `@deepseek-ai/dsh-client-runtime/client`, adds `@deepseek-ai/cordis`.
- CI drops the alpha.4/alpha.5 dual-version regression matrix and the pin script (`scripts/pin-dsh-dev-deps.mjs`); every push/PR runs the full build+test suite against the single `0.1.2-rc.1` baseline (`--frozen-lockfile`).

### Intentionally kept

- The plugin's own ≤0.1.1 one-shot store rebuild (a storage-schema migration, unrelated to the host version).
- The `context-types.ts` structural-mirror architecture and the cordis peer declarations.

### Verification

- Local: typecheck passes; all 19 test files / 173 tests green (178 → 173, exactly the 5 removed two-generation cases); lockfile freshly resolved with zero alpha leftovers.
- Real-mount verification: the plugin build mounted on a DSH 0.1.2-rc.1 instance built from source (tag `dsh-v0.1.2-rc.1`, isolated home directory, port 3090), verified item by item: boot injection table includes the plugin, client bundle loaded (`style[data-plugin]` ×3), `/usage/api/status` and `/usage/api/range` return real values (16 sessions backscanned, 0 failures), the StatsLine shadow entry renders in a real conversation ("90 轮 · 90 步 | LLM 3m0s"), and the settings "Usage statistics" panel renders in full (heatmap / daily trend / cache-hit curve / range switcher) with zero plugin-related console errors throughout.

### Upgrade notes

- ⚠️ Users on DeepSeek Harness `0.1.1-rc.2` or `0.1.2-alpha.*` should stay on plugin `0.1.9` or earlier; from `0.1.10` the plugin is supported and verified against `>= 0.1.2-rc.1` only.
- No storage change — no reset needed.

**Full Changelog**: https://github.com/HaoyueQin/dsh-usage-statistics-panel/compare/v0.1.9...v0.1.10
