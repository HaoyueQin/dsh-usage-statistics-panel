// Verify the usage panel fixes in the real DSH web UI:
// 1. Heatmap cells: size/gap/legend consistency (cells match legend swatches).
// 2. Tooltips on all three charts: visible, inside the panel, theme-aware bg.
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)

// Open settings and the usage stats section (zh UI).
const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2500) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3500) } else {
  console.log('FATAL: usage stats nav not found'); await browser.close(); process.exit(1)
}

const results = {}

// ── 1. Heatmap geometry ───────────────────────────────────────────────────
const heatGeom = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('rect[class*="heatLevel"]')]
  if (cells.length === 0) return { ok: false, reason: 'no heat cells' }
  const rects = cells.map((c) => c.getBoundingClientRect())
  const size = Math.round(rects[0].width)
  // Same-row adjacent pair: same top, horizontal neighbor.
  let gapX = null
  let gapY = null
  for (let i = 0; i < rects.length && (gapX === null || gapY === null); i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]
      const b = rects[j]
      if (gapX === null && Math.round(a.top) === Math.round(b.top) && Math.round(b.left) > Math.round(a.left) && Math.round(b.left - a.right) >= 0 && Math.round(b.left - a.right) < 10) {
        gapX = Math.round(b.left - a.right)
      }
      if (gapY === null && Math.round(a.left) === Math.round(b.left) && Math.round(b.top) > Math.round(a.top) && Math.round(b.top - a.bottom) >= 0 && Math.round(b.top - a.bottom) < 10) {
        gapY = Math.round(b.top - a.bottom)
      }
    }
  }
  // Legend swatch colors (the 5 <i> elements in the section head)
  const legendColors = [...document.querySelectorAll('i[class*="heatLevel"]')].slice(0, 5).map((el) => getComputedStyle(el).backgroundColor)
  const legendSizes = [...document.querySelectorAll('i[class*="heatLevel"]')].slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().width))
  const svgColor0 = getComputedStyle(cells[0]).fill
  const svgColorMax = getComputedStyle(cells[cells.length - 1]).fill
  return { ok: true, cellSize: size, gapX, gapY, nCells: cells.length, legendColors, legendSizes, svgColor0, svgColorMax }
})
console.log('HEAT:', JSON.stringify(heatGeom))
results.heat = heatGeom

// ── 2. Heatmap tooltip ────────────────────────────────────────────────────
const cells = page.locator('rect[class*="heatLevel"]')
if (await cells.count() > 0) {
  await cells.nth(0).hover()
  await page.waitForTimeout(700)
  const heatTip = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('[role="tooltip"]')].find((t) => t.textContent?.includes('2026'))
    if (!tip) return { visible: false }
    const r = tip.getBoundingClientRect()
    const panel = document.querySelector('._74hiaW_panel, [class*="options"]')?.parentElement?.getBoundingClientRect()
    const inPanel = panel ? r.left >= panel.left - 1 && r.right <= panel.right + 1 && r.top >= panel.top - 1 && r.bottom <= panel.bottom + 1 : null
    const inViewport = r.top >= 0 && r.bottom <= window.innerHeight
    return {
      visible: true,
      left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      bg: getComputedStyle(tip).backgroundColor,
      color: getComputedStyle(tip).color,
      inPanel, inViewport,
      text: tip.textContent?.trim().slice(0, 50),
    }
  })
  console.log('HEAT TIP:', JSON.stringify(heatTip))
  results.heatTip = heatTip
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// ── 3. Trend bar tooltip ──────────────────────────────────────────────────
const bars = page.locator('rect[class*="barHit"]')
const trendWrap = page.locator('[class*="chartWrap"]').first()
if (await bars.count() > 0) {
  await trendWrap.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  const dataIdx = await page.evaluate(() => {
    const hs = [...document.querySelectorAll('rect[class*="barHit"]')]
    return hs.findIndex((h) => {
      const g = h.closest('g')
      return g && [...g.querySelectorAll('rect')].some((r) => r !== h && Number(r.getAttribute('height') || 0) > 0)
    })
  })
  if (dataIdx >= 0) {
    const box = await bars.nth(dataIdx).boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(700)
    }
    const barTip = await page.evaluate(() => {
      const tips = [...document.querySelectorAll('[role="tooltip"]')].filter((t) => t.textContent?.trim())
      const tip = tips[0]
      if (!tip) return { visible: false, nTips: 0 }
      const r = tip.getBoundingClientRect()
      const panel = document.querySelector('._74hiaW_panel, [class*="options"]')?.parentElement?.getBoundingClientRect()
      const inPanel = panel ? r.left >= panel.left - 1 && r.right <= panel.right + 1 && r.top >= panel.top - 1 && r.bottom <= panel.bottom + 1 : null
      const inViewport = r.top >= 0 && r.bottom <= window.innerHeight
      return {
        visible: true,
        left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        bg: getComputedStyle(tip).backgroundColor,
        inPanel, inViewport,
        text: tip.textContent?.trim().slice(0, 60),
      }
    })
    console.log('BAR TIP:', JSON.stringify(barTip))
    results.barTip = barTip
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
  }
}

// ── 4. Donut segment tooltip ──────────────────────────────────────────────
const segs = page.locator('circle[class*="donutSeg"]')
if (await segs.count() > 0) {
  await page.locator('[class*="donutWrap"]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  // Hover a real point on the ring: the centre text intercepts pointer events,
  // so pick the first segment's stroke ring coordinates (roughly 3 o'clock).
  const segBox = await segs.first().boundingBox()
  if (segBox) {
    const cx = segBox.x + segBox.width / 2
    const cy = segBox.y + segBox.height / 2
    await page.mouse.move(cx + segBox.width * 0.28, cy)
    await page.waitForTimeout(700)
  }
  const donutTip = await page.evaluate(() => {
    const tips = [...document.querySelectorAll('[role="tooltip"]')].filter((t) => t.textContent?.trim())
    const tip = tips[0]
    if (!tip) return { visible: false, nTips: tips.length }
    const r = tip.getBoundingClientRect()
    const panel = document.querySelector('._74hiaW_panel, [class*="options"]')?.parentElement?.getBoundingClientRect()
    const inPanel = panel ? r.left >= panel.left - 1 && r.right <= panel.right + 1 && r.top >= panel.top - 1 && r.bottom <= panel.bottom + 1 : null
    return {
      visible: true,
      left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      bg: getComputedStyle(tip).backgroundColor,
      inPanel,
      text: tip.textContent?.trim().slice(0, 60),
    }
  })
  console.log('DONUT TIP:', JSON.stringify(donutTip))
  results.donutTip = donutTip
  await page.mouse.move(0, 0)
  await page.waitForTimeout(200)
}

// ── 5. Screenshot for the record ──────────────────────────────────────────
await page.screenshot({ path: 'verify-light.png' })
console.log('LIGHT MODE:', JSON.stringify(results))
await browser.close()
