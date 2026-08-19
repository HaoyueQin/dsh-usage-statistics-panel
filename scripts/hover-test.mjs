// Hover a heatmap cell and a trend bar, then report whether a tooltip
// rendered and its position — root-cause the missing hover feedback.
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

// 1. Hover a heatmap cell (the one with data, level5).
const cells = page.locator('rect[class*="heatLevel"]')
const n = await cells.count()
console.log('heat cells:', n)
if (n > 0) {
  // find the cell with a non-empty fill (has data) by evaluating fill
  const withData = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('rect[class*="heatLevel"]')]
    const idx = rects.findIndex((r) => getComputedStyle(r).fill !== 'rgb(235, 237, 240)' && getComputedStyle(r).fill !== 'rgb(33, 38, 45)')
    return idx
  })
  if (withData >= 0) {
    await cells.nth(withData).hover()
    await page.waitForTimeout(600)
    const tip = await page.evaluate(() => {
      const t = [...document.querySelectorAll('*')].find((el) => {
        const c = getComputedStyle(el)
        return c.position === 'absolute' && el.textContent?.includes('Tokens') && el.textContent?.includes('2026-')
      })
      if (!t) return null
      const r = t.getBoundingClientRect()
      return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), text: t.textContent?.trim().slice(0, 60) }
    })
    console.log('heat tip:', JSON.stringify(tip))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
  }
}

// 2. Hover a trend bar (the data day).
const bars = page.locator('rect[class*="barHit"]')
const bn = await bars.count()
console.log('barHit overlays:', bn)
if (bn > 0) {
  const withBar = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('rect[class*="barHit"]')]
    // find one whose sibling bar has a height
    return hit.findIndex((h) => {
      const g = h.closest('g')
      const bars = g ? [...g.querySelectorAll('rect')].filter((r) => r.getAttribute('height') !== '0' && r !== h) : []
      return bars.length > 0
    })
  })
  if (withBar >= 0) {
    await bars.nth(withBar).hover()
    await page.waitForTimeout(600)
    const state = await page.evaluate(() => {
      // did any bar change transform/width?
      const hit = [...document.querySelectorAll('rect[class*="barHit"]')]
      const g = hit.find((h) => {
        const c = getComputedStyle(h)
        return c.opacity !== '0'
      })?.closest('g')
      const barsInG = g ? [...g.querySelectorAll('rect')].filter((r) => r !== g.querySelector('rect[class*="barHit"]')) : []
      const barState = barsInG.map((b) => {
        const r = b.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), transform: getComputedStyle(b).transform }
      })
      const tip = [...document.querySelectorAll('.tip, [class*="tip"]')].filter((el) => getComputedStyle(el).position !== 'static' && el.textContent?.trim())
      return { barState, tipCount: tip.length, tipTexts: tip.map((t) => t.textContent?.trim().slice(0, 50)) }
    })
    console.log('trend hover state:', JSON.stringify(state))
  }
}
await browser.close()
