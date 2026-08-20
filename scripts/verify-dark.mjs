// Verify dark-mode tooltip background flips with the theme.
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

// Force dark theme the same way the app does.
await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
await page.waitForTimeout(500)

// Hover the heatmap first cell.
const cells = page.locator('rect[class*="heatLevel"]')
if (await cells.count() > 0) {
  await cells.nth(0).hover()
  await page.waitForTimeout(700)
  const heatTip = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('[role="tooltip"]')].find((t) => t.textContent?.includes('2026'))
    if (!tip) return { visible: false }
    const r = tip.getBoundingClientRect()
    return { visible: true, bg: getComputedStyle(tip).backgroundColor, color: getComputedStyle(tip).color, t: Math.round(r.top), inVp: r.top >= 0 && r.bottom <= window.innerHeight }
  })
  console.log('DARK HEAT TIP:', JSON.stringify(heatTip))
  await page.mouse.move(0, 0); await page.waitForTimeout(200)
}

// Hover the trend bar.
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
    const barTip = await page.evaluate(() => {
      const tips = [...document.querySelectorAll('[role="tooltip"]')].filter((t) => t.textContent?.trim())
      const tip = tips[0]
      if (!tip) return { visible: false }
      return { visible: true, bg: getComputedStyle(tip).backgroundColor, color: getComputedStyle(tip).color, text: tip.textContent?.trim().slice(0, 30) }
    })
    console.log('DARK BAR TIP:', JSON.stringify(barTip))
  }
}
await page.screenshot({ path: 'verify-dark.png' })
await browser.close()
