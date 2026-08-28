/**
 * Locale dictionary consistency. The dictionaries are typed as
 * `Record<UsageStatsKey, string>`, so tsc already pins the key sets at
 * compile time — but vitest transpiles WITHOUT type checking, and a future
 * `as` cast or Record<string, string> widening would silently ship a dict
 * that renders raw key names. These guards also catch the subtler drift the
 * compiler cannot see: a {placeholder} present in one language but missing
 * in another makes the runtime substitution drop or misrender that value.
 */
import { describe, expect, it } from 'vitest'
import { en, zh, zhTW, LOCALE_NS, type UsageStatsKey } from '../src/client/locales.ts'

const DICTS: Array<[string, Record<UsageStatsKey, string>]> = [
  ['en', en],
  ['zh', zh],
  ['zh-TW', zhTW],
]

/** The {param} tokens a template substitutes, sorted for stable comparison. */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
}

describe('locale dictionaries', () => {
  it('share one namespace constant', () => {
    expect(LOCALE_NS).toBe('usageStats')
  })

  it('cover exactly the same key set in every language', () => {
    const enKeys = Object.keys(en).sort()
    expect(enKeys.length).toBeGreaterThan(0)
    for (const [name, dict] of DICTS) {
      expect(Object.keys(dict).sort(), name).toEqual(enKeys)
    }
  })

  it('carry identical {placeholder} sets per key in every language', () => {
    for (const key of Object.keys(en) as UsageStatsKey[]) {
      const expected = placeholdersOf(en[key]!)
      for (const [name, dict] of DICTS) {
        expect(placeholdersOf(dict[key]!), `${name}:${key}`).toEqual(expected)
      }
    }
  })

  it('never leave a dictionary entry empty', () => {
    for (const [name, dict] of DICTS) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim().length, `${name}:${key}`).toBeGreaterThan(0)
      }
    }
  })
})
