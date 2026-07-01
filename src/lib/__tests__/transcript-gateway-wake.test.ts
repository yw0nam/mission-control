import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Task 3: opening a conversation (chat.history) is an explicit interaction, so
// on a gateway-unreachable error the route wakes the pod, waits for readiness,
// and retries chat.history ONCE before falling through to the disk fallback.

const callOpenClawGateway = vi.fn()
const parseGatewayHistoryTranscript = vi.fn()
const parseJsonlTranscript = vi.fn(() => [])
const wakeRemotePod = vi.fn()
const isGatewayUnreachableError = vi.fn()
const waitForGatewayReady = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { username: 'v', role: 'viewer', workspace_id: 1 } })),
}))
vi.mock('@/lib/config', () => ({ config: { openclawStateDir: '' } }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway }))
vi.mock('@/lib/transcript-parser', () => ({ parseGatewayHistoryTranscript, parseJsonlTranscript }))
vi.mock('@/lib/openclaw-wake', () => ({ wakeRemotePod, isGatewayUnreachableError, waitForGatewayReady }))

function makeRequest() {
  return new NextRequest('http://localhost/api/sessions/transcript/gateway?key=agent:jarv:main&limit=50')
}

beforeEach(() => {
  vi.resetModules()
  callOpenClawGateway.mockReset()
  parseGatewayHistoryTranscript.mockReset().mockImplementation((msgs: unknown[]) =>
    Array.isArray(msgs) && msgs.length > 0 ? [{ role: 'user', parts: [] }] : [],
  )
  wakeRemotePod.mockReset().mockResolvedValue(true)
  isGatewayUnreachableError.mockReset()
  waitForGatewayReady.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/sessions/transcript/gateway wake-on-open', () => {
  it('wakes, waits, and retries chat.history once when the gateway is unreachable', async () => {
    callOpenClawGateway
      .mockRejectedValueOnce(new Error('websocket error'))
      .mockResolvedValueOnce({ messages: [{ role: 'user' }] })
    isGatewayUnreachableError.mockReturnValue(true)
    waitForGatewayReady.mockResolvedValue(true)

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(wakeRemotePod).toHaveBeenCalledTimes(1)
    expect(waitForGatewayReady).toHaveBeenCalledTimes(1)
    expect(callOpenClawGateway).toHaveBeenCalledTimes(2)
    expect(body.source).toBe('gateway-rpc')
    expect(body.messages).toHaveLength(1)
  })

  it('does not wake when the error is not a gateway-unreachable error', async () => {
    callOpenClawGateway.mockRejectedValueOnce(new Error('some rpc error'))
    isGatewayUnreachableError.mockReturnValue(false)

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(wakeRemotePod).not.toHaveBeenCalled()
    expect(callOpenClawGateway).toHaveBeenCalledTimes(1)
    // disk fallback short-circuits (no OPENCLAW_STATE_DIR)
    expect(body.error).toBe('OPENCLAW_STATE_DIR not configured')
  })

  it('does not retry when the gateway never becomes ready', async () => {
    callOpenClawGateway.mockRejectedValueOnce(new Error('websocket error'))
    isGatewayUnreachableError.mockReturnValue(true)
    waitForGatewayReady.mockResolvedValue(false)

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(wakeRemotePod).toHaveBeenCalledTimes(1)
    expect(waitForGatewayReady).toHaveBeenCalledTimes(1)
    expect(callOpenClawGateway).toHaveBeenCalledTimes(1) // no retry
    expect(body.error).toBe('OPENCLAW_STATE_DIR not configured')
  })
})
