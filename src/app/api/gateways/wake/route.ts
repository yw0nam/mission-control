import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { getDetectedGatewayToken } from '@/lib/gateway-runtime'
import { wakeRemotePod } from '@/lib/openclaw-wake'

interface GatewayRow {
  id: number
  host: string
  token: string
  is_primary: number
}

/**
 * POST /api/gateways/wake { id }
 *
 * Manual "Wake" button backend: resolve the gateway row, derive its slug (first
 * DNS label of the host) and token, then ask the cluster waker to resume the
 * suspended pod. Waking is an explicit operator action (wake trigger A).
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let id: number | null = null
  try {
    const body = await request.json()
    id = Number(body?.id)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!id || !Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const gateway = getDatabase()
    .prepare('SELECT id, host, token, is_primary FROM gateways WHERE id = ?')
    .get(id) as GatewayRow | undefined
  if (!gateway) {
    return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })
  }

  // Slug = first DNS label of the host. Token resolution mirrors the connect
  // route: the detected OpenClaw token for the primary gateway, else the row's.
  const slug = String(gateway.host || '').split('.')[0]
  const dbToken = (gateway.token || '').trim()
  const detectedToken = gateway.is_primary === 1 ? getDetectedGatewayToken() : ''
  const token = detectedToken || dbToken

  const ok = await wakeRemotePod(slug, token)
  return NextResponse.json({ ok }, { status: ok ? 200 : 502 })
}
