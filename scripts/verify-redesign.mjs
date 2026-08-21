// Verify the 2026-08-22 redesign in the real DSH web UI (light + dark):
// 1. Cards: 3 columns, first track wider; tokens (row 1) and the most-used
//    model (row 2) share column 1 and align; order after the swap.
// 2. Heatmap: cells separated by a visible 3px gap; legend swatches render
//    at the exact cell size and spacing.
// 3. Hit-rate curve stroke = DeepSeek brand blue; model bars ride the
//    reasonix palette (no saturated Primer reds/greens).
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const scheme = process.env.USAGE_SCHEME ?? 'light'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)

const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2500) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3500) } else {
  console.log('FATAL: usage stats nav not found'); await browser.close(); process.exit(1)
}

const results = { scheme }

// ── 1. Card grid ──────────────────────────────────────────────────────────
results.cards = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('div[class*="cards"] > div[class*="card"]')]
  if (cards.length !== 6) return { ok: false, reason: `expected 6 cards, got ${cards.length}` }
  const info = cards.map((c) => {
    const r = c.getBoundingClientRect()
    const label = c.querySelector('span[class*="cardLabel"]')?.textContent ?? ''
    return { label, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }
  })
  const colX = [...new Set(info.map((c) => c.x))].sort((a, b) => a - b)
  const tokens = info.find((c) => c.label.includes('Tokens') || c.label.includes('用量') || c.label.toLowerCase().includes('token'))
  // The tokens card shows the exact count with thousands separators — no
  // 万/亿/k/M units.
  const tokensValue = cards.map((c) => ({
    label: c.querySelector('span[class*="cardLabel"]')?.textContent ?? '',
    value: c.querySelector('div[class*="cardValue"]')?.textContent ?? '',
  })).find((c) => c.label === tokens?.label)?.value ?? ''
  const tokensExact = /^\d{1,3}(,\d{3})*$/.test(tokensValue.trim())
  const topModel = info.find((c) => c.label.includes('Most used') || c.label.includes('最常用'))
  const active = info.find((c) => c.label.includes('Active') || c.label.includes('活跃'))
  const sortedByY = [...info].sort((a, b) => a.y - b.y)
  const row1 = sortedByY.slice(0, 3).sort((a, b) => a.x - b.x).map((c) => c.label)
  const row2 = sortedByY.slice(3).sort((a, b) => a.x - b.x).map((c) => c.label)
  // The model card shows two lines — model name, then provider in the muted
  // small style — never the raw "provider/model" ref.
  const modelCard = cards.find((c) => (c.querySelector('span[class*="cardLabel"]')?.textContent ?? '').includes(topModel?.label ?? '###'))
  const modelName = modelCard?.querySelector('span[class*="modelName"]')?.textContent ?? ''
  const modelProvider = modelCard?.querySelector('span[class*="modelProvider"]')?.textContent ?? ''
  const modelTwoLine = !!modelName && !!modelProvider && !modelName.includes('/') && !modelProvider.includes('/')
  return {
    ok: colX.length === 3
      && !!tokens && !!topModel
      && tokens.x === topModel.x && Math.abs(tokens.w - topModel.w) <= 1 && tokens.w > info[1].w + 20
      && !!active && row2[0] === topModel.label && row1[0] === tokens.label
      && tokensExact && modelTwoLine,
    columns: colX.length,
    row1, row2,
    tokens: { x: tokens?.x, w: tokens?.w }, topModel: { x: topModel?.x, w: topModel?.w },
    smallCardW: info[1].w,
    tokensValue, tokensExact,
    modelName, modelProvider, modelTwoLine,
  }
})

// ── 2. Heatmap geometry + legend parity ───────────────────────────────────
results.heatmap = await page.evaluate(() => {
  const svg = document.querySelector('svg[class*="heatmap"]')
  if (!svg) return { ok: false, reason: 'no heatmap svg' }
  const rects = [...svg.querySelectorAll('rect')].map((r) => {
    const b = r.getBBox()
    return { x: b.x, y: b.y, w: b.width, h: b.height, rx: r.getAttribute('rx') }
  })
  const cell = rects[0]
  if (!cell) return { ok: false, reason: 'no cells' }
  // Vertical gap between two cells in the same column (adjacent weekdays).
  const sameCol = rects.filter((r) => Math.abs(r.x - cell.x) < 0.5 && r.y > cell.y).sort((a, b) => a.y - b.y)[0]
  const vGap = sameCol ? Math.round((sameCol.y - (cell.y + cell.h)) * 10) / 10 : null
  // Horizontal gap between neighbouring week columns.
  const nextCol = rects.filter((r) => r.x > cell.x + 1).sort((a, b) => a.x - b.x)[0]
  const hGap = nextCol ? Math.round((nextCol.x - (cell.x + cell.w)) * 10) / 10 : null
  const legend = [...document.querySelectorAll('span[class*="heatLegend"] i, div[class*="heatLegend"] i')]
  const sw = legend.map((i) => { const r = i.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })
  const lg = legend.length >= 2 ? Math.round((legend[1].getBoundingClientRect().x - legend[0].getBoundingClientRect().x - legend[0].getBoundingClientRect().width) * 10) / 10 : null
  return {
    ok: vGap === 3 && hGap === 3 && sw.length === 5 && sw.every((s) => Math.abs(s.w - cell.w) <= 1 && Math.abs(s.h - cell.h) <= 1) && lg === 3,
    cell: { w: Math.round(cell.w * 10) / 10, h: Math.round(cell.h * 10) / 10, rx: cell.rx },
    vGap, hGap,
    legend: { count: sw.length, first: sw[0], gap: lg },
  }
})

// ── 3. Trend curve + bar palette ──────────────────────────────────────────
const chartRaw = await page.evaluate(() => {
  const trend = document.querySelector('path[class*="trend"]')
  const trendStroke = trend ? getComputedStyle(trend).stroke : null
  const bars = [...document.querySelectorAll('rect[class*="bar"]')]
  // Exclude the transparent whole-column hover targets (barHit also matches
  // [class*="bar"]).
  const fills = [...new Set(bars.map((b) => getComputedStyle(b).fill))].filter((f) => f !== 'rgba(0, 0, 0, 0)')
  return { trendStroke, fills }
})
const expectedPalette = scheme === 'light'
  ? ['rgb(80, 159, 255)', 'rgb(109, 154, 115)', 'rgb(214, 145, 89)', 'rgb(182, 140, 245)', 'rgb(224, 125, 178)', 'rgb(137, 145, 155)']
  : ['rgb(93, 166, 255)', 'rgb(120, 161, 125)', 'rgb(217, 153, 101)', 'rgb(187, 148, 246)', 'rgb(226, 134, 184)', 'rgb(146, 153, 162)']
const expectedTrend = scheme === 'light' ? 'rgb(77, 107, 254)' : 'rgb(125, 149, 255)'
results.chart = {
  ok: chartRaw.trendStroke === expectedTrend && chartRaw.fills.length > 0 && chartRaw.fills.every((f) => expectedPalette.includes(f)),
  trendStroke: chartRaw.trendStroke, expectedTrend,
  barFills: chartRaw.fills,
}

console.log(JSON.stringify(results, null, 2))
await page.screenshot({ path: `verify-redesign-${scheme}.png`, fullPage: false })

// ── 4. Narrow-range spread (7-day preset) ─────────────────────────────────
const preset7 = page.locator('button', { hasText: '最近 7 天' }).first()
if (await preset7.count()) {
  await preset7.click(); await page.waitForTimeout(2500)
  const seven = await page.evaluate(() => {
    const svg = document.querySelector('svg[class*="chart"]')
    if (!svg) return { ok: false, reason: 'no chart svg' }
    const box = svg.getBoundingClientRect()
    // The viewBox must match the box width — a narrower viewBox letterboxes
    // the chart dead-centre with empty flanks.
    const vbW = Number(svg.getAttribute('viewBox')?.split(' ')[2] ?? 0)
    const bars = [...svg.querySelectorAll('rect[class*="bar"]')].map((r) => r.getBoundingClientRect())
    const firstBar = Math.min(...bars.map((b) => b.x))
    const lastBarRight = Math.max(...bars.map((b) => b.right))
    const spread = (lastBarRight - firstBar) / box.width
    // X-axis labels must not overlap their neighbours.
    const labels = [...svg.querySelectorAll('text')]
      .map((t) => t.getBoundingClientRect())
      .filter((r) => r.y - box.y > box.height - 32)
      .sort((a, b) => a.x - b.x)
    let overlap = false
    for (let i = 1; i < labels.length; i++) if (labels[i].x < labels[i - 1].right - 0.5) overlap = true
    return {
      ok: Math.abs(vbW - box.width) <= 1.5 && spread >= 0.75 && !overlap,
      vbW: Math.round(vbW), boxW: Math.round(box.width),
      barCount: bars.length, spread: Math.round(spread * 100) / 100,
      labelCount: labels.length, overlap,
    }
  })
  console.log('"sevenDay": ' + JSON.stringify(seven, null, 2))
  await page.screenshot({ path: `verify-redesign-7day-${scheme}.png`, fullPage: false })

  // ── 5. 90-day preset actually shows ~90 columns ─────────────────────────
  const preset90 = page.locator('button', { hasText: '最近 90 天' }).first()
  if (await preset90.count()) {
    await preset90.click(); await page.waitForTimeout(2500)
    const ninety = await page.evaluate(() => {
      // One transparent hit column per day — the day count on screen.
      const cols = document.querySelectorAll('svg[class*="chart"] rect[class*="barHit"]').length
      return { ok: cols >= 85, dayColumns: cols }
    })
    console.log('"ninetyDay": ' + JSON.stringify(ninety))
  }
}
await browser.close()
