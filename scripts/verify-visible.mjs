// Pixel-level visibility check: hover a cell/bar and confirm the tooltip is
// actually painted on top (elementFromPoint hits the tip, not the modal).
import { chromium } from 'playwright-core'
const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)
const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2500) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3500) }

async function checkTip(label) {
  const r = await page.evaluate(() => {
    const tips = [...document.querySelectorAll('[role="tooltip"]')].filter((t) => t.textContent?.trim() && getComputedStyle(t).visibility !== 'hidden')
    if (tips.length === 0) return { visible: false, reason: 'no tip element' }
    const tip = tips[0]
    const rect = tip.getBoundingClientRect()
    // Sample several points inside the tip; elementFromPoint must hit the tip
    // (or a descendant) for it to actually be painted on top.
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const hit = document.elementFromPoint(cx, cy)
    const hitIsTip = hit !== null && (hit === tip || tip.contains(hit))
    const modal = document.elementFromPoint(cx, cy)?.closest?.('[class*="overlay"], [class*="settingsRoot"]')
    return {
      visible: true,
      z: getComputedStyle(tip).zIndex,
      hitIsTip,
      hitCls: hit ? (hit.className?.toString?.() || hit.tagName).slice(0, 50) : null,
      underModal: modal !== null && !tip.contains(hit),
      left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height),
      bg: getComputedStyle(tip).backgroundColor,
    }
  })
  console.log(label + ':', JSON.stringify(r))
}

// Heatmap cell
const cells = page.locator('rect[class*="heatLevel"]')
if (await cells.count() > 0) {
  await cells.nth(0).hover()
  await page.waitForTimeout(700)
  await checkTip('HEAT')
  await page.mouse.move(0, 0); await page.waitForTimeout(300)
}
// Trend bar
const bars = page.locator('rect[class*="barHit"]')
await page.locator('[class*="chartWrap"]').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(500)
if (await bars.count() > 0) {
  const dataIdx = await page.evaluate(() => {
    const hs = [...document.querySelectorAll('rect[class*="barHit"]')]
    return hs.findIndex((h) => { const g = h.closest('g'); return g && [...g.querySelectorAll('rect')].some((r) => r !== h && Number(r.getAttribute('height') || 0) > 0) })
  })
  if (dataIdx >= 0) {
    const box = await bars.nth(dataIdx).boundingBox()
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(700) }
    await checkTip('BAR')
    await page.mouse.move(0, 0); await page.waitForTimeout(300)
  }
}
// Donut segment
await page.locator('[class*="donutWrap"]').scrollIntoViewIfNeeded()
await page.waitForTimeout(500)
const segBox = await page.locator('circle[class*="donutSeg"]').first().boundingBox()
if (segBox) {
  await page.mouse.move(segBox.x + segBox.width * 0.85, segBox.y + segBox.height / 2)
  await page.waitForTimeout(700)
  await checkTip('DONUT')
  // screenshot with the tip visible for the record
  await page.screenshot({ path: 'verify-visible.png' })
}
await browser.close()
