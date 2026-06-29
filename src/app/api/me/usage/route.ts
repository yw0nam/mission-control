import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getTenantForOwner, listProvisionJobs } from '@/lib/super-admin'

/**
 * GET /api/me/usage
 * Owner-scoped usage/activity for the caller's single instance (spec #4). Returns ONLY
 * what Mission Control tracks for the tenant it brokers — instance status, last-active
 * time, and lifecycle history (provision/suspend/resume) — never host or other-tenant
 * data. The tenant_id is resolved from the session, never accepted as input. Detailed
 * token/workflow usage lives inside the pod and is out of scope for this MC-side view.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const t = getTenantForOwner(auth.user.id)
  if (!t) return NextResponse.json({ error: 'No instance assigned' }, { status: 404 })

  const activity = listProvisionJobs({ tenant_id: t.id, limit: 50 }).map((j: any) => ({
    kind: j.job_type,
    status: j.status,
    requested_by: j.requested_by,
    created_at: j.created_at,
    completed_at: j.completed_at,
  }))

  return NextResponse.json({
    instance: {
      slug: t.slug,
      display_name: t.display_name,
      status: t.status,
      plan_tier: t.plan_tier,
      created_at: t.created_at,
      last_active_at: (t as { last_active_at?: number | null }).last_active_at ?? null,
    },
    activity,
    note: 'Token- and workflow-level usage is recorded inside your pod; this view shows MC-brokered activity.',
  })
}
