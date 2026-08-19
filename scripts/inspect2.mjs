// Verify the donut, model list, and footer are actually within the viewport
// and visible (geometric evidence, no vision needed).
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

const result = await page.evaluate(() => {
  const out = { donutVisible: false, donutBox: null, modelListRows: [], footer: null, sectionTitles: [], heatCells: 0, barRects: 0 }
  const svgs = [...document.querySelectorAll('svg')]
  for (const s of svgs) {
    const c = s.querySelector('circle[stroke-dasharray]')
    if (c) {
      const r = c.getBoundingClientRect()
      out.donutVisible = r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0
      out.donutBox = { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), stroke: getComputedStyle(c).stroke }
      break
    }
  }
  out.modelListRows = [...document.querySelectorAll('[class*="modelRow"]')].map((r) => r.textContent?.trim().slice(0, 60))
  const foot = [...document.querySelectorAll('*')].find((el) => el.textContent?.trim().startsWith('统计截至') || el.textContent?.trim().startsWith('As of'))
  if (foot) out.footer = foot.textContent?.trim()
  out.sectionTitles = [...document.querySelectorAll('h3')].map((h) => h.textContent?.trim())
  out.heatCells = document.querySelectorAll('rect[class*="heatLevel"]').length
  out.barRects = document.querySelectorAll('rect[class*="bar"]').length
  return out
})
console.log(JSON.stringify(result, null, 2))
await browser.close()
