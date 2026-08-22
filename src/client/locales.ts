/**
 * Usage panel dictionaries, registered into the DSH locale service. The keys
 * mirror the reasonix stats locale block (settings.stats.*) plus the PR#7503
 * additions ("Other", 180-day trend note); values are the same Chinese and
 * English copy with the zh-TW variant transliterated.
 */

/** The locale namespace this plugin owns. */
export const LOCALE_NS = 'usageStats'

/** The typed translator key union for the panel's locale seat. */
export type UsageStatsKey =
  | 'nav'
  | 'range'
  | 'rangePreset.7'
  | 'rangePreset.14'
  | 'rangePreset.30'
  | 'rangePreset.90'
  | 'rangeCustom'
  | 'from'
  | 'to'
  | 'refresh'
  | 'loading'
  | 'tokens'
  | 'tokensHint'
  | 'cachedTokens'
  | 'sessions'
  | 'requests'
  | 'activeDays'
  | 'cacheRate'
  | 'cacheRateHint'
  | 'cacheHitRate'
  | 'hitRateLegend'
  | 'topModel'
  | 'topModelHint'
  | 'heatmap'
  | 'heatLess'
  | 'heatMore'
  | 'dailyTrend'
  | 'trendLimited'
  | 'modelUsage'
  | 'other'
  | 'total'
  | 'percent'
  | 'asOf'
  | 'empty'

export const en: Record<UsageStatsKey, string> = {
  nav: 'Usage statistics',
  range: 'Time range',
  'rangePreset.7': 'Last 7 days',
  'rangePreset.14': 'Last 14 days',
  'rangePreset.30': 'Last 30 days',
  'rangePreset.90': 'Last 90 days',
  rangeCustom: 'Custom',
  from: 'From',
  to: 'To',
  refresh: 'Refresh',
  loading: 'Loading',
  tokens: 'Token usage',
  tokensHint: 'Provider-visible total: uncached input + output + cached tokens',
  cachedTokens: 'cached',
  sessions: 'Sessions',
  requests: 'Requests',
  activeDays: 'Active days',
  cacheRate: 'Avg cache hit rate',
  cacheRateHint: 'Cached input tokens as a share of all input tokens in the range',
  cacheHitRate: 'Cache hit rate',
  hitRateLegend: 'Cache hit rate',
  topModel: 'Top model',
  topModelHint: 'Ranked by token volume, not call count',
  heatmap: 'Activity heatmap',
  heatLess: 'Less',
  heatMore: 'More',
  dailyTrend: 'Daily token trend',
  trendLimited: 'Showing the latest {n} days',
  modelUsage: 'Model usage',
  other: 'Other',
  total: 'Total',
  percent: 'Share',
  asOf: 'As of',
  empty: 'No usage data in this time range yet. Token usage is recorded from the day the panel is installed, including a one-time scan of your existing sessions.',
}

export const zh: Record<UsageStatsKey, string> = {
  nav: '使用统计',
  range: '时间范围',
  'rangePreset.7': '最近 7 天',
  'rangePreset.14': '最近 14 天',
  'rangePreset.30': '最近 30 天',
  'rangePreset.90': '最近 90 天',
  rangeCustom: '自定义',
  from: '开始日期',
  to: '结束日期',
  refresh: '刷新',
  loading: '加载中',
  tokens: 'Tokens 用量',
  tokensHint: '服务商总口径：未缓存输入 + 输出 + 缓存命中 token',
  cachedTokens: '缓存命中',
  sessions: '会话数量',
  requests: '请求数量',
  activeDays: '活跃天数',
  cacheRate: '平均缓存命中率',
  cacheRateHint: '时间段内缓存命中 token 占输入 token 的比例',
  cacheHitRate: '缓存命中率',
  hitRateLegend: '缓存命中率',
  topModel: '最常用模型',
  topModelHint: '按 token 用量排序，非调用次数',
  heatmap: '活跃热力图',
  heatLess: '较少',
  heatMore: '较多',
  dailyTrend: '按天 Token 趋势',
  trendLimited: '仅显示最近 {n} 天',
  modelUsage: '模型用量',
  other: '其他',
  total: '总用量',
  percent: '占比',
  asOf: '统计截至',
  empty: '当前时间范围内暂无用量数据。Token 用量从本面板启用后开始累计，并会一次性回扫已有的历史会话。',
}

export const zhTW: Record<UsageStatsKey, string> = {
  nav: '使用統計',
  range: '時間範圍',
  'rangePreset.7': '最近 7 天',
  'rangePreset.14': '最近 14 天',
  'rangePreset.30': '最近 30 天',
  'rangePreset.90': '最近 90 天',
  rangeCustom: '自訂',
  from: '開始日期',
  to: '結束日期',
  refresh: '重新整理',
  loading: '載入中',
  tokens: 'Tokens 用量',
  tokensHint: '服務商總口徑：未快取輸入 + 輸出 + 快取命中 token',
  cachedTokens: '快取命中',
  sessions: '會話數量',
  requests: '請求數量',
  activeDays: '活躍天數',
  cacheRate: '平均快取命中率',
  cacheRateHint: '時間範圍內快取命中 token 佔輸入 token 的比例',
  cacheHitRate: '快取命中率',
  hitRateLegend: '快取命中率',
  topModel: '最常用模型',
  topModelHint: '依 token 用量排序，非呼叫次數',
  heatmap: '活躍熱力圖',
  heatLess: '較少',
  heatMore: '較多',
  dailyTrend: '每日 Token 趨勢',
  trendLimited: '僅顯示最近 {n} 天',
  modelUsage: '模型用量',
  other: '其他',
  total: '總用量',
  percent: '佔比',
  asOf: '統計截至',
  empty: '目前時間範圍內尚無用量資料。Token 用量自本面板啟用後開始累計，並會一次掃描既有的歷史會話。',
}
