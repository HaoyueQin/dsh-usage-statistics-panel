// Screenshot the trend chart while hovering a bar, to SEE whether the bars
// vanish on hover (root-cause via vision).
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const out = 'D:/Project/dsh-usage-statistics-panel/dsh-hover.png'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2000) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3000) }

// Scroll the trend chart into view and hover the data-day bar.
const hit = page.locator('rect[class*="barHit"]')
const idx = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('rect[class*="barHit"]')]
  return hs.findIndex((h) => {
    const g = h.closest('g')
    return g && [...g.querySelectorAll('rect')].some((r) => r !== h && Number(r.getAttribute('height') || 0) > 0)
  })
})
console.log('data barHit idx:', idx)
if (idx >= 0) {
  await hit.nth(idx).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  // screenshot BEFORE hover
  await page.screenshot({ path: 'D:/Project/dsh-usage-statistics-panel/dsh-before.png' })
  await hit.nth(idx).hover()
  await page.waitForTimeout(600)
  await page.screenshot({ path: out })
  console.log('saved hover shot')
}
await browser.close()
