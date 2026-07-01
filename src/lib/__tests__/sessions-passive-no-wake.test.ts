import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Governing policy: passive paths must NEVER wake a suspended pod. The sessions
// GET route (`sessions.list`) is passive — this test proves it never calls
// wakeRemotePod, in BOTH the RPC-success and RPC-failure (served-stale)
// branches. `@/lib/openclaw-wake` is mocked so that if a future change wires a
// wake into this path, the spy trips and this guard fails.

const callGatewayMock = vi.fn()
const getDetectedTokenMock = vi.fn(() => 'gw-token')
const wakeRemotePod = vi.fn()
const prepareMock = vi.fn()
const settingsStore = new Map<string, string>()

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { username: 'tester', role: 'viewer', workspace_id: 1 } })),
}))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: vi.fn(() => null) }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: callGatewayMock }))
vi.mock('@/lib/openclaw-wake', () => ({ wakeRemotePod }))
vi.mock('@/lib/gateway-runtime', () => ({ getDetectedGatewayToken: getDetectedTokenMock }))
vi.mock('@/lib/config', () => ({ config: { gatewaySlug: 'alice' } }))
vi.mock('@/lib/claude-sessions', () => ({ syncClaudeSessions: vi.fn(async () => {}) }))
vi.mock('@/lib/codex-sessions', () => ({ scanCodexSessions: vi.fn(() => []) }))
vi.mock('@/lib/hermes-sessions', () => ({ scanHermesSessions: vi.fn(() => []) }))
vi.mock('@/lib/opencode-sessions', () => ({ scanOpenCodeSessions: vi.fn(() => []) }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
  db_helpers: { logActivity: vi.fn() },
}))
vi.mock('@/lib/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessions')>()
  return { ...actual, getAllGatewaySessions: vi.fn(() => []) }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  settingsStore.clear()
  callGatewayMock.mockReset()
  getDetectedTokenMock.mockReturnValue('gw-token')
  prepareMock.mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO settings')) {
      return { run: (...args: unknown[]) => { settingsStore.set(String(args[0]), String(args[1])) } }
    }
    if (sql.includes('SELECT value FROM settings')) {
      return { get: (key: string) => { const v = settingsStore.get(key); return v === undefined ? undefined : { value: v } } }
    }
    if (sql.includes('FROM claude_sessions')) return { all: () => [] }
    throw new Error(`Unexpected SQL in test: ${sql}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sessions GET is wake-free (passive path)', () => {
  it('does not wake when sessions.list RPC succeeds', async () => {
    callGatewayMock.mockResolvedValue({ sessions: [] })

    const { GET } = await import('@/app/api/sessions/route')
    const res = await GET(new NextRequest('http://localhost/api/sessions'))

    expect(res.status).toBe(200)
    expect(wakeRemotePod).not.toHaveBeenCalled()
  })

  it('does not wake when sessions.list RPC fails (serves stale cache)', async () => {
    callGatewayMock.mockRejectedValue(new Error('websocket error: closed before ready'))

    const { GET } = await import('@/app/api/sessions/route')
    const res = await GET(new NextRequest('http://localhost/api/sessions'))

    expect(res.status).toBe(200)
    expect(wakeRemotePod).not.toHaveBeenCalled()
  })
})
