import { describe, it, expect } from 'vitest'
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
