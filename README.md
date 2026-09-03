# DSH Usage Statistics Panel

[English](README_EN.md) | 中文

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/banner-zh-dark.svg">
    <img src="docs/banner-zh.svg" alt="DSH Usage Statistics Panel" width="720">
  </picture>
</p>

![npm version](https://img.shields.io/npm/v/dsh-usage-statistics-panel)
![npm downloads](https://img.shields.io/npm/dm/dsh-usage-statistics-panel)
![License](https://img.shields.io/github/license/HaoyueQin/dsh-usage-statistics-panel)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)
![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4D6BFE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Commit activity](https://img.shields.io/github/commit-activity/t/HaoyueQin/dsh-usage-statistics-panel)](https://github.com/HaoyueQin/dsh-usage-statistics-panel/graphs/commit-activity)
[![Last commit](https://img.shields.io/github/last-commit/HaoyueQin/dsh-usage-statistics-panel)](https://github.com/HaoyueQin/dsh-usage-statistics-panel/commits)

DSH web 插件的用量统计面板：按天 Token 趋势、GitHub 风格活跃热力图、缓存命中率曲线、按模型用量拆分（环形图 + 列表），在设置页新增一个"使用统计"页面。

所有图表均为手绘 SVG，不依赖图表库；配色使用 GitHub Primer 的 data-viz 双套色板（前 5 名模型各取一个等级色，其余归入灰色 "Other" 桶），并随 DSH 主题自适应。

<p align="center">
  <img src="docs/demo-zh.svg" alt="demo：安装后设置页出现「使用统计」入口，进入面板后卡片、热力图、趋势与环形图依次点亮" width="720">
</p>

## 预览

<p align="center">
  <img src="docs/images/panel-overview.png" alt="面板概览：汇总卡片、活跃热力图与按天 Token 趋势" width="720">
</p>

<p align="center">
  <img src="docs/images/model-usage.png" alt="模型用量：环形图、列表与趋势图" width="720">
</p>

## 功能

- **时间范围**：最近 7 / 14 / 30 / 90 天，或自定义起止日期
- **汇总卡片**：Token 用量、会话数量（完成的 turn）、请求数量、活跃天数、平均缓存命中率、最常用模型
- **26 周活跃热力图**：每日 token 用量的 GitHub 风格色阶，悬停查看当天明细
- **按天 Token 趋势**：堆叠柱状图叠加平滑的缓存命中率曲线（Catmull-Rom 样条），悬停查看各模型拆分
- **模型用量**：环形图 + 列表，前 5 名模型分色，其余折叠为可展开的 "Other" 明细
- **底部信息栏增强**：设置页可开启"精确缓存命中率"（会话底部信息栏的缓存命中率以两位小数显示，如 85.25%）与"会话 Token 明细"（底部信息栏显示总 Token、输入、输入（命中缓存）、输入（未命中缓存）与输出 Token，替代默认的"输入/输出"两项）；开关位于"使用统计"面板底部，与"侧边栏快捷入口"同款样式，切换即时生效
- **历史回扫**：首次启用时枚举并回放既有会话日志；对挂载后才首次观测到的活跃会话，其挂载前的历史会在下一次启动时按事件序号边界回放补全，从安装日起尽量还原历史用量
- **本地持久化**：数据写入 `$DSH_HOME/storages/usage_history.json`（storage-domain），纯本地、无外部依赖

## 安装

```sh
dsh plugin --profile <name> add dsh-usage-statistics-panel@latest
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）：client 半的改动 DSH 会热加载，无需重启；仅 host 半（采集/存储/路由）更新时需要重启 DSH。

插件挂载后，在 Web UI 的设置页左侧导航会出现"使用统计"页面。

**兼容性**：本插件支持 DeepSeek Harness `>= 0.1.2-rc.1`（peer 声明 `>=0.1.2-rc.1`），CI 对 `0.1.2-rc.1` 基线全量构建与测试回归（`.github/workflows/test.yml`）；更高版本通常可用，属未验证范围。

> **旧版本用户**：使用 DeepSeek Harness `0.1.1-rc.2` 或 `0.1.2-alpha.*` 的用户，请安装本插件的旧版本（`0.1.9` 及之前）。本插件自 `0.1.10` 起仅对 `>= 0.1.2-rc.1` 的 DeepSeek Harness 提供支持与验证。

## 数据来源

面板的数据采集是**观测式**的：插件订阅会话事件流（`session/event`）中的 `assistant/message` 与 `assistant/chunk`，提取 provider 上报的 token 用量（输入 / 输出 / 缓存读 / 缓存写），在**单个会话内**按 `(turn, step)` 去重（同一调用只计一次、保留先到的样本——两个官方适配器对流式采样与最终上报的数值完全一致；并发会话各自独立计数、互不吞样本）。模型归因优先取消息自带的 `source`（每次调用各自标注），缺失时回退到会话的路由折叠（`request/context` 事件或会话的 `requestContext()`），宿主重启后也不会落入 "(unknown)" 桶。首次启用时还会回扫既有会话日志补齐历史。

> 提示：Token 用量从插件启用（含回扫）之日起累计；更早的会话日志若无 provider 上报的用量数据，则无法回溯。

**子代理会话**：子代理是独立会话，其 token、请求与完成的轮次与顶层会话一并统计（实时采集覆盖全部会话事件流，重启后回扫同样覆盖子代理会话日志）；父会话仅收到子代理结果摘要，不会重复计入。子代理会话早期的请求标记（step/start）先于其路由事件写入日志，首个请求可能统计在 "(unknown)" 桶——请求总数不受影响。

**Token 口径**：汇总卡片与趋势图的 Token 总量为**服务商总口径**——未缓存输入 + 输出 + 缓存读 + 缓存写，与服务商账单面板一致（DeepSeek 会把 prompt 拆成输入/缓存读两个不相交的桶，简单相加会漏掉占大头的缓存部分）。平均缓存命中率以输入侧（命中 + 未命中）为分母，其中**未命中 = 未缓存输入 + 缓存写入**——与会话底部信息栏（官方 StatsLine 口径）完全一致，两处读数不会出现分歧；命中率卡片下方同时展示缓存命中的绝对 token 量。

**重建统计**：`POST /usage/api/reset`（与面板同源信任围栏保护）清空本地统计并按当前归因规则全量重放会话日志——用于历史数据损坏或归因规则升级后的重建。仍在进行中的会话以其重置时刻的日志长度为界：界内由重放重建、界外继续由实时采集，恰好各计一次。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsc declarations + tsdown (host ESM + 双通道 client bundle)
```

## 设计与实现

- **Host 半**（`src/`）：`collector`（事件订阅 + 回扫折叠）、`store`（`usage_history` storage-domain）、`query`（范围聚合，翻译自 reasonix 的 query.go）、`routes`（`/usage/api` fenced JSON 路由，信任围栏与 `/api` 网关一致）
- **Client 半**（`src/client/`）：`UsageStatsPanel.tsx`（手绘 SVG 图表，移植自 reasonix 面板 + Primer 配色）、`locales`（en / zh / zh-TW）、`api`（`/usage/api` fetch 封装）
- **双通道打包**：`lib/client.js`（官方 profile 通道，bundle id = 包名）与 `lib/client-registry.js`（插件注册表通道，bundle id = manifest id）。harness 0.1.x 官方加载链只消费前者；后者为外部 registry 通道预留，当前无消费者
- 详细设计见 [docs/design.md](docs/design.md)

## 致谢

本面板是对 reasonix 用量统计功能的复刻移植：作者曾为 [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 实现并贡献了该功能（PR [#7238](https://github.com/esengine/DeepSeek-Reasonix/pull/7238)、[#7503](https://github.com/esengine/DeepSeek-Reasonix/pull/7503)），本插件按 DSH 的插件规范将其移植到 DeepSeek Harness，前端图表大比例复用原实现，数据层则基于 DSH 的会话日志与 storage-domain 重新实现。

## Activity

[![HaoyueQin/dsh-usage-statistics-panel GitStock K-Line Chart](https://gitstock.org/HaoyueQin/dsh-usage-statistics-panel/stock.svg)](https://gitstock.org/HaoyueQin/dsh-usage-statistics-panel)

## License

MIT
