/**
 * Browser-trust fence for the /usage/api routes, mirroring better-sidebar's
 * trust-fence (src/trust-fence.ts). A route accepts a request when the Host
 * header resolves to the loopback interface, or when the Host is in the web
 * runtime's `trustedHosts` list (LAN IP literals sampled at boot plus any
 * --trusted-host authorities). The fence reads the live trusted-host value
 * per request so it tracks the same trust source the /api gateway derives
 * from.
 *
 * The face stays structural (no node:types) so it can live in the shared
 * declaration graph.
 */

import type { UsageHttpRequest } from './context-types.ts'

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
  )
}

export function parseHostHeader(req: UsageHttpRequest): string | null {
  const header = req.headers.host
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  // Strip an optional port (host:port / [v6]:port).
  const cleaned = value.trim().toLowerCase()
  const v6 = /^\[([^\]]+)\]/.exec(cleaned)
  if (v6) return v6[1]!.toLowerCase()
  return cleaned.split(':')[0]!.toLowerCase()
}

/** The web runtime's trusted-host source (mirror of dsh-web-app webRuntime). */
export interface TrustedHostsSource {
  trustedHosts?: string[]
}

export interface TrustFence {
  /** Accept the request when the Host header is loopback or trusted. */
  isTrusted(req: UsageHttpRequest): boolean
}

export function createTrustFence(trusted: () => string[]): TrustFence {
  const trustedSet = (): Set<string> => new Set(trusted().map((h) => h.toLowerCase()))
  return {
    isTrusted(req: UsageHttpRequest): boolean {
      const host = parseHostHeader(req)
      if (!host) return false
      if (isLoopbackHostname(host)) return true
      return trustedSet().has(host)
    },
  }
}
