// Verify the per-model and per-provider sections in the real DSH web UI:
// 1. Each section draws a flat stacked column: every segment is a focusable
//    rect with its own rank colour and aria-label, with the range total and
//    its caption above the column.
// 2. The rise-in completed: the segment heights fill the column body, and
//    every non-zero segment clears the 4px floor (a real tail rank can hold
//    0.4% of the volume, i.e. ~2px of body without the floor).
// 3. The list beside it is two-line: [name / provider] left, [tokens / share]
//    right; model names carry no provider prefix.
// 4. Expansion never moves the column: every twisty in a section is clicked
//    with the column height sampled through the accordion's animation.
// 5. The provider section expands in two levels and each level shows the right
//    thing — Other opens PROVIDERS (rows that carry a model count), a ranked
//    provider opens the models it served, and a folded provider opens ITS
//    models. Every level's rows must add up to the tokens of the row that
//    opened them.
//
// The URL: USAGE_URL wins; otherwise the desktop shell's launch URL is used
// (a `dsh web` started with a token only accepts that URL carrying it).
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

function resolveUrl() {
  if (process.env.USAGE_URL) return process.env.USAGE_URL
  try {
    const log = readFileSync(`${process.env.APPDATA}\\deepseek-harness-desktop\\logs\\main.log`, 'utf8')
    const hits = [...log.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/g)]
    if (hits.length > 0) {
      console.log('using the desktop shell launch URL (token redacted)')
      return hits[hits.length - 1][0]
    }
  } catch { /* fall through to the default */ }
  return 'http://127.0.0.1:8090/'
}

const url = resolveUrl()
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)

const settings = page.locator('button', { hasText: '设置' }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(2500) }
const nav = page.locator('nav button', { hasText: '使用统计' }).first()
if (await nav.count()) { await nav.click(); await page.waitForTimeout(3500) } else {
  console.log('FATAL: usage stats nav not found'); await browser.close(); process.exit(1)
}

/** Scroll the section into view (which starts the rise-in) and read it back. */
async function readSection(heading, shot) {
  const section = page.locator('section', { hasText: heading }).first()
  if (await section.count() === 0) return { ok: false, reason: 'section missing' }
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1800)
  if (shot !== undefined) {
    const box = await section.boundingBox()
    if (box !== null) await page.screenshot({ path: shot, clip: box })
  }
  return page.evaluate((text) => {
    const sec = [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h3')?.textContent?.includes(text))
    if (sec === undefined) return { ok: false, reason: 'section missing' }
    const svg = sec.querySelector('svg[role="group"]')
    if (svg === null) return { ok: false, reason: 'no chart svg' }
    const segs = [...svg.querySelectorAll('[role="img"]')]
    const heights = segs.map((el) => el.getBoundingClientRect().height)
    const round = (n) => Math.round(n * 10) / 10
    const rows = [...sec.querySelectorAll('ul[class*="modelList"] > li[class*="modelRow"]')]
      .map((row) => ({
        name: row.querySelector('[class*="modelName"]')?.textContent?.trim() ?? '',
        sub: row.querySelector('[class*="modelProvider"]')?.textContent?.trim() ?? '',
        tokens: row.querySelector('[class*="modelTokens"]')?.textContent?.trim() ?? '',
        share: row.querySelector('[class*="modelPct"]')?.textContent?.trim() ?? '',
      }))
    return {
      ok: true,
      ariaLabel: svg.getAttribute('aria-label'),
      // The column fills its box: no total/caption strip is reserved.
      bodyHeight: round(svg.getBoundingClientRect().height),
      segmentCount: segs.length,
      baseShape: segs[0]?.tagName.toLowerCase() ?? null,
      rowCount: rows.length,
      // Every segment must clear the floor (the base path overshoots by the
      // cap radius, so it is measured above the floor like the rest).
      minSegment: round(Math.min(...heights)),
      colors: segs.map((el) => el.getAttribute('fill')),
      labels: segs.map((el) => el.getAttribute('aria-label')),
      sampleRows: rows.slice(0, 3),
    }
  }, heading)
}

/** Every twisty in the section, clicked in turn (which leaves each row open, so
 *  the run also proves that several open rows coexist), with the column height
 *  sampled through the accordion's animation at every step. The column is sized
 *  from the list's top-level ROWS, so no expansion may move it by a pixel. */
async function checkExpandKeepsHeight(heading) {
  const section = page.locator('section', { hasText: heading }).first()
  if (await section.count() === 0) return { ok: false, reason: 'section missing' }
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1600)
  const svg = section.locator('svg[role="group"]').first()
  const read = async () => Number(await svg.getAttribute('height'))
  const base = await read()
  const toggles = section.locator('button[aria-expanded]')
  const count = await toggles.count()
  const heights = []
  for (let i = 0; i < count; i += 1) {
    await toggles.nth(i).click()
    for (let k = 0; k < 6; k += 1) {
      heights.push(await read())
      await page.waitForTimeout(60)
    }
  }
  return {
    ok: count > 0 && heights.every((h) => h === base),
    base,
    toggles: count,
    distinct: [...new Set(heights)],
  }
}

/** One section read as a nested tree: each row carries its own twisty state and
 *  the rows its (mounted, possibly collapsed) detail list holds. */
function readTree(heading) {
  return page.evaluate((text) => {
    const sec = [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h3')?.textContent?.includes(text))
    if (sec === undefined) return null
    const svg = sec.querySelector('svg[role="group"]')
    const topList = sec.querySelector('ul[class*="modelList"]')
    if (topList === null) return null
    // Direct children only: a nested detail list lives one level deeper.
    const directRows = (ul) => [...ul.children].filter((el) => el.className.includes('modelRow'))
    const detailListOf = (row) => {
      const wrap = row.nextElementSibling
      return wrap === null ? null : wrap.querySelector('ul[class*="modelOtherList"]')
    }
    const readRow = (el) => {
      const detail = detailListOf(el)
      return {
        name: el.querySelector('[class*="modelName"]')?.textContent?.trim() ?? '',
        sub: el.querySelector('[class*="modelProvider"]')?.textContent?.trim() ?? '',
        tokens: Number((el.querySelector('[class*="modelTokens"]')?.textContent ?? '').replace(/[^0-9]/g, '')),
        expanded: el.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
        indent: Number.parseFloat(getComputedStyle(el).paddingLeft) || 0,
        children: detail === null ? [] : directRows(detail).map(readRow),
      }
    }
    return {
      height: svg === null ? null : Number(svg.getAttribute('height')),
      rows: directRows(topList).map(readRow),
    }
  }, heading)
}

/** Click one row's twisty inside a section, addressed by its name line. Any
 *  level: a provider folded into Other lives inside that row's detail list. */
function clickRow(heading, name) {
  return page.evaluate(([text, wanted]) => {
    const sec = [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h3')?.textContent?.includes(text))
    if (sec === undefined) return false
    const row = [...sec.querySelectorAll('li[class*="modelRow"]')]
      .find((el) => el.querySelector('[class*="modelName"]')?.textContent?.trim() === wanted)
    if (row === undefined) return false
    row.querySelector('button[aria-expanded]')?.click()
    return true
  }, [heading, name])
}

/** Fold every open row in a section — at both levels — so an expansion check
 *  starts from the collapsed state. DOM clicks: a toggle inside a collapsed
 *  wrapper is 0px tall and fails Playwright's actionability check. */
async function collapseAll(heading) {
  await page.evaluate((text) => {
    const sec = [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h3')?.textContent?.includes(text))
    if (sec === undefined) return
    sec.querySelectorAll('button[aria-expanded="true"]').forEach((button) => { button.click() })
  }, heading)
  await page.waitForTimeout(500)
}

const sumTokens = (rows) => rows.reduce((total, row) => total + row.tokens, 0)

/** The provider section's two-level expansion, checked against the rows that
 *  opened it: Other opens PROVIDERS (every child row carries a model count and
 *  is not a model), a ranked provider opens the models it served, and a folded
 *  provider opens its own models. Each level must add up to its parent's
 *  tokens, and the column must not move. */
async function checkProviderExpansion(shot) {
  const section = page.locator('section', { hasText: '各供应商用量' }).first()
  if (await section.count() === 0) return { ok: false, reason: 'section missing' }
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1600)
  // The height check runs first and leaves every row open; start folded so the
  // twisty states below are read from the collapsed baseline.
  await collapseAll('各供应商用量')

  const base = await readTree('各供应商用量')
  if (base === null) return { ok: false, reason: 'provider list missing' }
  // The Other bucket is always the last row; a ranked provider is any row
  // before it that serves at least one model.
  const other = base.rows[base.rows.length - 1]
  if (other === undefined || other.children.length === 0) {
    return { ok: true, skipped: 'no Other bucket' }
  }
  const ranked = base.rows.find((row) => row.name !== other.name && row.children.length > 0)
  if (ranked === undefined) return { ok: false, reason: 'no ranked provider with models' }

  const report = {
    ok: true,
    baseHeight: base.height,
    collapsedAll: base.rows.every((row) => row.expanded === 'false'),
    rowCount: base.rows.length,
  }
  report.ok = report.collapsedAll

  // ── level 1a: a ranked provider opens the models it served ───────────────
  await clickRow('各供应商用量', ranked.name)
  await page.waitForTimeout(400)
  const afterRanked = await readTree('各供应商用量')
  const rankedRow = afterRanked.rows.find((row) => row.name === ranked.name)
  report.ranked = {
    name: ranked.name,
    expanded: rankedRow?.expanded,
    indent: rankedRow?.indent,
    childrenIndent: rankedRow?.children.map((child) => child.indent) ?? [],
    children: rankedRow?.children.map((child) => child.name) ?? [],
    // A model row never carries an "N models" subtitle; a provider row always does.
    childrenAreModels: rankedRow?.children.every((child) => child.sub === '') ?? false,
    // One level in: every child indents past the row that opened it.
    childrenIndentDeeper: rankedRow !== undefined
      && rankedRow.children.every((child) => child.indent > rankedRow.indent),
    tokensMatch: rankedRow !== undefined && sumTokens(rankedRow.children) === rankedRow.tokens,
  }

  // ── level 1b: Other opens the providers it folded, never their models ────
  await clickRow('各供应商用量', other.name)
  await page.waitForTimeout(400)
  const afterOther = await readTree('各供应商用量')
  const otherRow = afterOther.rows.find((row) => row.name === other.name)
  report.other = {
    name: other.name,
    expanded: otherRow?.expanded,
    indent: otherRow?.indent,
    childrenIndent: otherRow?.children.map((child) => child.indent) ?? [],
    children: otherRow?.children.map((child) => child.name) ?? [],
    // Every child is a PROVIDER: it carries a model count and its own twisty.
    childrenCarryModelCount: otherRow?.children.every((child) => child.sub.length > 0) ?? false,
    childrenHaveTwisty: otherRow?.children.every((child) => child.expanded !== null) ?? false,
    childrenStartFolded: otherRow?.children.every((child) => child.expanded === 'false') ?? false,
    childrenIndentDeeper: otherRow !== undefined
      && otherRow.children.every((child) => child.indent > otherRow.indent),
    tokensMatch: otherRow !== undefined && sumTokens(otherRow.children) === otherRow.tokens,
  }

  // ── level 2: a folded provider opens its own models ─────────────────────
  const foldedName = otherRow?.children.find((child) => child.children.length > 0)?.name
  if (foldedName !== undefined) {
    await clickRow('各供应商用量', foldedName)
    await page.waitForTimeout(400)
    const afterFolded = await readTree('各供应商用量')
    const foldedRow = afterFolded.rows
      .find((row) => row.name === other.name)?.children
      .find((child) => child.name === foldedName)
    report.folded = {
      name: foldedName,
      expanded: foldedRow?.expanded,
      indent: foldedRow?.indent,
      childrenIndent: foldedRow?.children.map((child) => child.indent) ?? [],
      children: foldedRow?.children.map((child) => child.name) ?? [],
      childrenAreModels: foldedRow?.children.every((child) => child.sub === '') ?? false,
      // Two levels in: these rows indent past the folded provider that opened them.
      childrenIndentDeeper: foldedRow !== undefined
        && foldedRow.children.every((child) => child.indent > foldedRow.indent),
      tokensMatch: foldedRow !== undefined && sumTokens(foldedRow.children) === foldedRow.tokens,
    }
  }

  report.heightStable = afterRanked.height === base.height && afterOther.height === base.height
  report.ok = report.ok
    && report.ranked.expanded === 'true' && report.ranked.childrenAreModels
    && report.ranked.childrenIndentDeeper && report.ranked.tokensMatch
    && report.other.expanded === 'true' && report.other.childrenCarryModelCount
    && report.other.childrenHaveTwisty && report.other.childrenStartFolded
    && report.other.childrenIndentDeeper && report.other.tokensMatch
    && (report.folded === undefined || (report.folded.expanded === 'true'
      && report.folded.childrenAreModels && report.folded.childrenIndentDeeper && report.folded.tokensMatch))
    && report.heightStable

  if (shot !== undefined) {
    const box = await section.boundingBox()
    if (box !== null) await page.screenshot({ path: shot, clip: box })
  }
  return report
}

const results = {
  model: await readSection('模型用量', 'scripts/models-section.png'),
  provider: await readSection('各供应商用量', 'scripts/provider-section.png'),
  expandKeepsHeight: {
    model: await checkExpandKeepsHeight('模型用量'),
    provider: await checkExpandKeepsHeight('各供应商用量'),
  },
  providerExpansion: await checkProviderExpansion('scripts/provider-expanded-section.png'),
}

// Every model name must be bare (no "provider/" prefix) and every provider row
// must list how many models it served.
results.modelNamesBare = results.model.ok === true
  && results.model.sampleRows.every((r) => !r.name.includes('/'))
results.providerRowsCarryModelCount = results.provider.ok === true
  && results.provider.sampleRows.every((r) => r.sub.length > 0)
results.segmentsMatchRows = results.model.ok === true
  && results.model.segmentCount === results.model.rowCount

console.log(JSON.stringify(results, null, 2))
await browser.close()
