import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'

// Gateway readers shell to kubectl; /bin/true exits 0 with empty stdout, so a live
// gateway is never resolved here — resolveTenantGateway for an owner yields
// 'unavailable'. The security decision under test is resolveTenantForUser (DB only).
process.env.MC_PROVISIONER_BACKEND = 'k8s'
process.env.MC_KUBECTL_PATH = '/bin/true'

let tmpDir: string
type SuperAdmin = typeof import('@/lib/super-admin')
type Auth = typeof import('@/lib/auth')
type Db = typeof import('@/lib/db')
type TG = typeof import('@/lib/tenant-gateway')

let superAdmin: SuperAdmin
let auth: Auth
let db: Db
let tg: TG

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tenant-gw-'))
  process.env.MISSION_CONTROL_DATA_DIR = tmpDir
  process.env.MISSION_CONTROL_DB_PATH = path.join(tmpDir, 'mission-control.db')
  superAdmin = await import('@/lib/super-admin')
  auth = await import('@/lib/auth')
  db = await import('@/lib/db')
  tg = await import('@/lib/tenant-gateway')
  db.getDatabase()
})

afterAll(() => {
  try {
    db?.getDatabase().close()
  } catch {
    /* ignore */
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

function insertTenant(slug: string, ownerUserId: number | null) {
  const database = db.getDatabase()
  const res = database.prepare(`
    INSERT INTO tenants (slug, display_name, linux_user, plan_tier, status, openclaw_home, workspace_root, config, created_by, owner_user_id)
    VALUES (?, ?, ?, 'standard', 'active', ?, ?, '{}', 'admin', ?)
  `).run(slug, slug, `oc-${slug}`, `/home/oc-${slug}/.openclaw`, `/home/oc-${slug}/workspace`, ownerUserId)
  return Number(res.lastInsertRowid)
}

describe('resolveTenantForUser — isolation decision', () => {
  it('binds an owner to their own tenant only', () => {
    const a = auth.createUser('gw-owner-a', 'password-aaaa-1', 'A', 'viewer')
    const b = auth.createUser('gw-owner-b', 'password-bbbb-1', 'B', 'viewer')
    const tA = insertTenant('gw-a', a.id)
    insertTenant('gw-b', b.id)

    const resA = tg.resolveTenantForUser({ id: a.id, role: 'viewer' })
    expect(resA.kind).toBe('tenant')
    if (resA.kind === 'tenant') {
      expect(resA.tenant.id).toBe(tA)
      expect(resA.tenant.slug).toBe('gw-a')
    }
  })

  it('denies a non-admin with no bound tenant (never global)', () => {
    const orphan = auth.createUser('gw-orphan', 'password-cccc-1', 'C', 'viewer')
    expect(tg.resolveTenantForUser({ id: orphan.id, role: 'viewer' }).kind).toBe('denied')
  })

  it('treats admins and synthetic (id<=0) principals as global, not per-tenant', () => {
    expect(tg.resolveTenantForUser({ id: 5, role: 'admin' }).kind).toBe('admin')
    expect(tg.resolveTenantForUser({ id: 0, role: 'viewer' }).kind).toBe('admin')
    expect(tg.resolveTenantForUser({ id: -1, role: 'operator' }).kind).toBe('admin')
  })

  it('resolveTenantGateway yields unavailable when the gateway address cannot be read', async () => {
    const d = auth.createUser('gw-owner-d', 'password-dddd-1', 'D', 'viewer')
    insertTenant('gw-d', d.id)
    const res = await tg.resolveTenantGateway({ id: d.id, role: 'viewer' })
    expect(res.kind).toBe('unavailable')
  })
})
