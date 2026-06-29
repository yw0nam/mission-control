import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { runSelfServiceLifecycle } from '@/lib/super-admin'

/**
 * POST /api/me/instance/suspend
 * Owner self-service suspend. EXEMPT from the two-person rule (reversible).
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    return NextResponse.json(await runSelfServiceLifecycle(auth.user, 'suspend'))
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to suspend instance' }, { status: 400 })
  }
}
