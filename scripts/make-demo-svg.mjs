#!/usr/bin/env node
/**
 * Generates docs/demo.svg (English) and docs/demo-zh.svg (Chinese): a looping
 * SVG animation of the panel being opened from its sidebar row and filling in.
 *
 * One script rather than two hand-maintained files: the layouts are identical
 * and only the copy differs, so keeping the geometry in one place is what stops
 * the two versions from drifting apart.
 *
 * The story the animation tells, in 6.4s:
 *   0.000  the shell, its sidebar, and the shipped panel rows
 *   0.125  this plugin's own row appears under them and highlights
 *   0.250  the toolbar
 *   0.313  the metric cards, the two long ones on wider end tracks
 *   0.375  the activity heatmap, wiping open left to right
 *   0.438  the daily token trend
 *   0.500  the model donut and its ranked list
 *   0.875  everything fades out and the loop restarts
 *
 * Colours mirror the panel's own tokens (brand accent #4D6BFE, the five
 * heatmap steps, and the chart series), so the demo cannot show a palette the
 * plugin does not actually render.
 *
 * Usage: node scripts/make-demo-svg.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── palette (mirrors the panel) ────────────────────────────────────────────
const INK = '#1F2328'
const INK_2 = '#57606A'
const INK_3 = '#8C959F'
const LINE = '#D9DEE3'
const LINE_SOFT = '#E7EAEE'
const CARD_LINE = '#E3E7EB'
const ACCENT = '#4D6BFE'
const HEAT = ['#EBEDF0', '#D5DCFF', '#B8C6FF', '#9DB0FF', '#7990FE', ACCENT]
const SERIES = ['#509FFF', '#6D9A73', '#D69159', '#B68CF5', '#E07DB2', '#55ADAD', '#CA7162', '#89919B']

// ── geometry ───────────────────────────────────────────────────────────────
const W = 720
const H = 520
const DIVIDER = 168
const MAIN_X = 192
const MAIN_R = 688
const MAIN_W = MAIN_R - MAIN_X

/** A looping fade that is invisible before `from` and after `to`. */
const fade = (from, to) => `<animate attributeName="opacity" dur="6.4s" repeatCount="indefinite" values="0;0;1;1;0" keyTimes="0;${from};${(from + 0.02).toFixed(4)};${to};1"/>`

// ── copy ───────────────────────────────────────────────────────────────────
const COPY = {
  zh: {
    newSession: '新会话',
    rows: ['插件', '技能', 'MCP'],
    mine: '使用统计',
    workspace: '工作区',
    workspaceName: 'dsh-usage-stats…',
    presets: ['最近 7 天', '最近 14 天', '最近 30 天', '最近 90 天'],
    refresh: '刷新',
    cards: [
      { label: 'Tokens 用量', value: '4.51B' },
      { label: '平均缓存命中率', value: '97.8%', sub: '4.41B 缓存命中' },
      { label: '最常用模型', value: 'deepseek-v4-pro', sub: 'deepseek' },
    ],
    heatmap: '活跃热力图',
    heatLess: '较少',
    heatMore: '较多',
    trend: '按天 Token 趋势',
    hitRate: '缓存命中率',
    donut: '模型用量',
    legend: [
      ['deepseek-v4-pro', '27.6%'],
      ['deepseek-r1', '22.5%'],
      ['deepseek-v3', '13.7%'],
      ['其他', '36.2%'],
    ],
  },
  en: {
    newSession: 'New Session',
    rows: ['Plugins', 'Skills', 'MCP'],
    mine: 'Usage statistics',
    workspace: 'Workspace',
    workspaceName: 'dsh-usage-stats…',
    presets: ['7 days', '14 days', '30 days', '90 days'],
    refresh: 'Refresh',
    cards: [
      { label: 'Tokens used', value: '4.51B' },
      { label: 'Avg cache hit rate', value: '97.8%', sub: '4.41B cached' },
      { label: 'Top model', value: 'deepseek-v4-pro', sub: 'deepseek' },
    ],
    heatmap: 'Activity heatmap',
    heatLess: 'Less',
    heatMore: 'More',
    trend: 'Daily token trend',
    hitRate: 'Cache hit rate',
    donut: 'Model usage',
    legend: [
      ['deepseek-v4-pro', '27.6%'],
      ['deepseek-r1', '22.5%'],
      ['deepseek-v3', '13.7%'],
      ['Other', '36.2%'],
    ],
  },
}

// ── pieces ─────────────────────────────────────────────────────────────────

/** The sidebar: New Session, the shipped panel rows, then this plugin's own. */
function sidebar(c) {
  const parts = []
  parts.push(`<rect x="22" y="26" width="104" height="28" rx="8" fill="#FFF" stroke="${LINE}"/>`)
  parts.push(`<circle cx="38" cy="40" r="4" fill="none" stroke="${INK_2}" stroke-width="1.2"/>`)
  parts.push(`<text x="50" y="44" font-size="11" fill="${INK}">${c.newSession}</text>`)

  // The shipped rows, then ours: a filled row with the brand glyph, because it
  // is the one that is selected.
  c.rows.forEach((label, i) => {
    const y = 74 + i * 30
    parts.push(`<text x="30" y="${y + 16}" font-size="12.5" fill="${INK_2}">${label}</text>`)
  })
  const mineY = 74 + c.rows.length * 30
  parts.push(`<g>${fade(0.125, 0.875)}
    <rect x="18" y="${mineY}" width="134" height="30" rx="9" fill="#EEF1F4"/>
    <rect x="30" y="${mineY + 8}" width="14" height="14" rx="3" fill="none" stroke="${ACCENT}" stroke-width="1.6"/>
    <path d="M33 ${mineY + 18}v-5M36.5 ${mineY + 18}v-8M40 ${mineY + 18}v-3" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"/>
    <text x="52" y="${mineY + 20}" font-size="12" font-weight="600" fill="${INK}">${c.mine}</text>
  </g>`)

  const wsY = mineY + 52
  parts.push(`<text x="30" y="${wsY}" font-size="11" fill="${INK_3}">${c.workspace}</text>`)
  parts.push(`<text x="30" y="${wsY + 26}" font-size="11" fill="${INK_2}">${c.workspaceName}</text>`)
  return parts.join('\n')
}

/** Toolbar: the range presets with the third one selected, plus Refresh. */
function toolbar(c) {
  const parts = []
  parts.push(`<rect x="${MAIN_X}" y="30" width="300" height="28" rx="8" fill="#F6F8FA" stroke="${CARD_LINE}"/>`)
  const widths = [64, 70, 70, 70]
  let x = MAIN_X
  c.presets.forEach((label, i) => {
    const active = i === 2
    if (active) parts.push(`<rect x="${x + 2}" y="32" width="${widths[i]}" height="24" rx="6" fill="#FFF" stroke="${LINE}"/>`)
    parts.push(`<text x="${x + 2 + widths[i] / 2}" y="47.5" font-size="10.5" text-anchor="middle" fill="${active ? INK : INK_2}"${active ? ' font-weight="600"' : ''}>${label}</text>`)
    x += widths[i] + 2
  })
  parts.push(`<text x="${MAIN_R}" y="47.5" font-size="11" text-anchor="end" fill="${INK_2}">${c.refresh}</text>`)
  return `<g>${fade(0.25, 0.875)}\n${parts.join('\n')}\n</g>`
}

/** The metric cards: the two long-valued ones on wider end tracks. */
function cards(c) {
  const gap = 8
  const total = MAIN_W - gap * 2
  const unit = total / 3.6
  const widths = [unit * 1.3, unit, unit * 1.3]
  const parts = []
  let x = MAIN_X
  c.cards.forEach((card, i) => {
    const w = widths[i]
    parts.push(`<rect x="${x}" y="72" width="${w}" height="58" rx="10" fill="#FFF" stroke="${CARD_LINE}"/>`)
    parts.push(`<text x="${x + 14}" y="92" font-size="10.5" fill="${INK_2}">${card.label}</text>`)
    const big = i === c.cards.length - 1 ? 12.5 : 17
    parts.push(`<text x="${x + 14}" y="${card.sub ? 110 : 116}" font-size="${big}" font-weight="600" fill="${INK}">${card.value}</text>`)
    if (card.sub) parts.push(`<text x="${x + 14}" y="123" font-size="9" fill="${INK_3}">${card.sub}</text>`)
    x += w + gap
  })
  return `<g>${fade(0.3125, 0.875)}\n${parts.join('\n')}\n</g>`
}

/** One heatmap row: 26 cells spanning the full main column. */
function heatCells(y, levels) {
  // 26 cells + 25 gaps must fill MAIN_W (496): (496 - 25*4) / 26 ≈ 15.
  const size = 15
  const gap = 4
  const out = []
  levels.forEach((level, i) => {
    out.push(`<rect x="${MAIN_X + i * (size + gap)}" y="${y}" width="${size}" height="${size}" rx="3" fill="${HEAT[level]}"/>`)
  })
  return out.join('')
}

function heatmap(c) {
  const levels = [
    [1, 0, 2, 1, 3, 0, 1, 4, 2, 0, 1, 3, 1, 0, 2, 5, 1, 0, 3, 1, 2, 0, 1, 4, 2, 1],
    [0, 2, 1, 3, 0, 1, 4, 1, 0, 2, 3, 1, 0, 1, 5, 2, 0, 1, 4, 2, 1, 3, 0, 1, 2, 0],
    [2, 1, 0, 4, 1, 2, 0, 3, 1, 5, 0, 2, 1, 4, 0, 1, 3, 2, 1, 0, 4, 1, 2, 3, 0, 1],
  ]
  const rows = levels.map((row, i) => heatCells(164 + i * 20, row)).join('\n')
  return `<g>${fade(0.375, 0.875)}
<text x="${MAIN_X}" y="152" font-size="13" font-weight="600" fill="${INK}">${c.heatmap}</text>
<g font-size="9" fill="${INK_3}"><text x="${MAIN_R - 148}" y="152">${c.heatLess}</text>${HEAT.map((color, i) => `<rect x="${MAIN_R - 124 + i * 14}" y="143" width="10" height="10" rx="2" fill="${color}"/>`).join('')}<text x="${MAIN_R - 34}" y="152">${c.heatMore}</text></g>
<clipPath id="hw"><rect x="${MAIN_X}" y="160" width="0" height="64"><animate attributeName="width" dur="6.4s" repeatCount="indefinite" values="0;0;${MAIN_W};${MAIN_W}" keyTimes="0;0.375;0.4375;1"/></rect></clipPath>
<g clip-path="url(#hw)">
${rows}
</g>
</g>`
}

/** The stacked daily trend with its hit-rate curve. */
function trend(c) {
  const baseY = 356
  const bars = [`<rect x="${MAIN_X}" y="${baseY}" width="${MAIN_W}" height="1" fill="${LINE_SOFT}"/>`]
  const heights = [
    [42, 27, 31, 20, 24, 16, 11],
    [31, 23, 27, 18, 21, 14, 9],
    [20, 16, 18, 12, 14, 10, 6],
  ]
  for (let i = 0; i < 13; i += 1) {
    const x = MAIN_X + 8 + i * 39
    let y = baseY
    heights.forEach((series, si) => {
      const h = series[i % series.length]
      y -= h
      bars.push(`<rect x="${x}" y="${y}" width="21" height="${h}" fill="${SERIES[si]}"/>`)
    })
  }
  return `<g>${fade(0.4375, 0.875)}
<text x="${MAIN_X}" y="240" font-size="13" font-weight="600" fill="${INK}">${c.trend}</text>
<clipPath id="tw"><rect x="${MAIN_X}" y="248" width="0" height="112"><animate attributeName="width" dur="6.4s" repeatCount="indefinite" values="0;0;${MAIN_W};${MAIN_W}" keyTimes="0;0.4375;0.5;1"/></rect></clipPath>
<g clip-path="url(#tw)">
${bars.join('\n')}
<path d="M${MAIN_X + 18} 300C${MAIN_X + 92} 292 ${MAIN_X + 152} 304 ${MAIN_X + 232} 296S${MAIN_X + 362} 286 ${MAIN_X + 442} 292 ${MAIN_X + 502} 286" fill="none" stroke="${ACCENT}" stroke-width="2.5"/>
</g>
<g font-size="9" fill="${INK_3}"><rect x="${MAIN_X}" y="372" width="14" height="3" rx="1.5" fill="${ACCENT}"/><text x="${MAIN_X + 20}" y="376">${c.hitRate}</text></g>
</g>`
}

/** The model donut and the ranked list beside it. */
function donut(c) {
  const cx = MAIN_X + 66
  const cy = 454
  const r = 42
  const sw = 19
  const circ = 2 * Math.PI * r
  const shares = [0.276, 0.225, 0.137, 0.362]
  let offset = 0
  const arcs = shares.map((share, i) => {
    const dash = share * circ
    const arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${SERIES[i]}" stroke-width="${sw}" stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
    offset += dash
    return arc
  })
  const legend = c.legend.map(([name, pct], i) => {
    const y = 418 + i * 26
    return `<circle cx="${MAIN_X + 160}" cy="${y - 4}" r="4" fill="${SERIES[i]}"/><text x="${MAIN_X + 170}" y="${y}" font-size="10.5" fill="${INK_2}">${name}</text><text x="${MAIN_R}" y="${y}" font-size="10.5" fill="${INK_2}" text-anchor="end">${pct}</text>`
  }).join('\n')
  return `<g>${fade(0.5, 0.875)}
<text x="${MAIN_X}" y="394" font-size="13" font-weight="600" fill="${INK}">${c.donut}</text>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${HEAT[0]}" stroke-width="${sw}"/>
${arcs.join('\n')}
<text x="${cx}" y="${cy + 2}" font-size="13" font-weight="600" fill="${INK}" text-anchor="middle">4.51B</text>
<text x="${cx}" y="${cy + 15}" font-size="8.5" fill="${INK_3}" text-anchor="middle">tokens</text>
${legend}
</g>`
}

// ── assembly ───────────────────────────────────────────────────────────────
function render(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,Segoe UI,sans-serif">
<rect x="8" y="8" width="704" height="504" rx="16" fill="#FFF" stroke="${LINE}"/>
<path d="M${DIVIDER} 9v502" stroke="${LINE_SOFT}"/>
${sidebar(c)}
${toolbar(c)}
${cards(c)}
${heatmap(c)}
${trend(c)}
${donut(c)}
</svg>
`
}

writeFileSync(join(ROOT, 'docs', 'demo-zh.svg'), render(COPY.zh), 'utf8')
writeFileSync(join(ROOT, 'docs', 'demo.svg'), render(COPY.en), 'utf8')
console.log('wrote docs/demo-zh.svg and docs/demo.svg')
