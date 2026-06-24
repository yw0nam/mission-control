import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getTenantForOwner } from '@/lib/super-admin'

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

  return NextResponse.json({
    instance: {
      slug: t.slug,
      display_name: t.display_name,
      status: t.status,
      plan_tier: t.plan_tier,
    },
  })
}
