# DSH Usage Statistics Panel

[English](README_EN.md) | 中文

![npm version](https://img.shields.io/npm/v/dsh-usage-statistics-panel)
![License](https://img.shields.io/github/license/HaoyueQin/dsh-usage-statistics-panel)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)
![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4D6BFE)

DSH web 插件的用量统计面板：按天 Token 趋势、GitHub 风格活跃热力图、缓存命中率曲线、按模型用量拆分（环形图 + 列表），在设置页新增一个"使用统计"页面。

所有图表均为手绘 SVG，不依赖图表库；配色使用 GitHub Primer 的 data-viz 双套色板（前 5 名模型各取一个等级色，其余归入灰色 "Other" 桶），并随 DSH 主题自适应。

## 功能

- **时间范围**：最近 7 / 14 / 30 / 90 天，或自定义起止日期
- **汇总卡片**：Token 用量、会话数量（完成的 turn）、请求数量、活跃天数、平均缓存命中率、最常用模型
- **26 周活跃热力图**：每日 token 用量的 GitHub 风格色阶，悬停查看当天明细
- **按天 Token 趋势**：堆叠柱状图叠加平滑的缓存命中率曲线（Catmull-Rom 样条），悬停查看各模型拆分
- **模型用量**：环形图 + 列表，前 5 名模型分色，其余折叠为可展开的 "Other" 明细
- **历史回扫**：首次启用时枚举并回放全部既有会话日志，从安装日起补全历史用量
- **本地持久化**：数据写入 `$DSH_HOME/storages/usage_history.json`（storage-domain），纯本地、无外部依赖

## 安装

```sh
dsh plugin --profile <name> add dsh-usage-statistics-panel@latest
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）：client 半的改动 DSH 会热加载，无需重启；仅 host 半（采集/存储/路由）更新时需要重启 DSH。

插件挂载后，在 Web UI 的设置页左侧导航会出现"使用统计"页面。

## 数据来源

面板的数据采集是**观测式**的：插件订阅会话事件流（`session/event`）中的 `assistant/message` 与 `assistant/chunk`，提取 provider 上报的 token 用量（输入 / 输出 / 缓存读 / 缓存写），按 `(turn, step)` 去重（同一调用的流式采样与最终上报取后者），并按 `request/context` 中的 provider/model 归因。首次启用时还会回扫既有会话日志补齐历史。

> 提示：Token 用量从插件启用（含回扫）之日起累计；更早的会话日志若无 provider 上报的用量数据，则无法回溯。

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
- **双通道打包**：`lib/client.js`（官方 profile 通道，bundle id = 包名）与 `lib/client-registry.js`（插件注册表通道，bundle id = manifest id）
- 详细设计见 [docs/design.md](docs/design.md)

## 致谢

本面板是对 reasonix 用量统计功能的复刻移植：作者曾为 [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 实现并贡献了该功能（PR [#7238](https://github.com/esengine/DeepSeek-Reasonix/pull/7238)、[#7503](https://github.com/esengine/DeepSeek-Reasonix/pull/7503)），本插件按 DSH 的插件规范将其移植到 DeepSeek Harness，前端图表大比例复用原实现，数据层则基于 DSH 的会话日志与 storage-domain 重新实现。

## License

MIT
