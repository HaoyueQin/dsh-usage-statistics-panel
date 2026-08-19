// Precise geometric check: hover the data bar, then measure EVERY bar rect's
// bounding box and transform. If bars vanish, their boxes will be 0/off-screen.
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2000) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3000) }

const before = await page.evaluate(() => {
  return [...document.querySelectorAll('rect[class*="barHit"]')].map((h) => {
    const g = h.closest('g')
    if (!g) return null
    const bars = [...g.querySelectorAll('rect')].filter((r) => r !== h)
    return bars.map((b) => {
      const r = b.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), tf: getComputedStyle(b).transform }
    })
  }).filter(Boolean)
})
const nBars = before.reduce((s, g) => s + g.length, 0)
const visibleBefore = before.flat().filter((b) => b.w > 0 && b.h > 0).length
console.log('BEFORE hover — bar groups:', before.length, 'total bars:', nBars, 'visible:', visibleBefore)

// hover the data bar
const hit = page.locator('rect[class*="barHit"]')
const idx = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('rect[class*="barHit"]')]
  return hs.findIndex((h) => {
    const g = h.closest('g')
    return g && [...g.querySelectorAll('rect')].some((r) => r !== h && Number(r.getAttribute('height') || 0) > 0)
  })
})
await hit.nth(idx).scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await hit.nth(idx).hover()
await page.waitForTimeout(700)

const after = await page.evaluate(() => {
  return [...document.querySelectorAll('rect[class*="barHit"]')].map((h) => {
    const g = h.closest('g')
    if (!g) return null
    const bars = [...g.querySelectorAll('rect')].filter((r) => r !== h)
    return bars.map((b) => {
      const r = b.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), tf: getComputedStyle(b).transform }
    })
  }).filter(Boolean)
})
const nBarsA = after.reduce((s, g) => s + g.length, 0)
const visibleAfter = after.flat().filter((b) => b.w > 0 && b.h > 0).length
console.log('AFTER hover — bar groups:', after.length, 'total bars:', nBarsA, 'visible:', visibleAfter)

// the hovered group specifically
const hov = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('rect[class*="barHit"]')]
  const h = hs.find((x) => x.matches(':hover')) ?? hs[0]
  const g = h.closest('g')
  if (!g) return null
  return [...g.querySelectorAll('rect')].map((b) => {
    const r = b.getBoundingClientRect()
    return { cls: b.getAttribute('class'), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), tf: getComputedStyle(b).transform, fill: getComputedStyle(b).fill }
  })
})
console.log('HOVERED group bars:', JSON.stringify(hov, null, 2))
await browser.close()
