// Local backport of PR #2277 to v1.44.0: a Security-tab switch whose registry entry says a change
// LOOSENS it accepts that change only from the owner: the dashboard session, also when the browser
// sends the stored token alongside it; the bare token only before the first dashboard login exists.
// Tightening stays open to every caller. (Upstream's test of the same rule covers BASH_SANDBOX_AGENTS
// and the reset route, neither of which exists in v1.44.0.)
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? (k === 'SECURITY_COPY_GATE_MODE' ? 'block' : '0'),
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
}))
vi.mock('../db.js', async (orig) => ({ ...(await orig<typeof import('../db.js')>()), logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => {} }))

const { tryHandleSettings } = await import('../web/routes/settings.js')
const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; user?: string }
async function set(key: string, value: string, auth: Auth, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = JSON.stringify({ key, value })
  const req: any = { headers, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL('http://localhost/api/settings')
  expect(await tryHandleSettings({ req, res, path: url.pathname, method: 'POST', url, auth } as any)).toBe(true)
  return out
}
let ownerId = 0
const ownerCookie = () => `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}`

beforeAll(() => { initDatabase(':memory:') })

describe('Security switches: the shared token may tighten them, never loosen them', () => {
  beforeEach(() => {
    settings.clear()
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    // a dashboard login exists (the normal state): the bare token is not the owner
    ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  })

  it('the token may not open external Bash egress or switch the copy gate to warn; the value stays', async () => {
    const r = await set('SECURITY_BASH_EXTERNAL', '1', { kind: 'token' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect((await set('SECURITY_COPY_GATE_MODE', 'warn', { kind: 'token' })).status).toBe(403)
    expect((await set('SECURITY_BASH_EXTERNAL', '1', { kind: 'token' }, { cookie: `${SESSION_COOKIE_NAME}=not-a-session` })).status).toBe(403)
    expect(settings.has('SECURITY_BASH_EXTERNAL')).toBe(false)
    expect(settings.has('SECURITY_COPY_GATE_MODE')).toBe(false)
  })

  it('the token may tighten', async () => {
    settings.set('SECURITY_BASH_EXTERNAL', '1')
    expect((await set('SECURITY_BASH_EXTERNAL', '0', { kind: 'token' })).status).toBe(200)
    expect((await set('SECURITY_CREDENTIAL_GATE', 'block', { kind: 'token' })).status).toBe(200)
    expect(settings.get('SECURITY_BASH_EXTERNAL')).toBe('0')
  })

  it('a device key is not an owner session, whatever its scope', async () => {
    expect((await set('SECURITY_BASH_EXTERNAL', '1', { kind: 'device', scope: 'operator' })).status).toBe(403)
    expect((await set('SECURITY_BASH_EXTERNAL', '1', { kind: 'device', scope: 'full' })).status).toBe(403)
  })

  it('the owner session may loosen, also from a browser that sends the stored token with its session cookie', async () => {
    expect((await set('SECURITY_BASH_EXTERNAL', '1', { kind: 'session', user: 'owner' })).status).toBe(200)
    expect((await set('SECURITY_COPY_GATE_MODE', 'warn', { kind: 'token' }, { cookie: ownerCookie() })).status).toBe(200)
  })

  it('before the first dashboard login exists, the token is the one credential there is: it may loosen', async () => {
    getDb().exec('DELETE FROM dashboard_users')
    expect((await set('SECURITY_BASH_EXTERNAL', '1', { kind: 'token' })).status).toBe(200)
  })
})
