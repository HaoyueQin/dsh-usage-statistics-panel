/**
 * Trust-fence tests — the /usage/api fence must match the official /api
 * gateway semantics (dsh-client-connection isTrustedApiRequest): Host fence
 * (loopback or trusted authority, port-aware entry matching), the
 * sec-fetch-site cross-site refusal, and the same-origin Origin check.
 */
import { describe, expect, it } from 'vitest'
import { createTrustFence, isLoopbackHostname, parseHostHeader } from '../src/trust-fence.ts'
import type { UsageHttpRequest } from '../src/context-types.ts'

function reqOf(headers: Record<string, string>): UsageHttpRequest {
  return { headers } as unknown as UsageHttpRequest
}

describe('isLoopbackHostname', () => {
  it('accepts localhost, bracketed IPv6 loopback, and the whole 127/8 range', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.15.9')).toBe(true)
  })

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHostname('192.168.1.5')).toBe(false)
    expect(isLoopbackHostname('evil.example')).toBe(false)
    expect(isLoopbackHostname('127.1')).toBe(false) // not four dotted parts
  })
})

describe('parseHostHeader', () => {
  it('lowercases and returns the raw authority', () => {
    expect(parseHostHeader(reqOf({ host: 'LocalHost:3080' }))).toBe('localhost:3080')
    expect(parseHostHeader(reqOf({}))).toBeNull()
  })
})

describe('createTrustFence', () => {
  const fence = createTrustFence(() => ['192.168.1.5', 'myhost.example:3080'])

  it('accepts a loopback Host with port', () => {
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: 'localhost:3080' }))).toBe(true)
  })

  it('matches a port-less trusted entry on any port', () => {
    expect(fence.isTrusted(reqOf({ host: '192.168.1.5:3000' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: '192.168.1.5' }))).toBe(true)
  })

  it('matches a port-bearing trusted entry only on that exact port', () => {
    expect(fence.isTrusted(reqOf({ host: 'myhost.example:3080' }))).toBe(true)
    // The old fence stripped the request port and never matched this shape.
    expect(fence.isTrusted(reqOf({ host: 'myhost.example:9999' }))).toBe(false)
  })

  it('refuses a missing or unparsable Host and unknown hosts', () => {
    expect(fence.isTrusted(reqOf({}))).toBe(false)
    expect(fence.isTrusted(reqOf({ host: ':::' }))).toBe(false)
    expect(fence.isTrusted(reqOf({ host: 'attacker.example' }))).toBe(false)
  })

  it('refuses an explicit cross-site fetch even from a loopback Host', () => {
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    // Same-site and absent markers stay fine.
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  it('requires an attached Origin to be same-origin with the Host', () => {
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', origin: 'http://attacker.example' }))).toBe(false)
    // The opaque origin "null" (sandboxed iframe / file:) is refused.
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', origin: 'null' }))).toBe(false)
  })
})
