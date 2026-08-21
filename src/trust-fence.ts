/**
 * Browser-trust fence for the /usage/api routes, mirroring the official /api
 * gateway fence (dsh-client-connection `isTrustedApiRequest`). A route
 * accepts a request only when ALL of these hold:
 *
 * 1. Host fence (DNS-rebinding defense): the Host header resolves to the
 *    loopback interface, or to a trusted authority — a port-less trustedHosts
 *    entry matches its hostname on ANY port, an entry with an explicit port
 *    matches that exact host:port. Both sides compare through WHATWG URL
 *    normalization, so case and a redundant default port never decide trust.
 * 2. Cross-site fence: a browser-labeled `sec-fetch-site: cross-site`
 *    request is refused regardless of Origin.
 * 3. Origin fence: when a browser attaches an Origin it must be exactly the
 *    Host authority; the literal "null" (sandboxed iframes, file: pages) is
 *    an opaque origin and refused. Absent Origin is fine — the Host fence
 *    already bound the request.
 *
 * The fence reads the live trusted-host value per request so it tracks the
 * same trust source the /api gateway derives from (webRuntime.trustedHosts:
 * port-less LAN IP literals sampled at boot plus any --trusted-host
 * authorities). The face stays structural (no node:types) so it can live in
 * the shared declaration graph.
 */

import type { UsageHttpRequest } from './context-types.ts'

/**
 * Whether a WHATWG URL hostname names the loopback authority. The input is
 * expected in URL hostname form (IPv6 literals keep their brackets), matching
 * dsh-client-connection's loopback classification: localhost, [::1], or any
 * IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** The raw Host header value (lowercased), or null when absent. */
export function parseHostHeader(req: UsageHttpRequest): string | null {
  const header = req.headers.host
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  return value.trim().toLowerCase()
}

/** Normalized URL of a Host-header authority (hostname lowercased, default
 *  port stripped, IPv6 bracketed), or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Canonical form of a parsed trustedHosts entry: `hostname` when no port was
 * written, else `hostname:port`. The port is judged from URL parses under
 * both special schemes (their default ports differ, so `:80` and `:443`
 * still count as explicit), never from the raw string.
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  // An authority that parsed under http cannot fail under https.
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether the request authority matches a `trustedHosts` entry. An entry with
 * an explicit port matches that exact authority; a port-less entry matches
 * the hostname on any port (the shape the CLI derives for IP-literal LAN
 * serving, where the bound port may be OS-assigned).
 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** The web runtime's trusted-host source (mirror of dsh-web-app webRuntime). */
export interface TrustedHostsSource {
  trustedHosts?: string[]
}

export interface TrustFence {
  /** Accept the request when the Host is ours (loopback or trusted) and any
   *  attached browser markers are same-origin. */
  isTrusted(req: UsageHttpRequest): boolean
}

export function createTrustFence(trusted: () => string[]): TrustFence {
  return {
    isTrusted(req: UsageHttpRequest): boolean {
      // 1. Host fence, applied to every request: over plain HTTP a browser
      // attaches neither Origin nor Fetch-Metadata to reads, so an unmarked
      // request may still be a rebound browser read and Host is the one
      // header rebinding cannot forge.
      const host = parseHostHeader(req)
      if (host === null) return false
      const hostUrl = parseAuthority(host)
      if (hostUrl === undefined) return false
      if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trusted())) return false
      // 2. Cross-site fence: modern browsers label the initiator relationship
      // on every fetch; an explicit cross-site marker is refused.
      const site = req.headers['sec-fetch-site']
      if ((Array.isArray(site) ? site[0] : site) === 'cross-site') return false
      // 3. Origin fence: an attached Origin must be exactly this authority.
      // The literal "null" fails the URL parse below and is refused.
      const origin = req.headers.origin
      const originValue = Array.isArray(origin) ? origin[0] : origin
      if (originValue === undefined) return true
      try {
        return new URL(originValue).host === hostUrl.host
      } catch {
        return false
      }
    },
  }
}
