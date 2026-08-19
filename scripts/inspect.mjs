// Inspect the usage-stats panel DOM state: donut circle stroke/visibility,
// heatmap cell fill, and any console errors.
import { chromium } from 'playwright-core'

const url = process.env.USAGE_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
page.on('pageerror', (e) => errors.push('PAGEERR: ' + String(e).slice(0, 300)))
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2000) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3000) }

const info = await page.evaluate(() => {
  const out = { donut: null, heat: null, chartVars: null, panelVars: null, modelCount: 0, donutSvg: null }
  const donut = document.querySelector('svg[aria-label*="模型用量"], svg[role="img"]') 
  // find the donut svg: it contains a <circle> with stroke
  const svgs = [...document.querySelectorAll('svg')]
  for (const s of svgs) {
    const c = s.querySelector('circle[stroke-dasharray]')
    if (c) {
      out.donut = {
        stroke: getComputedStyle(c).stroke,
        strokeDasharray: c.getAttribute('stroke-dasharray'),
        r: c.getAttribute('r'),
        visible: !!(c.getBoundingClientRect().width && c.getBoundingClientRect().height),
        rect: { w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) },
      }
      out.donutSvg = { w: s.getAttribute('width'), h: s.getAttribute('height'), vb: s.getAttribute('viewBox') }
      break
    }
  }
  const heat = document.querySelector('rect[class*="heat"]')
  if (heat) out.heat = { fill: getComputedStyle(heat).fill, cls: heat.getAttribute('class') }
  const panel = document.querySelector('[class*="panel"]')
  if (panel) {
    const cs = getComputedStyle(panel)
    out.panelVars = {
      heat1: cs.getPropertyValue('--dsw-heat-1').trim(),
      chart1: cs.getPropertyValue('--dsw-chart-1').trim(),
    }
  }
  // count model rows
  out.modelCount = document.querySelectorAll('[class*="modelRow"]').length
  return out
})
console.log(JSON.stringify({ info, errors }, null, 2))
await browser.close()
