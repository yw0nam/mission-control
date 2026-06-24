import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { createTenantLifecycleJob } from '@/lib/super-admin'

/**
 * POST /api/super/tenants/[id]/suspend  (k8s backend only)
 * Body: { dry_run?: boolean, reason?: string }
 * Queues a scale-to-zero job (PoC observation #3).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const tenantId = Number((await context.params).id)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: 'Invalid tenant id' }, { status: 400 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const created = createTenantLifecycleJob(tenantId, 'suspend', {
      dry_run: body?.dry_run,
      reason: body?.reason,
    }, auth.user.username)
    return NextResponse.json(created, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to queue suspend job' }, { status: 400 })
  }
}
