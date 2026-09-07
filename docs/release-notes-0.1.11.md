# v0.1.11 Release Notes

> 中文说明在前，English notes below / Chinese first, then English.

## 中文 · v0.1.11 更新说明

本版本让历史回扫同时兼容 DeepSeek Harness `0.1.2-rc.1` 与 `0.1.3-alpha.*` 两代持久化契约：有 `open` 走 alpha 新缝（`list` 快照→`open(id,\'read\')`→分页 `read`→`finally close()`，继承切点取自 handle），无 `open` 有 `inspect` 回退 rc.1 老路；快照与头行自动归一，坏行丢弃不崩。peer 范围不变（`>=0.1.2-rc.1`），存储格式未变，无需 reset。

### 验证

- 本地：`typecheck` 通过；20 个测试文件 177 个用例全绿（含新增 `tests/collector-dual.spec.ts` 4 例：快照回放、`close` 释放、分页+切点、abort、rc 回归）；`pnpm build`（host ESM + 双 client CJS）成功。
- rc.1 真机：隔离家目录 + 3091 端口实例挂载本版 tgz，`POST /usage/api/status` 与 `/usage/api/range` 返回真值（新家目录 0 会话、0 失败），回退分支在真机成立；3080 原实例全程未受影响。
- alpha：`deepseek-harness-dev`（`0.1.3-alpha.2`）`tsc` 双面 + `tsdown host` 源码构建成功；`open` 分支 covered by 上述单测。

### 已知限制（未验证范围，如实声明）

- alpha 整机 boot 未跑通：本机缺 Windows SDK（两台 VS 均无 SDK），`fs-ext` native 绑定编不出（`session-persistence-jsonl` 强依赖）；另 `tsdown client` 在 HEAD 合并态报某包 `Missing export … dsh-session-persistence`，原因未定位。alpha 面板真机渲染、alpha 大日志回扫计数均待补。
- `dsh.plugin.json engines.dsh` 保持 `>=0.1.2-rc.1`，与 peer 一致。

### 升级须知

- `0.1.2-rc.1` 用户：行为零变化（回退分支与旧逻辑同构，旧 30 例未改即过），可跟随升级。
- `0.1.3-alpha.*` 用户：此前版本回扫全灭（无 `inspect`），本版恢复历史回扫；已存在的空统计会在下次回扫补全，无需手动 reset。

---

## English · v0.1.11 Release Notes

This release teaches the backfill both persistence seams: `list`+`inspect` on DSH `0.1.2-rc.1`, `list`+`open`+paged `read`+`close` on DSH `0.1.3-alpha.*` (`open` wins when present; snapshots normalize to headers; malformed rows are dropped, never crash). Peer range unchanged (`>=0.1.2-rc.1`); no storage change, no reset needed.

### Verification

- Local: typecheck passes; all 20 test files / 177 tests green (including the 4 new `tests/collector-dual.spec.ts` cases: snapshot replay, `close` release, pagination+cut, abort, rc regression); `pnpm build` (host ESM + dual client CJS) succeeds.
- rc.1 real mount: isolated home + port-3091 instance serves this build; `POST /usage/api/status` and `/usage/api/range` return real values (fresh home: 0 sessions, 0 failures), proving the fallback on a live host; the 3080 instance was untouched throughout.
- Alpha: source build of `deepseek-harness-dev` (`0.1.3-alpha.2`) passes `tsc` on both faces plus `tsdown host`; the `open` branch is covered by the unit tests above.

### Known limitations (honestly unverified)

- No full alpha boot yet: this machine lacks the Windows SDK (neither VS install ships one), so the `fs-ext` native binding required by `session-persistence-jsonl` cannot compile; separately, `tsdown client` at the HEAD merge state fails with a `Missing export … dsh-session-persistence` error whose cause is not yet located. Alpha panel rendering and alpha large-log replay counts remain pending.
- `dsh.plugin.json engines.dsh` stays `>=0.1.2-rc.1`, matching peers.

### Upgrade notes

- `0.1.2-rc.1` users: zero behavior change (the fallback is isomorphic to the old logic; all 30 pre-existing collector cases pass unmodified) — safe to follow.
- `0.1.3-alpha.*` users: previous builds recorded nothing on backfill (no `inspect`); this build restores it. Existing empty stats refill on the next scan; no manual reset needed.

**Full Changelog**: https://github.com/HaoyueQin/dsh-usage-statistics-panel/compare/v0.1.10...v0.1.11
