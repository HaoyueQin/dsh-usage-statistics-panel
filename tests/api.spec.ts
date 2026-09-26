/**
 * The usage API client must address its route DOCUMENT-RELATIVE, never
 * root-absolute. dsh serves the shell index with `<base href="./">`
 * (packages/host/frontend-static, from 0.1.7 on; it was `<base href="/">`
 * through 0.1.6), so `usage/api/...` resolves under whatever mount served the
 * page while `/usage/api/...` only works at the origin root and 404s behind a
 * prefix-stripping proxy. The host's own route key stays absolute
 * (`src/routes.ts`), because only the browser half is relative.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRange, UsageApiError } from '../src/client/api.ts'

/** A Response stand-in: the client only ever reads `.json()`. */
function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response
}

afterEach(() => { vi.unstubAllGlobals() })

describe('usage api request path', () => {
  it('addresses the route document-relative, never root-absolute', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      return Promise.resolve(jsonResponse({ ok: true, value: {} }))
    })
    await fetchRange({ range: '30' })
    expect(urls).toEqual(['usage/api/range'])
    // A leading slash would escape the document base and the mount.
    expect(urls[0]!.startsWith('/')).toBe(false)
  })

  it('surfaces the wire error code instead of a bare network failure', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(
      jsonResponse({ ok: false, error: { code: 'bad_range', message: 'unsupported range' } }),
    ))
    await expect(fetchRange({ range: '30' })).rejects.toMatchObject({
      code: 'bad_range',
      message: 'unsupported range',
    })
  })

  it('wraps a transport failure as a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('boom')))
    const err = await fetchRange({ range: '30' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UsageApiError)
    expect((err as UsageApiError).code).toBe('network')
  })
})
