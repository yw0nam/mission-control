import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const prepare = vi.fn()
const wakeRemotePod = vi.fn()
const getDetectedGatewayToken = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/db', () => ({ getDatabase: vi.fn(() => ({ prepare })) }))
vi.mock('@/lib/openclaw-wake', () => ({ wakeRemotePod }))
vi.mock('@/lib/gateway-runtime', () => ({ getDetectedGatewayToken }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/gateways/wake', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function mockGatewayRow(row: Record<string, unknown> | undefined) {
  prepare.mockImplementation((sql: string) => {
    if (sql.includes('FROM gateways')) return { get: () => row }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
}

beforeEach(() => {
  vi.resetModules()
  requireRole.mockReturnValue({ user: { username: 'op', role: 'operator', workspace_id: 1 } })
  prepare.mockReset()
  wakeRemotePod.mockReset().mockResolvedValue(true)
  getDetectedGatewayToken.mockReset().mockReturnValue('detected-token')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/gateways/wake', () => {
  it('is operator-gated and does not wake when auth fails', async () => {
    requireRole.mockReturnValue({ error: 'Forbidden', status: 403 })

    const { POST } = await import('@/app/api/gateways/wake/route')
    const res = await POST(makeRequest({ id: 1 }))

    expect(res.status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), 'operator')
    expect(wakeRemotePod).not.toHaveBeenCalled()
  })

  it('derives slug from the host and uses the detected token for a primary gateway', async () => {
    mockGatewayRow({ id: 1, host: 'alice.pods.example.com', port: 443, token: 'row-token', is_primary: 1 })

    const { POST } = await import('@/app/api/gateways/wake/route')
    const res = await POST(makeRequest({ id: 1 }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(wakeRemotePod).toHaveBeenCalledWith('alice', 'detected-token')
  })

  it('falls back to the stored row token for a non-primary gateway', async () => {
    mockGatewayRow({ id: 2, host: 'bob.pods.example.com', port: 443, token: 'row-token', is_primary: 0 })

    const { POST } = await import('@/app/api/gateways/wake/route')
    const res = await POST(makeRequest({ id: 2 }))

    expect(res.status).toBe(200)
    expect(wakeRemotePod).toHaveBeenCalledWith('bob', 'row-token')
  })

  it('returns 404 when the gateway row is not found', async () => {
    mockGatewayRow(undefined)

    const { POST } = await import('@/app/api/gateways/wake/route')
    const res = await POST(makeRequest({ id: 999 }))

    expect(res.status).toBe(404)
    expect(wakeRemotePod).not.toHaveBeenCalled()
  })

  it('returns 400 for a missing/invalid id', async () => {
    const { POST } = await import('@/app/api/gateways/wake/route')
    const res = await POST(makeRequest({}))

    expect(res.status).toBe(400)
    expect(wakeRemotePod).not.toHaveBeenCalled()
  })

  it('surfaces a non-2xx when the wake fails', async () => {
    mockGatewayRow({ id: 1, host: 'alice.pods.example.com', port: 443, token: 'row-token', is_primary: 1 })
    wakeRemotePod.mockResolvedValue(false)

    const { POST } = await import('@/app/api/gateways/wake/route')
    const res = await POST(makeRequest({ id: 1 }))
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.ok).toBe(false)
  })
})
