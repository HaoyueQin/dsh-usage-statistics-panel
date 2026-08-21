// Verify the per-model section layout in the real DSH web UI:
// 1. Donut renders at the reduced 200px size with the ring inside bounds.
// 2. Each list row is two-line: [name / provider] left, [tokens / share]
//    right; the name carries no provider prefix.
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)

const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2500) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3500) } else {
  console.log('FATAL: usage stats nav not found'); await browser.close(); process.exit(1)
}

const results = {}

// ── 1. Donut geometry ──────────────────────────────────────────────────────
results.donut = await page.evaluate(() => {
  // The svg itself carries no module class (.donut has no CSS rule); anchor
  // on the wrapper instead.
  const svg = document.querySelector('[class*="donutWrap"] svg')
  if (!svg) return { ok: false, reason: 'no donut svg' }
  const rect = svg.getBoundingClientRect()
  return {
    ok: Math.round(rect.width) === 200 && Math.round(rect.height) === 200,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    viewBox: svg.getAttribute('viewBox'),
  }
})

// ── 2. Row anatomy ────────────────────────────────────────────────────────
results.rows = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('li[class*="modelRow"]')]
  if (rows.length === 0) return { ok: false, reason: 'no model rows' }
  const detail = rows.slice(0, 3).map((row) => {
    const id = row.querySelector('[class*="modelId"]')
    const values = row.querySelector('[class*="modelValues"]')
    const name = row.querySelector('[class*="modelName"]')?.textContent?.trim() ?? ''
    const provider = row.querySelector('[class*="modelProvider"]')?.textContent?.trim() ?? ''
    const tokens = row.querySelector('[class*="modelTokens"]')?.textContent?.trim() ?? ''
    const pct = row.querySelector('[class*="modelPct"]')?.textContent?.trim() ?? ''
    const idRect = id?.getBoundingClientRect()
    const valRect = values?.getBoundingClientRect()
    const nameEl = row.querySelector('[class*="modelName"]')
    const provEl = row.querySelector('[class*="modelProvider"]')
    const stackedLeft = nameEl && provEl ? provEl.getBoundingClientRect().top > nameEl.getBoundingClientRect().top : null
    const tokEl = row.querySelector('[class*="modelTokens"]')
    const pctEl = row.querySelector('[class*="modelPct"]')
    const stackedRight = tokEl && pctEl ? pctEl.getBoundingClientRect().top > tokEl.getBoundingClientRect().top : null
    // Values block hugs the row's right padding edge (12px padding + 1px border).
    const rightAligned = idRect && valRect ? valRect.right <= row.getBoundingClientRect().right - 8 && valRect.right >= row.getBoundingClientRect().right - 20 : null
    return { name, provider, tokens, pct, stackedLeft, stackedRight, rightAligned }
  })
  const allOk = detail.every((d) => d.stackedLeft === true && d.stackedRight === true && d.rightAligned === true)
  return { ok: allOk, sample: detail }
})

// Name must not carry a "provider/" prefix.
results.noPrefix = results.rows?.ok
  ? results.rows.sample.every((d) => !d.name.includes('/'))
  : false

await page.screenshot({ path: 'scripts/models-section.png', clip: (await page.locator('section', { hasText: '模型用量' }).first().boundingBox()) ?? undefined })

console.log(JSON.stringify(results, null, 2))
await browser.close()
