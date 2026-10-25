import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_EGRESS_DENY, LEGACY_BASH_EGRESS_DENY, bashExternalOpen, mergeBashEgressDeny } from '../web/agent-scaffold.js'
// @ts-expect-error -- plain .mjs hook, no type declarations
import { loadExternalOpen } from '../../scripts/hooks/bash-egress-parser.mjs'

function cfg(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bash-external-open-'))
  const p = join(dir, 'egress-vendor-hosts.json')
  writeFileSync(p, body)
  return p
}

describe('bash_external switch (local carry)', () => {
  it('is closed when the file is missing, malformed or carries another value', () => {
    expect(bashExternalOpen('/nonexistent/egress-vendor-hosts.json')).toBe(false)
    expect(bashExternalOpen(cfg('{not json'))).toBe(false)
    expect(bashExternalOpen(cfg('{"bash_external": true}'))).toBe(false)
    expect(bashExternalOpen(cfg('{"domains": ["safenet.hu"]}'))).toBe(false)
    expect(loadExternalOpen('/nonexistent/egress-vendor-hosts.json')).toBe(false)
    expect(loadExternalOpen(cfg('{"bash_external": "OPEN"}'))).toBe(false)
  })

  it('opens only on the exact string, in both layers', () => {
    const p = cfg('{"domains": ["safenet.hu"], "bash_external": "open"}')
    expect(bashExternalOpen(p)).toBe(true)
    expect(loadExternalOpen(p)).toBe(true)
  })

  // Since v1.45.0 the curl-https / wget rules are upstream's LEGACY_BASH_EGRESS_DENY, lifted when
  // bashEgressHostAllowEnabled() is true -- which the carry makes true when bash_external is open.
  it('the always-on egress list holds no curl/wget rule, nc / ncat / telnet stay denied', () => {
    expect(BASH_EGRESS_DENY.some((r: string) => r.includes('curl') || r.includes('wget'))).toBe(false)
    for (const kept of ['Bash(nc *)', 'Bash(*/nc *)', 'Bash(ncat *)', 'Bash(*/ncat *)', 'Bash(telnet *)', 'Bash(*/telnet *)']) {
      expect(BASH_EGRESS_DENY).toContain(kept)
    }
  })

  it('a parser-covered merge removes the legacy curl/wget rules and keeps the rest', () => {
    const settings: Record<string, unknown> = { permissions: { deny: [...LEGACY_BASH_EGRESS_DENY] } }
    mergeBashEgressDeny(settings, true, [...BASH_EGRESS_DENY])
    const deny = (settings.permissions as { deny: string[] }).deny
    expect(deny.some((r) => r.includes('curl') || r.includes('wget'))).toBe(false)
    expect(deny).toContain('Bash(nc *)')
  })
})
