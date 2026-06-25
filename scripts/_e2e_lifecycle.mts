// E2E: pod lifecycle automation + tenant isolation, on the live dev43 cluster.
//   Setup: 10 users, 3 active (running pods), 7 idle (suspended/0 pods).
//   1-2. idle user (dave) connects → broker auto-wake → pod AUTO-ASSIGNED.
//   3-4. active user (erin) goes idle → OPERATOR idle-suspend → pod AUTO-CLEANED.
//   5.   active user (alice) maliciously probes another (carol) → blocked at the root.
//
// Roles under test (spec): mission-control only REPORTS activity (stamps the
// openclaw.rocks/last-active annotation); the OPERATOR owns the idle decision and
// the suspend. This test never calls a sweep — it back-dates erin's annotation and
// observes the operator act. Requires the operator deployed with
// OPENCLAW_IDLE_SUSPEND_AFTER set (e.g. 1h); erin is back-dated 2h to cross it.
import { spawnSync } from 'child_process'
import WebSocket from 'ws'
import { getDatabase } from '../src/lib/db'

const K = process.env.MC_KUBECTL_PATH || '/usr/local/bin/kubectl'
const BASE = 'http://127.0.0.1:3010'
const ANNOTATION = 'openclaw.rocks/last-active'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: Array<[string, boolean]> = []
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? '  — ' + detail : ''}`)
}
function kc(args: string[]): string {
  return (spawnSync(K, args, { encoding: 'utf8' }).stdout || '').trim()
}
const phase = (s: string) => kc(['get', 'openclawinstance', s, '-n', `user-${s}`, '-o', 'jsonpath={.status.phase}'])
const suspendedFlag = (s: string) => kc(['get', 'openclawinstance', s, '-n', `user-${s}`, '-o', 'jsonpath={.spec.suspended}'])
const podCount = (s: string) => kc(['get', 'pods', '-n', `user-${s}`, '--no-headers']).split('\n').filter(Boolean).length
// Stamp the activity annotation directly (simulates what the MC broker does on traffic).
const stamp = (s: string, unixSec: number) =>
  kc(['annotate', 'openclawinstance', s, '-n', `user-${s}`, `${ANNOTATION}=${unixSec}`, '--overwrite'])

async function login(u: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: u + '1234' }),
  })
  const m = (r.headers.get('set-cookie') || '').match(/mc-session=[^;]+/)
  return m ? m[0] : ''
}
async function api(path: string, cookie: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie } })
  let body: any = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}

async function main() {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  // ───────── S0: setup assertion ─────────
  console.log('\n=== S0. SETUP (10 users / 3 active / 7 idle) ===')
  const owners = db.prepare(
    `SELECT u.username, t.slug, t.status FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.owner_user_id IS NOT NULL`
  ).all() as Array<{ username: string; slug: string; status: string }>
  const active = owners.filter((o) => o.status === 'active').map((o) => o.slug).sort()
  const idle = owners.filter((o) => o.status === 'suspended').map((o) => o.slug).sort()
  check('10 registered users', owners.length === 10, `got ${owners.length}`)
  check('3 active', active.length === 3, active.join(','))
  check('7 idle', idle.length === 7, idle.join(','))
  check('active pods Running (alice,carol,erin)',
    phase('alice') === 'Running' && phase('carol') === 'Running' && phase('erin') === 'Running')
  check('idle dave has 0 pods (scale-to-zero)', podCount('dave') === 0,
    `dave phase=${phase('dave')} pods=${podCount('dave')}`)

  // ───────── S1-2: idle dave → active, pod AUTO-ASSIGNED via broker auto-wake ─────────
  console.log('\n=== S1-2. dave (idle) connects → auto-wake → pod auto-assigned ===')
  console.log(`  before: dave suspended=${suspendedFlag('dave')} pods=${podCount('dave')}`)
  const daveCookie = await login('dave')
  // Connect the broker as dave. The server-side handler sees the tenant is suspended and
  // fires runSelfServiceLifecycle('resume') → CR suspended=false → operator scales up.
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/gateway`, { headers: { Cookie: daveCookie } })
    ws.on('open', () => console.log('  broker connected as dave (auto-wake triggered server-side)'))
    ws.on('close', () => resolve())
    ws.on('error', () => resolve())
    setTimeout(() => { try { ws.close() } catch {} ; resolve() }, 8000)
  })
  // Poll kubectl until the pod is assigned (cold wake takes a few minutes).
  let daveUp = false
  for (let i = 0; i < 60; i++) {
    if (phase('dave') === 'Running' && podCount('dave') >= 1) { daveUp = true; break }
    if (i % 5 === 0) console.log(`  ...waking dave: suspended=${suspendedFlag('dave')} phase=${phase('dave')} pods=${podCount('dave')} (${i * 6}s)`)
    await sleep(6000)
  }
  check('dave CR un-suspended (resume fired automatically)', suspendedFlag('dave') === 'false')
  check('dave pod AUTO-ASSIGNED (Running, replicas≥1)', daveUp, `phase=${phase('dave')} pods=${podCount('dave')}`)

  // ───────── S3-4: active erin → idle, pod AUTO-CLEANED by the OPERATOR ─────────
  console.log('\n=== S3-4. erin (active) goes idle → operator idle-suspend → pod auto-cleaned ===')
  // The operator suspends any instance whose openclaw.rocks/last-active annotation is
  // older than OPENCLAW_IDLE_SUSPEND_AFTER. Mark alice/carol FRESH (active) and erin
  // STALE (idle 2h); the annotate write triggers an immediate reconcile.
  stamp('alice', now)
  stamp('carol', now)
  console.log(`  before: erin suspended=${suspendedFlag('erin')} pods=${podCount('erin')}`)
  stamp('erin', now - 7200)
  let erinDown = false
  for (let i = 0; i < 30; i++) {
    if (suspendedFlag('erin') === 'true' && podCount('erin') === 0) { erinDown = true; break }
    if (i % 3 === 0) console.log(`  ...operator cleaning erin: suspended=${suspendedFlag('erin')} pods=${podCount('erin')} (${i * 4}s)`)
    await sleep(4000)
  }
  check('operator suspended idle erin (spec.suspended=true)', suspendedFlag('erin') === 'true', `suspended=${suspendedFlag('erin')}`)
  check('erin pod AUTO-CLEANED by operator (0 pods)', erinDown, `suspended=${suspendedFlag('erin')} pods=${podCount('erin')}`)
  check('fresh-stamped actives untouched (alice,carol still Running)',
    phase('alice') === 'Running' && phase('carol') === 'Running',
    `alice=${phase('alice')} carol=${phase('carol')}`)

  // ───────── S5: malicious cross-tenant access is blocked at the root ─────────
  console.log('\n=== S5. alice (active) maliciously probes carol — must be blocked ===')
  const aliceCookie = await login('alice')
  const mine = await api('/api/me/instance', aliceCookie)
  check('alice /api/me/instance returns ONLY alice (never carol)',
    mine.status === 200 && mine.body?.instance?.slug === 'alice', `slug=${mine.body?.instance?.slug}`)
  const usage = await api('/api/me/usage', aliceCookie)
  check('alice /api/me/usage scoped to alice', usage.status === 200 && usage.body?.instance?.slug === 'alice')
  // Explicit attack: alice actively TARGETS carol via param injection — must be ignored
  // (ownership derives from the session, never from a client-supplied slug/id).
  const inj1 = await api('/api/me/instance?slug=carol', aliceCookie)
  check('alice probing ?slug=carol still gets ONLY alice', inj1.body?.instance?.slug === 'alice', `slug=${inj1.body?.instance?.slug}`)
  const inj2 = await api('/api/me/instance?as=carol&user=carol&owner=carol', aliceCookie)
  check('alice probing ?as=carol/&user=carol still gets ONLY alice', inj2.body?.instance?.slug === 'alice', `slug=${inj2.body?.instance?.slug}`)
  // Try to read carol / all tenants via the admin surface — must be 403.
  const listAll = await api('/api/super/tenants', aliceCookie)
  check('alice cannot list all tenants (/api/super/tenants)', listAll.status === 403, `HTTP ${listAll.status}`)
  const hostSessions = await api('/api/sessions', aliceCookie)
  const hostGw = await api('/api/gateways', aliceCookie)
  check('alice cannot read host sessions', hostSessions.status === 403, `HTTP ${hostSessions.status}`)
  check('alice cannot read host gateways', hostGw.status === 403, `HTTP ${hostGw.status}`)
  // Confirm carol's slug never leaks into any alice-reachable response.
  const leaked = JSON.stringify([mine.body, usage.body, inj1.body, inj2.body, listAll.body, hostSessions.body, hostGw.body]).includes('carol')
  check("carol's data never appears in any alice response", !leaked)
  // Symmetric: carol cannot reach alice either.
  const carolCookie = await login('carol')
  const carolMine = await api('/api/me/instance', carolCookie)
  check('carol sees only carol (symmetric isolation)',
    carolMine.body?.instance?.slug === 'carol', `slug=${carolMine.body?.instance?.slug}`)

  // ───────── summary ─────────
  const passed = results.filter((r) => r[1]).length
  console.log(`\n=== RESULT: ${passed}/${results.length} checks passed ===`)
  console.log(results.every((r) => r[1]) ? 'E2E PASS' : 'E2E FAIL: ' + results.filter((r) => !r[1]).map((r) => r[0]).join('; '))
  process.exit(0)
}
main()
