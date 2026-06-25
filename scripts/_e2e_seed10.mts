// E2E seed: 10 users + 10 tenants (alice already exists). 3 active, 7 idle.
import { getDatabase } from '../src/lib/db'
import { hashPassword } from '../src/lib/password'

const db = getDatabase()
const now = Math.floor(Date.now() / 1000)

// name -> status. alice already seeded (active). Real CRs: carol/erin(active), dave(suspended).
const SPEC: Array<[string, 'active' | 'suspended']> = [
  ['carol', 'active'],
  ['erin', 'active'],
  ['dave', 'suspended'],
  ['frank', 'suspended'],
  ['grace', 'suspended'],
  ['heidi', 'suspended'],
  ['ivan', 'suspended'],
  ['judy', 'suspended'],
  ['ken', 'suspended'],
]

function ensureUser(username: string): number {
  const ex = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number } | undefined
  if (ex) {
    db.prepare(`UPDATE users SET password_hash=?, role='viewer', is_approved=1 WHERE id=?`).run(hashPassword(username + '1234'), ex.id)
    return ex.id
  }
  const r = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at, provider, is_approved)
     VALUES (?, ?, ?, 'viewer', ?, ?, 'local', 1)`
  ).run(username, username[0].toUpperCase() + username.slice(1), hashPassword(username + '1234'), now, now)
  return Number(r.lastInsertRowid)
}

function ensureTenant(slug: string, ownerId: number, status: string) {
  const ex = db.prepare('SELECT id FROM tenants WHERE slug=?').get(slug) as { id: number } | undefined
  if (ex) {
    db.prepare(`UPDATE tenants SET owner_user_id=?, status=?, updated_at=? WHERE id=?`).run(ownerId, status, now, ex.id)
    return
  }
  db.prepare(
    `INSERT INTO tenants (slug, display_name, linux_user, plan_tier, status, openclaw_home, workspace_root, config, created_by, created_at, updated_at, owner_user_id)
     VALUES (?, ?, ?, 'standard', ?, ?, ?, '{}', 'admin', ?, ?, ?)`
  ).run(slug, slug[0].toUpperCase() + slug.slice(1) + ' Instance', slug, status, `/home/${slug}/.openclaw`, `/home/${slug}/workspace`, now, now, ownerId)
}

for (const [name, status] of SPEC) {
  const uid = ensureUser(name)
  ensureTenant(name, uid, status)
}

const users = db.prepare('SELECT count(*) c FROM users').get() as { c: number }
const active = db.prepare(`SELECT count(*) c FROM tenants WHERE status='active'`).get() as { c: number }
const idle = db.prepare(`SELECT count(*) c FROM tenants WHERE status='suspended'`).get() as { c: number }
console.log(`SEED OK — users=${users.c} active=${active.c} idle=${idle.c}`)
console.log('active:', (db.prepare(`SELECT slug FROM tenants WHERE status='active' ORDER BY slug`).all() as any[]).map(r => r.slug).join(','))
console.log('idle:', (db.prepare(`SELECT slug FROM tenants WHERE status='suspended' ORDER BY slug`).all() as any[]).map(r => r.slug).join(','))
process.exit(0)
