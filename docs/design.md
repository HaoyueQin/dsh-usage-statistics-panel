# 设计说明

DSH Usage Statistics Panel 复刻 reasonix 的用量统计功能（PR #7238 / #7503），按 DeepSeek Harness 的插件规范实现：Host 半（Node）负责采集与聚合，Client 半（浏览器）负责渲染（插件页内的独立页面，以及一个同名主面板），两者通过插件自有的 fenced HTTP 路由通信。

## 数据流

```
session 事件流 (session/event)
        │  assistant/message.usage, assistant/chunk(chunk.type=usage)
        │  compaction/summary.usage, request/context (provider/model 归因)
        ▼
UsageCollector ──(turn,step / compactionId 去重折叠)──▶ UsageStore (storage-domain)
        ▲                                       │
        │ 首次启用回扫                        rangeRows(from,to)
        │  sessionPersistence.list() +        ▼
        └── inspect(id) 逐会话回放 ──────  /usage/api/range (fenced)
                                                │
                                                ▼
                                    UsageStatsPanel (插件页 + 独立主面板, 手绘 SVG)

llm/stream 瀑布 (purpose='session-title')       ← 不在会话日志中，无法回扫
        └──(流内观测 usage)──────────────────▶ UsageStore
```

## Host 半

### collector.ts — 采集与去重

- **实时**：`ctx.on('session/event')` 订阅。`assistant/message` 的 `data.usage`（TokenUsage）与 `assistant/chunk` 的 `chunk.type === 'usage'` 都是 usage 样本；`compaction/summary` 的 `data.usage` 是同一事件流上的第三类 usage 样本——摘要调用不产生 `assistant/message`，该事件是它唯一的持久记录——并同时计一次请求；`request/context` 提供 provider/model 归因。fold 桶与归因路由都按回调携带的 sessionId 分桶，并发会话互不干扰；`session/disposed` 时释放对应桶。
- **辅助调用**：`purpose: 'session-title'` 的调用（AI 生成会话标题）经 `ctx.llm.stream()` 发出，在会话日志里只留请求、不留用量，因此由 `llm/stream` 瀑布在流内观测：取流中最后一个 usage 样本加一个请求标记，按调用开始时刻归日、按 `options.provider`/`model` 归因。关闭流（超时或会话取消）时仍记账。其余 purpose 的调用原样透传，热路径不付出代价。
- **去重**：同一会话内同一 `(turn, step)` 只向 store 发射一次（fold 内部保留最新值用于判重）。已发布的两个适配器在流式 chunk 与最终 message 上报告**完全相同**的 TokenUsage（llm-deepseek 在 DONE 时用同一个 `pendingUsage` 对象发一次；llm-pi-ai 仅在 done/error 终态发射），因此"首样本生效"与"取后者"观测等价。若未来适配器对同一次调用报告不同数值，需升级为 store 侧按 `(session, turn, step)` 的差值修正。跨会话的相同 `(turn, step)` 各自成立。`compaction/summary` 没有 `(turn, step)` 槽位，改按 `compactionId` 去重（宿主以 `randomUUID()` 生成，全局唯一）。
- **游标**：实时监听把每个触达过的会话 id 合批写入持久化游标（`markSeenSessions`，microtask 合批）。这是重启安全的关键：harness 的 `SessionStore.list()` 只返回内存中活跃的会话，会话释放后其样本只存在于 store 行和持久化日志里——没有游标，下次启动的回扫会把日志重放在已记录的行上，全部翻倍。
- **回扫**：首次启用时 `sessionPersistence.list()` 枚举全部会话（当前活跃会话除外），`inspect(id)` 读取完整事件日志（zstd 由后端内部处理），并发 4 逐会话回放——每个会话使用全新的独立 fold。单个会话读取失败不中断整体回扫（status.error 记录）；游标按批（32 个/次）串行写回，避免并发读改写丢 id。每个目标重放前复查一次存活状态：快照之后恢复活跃的会话归实时监听所有，跳过重放。
- **旧库重建**：storage-domain 打开时（store 构造链内）检测"有行但游标为空"的 ≤0.1.1 旧库，一次性清空行让回扫重建——判定发生在任何 record/mark 之前，无顺序竞态。

### store.ts — 持久化

使用 storage-domain 的 `usage_history` 域，两张表：

- `days`：key `YYYY-MM-DD|provider|model`；value `{ day, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, requests, turns, lastSeen }`
- `hours`：key `YYYY-MM-DDTHH|provider|model`；value 同形，首字段为 `hour`（本地小时，补零）
- 写入走 `KvTable.update()`（按 key 原子读改写队列），并发 turn 不交错；实时样本同时写两表（两次 update，非事务——天行成功、小时行失败只影响小时视图，不影响天视图与卡片）
- 域名 **不升 version**：storage-domain 打开时按 spec 为缺失表补空表，升 version 反而会让旧介质 `version-mismatch`（域格式没有迁移路径）
- 后端（web-app bundle 的 storage-json）落地 `$DSH_HOME/storages/usage_history.json`

两套游标各自独立：`backfilledSessions` / `liveFirstSeq` 管天表，`hoursBackfilledSessions` / `hoursLiveFirstSeq` 管小时表，另有 `hoursReady` 记录小时历史是否已覆盖全部可重放会话。任何一次 global 写入都必须带上对方字段（整体重写，漏字段会让对方回填反复重跑）。小时表晚于天游标出现，所以升级时用独立游标重放日志、只写 `hours`，天表与天游标完全不动；升级时仍活跃的会话先按当前 `seq` 写小时水位，只重放前缀，与 reset 的切分语义一致。首次安装与重建由双写的 `'all'` 回扫顺带置位 `hoursReady`；升级场景的 `'all'` 没有目标，不得置位。

Token 桶语义：`inputTokens` 是 uncached input（即缓存 miss 侧），`cacheReadTokens` 是缓存命中侧——命中率恒为 `Σhit / Σ(hit+miss)`，与 reasonix 一致，两个分母不混。

请求标记语义：`requests` 与 token 桶正交。`step/start`、`llm/retry-started` 只加 `requests`（调用失败、无 token 也算一次）；`assistant/message` 只加 token 桶（那次调用已由自己的 `step/start` 计过请求）；`compaction/summary` 与标题调用两者都加——它们是 loop 之外的调用，没有 `step/start` 为它们计请求。

### query.ts — 范围聚合

翻译自 reasonix `internal/stats/query.go`：

- 粒度：`granularity: 'day' | 'hour'`；day 按日 emit，hour 按本地小时 emit（今日固定 24 桶、最近 3 天固定 72 桶，空桶补零）
- `activeDays` 始终按天去重（小时键取日期前缀），小时视图的总量与天视图同口径
- token 总计、请求数、turn 数、命中率派生、活跃天数、Top 模型/Provider
- 模型 ref `provider/model`，裸模型名归 `default` provider

### routes.ts + trust-fence.ts — HTTP 服务

`webServer.register({ kind: 'prefix', path: '/usage/api', handler })`：

- `POST /usage/api/range`：`{ range, from?, to? }` → `UsageStatsRange`；`range` 取值 `today | 3 | 7 | 14 | 30 | 90 | custom`，`today`/`3` 读小时表并置 `granularity: 'hour'`，其余一律按天（`custom` 不做隐式粒度推断）；custom 范围做语义日期校验（拒绝 `2026-13-45` 这类正则可过但日历不存在的形状）并限制跨度 ≤366 天（400）
- `POST /usage/api/status`：`BackfillStatus`
- 信任围栏与 `/api` 网关同源同语义（dsh-client-connection `isTrustedApiRequest`）：① Host 头须为 loopback、本监听端自身的 bind 地址（`webServer.host`，任意端口，剥 `%zone`；未指定地址拼写一律不认），或 trust 列表中的授权（无端口条目匹配任意端口，带端口条目精确匹配 host:port）；② `sec-fetch-site: cross-site` 一律拒绝；③ 携带 Origin 时必须与 Host 同源（"null" 视为不透明 origin 拒绝；Host 放到 Origin 的 scheme 下再归一）。任一不满足即 403。
- trust 列表与协议按宿主代际取源。`0.2.1-alpha.2` 起：`webStartup.trustedHosts`（仅 CLI 显式授权）+ `webServer.protocol`；该版还删除了 `webRuntime` 服务，并把「接受 bind 地址」独立出来。此前：`webRuntime.trustedHosts` 才是官方 fence 实际接入的那一份（`web-runtime` 行在绑定后采样局域网字面量并接上调用参数，是 `webStartup` 的超集），故这里 **webRuntime 优先、webStartup 兜底**。两个 provider 都用 `ctx.get()` 探测：直接读一个宿主未注册的服务属性会被 cordis 的 traced Context 抛错，而该抛错发生在 handler 的围栏调用里，会逃出 handler 被 webserver 兜底成空 400（本 issue 的现象）。

## Client 半

### index.tsx — 面板与侧栏入口注册

本插件注册三个面板相关槽位：`plugins.bundle.config`（keyed，键为本 bundle 的 npm 包名）把面板渲染进插件页里该组合包的详情页；`main`（keyed，键 `usage-stats`）把它注册成一个全局主面板；`sidebar.panellist`（list，id `usage-stats`，order 30）在左侧栏「新会话」下方加一行，点击即切到该主面板。面板因此由**同一组件渲染在两处**，`UsageStatsPanelPage` 用与插件页相同的 960px 内容列包住它（模块 css 的 `.page` 镜像插件页自己的 `.page`：左右与底部内边距、前景色 token 逐条对齐——**唯顶部那 28px 例外**，它落在返回行 `.backRow` 自己的盒子上。主面板贴着窗口左上角，若把这 28px 画在滚动容器上，顶部条带就归属容器而不参与窗口拖拽；宿主的两个页面型插件 `ui-plugin-manager`（`.pageHead`/`.detailTop`）与 `ui-schedule` 出于同一原因把该内边距移到头部行。搬移前后渲染逐像素一致），两处外观一致。locale 座绑定 `usageStats` 命名空间（en/zh/zh-TW 三份字典）；面板数值格式化跟随当前语言——中文显示 亿/万（简）或 億/萬（繁），英文用 K/M/B 图表惯例。组件经 `/usage/api` fetch 数据，不直接触 ctx（返回控制是唯一例外：主面板的 `goBack` 经槽位 `inject` 传入，见下）。

图标资产两处都按宿主风格校准（issue #12）：侧栏行的 `stats-icon.tsx` 用 lucide `BarChart3`，但线宽取 1.5 而非 lucide 默认的 2——24 网格缩到宿主的 16px 格，2 是 1.33px，比官方面板行（16 网格 stroke 1，`ICON_REGULAR_STROKE`）重三分之一，1.5 恰为 1px；插件卡 `icon.svg` 的命中率趋势线则改成只含两个拐点的折线（起点 + 两个拐点 + 终点），因为 36px 画布上原三段贝塞尔的起伏只剩一两像素，读作无意义的扭曲。

范围选择器提供 今日 / 最近 3 天 / 7 / 14 / 30 / 90 天 / 自定义（默认 30 天）。前两者驱动小时粒度趋势：标题切到「按小时 Token 趋势」，横轴 0 点显示日期、其余显示 `HH:00`，抽稀沿用既有的 `labelEvery`；统计卡片、热力图、模型/供应商图表的口径不变，`activeDays` 始终按天去重。

### index.tsx — 主面板的返回控制

独立主面板左上角有返回按钮，回到**进入该面板之前**的界面。宿主**没有**面板历史——`ctx.layout` 只写当前选中项（`ILayout` 仅暴露 `selectPanel` 与 `panelInfo`），所以历史由本插件自己重建：apply 订阅 `ctx.layout.panelInfo`（`inject` 因此增加 `layout`），每当 `usage-stats` 成为选中项就记下它替换掉的那个 key——读者从会话、插件页还是别的面板进来，目标都对。`selectPanel` 对已注销的 key 会抛错，而抛错会把读者困在面板里，所以目标不可用时回退到 `selectPanel(null)`（回到当前会话；`null` 永远是合法选择）。按钮只画在独立主面板：插件页那个入口在宿主自己的 chrome 里，本就有回到组合包列表的面包屑。图标取自已依赖的 `lucide-react`，不再引入 primitives 图标名去跟宿主改名保持同步。

> 侧栏入口刻意**不**走 `sidebar.footer.action`：那个座位是宿主里一条与其它插件共享的 flex 行，注册在那里会与邻居争宽度——两个插件时尚可等分，三个以上就会把彼此的标签挤成省略号（2026-09 实测：256px 行里三个条目各约 85px，而「上下文洞察」一类的标签需要约 126px）。

### UsageStatsPanel.tsx — 图表

移植自 reasonix 面板（853 行）+ PR #7503 的改动：

- **热力图**：数据窗口固定为一年（52 周）；宽度求解优先把空余宽度用在**更多周数**上，放不下整个窗口时改裁最早的列，两种情形都精确撑满容器；5 级色阶由 brand accent 经 color-mix 派生
- **趋势图**：堆叠柱状图按全范围用量排名着色（模型颜色逐日稳定），叠加 Catmull-Rom 命中率曲线；最窄时裁剪最早天数，超过 180 天显示提示
- **模型图 / 供应商图**：两者同一解剖——左侧环形占比图（`Donut`）+ 右侧明细列表。模型取前 10 名分色、供应商取前 5 名分色，其余折叠为灰色 "Other"。圆环直径由所在行的实测宽度求解（`resolveDonutSize`，钳在 200–280px），既随容器变化，又保证右侧明细列表不低于它的 flex 基准宽度；圆环与其列表在同一行内**垂直居中**（`align-items: center`），列表高度从不反过来决定图表尺寸。每段可聚焦（tabIndex + role="img" + aria-label + focus/hover 出 tooltip）——分段数量有界（≤11），而热力图 ~180 个格子不适合逐格进 tab 序，故热力图与趋势图保持鼠标悬停（SVG 整体带 role="img" 标注）
- **展开层级**：模型区只有 "Other" 行可展开（列出被折叠的模型）；供应商区两级——排名行展开该供应商的模型，"Other" 展开被折叠的供应商（每行带该供应商的模型数），这些行再展开各自的模型。展开容器是行的**兄弟节点**且不带行类名；圆环的直径只依赖行的**宽度**，故展开任一行都不会改变图表尺寸
- **色板**：`--dsw-chart-1..10` + `--dsw-chart-other`（模型）、`--dsw-provider-1..5` + `--dsw-provider-other`（供应商独立色板，供应商不穿模型色），light/dark 两套（CSS `@media (prefers-color-scheme)`），色值经 color-mix 向底色柔化

### StatsLineEnhanced.tsx — 底部信息栏接管

以 `priority: -1` 注册进 `conversation.composer.dock`（list 槽，最低优先级条目渲染），遮蔽官方 StatsPills 并叠加两个读数开关。**注册的 id 由宿主代际决定，注册前从该槽自己的条目账本读出**（`ctx.slots.entries`）：`0.2.1-alpha.1` 起官方把单个 `stats` 拆成 `activity`（轮/步与速度、用时浮层）与 `usage`（token 与命中率、用量浮层）两个独立条目（其 release notes 明言「覆盖旧 `stats` 整行的插件需要更新注册 ID」），所以那时注册两条同 id 条目；此前仍是单 `stats`，注册整行一条。id 不匹配不会遮蔽，只会多渲染一个条目——猜错任一方向都是 issue #10 那类重复行，故账本为空（ui-chat 晚于本插件注册）时**保持未决**，由 `ctx.slots.subscribe` 在首个发布出形状的变更上定夺，而不是默认成某一边。两条宿主线上的组件分工：单 `stats` 线上 `StatsLineEnhanced` 自持行容器与两个浮层共享的互斥态；拆分线上 `StatsActivityEntry` / `StatsUsageEntry` 各自只渲染裸 `.anchor`（无行容器，交给宿主 `.dock` 的 flex 行）、各自持空判据、各自持浮层开态，互斥改由 stat-dialog 在 document 捕获阶段关闭兄弟实现。

该行跨宿主代际有两套容器契约：`0.1.6-alpha.1` 及以前，槽位直接渲染进 InputBar 自己的列，行自持内容宽度（`--dsh-chat-content-width`）、左右 `clearance + 16px` 侧边距与 4px 顶距；`0.1.6-alpha.2` 起，槽位被放进与常驻 ContextMeter 并排的 flex 行 `.dock`，居中、12px 间距、顶距与侧边距由该容器负责，行只需在其中收缩。组件在 DOM 挂载时读父容器的计算样式并打 `data-dock-row` 标记，样式表按标记在两套声明间切换——一份构建同时满足两条宿主线。文字档位同理分两处：整行线上由 `.root` 声明、`.anchor` 继承；拆分线上没有行容器可继承（官方同一提交把这组声明从 `.root` 移到了每个条目的 `.anchor`），故拆分条目的锚点自带 `.dockAnchor` 档位。

### 样式

全部视觉值走 DSH 语义 token（`--dsw-alias-*` 颜色、`--dsw-font-*` 排版），无静态色值、无主题选择器，浅色/深色由主题包负责。

## 双通道打包

`tsdown.config.ts` 复刻官方未发布的 `tsdown.client.ts` 预设：

- host ESM → `lib/index.js`
- client bundle ×2：`lib/client.js`（官方 profile 通道，id=包名）与 `lib/client-registry.js`（注册表通道，id=manifest id），lazy-CJS factory（`window.__ModuleLoader__.load`），external 走模块表（react/cordis/dsh-client-* 白名单），其余内联，purity gate 拒非白名单 `@deepseek-ai` 值导入
- CSS Modules（lightningcss）哈希类名 + `<style data-plugin>` 注入

插件的卡片元数据（插件页卡片 / 详情页 / 组合包行的标题、描述、图标）走宿主既有通道，不经过本包任何代码：`package.json.icon`（顶层字段，包内相对路径，SVG/PNG/JPEG/WebP 且 ≤256 KiB）与 `locale/*.json` 中的 `meta.title` / `meta.description`，由 app-boot 的 `readPluginMeta()` 在不执行插件代码的前提下读取。两个易踩的坑：① 本包声明了 `exports`，因此**必须**显式导出 `./locale/*.json`——子路径解析失败会被当作"没有 locale"，静默回落成包名 + 英文描述；② locale 目录整体被读取：文件名去掉 `.json` 后必须是 `2–8 个字母` 起头、其后每段 `1–8 位字母数字` 的语言 id（`zh-TW` 合法，`zh_TW`、`traditional` 不合法），名字不合规或与另一份小写后重名，会让**整次**读取降级为一条诊断错误（标题与描述一起丢失）。这两条与本包的三份字典（en / zh / zh-TW）都由 `tests/manifest-consistency.spec.ts` 守卫；该守卫比读取端更严：每份字典都必须带非空的 `meta.title` / `meta.description`，以免目录里混进无害但无意义的空字典。

> 通道状态：harness 0.1.x 的官方加载链只消费 package.json 的 `dsh.client` 声明 + `exports["./client"]`（entry id = 包名，即 `lib/client.js`）；`dsh.plugin.json` 与 `lib/client-registry.js` 目前不被 harness 任何代码读取，是为外部 registry 通道预留的产物。只装官方 profile 通道时二者可忽略。

## 已知限制

- 回扫后的**增量**不重放旧会话（避免重复计数）；新会话实时采集并入游标，重启后不会被重放
- 回扫跳过启动时的**活跃会话**：这些会话在插件启动前的历史 usage 不计（避免与实时流重复折叠）；其后的增量由实时监听覆盖并写入游标，重启后同样不会重放
- 旧会话日志若无 provider usage（或日志被压缩清理），无法回溯
- `usage_history` 域版本 1；新增表不升版本（storage-domain 打开时按 spec 为空表补位，升版本则旧介质 `version-mismatch` 拒绝打开），只有变更既有表 schema 时才 bump 并写迁移
- 小时历史只能由会话日志回填：日志已被清理的旧会话在小时视图（今日 / 最近 3 天）中缺失，天表与长范围视图不受影响；升级后的首次启动会跑一次只写 `hours` 的回填，面板在回填完成前可能暂时没有小时数据
- 热力图/趋势图的 tooltip 仅鼠标触发（格子数量不适合逐格进 tab 序）；环形图分段支持键盘
- 侧栏入口的落点是「新会话」下方的面板行：它占的是 `sidebar.panellist` 的一行，而不是能自行隐藏的按钮——面板行一旦注册就常驻（与内置的插件/技能/MCP 行一致），所以没有「显示/隐藏入口」的开关
