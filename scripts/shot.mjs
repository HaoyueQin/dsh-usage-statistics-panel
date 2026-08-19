// Render the DSH usage-statistics settings section with the system Edge and
// screenshot it. Click: settings trigger (bottom-left gear) -> the
// "Usage statistics" nav row -> wait for the panel -> screenshot.
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const out = process.env.USAGE_OUT ?? 'D:/Project/dsh-usage-statistics-panel/dsh-shot.png'

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

// 1. Open settings via the bottom-left gear.
const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) {
  await settings.click()
  await page.waitForTimeout(2000)
} else {
  console.log('no settings button found')
}

// 2. Click the usage statistics nav row.
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) {
  await nav.click()
  await page.waitForTimeout(3000)
} else {
  console.log('no usage-stats nav found')
}

await page.screenshot({ path: out, fullPage: true })
console.log('saved', out)
await browser.close()
