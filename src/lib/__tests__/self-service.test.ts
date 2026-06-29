import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'

// The k8s lifecycle steps shell out to kubectl (requires_root: false), so we point
// MC_KUBECTL_PATH at /bin/true — it ignores args and exits 0, making every step
// "succeed" without a real cluster. These vars are read at call time, not import
// time, so setting them here (before the dynamic imports in beforeAll) is fine.
process.env.MC_PROVISIONER_BACKEND = 'k8s'
process.env.MC_SUPER_PROVISION_EXEC = 'true'
process.env.MC_KUBECTL_PATH = '/bin/true'

// config.dbPath is captured at module import time from MISSION_CONTROL_DATA_DIR,
// so the data dir MUST be set before db.ts / super-admin.ts are imported. We do
// the imports dynamically inside beforeAll after pointing at a fresh temp dir.
let tmpDir: string

type SuperAdmin = typeof import('@/lib/super-admin')
type Auth = typeof import('@/lib/auth')
type Db = typeof import('@/lib/db')

let superAdmin: SuperAdmin
let auth: Auth
let db: Db

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-self-service-'))
  process.env.MISSION_CONTROL_DATA_DIR = tmpDir
  process.env.MISSION_CONTROL_DB_PATH = path.join(tmpDir, 'mission-control.db')

  // Importing these triggers getDatabase() lazily; migrations (incl. 051) run on first access.
  superAdmin = await import('@/lib/super-admin')
  auth = await import('@/lib/auth')
  db = await import('@/lib/db')

  // Force DB init + migrations.
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

function insertTenant(slug: string, displayName: string, ownerUserId: number | null) {
  const database = db.getDatabase()
  const res = database.prepare(`
    INSERT INTO tenants (slug, display_name, linux_user, plan_tier, status, openclaw_home, workspace_root, config, created_by, owner_user_id)
    VALUES (?, ?, ?, 'standard', 'active', ?, ?, '{}', 'admin', ?)
  `).run(slug, displayName, `oc-${slug}`, `/home/oc-${slug}/.openclaw`, `/home/oc-${slug}/workspace`, ownerUserId)
  return Number(res.lastInsertRowid)
}

describe('two-tier owner self-service', () => {
  it('binds tenants to owners and scopes getTenantForOwner per user', () => {
    const userA = auth.createUser('owner-a', 'password-aaaa-1', 'Owner A', 'viewer')
    const userB = auth.createUser('owner-b', 'password-bbbb-1', 'Owner B', 'viewer')
    const orphan = auth.createUser('owner-c', 'password-cccc-1', 'Owner C', 'viewer')

    const tenantA = insertTenant('inst-a', 'Instance A', userA.id)
    const tenantB = insertTenant('inst-b', 'Instance B', userB.id)

    const forA = superAdmin.getTenantForOwner(userA.id)
    const forB = superAdmin.getTenantForOwner(userB.id)

    expect(forA?.id).toBe(tenantA)
    expect(forA?.slug).toBe('inst-a')
    expect(forB?.id).toBe(tenantB)
    expect(forA?.id).not.toBe(tenantB)

    // A user with no assigned tenant gets null.
    expect(superAdmin.getTenantForOwner(orphan.id)).toBeNull()
  })

  it('owner self-service suspend then resume runs end-to-end (no two-person blocker)', async () => {
    const user = auth.createUser('owner-self', 'password-self-1', 'Owner Self', 'viewer')
    insertTenant('inst-self', 'Self Instance', user.id)

    const suspended = await superAdmin.runSelfServiceLifecycle(
      { id: user.id, username: user.username },
      'suspend'
    )
    expect(suspended.job?.status).toBe('completed')
    expect(suspended.instance.status).toBe('suspended')
    expect(superAdmin.getTenantForOwner(user.id)?.status).toBe('suspended')

    // Fix 5: the self-service payload must not leak job internals.
    const flat = JSON.stringify(suspended)
    expect(flat).not.toContain('linux_user')
    expect(flat).not.toContain('plan_json')
    expect(flat).not.toContain('stdout')
    expect(flat).not.toContain('runner_host')

    const resumed = await superAdmin.runSelfServiceLifecycle(
      { id: user.id, username: user.username },
      'resume'
    )
    expect(resumed.job?.status).toBe('completed')
    expect(resumed.instance.status).toBe('active')
    expect(superAdmin.getTenantForOwner(user.id)?.status).toBe('active')
  })

  it('still enforces the two-person rule on a live bootstrap job (self-approval rejected)', async () => {
    const actor = 'admin'
    const { job } = superAdmin.createTenantAndBootstrapJob(
      { slug: 'inst-boot', display_name: 'Bootstrap Instance', dry_run: false },
      actor
    )
    expect(job).toBeTruthy()

    // Same actor approves and runs -> two-person violation.
    superAdmin.transitionProvisionJobStatus(job!.id, actor, 'approve')
    await expect(superAdmin.executeProvisionJob(job!.id, actor)).rejects.toThrow(/Two-person rule violation/)
  })

  it('re-gates live update jobs under the two-person rule (Fix 1: allow-list, not deny-list)', async () => {
    const actor = 'admin'
    const tenantId = insertTenant('inst-update', 'Update Instance', null)
    const database = db.getDatabase()

    // A trivial live update job, mirroring how admin-reachable update jobs are stored.
    const trivialPlan = [
      { key: 'noop', title: 'No-op', command: ['/bin/true'], requires_root: false, timeout_ms: 5000 },
    ]
    const res = database.prepare(`
      INSERT INTO provision_jobs (tenant_id, job_type, status, dry_run, requested_by, idempotency_key, request_json, plan_json, updated_at)
      VALUES (?, 'update', 'queued', 0, ?, ?, ?, ?, (unixepoch()))
    `).run(
      tenantId,
      actor,
      `update-${tenantId}`,
      JSON.stringify({ dry_run: false }),
      JSON.stringify(trivialPlan),
    )
    const jobId = Number(res.lastInsertRowid)

    // Same actor approves and runs -> must still trip the two-person rule for `update`.
    superAdmin.transitionProvisionJobStatus(jobId, actor, 'approve')
    await expect(superAdmin.executeProvisionJob(jobId, actor)).rejects.toThrow(/Two-person rule violation/)
  })

  it('enforces the status precondition for lifecycle jobs (Fix 3)', () => {
    const user = auth.createUser('owner-precond', 'password-prec-1', 'Owner Precond', 'viewer')
    // insertTenant creates an 'active' tenant.
    const tenantId = insertTenant('inst-precond', 'Precond Instance', user.id)

    // resume on an active tenant -> rejected.
    expect(() =>
      superAdmin.createTenantLifecycleJob(tenantId, 'resume', { dry_run: false }, 'admin')
    ).toThrow(/Cannot resume an instance in status 'active'/)

    // Flip to suspended, then suspend -> rejected.
    db.getDatabase().prepare(`UPDATE tenants SET status = 'suspended' WHERE id = ?`).run(tenantId)
    expect(() =>
      superAdmin.createTenantLifecycleJob(tenantId, 'suspend', { dry_run: false }, 'admin')
    ).toThrow(/Cannot suspend an instance in status 'suspended'/)
  })
})
