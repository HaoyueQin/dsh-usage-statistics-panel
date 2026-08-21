import { chromium } from 'playwright-core'
const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)
const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2500) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(5000) }
const b30 = page.locator('button', { hasText: '最近 30 天' }).first()
if (await b30.count()) { await b30.click(); await page.waitForTimeout(2500) }
const cards = await page.evaluate(() => {
  const out = []
  // Each stat card is a div whose first child head holds the label span.
  for (const el of document.querySelectorAll('div')) {
    const label = el.querySelector(':scope > div > span')?.textContent?.trim()
    const value = el.querySelector(':scope > div:nth-child(2)')?.textContent?.trim()
    if (label && value !== undefined && value !== '' && el.className.includes('card')) {
      out.push(`${label} = ${value}`)
    }
  }
  return out
})
console.log('CARDS:', JSON.stringify(cards, null, 0))
await browser.close()
