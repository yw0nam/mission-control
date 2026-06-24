import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getTenantForOwner, updateTenantStatus } from '@/lib/super-admin'
import { readInstancePhase, mapPhaseToStatus } from '@/lib/super-admin-k8s'
import type { Tenant } from '@/lib/db'

/**
 * GET /api/me/instance
 * Returns the calling owner's single instance. Scoped: any logged-in user
 * (viewer or above) can read ONLY their own instance, and only safe fields.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const t = getTenantForOwner(auth.user.id)
  if (!t) return NextResponse.json({ error: 'No instance assigned' }, { status: 404 })

  // Project the live operator phase over the stored status, but ONLY when the stored
  // status is a settled, operator-authoritative state (active/suspended). Transient,
  // MC-job-owned states (provisioning/decommissioning/pending/error) must never be
  // overwritten by a live phase -- e.g. a tenant being torn down must not be
  // resurrected to active. On any kubectl/cluster failure readInstancePhase yields
  // null, so we fall back to the stored DB value.
  let status: Tenant['status'] = t.status
  if (t.status === 'active' || t.status === 'suspended') {
    const phase = await readInstancePhase(t.slug)
    const mapped = mapPhaseToStatus(phase)
    if (mapped && mapped !== t.status) {
      updateTenantStatus(t.id, mapped, t.status)
      status = mapped
    }
  }

  return NextResponse.json({
    instance: {
      slug: t.slug,
      display_name: t.display_name,
      status,
      plan_tier: t.plan_tier,
    },
  })
}
