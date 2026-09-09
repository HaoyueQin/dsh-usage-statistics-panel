# v0.1.12 Release Notes

> 中文说明在前，English notes below / Chinese first, then English.

## 中文 · v0.1.12 更新说明

本版本适配 DeepSeek Harness `0.1.5-alpha.1`（会话日志 V3，`SESSION_FORMAT_VERSION 3`）。逐项核验结论：宿主 `loader`/`bundles`/`webServer`/`storageDomain` 零变更；回扫走 `open` 路径的签名与语义不变（`inspect` 在新版宿主已彻底移除，本插件的回退分支仅对 `0.1.2-rc.1` 保留）；`assistant/message` 的用量口径、`request/context` 路由、`session/event`、`inheritedEventCount` 均不变，V3 新增的 `system/message` / `assistant/attempt` / `stream` / `surfaceOp` / `systemPromptUpdate` 一律忽略；三个 client 槽位、`locale`、`primitives`、`PLATFORM_MODULES`（只新增 `dockkit`，本插件 externals 仍是其子集）均兼容；底部信息栏 `id='stats'` 影子替换机制（最低优先级渲染）与 `useChat` / `useProjection` 座子在新版官方 `StatsPills` 下原样成立。无逻辑改动，只有注释同步。peer 范围不变（`>=0.1.2-rc.1`），存储格式未变，无需 reset。

### 验证

- 本地：`tsc --noEmit` 在 `0.1.5-alpha.1` 头文件下通过；21 个测试文件 180 个用例全绿（含新增 `tests/collector-v3.spec.ts` 3 例：V3 专有事件忽略、无 `inspect` 回扫、`stream`/`surfaceOp`/`systemPromptUpdate` 忽略）；`pnpm build`（host ESM + 双 client CJS）成功。
- 真机：未做（按需求跳过）。

### 已知事项

- 官方底部条带已换成两颗图标药丸（`StatsPills`）+ 点击弹窗；本插件已跟随重做（双药丸 + 互斥弹窗，双开关 off 时与官方同构；`cachePrecision` on 时命中率两位小数，`tokenDetail` on 时用量弹窗多一行未命中缓存），见 `tests/stats-line.spec.tsx` 9 例。
- `dsh.plugin.json engines.dsh` 保持 `>=0.1.2-rc.1`，与 peer 一致。

### 升级须知

- 所有宿主版本用户：行为零变化，可跟随升级。

---

## English · v0.1.12 Release Notes

This release adapts to DeepSeek Harness `0.1.5-alpha.1` (session-log V3, `SESSION_FORMAT_VERSION 3`). Item-by-item verdict: host `loader`/`bundles`/`webServer`/`storageDomain` unchanged; the `open`-path backfill signatures and semantics are unchanged (`inspect` is gone upstream; this plugin keeps the fallback for `0.1.2-rc.1` only); `assistant/message` usage accounting, `request/context` routing, `session/event` and `inheritedEventCount` are unchanged, and everything V3 adds (`system/message`, `assistant/attempt`, `stream`, `surfaceOp`, `systemPromptUpdate`) is ignored; the three client slots, `locale`, `primitives` and `PLATFORM_MODULES` (only additive `dockkit`) are compatible; the bottom-bar `id='stats'` shadowing (lowest priority renders) and the `useChat`/`useProjection` seats hold under the new official `StatsPills`. No logic changes, comments only. Peer range unchanged (`>=0.1.2-rc.1`); no storage change, no reset needed.

### Verification

- Local: `tsc --noEmit` passes against `0.1.5-alpha.1` headers; all 21 test files / 180 tests green (including the 3 new `tests/collector-v3.spec.ts` cases); `pnpm build` (host ESM + dual client CJS) succeeds.
- Real mount: skipped per request.

### Known items

- The official bottom strip is now two icon pills (`StatsPills`) with click-open dialogs; this plugin follows the same pills (identical with both toggles off; `cachePrecision` renders two decimals, `tokenDetail` adds the miss row to the usage dialog), covered by 9 `tests/stats-line.spec.tsx` cases.
- `dsh.plugin.json engines.dsh` stays `>=0.1.2-rc.1`, matching peers.

### Upgrade notes

- All host-version users: zero behavior change — safe to follow.

**Full Changelog**: https://github.com/HaoyueQin/dsh-usage-statistics-panel/compare/v0.1.11...v0.1.12
