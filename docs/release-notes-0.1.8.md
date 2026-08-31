> 中文说明在前，English notes below / Chinese first, then English.

## 中文 · v0.1.8 更新说明

本版本让插件在 DSH 0.1.2-alpha.2 上完整可用，同时保留对 0.1.1-rc.2 基线的全部兼容：同一个 npm 包、同一个浏览器 bundle，两代内核各测各过。

### 兼容 · DSH 0.1.2-alpha.2

- alpha.2 删除了 `@deepseek-ai/dsh-client-runtime` 包（上一版依赖其类型做编译），类型面拆入 ui-chat / ui-session / api-session-controller / client-store 等新契约包。插件不再依赖任何"只存在于单一内核"的包：与既有 `context-types.ts` 相同的结构镜像哲学，新增会话节点快照、投影 hook 的本地结构化类型，client bundle 编译产物与两代内核都无类型牵连。
- 官方 StatsLine 自 ui-conversation 迁入 ui-chat，仍注册在同一个 `conversation.composer.dock` 槽（id `stats`）；插件的影子注册（同 id、priority -1 更低者渲染）在两代内核策略一致，统计行在两代内核上保持 0.1.7 的行为。
- 依赖侧同步：dev 依赖升 `@deepseek-ai/*@0.1.2-alpha.2`；peer 范围改为双分支 `^0.1.1-rc.2 || ^0.1.2-alpha.1`——node-semver 对带预发布标签的版本，要求范围内存在同 `[major.minor.patch]` 元组的预发布比较器，单一区间（如 `>=0.1.1-rc.2 <0.1.3`）无法同时命中 0.1.1-rc.2 与 0.1.2-alpha.x（node-semver 7.7.4 实测）；双分支严格覆盖 rc.2、0.1.1、alpha.1/2 与 0.1.2 正式版。`dsh.client.inject` 清单移除已删包。
- 打包侧：tsdown 的内联白名单（INLINE_SAFE）对齐 alpha.2 官方清单（新增 deque/typert-protocol/util-values/agent-presets/display 与 token-meter/client 内联位）。
- 修正镜像类型的一处老错误：locale 服务的 `register` 此前按"entries 数组"声明，与两代真实签名（单语言三参 / 全词典双参）都不符——暴露后已改为正确的双重载。

### 工程与质量

- client bundle 跨机器构建可复现：lightningcss 的 CSS Modules `[hash]` 会把 transform 的 filename 字符串（此前是构建机绝对路径）混入哈希，且 exports 键序为 Rust HashMap 随机序——同一源码树在 npm 与 GitHub 两渠道发布的 bundle 类名不同（各包功能自洽，但无法逐字节核对）。改为传入仓库相对 POSIX 路径、构建 class map 时按键排序后，同源码树任意机器构建的 `lib/client.js` 与 `lib/client-registry.js` 逐字节一致，双渠道 tarball 可直接核对。
- README 新增浅/深色双版 banner 与"面板苏醒"demo 动图（手写 SMIL SVG，单文件 ≤8.2KB）、GitStock 活动图表与提交徽章（纯文档变更）。

### 验证

- 双代矩阵全绿：以 0.1.2-alpha.2 编译的依赖集与临时切回 0.1.1-rc.2 的依赖集，各自 typecheck、19 个测试文件 174 个用例、build 全部通过。
- peer 范围以 node-semver 7.7.4 对 rc.1 / rc.2 / 0.1.1 / alpha.1 / alpha.2 / 0.1.2 六个版本逐一实测：双分支在除 rc.1（本就不在支持基线内，与 0.1.7 相同）外的五个版本全部命中。
- 真机挂载（DSH 0.1.2-alpha.2 web 实例）：采集器对 alpha.2 会话事件正常采数（`/usage/api/range` 返回实例内真值），`/usage/api/status` 正常；浏览器插件行进入 boot 注入表，`/plugins/??dsh-usage-statistics-panel/client.js` 按 rev 正常取回。

### 升级须知

- 存储格式与统计口径未变，历史数据无需 reset。
- 仍在 DSH 0.1.1-rc.2 上的用户无感升级；使用 DSH 0.1.2-alpha.2 的用户需要本版本。

---

## English · v0.1.8 Release Notes

This release makes the plugin fully usable on DSH 0.1.2-alpha.2 while keeping every compatibility promise of the 0.1.1-rc.2 baseline: one npm package, one browser bundle, verified on both kernels.

### Compatibility — DSH 0.1.2-alpha.2

- alpha.2 removed the `@deepseek-ai/dsh-client-runtime` package (whose types the previous release compiled against) and split its type surface into newer contract packages (ui-chat, ui-session, api-session-controller, client-store). The plugin now depends on no package that exists on only one kernel: following the same structural-mirror philosophy already used by `context-types.ts`, it declares local structural skeletons for the snapshot nodes and the projection hook, so the built client bundle carries no type ties to either kernel.
- The official StatsLine moved from ui-conversation into ui-chat, still registering on the same `conversation.composer.dock` slot (id `stats`); the plugin's shadow registration (same id, priority -1 — lowest live entry renders) matches both kernels' policy, and the stats line keeps its 0.1.7 behavior on both.
- Dependencies: dev deps move to `@deepseek-ai/*@0.1.2-alpha.2`; peer ranges become the two-branch `^0.1.1-rc.2 || ^0.1.2-alpha.1` — node-semver requires a prerelease-tagged version to find a comparator with the same `[major.minor.patch]` tuple inside the range, so a single span (`>=0.1.1-rc.2 <0.1.3`) cannot admit both 0.1.1-rc.2 and 0.1.2-alpha.x (verified against node-semver 7.7.4); the two branches cover rc.2, 0.1.1, alpha.1/2 and the future 0.1.2 stable. The removed package is dropped from `dsh.client.inject`.
- Packaging: the tsdown inline-safe whitelist (INLINE_SAFE) tracks the alpha.2 official preset (deque/typert-protocol/util-values/agent-presets/display entries and the token-meter/client inline slot).
- A long-standing mirror error fixed: the locale service's `register` was declared as an entries-array form that matched neither kernel's real signature (single-locale three-arg / all-dictionaries two-arg); it now declares both overloads correctly.

### Engineering and quality

- Reproducible client bundles across build machines: lightningcss mixes the transform's `filename` STRING (previously a build-machine absolute path) into the CSS Modules `[hash]`, and returns its exports map in Rust-HashMap order — the npm and GitHub tarballs of one source tree shipped different class names (each package self-consistent, but not byte-comparable). Feeding a repository-relative POSIX path and sorting the class-map keys makes `lib/client.js` and `lib/client-registry.js` byte-identical from any machine; the two channel tarballs can now be diffed directly.
- The READMEs gain light/dark banners and a "panel waking up" demo animation (hand-written SMIL SVG, ≤8.2KB per file), a GitStock activity chart and commit badges (docs only).

### Verification

- Dual-kernel matrix green: with the 0.1.2-alpha.2 dependency set and with a temporary rollback to 0.1.1-rc.2, typecheck, all 19 test files / 174 tests and the build pass on each.
- The peer ranges were probed against node-semver 7.7.4 across rc.1 / rc.2 / 0.1.1 / alpha.1 / alpha.2 / 0.1.2: both branches hit on every version except rc.1 (never in the supported baseline, same as 0.1.7).
- Real-mount on a DSH 0.1.2-alpha.2 web instance: the collector records alpha.2 session events (`/usage/api/range` returns real in-instance values), `/usage/api/status` works, the plugin's client row lands in the boot injection table and the `/plugins/??dsh-usage-statistics-panel/client.js` artifact is served with its rev.

### Upgrade notes

- No storage or accounting change — no reset needed.
- Users on DSH 0.1.1-rc.2 can upgrade with no visible change; users on DSH 0.1.2-alpha.2 need this release.

**Full Changelog**: https://github.com/HaoyueQin/dsh-usage-statistics-panel/compare/v0.1.7...v0.1.8
