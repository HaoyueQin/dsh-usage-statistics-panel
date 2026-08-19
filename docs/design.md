# 设计说明

DSH Usage Statistics Panel 复刻 reasonix 的用量统计功能（PR #7238 / #7503），按 DeepSeek Harness 的插件规范实现：Host 半（Node）负责采集与聚合，Client 半（浏览器）负责设置页渲染，两者通过插件自有的 fenced HTTP 路由通信。

## 数据流

```
session 事件流 (session/event)
        │  assistant/message.usage, assistant/chunk(chunk.type=usage)
        │  request/context (provider/model 归因)
        ▼
UsageCollector ──(turn,step 去重折叠)──▶ UsageStore (storage-domain)
        ▲                                       │
        │ 首次启用回扫                        rangeRows(from,to)
        │  sessionPersistence.list() +        ▼
        └── inspect(id) 逐会话回放 ──────  /usage/api/range (fenced)
                                                │
                                                ▼
                                    UsageStatsPanel (设置页, 手绘 SVG)
```

## Host 半

### collector.ts — 采集与去重

- **实时**：`ctx.on('session/event')` 订阅。`assistant/message` 的 `data.usage`（TokenUsage）与 `assistant/chunk` 的 `chunk.type === 'usage'` 都是 usage 样本；`request/context` 提供 provider/model 归因。
- **去重**：同一 `(turn, step)` 的流式采样与最终上报取后者（replace），与 `dsh-token-meter` 的 usage 投影语义一致——同一调用的重复上报不会重复计数。键为 `turn:step`，与事件类型无关。
- **回扫**：首次启用时 `sessionPersistence.list()` 枚举全部会话，`inspect(id)` 读取完整事件日志（zstd 由后端内部处理），并发 4 逐会话回放同一折叠。单个会话读取失败不中断整体回扫（status.error 记录）。

### store.ts — 持久化

使用 storage-domain 的 `usage_history` 域，单表 `days`：

- key：`YYYY-MM-DD|provider|model`
- value：`{ day, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, requests, turns, lastSeen }`
- 写入走 `KvTable.update()`（按 key 原子读改写队列），并发 turn 不交错
- 后端（web-app bundle 的 storage-json）落地 `$DSH_HOME/storages/usage_history.json`

Token 桶语义：`inputTokens` 是 uncached input（即缓存 miss 侧），`cacheReadTokens` 是缓存命中侧——命中率恒为 `Σhit / Σ(hit+miss)`，与 reasonix 一致，两个分母不混。

### query.ts — 范围聚合

翻译自 reasonix `internal/stats/query.go`：

- 按日 emit 全范围（含零值日），趋势图显示完整时间轴
- token 总计、请求数、turn 数、命中率派生、活跃天数、Top 模型/Provider
- 模型 ref `provider/model`，裸模型名归 `default` provider

### routes.ts + trust-fence.ts — HTTP 服务

`webServer.register({ kind: 'prefix', path: '/usage/api', handler })`：

- `POST /usage/api/range`：`{ range, from?, to? }` → `UsageStatsRange`
- `POST /usage/api/status`：`BackfillStatus`
- 信任围栏：Host 头为 loopback 或 webRuntime.trustedHosts（与 `/api` 网关同源），否则 403

## Client 半

### index.tsx — 设置页注册

`ctx.slots.inject('settings.section', ...)` 注册导航项（id `usage-statistics`，order 30），locale 座绑定 `usageStats` 命名空间（en/zh/zh-TW 三份字典），组件经 `/usage/api` fetch 数据，不直接触 ctx。

### UsageStatsPanel.tsx — 图表

移植自 reasonix 面板（853 行）+ PR #7503 的改动：

- **热力图**：固定 40 周窗口，容器过窄时优先裁剪最早列；5 级色阶由 brand accent 经 color-mix 派生
- **趋势图**：堆叠柱状图按全范围用量排名着色（模型颜色逐日稳定），叠加 Catmull-Rom 命中率曲线；最窄时裁剪最早天数，超过 180 天显示提示
- **模型图**：donut 固定 240×240 viewBox（悬停加粗不溢出），前 5 名分色，其余折叠为灰色 "Other"（可展开明细，键盘可访问）
- **Primer 色板**：`--dsw-chart-1..5` + `--dsw-chart-other`，light/dark 两套（CSS `@media (prefers-color-scheme)`），色值经 color-mix 向底色柔化

### 样式

全部视觉值走 DSH 语义 token（`--dsw-alias-*` 颜色、`--dsw-font-*` 排版），无静态色值、无主题选择器，浅色/深色由主题包负责。

## 双通道打包

`tsdown.config.ts` 复刻官方未发布的 `tsdown.client.ts` 预设：

- host ESM → `lib/index.js`
- client bundle ×2：`lib/client.js`（官方 profile 通道，id=包名）与 `lib/client-registry.js`（注册表通道，id=manifest id），lazy-CJS factory（`window.__ModuleLoader__.load`），external 走模块表（react/cordis/dsh-client-* 白名单），其余内联，purity gate 拒非白名单 `@deepseek-ai` 值导入
- CSS Modules（lightningcss）哈希类名 + `<style data-plugin>` 注入

## 已知限制

- 回扫后的**增量**不重放旧会话（避免重复计数）；新会话实时采集
- 旧会话日志若无 provider usage（或日志被压缩清理），无法回溯
- `usage_history` 域版本 1；若需迁移，bump domain version 并写迁移
