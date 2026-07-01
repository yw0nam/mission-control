import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { mapGatewayRpcSessions } from '../sessions'

const NOW = 2_000_000_000_000
const WINDOW = 60 * 60 * 1000 // 1h

// Representative `sessions.list` RPC payload as returned by the OpenClaw gateway
// (frame.payload). Shapes mirror what a live remote pod returns.
const payload = {
  defaultId: 'main',
  mainKey: 'main',
  scope: 'per-sender',
  count: 2,
  sessions: [
    {
      key: 'agent:main:main',
      kind: 'direct',
      chatType: 'direct',
      sessionId: 'fd0b25f3',
      updatedAt: NOW - 2 * 60 * 60 * 1000, // 2h ago -> inactive
      model: 'GPT-OSS-120B',
      inputTokens: 9376,
      outputTokens: 57,
      totalTokens: 9376,
      contextTokens: 262144,
      deliveryContext: { channel: 'webchat' },
      lastChannel: 'webchat',
    },
    {
      key: 'agent:alice:web-x',
      kind: 'direct',
      sessionId: '',
      updatedAt: NOW - 1000, // 1s ago -> active
      model: { primary: 'openai/GPT-OSS-120B' },
      lastChannel: 'webchat',
    },
  ],
}

describe('mapGatewayRpcSessions', () => {
  it('maps gateway sessions.list payload into GatewaySession records', () => {
    const out = mapGatewayRpcSessions(payload, { now: NOW, activeWithinMs: WINDOW })
    expect(out).toHaveLength(2)

    const a = out[0]
    expect(a.key).toBe('agent:main:main')
    expect(a.agent).toBe('main') // derived from key segment
    expect(a.sessionId).toBe('fd0b25f3')
    expect(a.channel).toBe('webchat') // from deliveryContext.channel
    expect(a.model).toBe('GPT-OSS-120B')
    expect(a.totalTokens).toBe(9376)
    expect(a.contextTokens).toBe(262144)
    expect(a.chatType).toBe('direct')
    expect(a.active).toBe(false) // 2h ago > 1h window
  })

  it('derives agent from key, reads model object, falls back to lastChannel, computes active', () => {
    const out = mapGatewayRpcSessions(payload, { now: NOW, activeWithinMs: WINDOW })
    const b = out[1]
    expect(b.agent).toBe('alice')
    expect(b.model).toBe('openai/GPT-OSS-120B') // from { primary }
    expect(b.channel).toBe('webchat') // falls back to lastChannel
    expect(b.totalTokens).toBe(0)
    expect(b.contextTokens).toBe(0)
    expect(b.active).toBe(true) // 1s ago < 1h window
  })

  it('returns [] for null / malformed / missing sessions', () => {
    expect(mapGatewayRpcSessions(null, { now: NOW, activeWithinMs: WINDOW })).toEqual([])
    expect(mapGatewayRpcSessions({}, { now: NOW, activeWithinMs: WINDOW })).toEqual([])
    expect(mapGatewayRpcSessions({ sessions: 'nope' }, { now: NOW, activeWithinMs: WINDOW })).toEqual([])
  })

  it('skips entries without a usable key', () => {
    const out = mapGatewayRpcSessions(
      { sessions: [{ key: '', updatedAt: NOW }, { updatedAt: NOW }] },
      { now: NOW, activeWithinMs: WINDOW },
    )
    expect(out).toEqual([])
  })
})

// -- Suspended-pod session cache (Phase A) --------------------------------
//
// When the remote pod is suspended, `sessions.list` returns [] / errors. The
// sessions route persists the last-good mapped list in the `settings` KV table
// and serves it (flagged `stale`) so the sidebar is not empty. This path is
// PASSIVE: it must never trigger a wake.

const settingsStore = new Map<string, string>()
const callGatewayMock = vi.fn()
const getDetectedTokenMock = vi.fn(() => 'gw-token')
const prepareMock = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { username: 'tester', role: 'viewer', workspace_id: 1 } })),
}))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: vi.fn(() => null) }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: callGatewayMock }))
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
// Keep the real (pure) mapGatewayRpcSessions; only stub the on-disk scan.
vi.mock('@/lib/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessions')>()
  return { ...actual, getAllGatewaySessions: vi.fn(() => []) }
})

const CACHE_KEY = 'gateway_sessions_cache:alice'

function makeCachedSession(overrides: Record<string, unknown> = {}) {
  return {
    key: 'agent:main:main',
    agent: 'main',
    sessionId: 'fd0b25f3',
    updatedAt: NOW,
    chatType: 'direct',
    channel: 'webchat',
    model: 'GPT-OSS-120B',
    totalTokens: 100,
    inputTokens: 50,
    outputTokens: 50,
    contextTokens: 1000,
    active: true,
    ...overrides,
  }
}

describe('getGatewayRpcSessions suspended-pod cache', () => {
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
        return {
          get: (key: string) => {
            const value = settingsStore.get(key)
            return value === undefined ? undefined : { value }
          },
        }
      }
      if (sql.includes('FROM claude_sessions')) {
        return { all: () => [] }
      }
      throw new Error(`Unexpected SQL in test: ${sql}`)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('overwrites the KV cache blob with the mapped list on RPC success', async () => {
    // Pre-seed a stale blob to prove it is overwritten with the fresh list.
    settingsStore.set(CACHE_KEY, JSON.stringify([{ key: 'agent:old:main', stale: true }]))
    callGatewayMock.mockResolvedValue(payload)

    const { GET } = await import('@/app/api/sessions/route')
    const res = await GET(new NextRequest('http://localhost/api/sessions'))
    expect(res.status).toBe(200)

    const stored = settingsStore.get(CACHE_KEY)
    expect(stored).toBeDefined()
    const parsed = JSON.parse(stored as string)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((s: { key: string }) => s.key)).toEqual(['agent:main:main', 'agent:alice:web-x'])
    // Freshly written entries are not stale.
    expect(parsed.every((s: { stale?: boolean }) => !s.stale)).toBe(true)
  })

  it('serves cached entries flagged stale:true and active:false on RPC failure', async () => {
    settingsStore.set(CACHE_KEY, JSON.stringify([makeCachedSession()]))
    callGatewayMock.mockRejectedValue(new Error('websocket error: closed before ready'))

    const { GET } = await import('@/app/api/sessions/route')
    const res = await GET(new NextRequest('http://localhost/api/sessions'))
    const body = await res.json() as { sessions: Array<Record<string, unknown>> }

    const gw = body.sessions.find((s) => s.key === 'agent:main:main')
    expect(gw).toBeDefined()
    expect(gw?.stale).toBe(true)
    expect(gw?.active).toBe(false)
    expect(gw?.source).toBe('gateway')
  })

  it('threads stale through mapGatewaySessions into the client-facing shape', async () => {
    // Cached entry was active when captured; the stale mapping must flip it off.
    settingsStore.set(CACHE_KEY, JSON.stringify([makeCachedSession({ active: true })]))
    callGatewayMock.mockRejectedValue(new Error('timed out'))

    const { GET } = await import('@/app/api/sessions/route')
    const res = await GET(new NextRequest('http://localhost/api/sessions'))
    const body = await res.json() as { sessions: Array<Record<string, unknown>> }

    const gw = body.sessions.find((s) => s.key === 'agent:main:main')
    expect(gw).toBeDefined()
    expect(gw?.stale).toBe(true)
    expect(gw?.active).toBe(false)
  })

  it('returns [] (no stale entries) on failure when the cache is empty', async () => {
    callGatewayMock.mockRejectedValue(new Error('websocket error'))

    const { GET } = await import('@/app/api/sessions/route')
    const res = await GET(new NextRequest('http://localhost/api/sessions'))
    const body = await res.json() as { sessions: Array<Record<string, unknown>> }

    expect(body.sessions.some((s) => s.source === 'gateway')).toBe(false)
  })
})
