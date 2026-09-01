> 中文说明在前，English notes below / Chinese first, then English.

## 中文 · v0.1.9 更新说明

本版本修复 fork 会话的用量双计，并把开发/测试基线对齐 DSH 0.1.2-alpha.4；peer 兼容范围不变，0.1.1-rc.2 至 0.1.2-alpha.4 全系覆盖。

### 修复 · fork 会话用量双计

- fork 出的子会话从存储恢复时，日志开头是从父会话复制的事件前缀；此前的回扫（backfill）整日志重放，这部分继承事件会与父会话自己的回扫重复计数。现在宿主上报精确继承切点（`SessionInspection.inheritedEventCount`，dsh 0.1.2-alpha.4 起提供）时，回扫跳过 `[0, cut)`，只折叠子会话自有事件——继承前缀只计入它的来源（父会话）一次。
- 旧版本宿主不返回该字段（或返回负数/非整数），回退为整日志回放，行为与 0.1.8 完全一致；live 首观测边界、回扫游标、`/reset` 水位三段划分依旧恰好铺满每个日志一次、互不重叠。

### 兼容 · DSH 0.1.2-alpha.4

- alpha.4 的两条 breaking 均不触及本插件的消费面：live 路径订阅的 `session/event` 载荷不变；历史路径的 `sessionPersistence.inspect` 签名不变（返回仅新增 `inheritedEventCount` 字段）。`SessionSeq`/`SessionLogOffset` 是编译期品牌（运行时仍是普通 number），插件的结构镜像类型与其 `typeof seq === 'number'` 判断全部照常工作。
- dev 依赖升 `@deepseek-ai/*@0.1.2-alpha.4`；peer 范围不变——`^0.1.1-rc.2 || ^0.1.2-alpha.1` 在 node-semver 下已覆盖 0.1.2-alpha.4（实测），双分支保持不动。release-age 豁免清单同步 alpha.4。

### 工程与质量

- 新增 CI 双版本回归矩阵（`.github/workflows/test.yml`）：每次 push/PR 对 alpha.4 与重钉回 alpha.3 的两条腿各跑全量 build+test（`scripts/pin-dsh-dev-deps.mjs` 仅在 CI 内改写 package.json、不落库），"只在最新 alpha 上能过"的改动会在 CI 拦下。
- 新增 4 个单测：切点生效 / 旧宿主回退 / 切点 × live 边界三段精确拼接 / 垃圾值回退。

### 验证

- 本地：typecheck 通过；19 个测试文件 178 个用例全绿（4 个新用例在 verbose 报告下逐一确认）。
- GitHub Actions：alpha.4 与重钉 alpha.3 双腿矩阵全绿。
- alpha.4 真机挂载验证待补：alpha.4 兼容结论来自两个 tag 间上游 diff 的逐点审查 + CI 矩阵；切点逻辑对旧宿主有逐字节一致的回退保证。

### 升级须知

- 存储格式未变，无需 reset。注意：已入库的历史数据不会因本版自动重算（已回扫过的会话在游标中不会再重放）；如需按新口径消除 fork 重复计数，可在面板里执行一次重建重扫（重扫按新逻辑跳过继承前缀）。
- DSH 0.1.1-rc.2 ~ 0.1.2-alpha.3 用户行为完全不变；DSH 0.1.2-alpha.4 用户获得 fork 双计修复。

---

## English · v0.1.9 Release Notes

This release fixes double counting for forked sessions and moves the dev/test baseline to DSH 0.1.2-alpha.4; the peer compatibility range is unchanged, covering 0.1.1-rc.2 through 0.1.2-alpha.4.

### Fix — double counting for forked sessions

- A forked child restores its parent-copied event prefix from storage, so the backfill replayed its full log and double-counted usage the parent session had already recorded. When the host reports the exact cut (`SessionInspection.inheritedEventCount`, dsh 0.1.2-alpha.4+), the backfill now skips `[0, cut)` and folds only child-owned events — the inherited prefix is counted once, on the session it came from.
- Older hosts leave the field absent (or return a non-positive/non-integer value) and the replay stays full-log — byte-for-byte the 0.1.8 behavior; the live first-observed boundary, the backfill cursor, and the /reset watermark still tile every log exactly once, without overlap.

### Compatibility — DSH 0.1.2-alpha.4

- Neither of alpha.4's two breaking changes touches the plugin's consumption surface: the live `session/event` payload is unchanged, and `sessionPersistence.inspect` keeps its signature (its return only gains `inheritedEventCount`). `SessionSeq`/`SessionLogOffset` are compile-time brands (plain numbers at runtime), so the plugin's structural mirrors and its `typeof seq === 'number'` guards keep working as-is.
- Dev deps move to `@deepseek-ai/*@0.1.2-alpha.4`; the peer range is unchanged — `^0.1.1-rc.2 || ^0.1.2-alpha.1` already admits 0.1.2-alpha.4 under node-semver (verified). The release-age exclude list tracks alpha.4.

### Engineering and quality

- New CI dual-version regression matrix (`.github/workflows/test.yml`): every push/PR runs the full build+test suite against alpha.4 and against a re-pinned 0.1.2-alpha.3 leg (`scripts/pin-dsh-dev-deps.mjs` rewrites package.json in CI only, never committed), so a change that only works on the newest alpha fails in CI instead of shipping.
- Four new unit tests: the cut takes effect / older-host fallback / cut × live-boundary tiling / garbage-value fallback.

### Verification

- Local: typecheck passes; all 19 test files / 178 tests green (the 4 new ones confirmed individually under the verbose reporter).
- GitHub Actions: the alpha.4 and re-pinned alpha.3 matrix legs are green.
- Real-mount verification on an alpha.4 instance is still pending: the alpha.4 conclusion rests on a point-by-point review of the upstream diff between the two tags plus the CI matrix, and the cut logic carries a byte-exact fallback guarantee on older hosts.

### Upgrade notes

- No storage change — no reset needed. Note: already-recorded history is NOT recomputed by this release (backfilled sessions never replay again); to remove fork double counting from accumulated history, run one panel rebuild rescan (the rescan applies the new cut).
- Users on DSH 0.1.1-rc.2 through 0.1.2-alpha.3 see no behavior change; users on DSH 0.1.2-alpha.4 get the fork fix.

**Full Changelog**: https://github.com/HaoyueQin/dsh-usage-statistics-panel/compare/v0.1.8...v0.1.9
