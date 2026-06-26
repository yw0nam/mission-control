import { describe, it, expect } from 'vitest'
import {
  gatewaySessionToConversation,
  gatewaySessionsToConversations,
  gatewayColorTag,
  gatewayHistoryToTranscript,
  gatewayMessageToChatMessage,
  type GatewaySession,
} from '../gateway-adapters'

// Fixtures captured from the REAL pod gateway (tenant alice, broker /ws/gateway)
// via scratchpad probes. sessions.list returns its data under frame.payload:
//   { ts, path, count, defaults:{...}, sessions:[ ... ] }
const REAL_PROBE_SESSION: GatewaySession = {
  key: 'agent:main:probe-1782446954826',
  kind: 'direct',
  displayName: 'Mission Control',
  chatType: 'direct',
  origin: { label: 'Mission Control', provider: 'webchat', surface: 'webchat', chatType: 'direct' },
  updatedAt: 1782446954942,
  sessionId: '9a522820-70b6-4a72-8060-b4f9635b02d3',
  systemSent: true,
  abortedLastRun: false,
  totalTokens: 0,
  modelProvider: 'openai',
  model: 'GPT-OSS-120B',
  deliveryContext: { channel: 'webchat' },
  lastChannel: 'webchat',
}

const REAL_HEARTBEAT_SESSION: GatewaySession = {
  key: 'agent:main:main',
  kind: 'direct',
  displayName: 'heartbeat',
  chatType: 'direct',
  origin: { label: 'heartbeat', provider: 'heartbeat', from: 'heartbeat', to: 'heartbeat' },
  updatedAt: 1782355511025,
  sessionId: '35593d5a-fd57-4f71-805b-af035c3fb44d',
  systemSent: true,
  abortedLastRun: false,
  totalTokens: 0,
  modelProvider: 'openai',
  model: 'GPT-OSS-120B',
  deliveryContext: { to: 'heartbeat' },
  lastTo: 'heartbeat',
}

// A point in time just after the probe session's updatedAt, so it counts as
// "active" (<1h old) and the heartbeat session (~25h old) counts as "recent".
const NOW = 1782446955000

describe('gatewaySessionToConversation', () => {
  it('maps a real gateway session field-by-field into the Conversation shape', () => {
    const conv = gatewaySessionToConversation(REAL_PROBE_SESSION, NOW)
    expect(conv).not.toBeNull()
    const c = conv!

    expect(c.id).toBe('session:gateway:9a522820-70b6-4a72-8060-b4f9635b02d3')
    expect(c.name).toBe('Mission Control')
    expect(c.kind).toBe('gateway')
    expect(c.source).toBe('session')
    expect(c.participants).toEqual([])
    expect(c.unreadCount).toBe(0)
    // updatedAt normalised from ms -> seconds
    expect(c.updatedAt).toBe(Math.floor(1782446954942 / 1000))

    const s = c.session!
    expect(s.prefKey).toBe('gateway:9a522820-70b6-4a72-8060-b4f9635b02d3')
    expect(s.sessionId).toBe('9a522820-70b6-4a72-8060-b4f9635b02d3')
    // RPC key is the full gateway session key (chat.history/chat.send accept it)
    expect(s.sessionKey).toBe('agent:main:probe-1782446954826')
    expect(s.sessionKind).toBe('gateway')
    expect(s.agent).toBe('main')
    expect(s.displayName).toBe('Mission Control')
    expect(s.model).toBe('GPT-OSS-120B')
    expect(s.tokens).toBe('0')
    expect(s.workingDir).toBeNull()
    expect(s.lastUserPrompt).toBeNull()
    expect(s.active).toBe(true)
    expect(s.age).toBe('now')
    // colorTag is derived deterministically from the key
    expect(s.colorTag).toBe(gatewayColorTag('agent:main:probe-1782446954826'))

    // lastMessage is a deterministic system summary row
    expect(c.lastMessage).toMatchObject({
      conversation_id: 'session:gateway:9a522820-70b6-4a72-8060-b4f9635b02d3',
      from_agent: 'system',
      to_agent: null,
      message_type: 'system',
    })
    expect(c.lastMessage!.content).toContain('GPT-OSS-120B')
  })

  it('marks an old session as inactive and formats a day-scale age', () => {
    const c = gatewaySessionToConversation(REAL_HEARTBEAT_SESSION, NOW)!
    expect(c.name).toBe('heartbeat')
    expect(c.session!.active).toBe(false)
    expect(c.session!.age).toBe('1d')
    expect(c.session!.agent).toBe('main')
  })

  it('falls back to the key for the name when displayName is missing', () => {
    const bare: GatewaySession = { key: 'agent:jarv:task-7', sessionId: 'uuid-x' }
    const c = gatewaySessionToConversation(bare, NOW)!
    expect(c.name).toBe('agent:jarv:task-7')
    expect(c.session!.displayName).toBe('agent:jarv:task-7')
    expect(c.session!.agent).toBe('jarv')
    expect(c.session!.model).toBeUndefined()
    expect(c.session!.tokens).toBeUndefined()
  })

  it('returns null for an entry without a usable key', () => {
    expect(gatewaySessionToConversation({} as GatewaySession, NOW)).toBeNull()
    expect(gatewaySessionToConversation({ sessionId: 'x' } as GatewaySession, NOW)).toBeNull()
  })

  it('derives sessionId from the key when sessionId is absent', () => {
    const c = gatewaySessionToConversation({ key: 'agent:main:abc' } as GatewaySession, NOW)!
    expect(c.session!.sessionId).toBe('agent:main:abc')
    expect(c.id).toBe('session:gateway:agent:main:abc')
  })
})

describe('gatewaySessionsToConversations', () => {
  it('maps the full sessions.list payload and sorts by updatedAt desc', () => {
    const payload = {
      ts: 1782446959911,
      count: 2,
      defaults: { modelProvider: 'openai', model: 'GPT-OSS-120B', contextTokens: 200000 },
      sessions: [REAL_HEARTBEAT_SESSION, REAL_PROBE_SESSION],
    }
    const convs = gatewaySessionsToConversations(payload, NOW)
    expect(convs).toHaveLength(2)
    // probe session is newer -> sorts first
    expect(convs[0].name).toBe('Mission Control')
    expect(convs[1].name).toBe('heartbeat')
  })

  it('handles an empty/zero-session result (alice with no sessions)', () => {
    expect(gatewaySessionsToConversations({}, NOW)).toEqual([])
    expect(gatewaySessionsToConversations({ sessions: [] }, NOW)).toEqual([])
    expect(gatewaySessionsToConversations(undefined, NOW)).toEqual([])
  })

  it('skips malformed session entries instead of throwing', () => {
    const convs = gatewaySessionsToConversations(
      { sessions: [REAL_PROBE_SESSION, null, {}, 'nope'] as unknown[] },
      NOW,
    )
    expect(convs).toHaveLength(1)
  })
})

describe('gatewayColorTag', () => {
  it('is deterministic and always a known tag color', () => {
    const palette = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'teal']
    const a = gatewayColorTag('agent:main:probe-1')
    const b = gatewayColorTag('agent:main:probe-1')
    expect(a).toBe(b)
    expect(palette).toContain(a)
  })
})

describe('gatewayHistoryToTranscript', () => {
  // chat.history returns { sessionKey, messages, thinkingLevel }; each message is
  // Claude-format { role, content, timestamp } (string OR content-block array).
  const messages = [
    { role: 'user', content: 'hello there', timestamp: '2026-06-24T10:00:00.000Z' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me think' },
        { type: 'text', text: 'hi!' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
      ],
      timestamp: '2026-06-24T10:00:05.000Z',
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt', is_error: false }],
    },
  ]

  it('maps Claude-format history entries into SessionTranscriptMessage[]', () => {
    const out = gatewayHistoryToTranscript(messages)
    expect(out).toHaveLength(3)

    expect(out[0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', text: 'hello there' }],
      timestamp: '2026-06-24T10:00:00.000Z',
    })

    expect(out[1].role).toBe('assistant')
    expect(out[1].timestamp).toBe('2026-06-24T10:00:05.000Z')
    expect(out[1].parts).toEqual([
      { type: 'thinking', thinking: 'let me think' },
      { type: 'text', text: 'hi!' },
      { type: 'tool_use', id: 't1', name: 'bash', input: JSON.stringify({ cmd: 'ls' }) },
    ])

    expect(out[2].parts).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: 'file.txt', isError: false },
    ])
    expect(out[2].timestamp).toBeUndefined()
  })

  it('defaults an unknown role to user and skips empty messages', () => {
    const out = gatewayHistoryToTranscript([
      { role: 'tool', content: 'ping' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [] },
      null,
      'garbage',
    ] as unknown[])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].parts).toEqual([{ type: 'text', text: 'ping' }])
  })

  it('returns [] for an empty history (the common pod case)', () => {
    expect(gatewayHistoryToTranscript([])).toEqual([])
    expect(gatewayHistoryToTranscript(undefined)).toEqual([])
  })
})

describe('gatewayMessageToChatMessage', () => {
  it('maps a user history entry into the store ChatMessage shape', () => {
    const msg = gatewayMessageToChatMessage(
      { role: 'user', content: 'do the thing', timestamp: '2026-06-24T10:00:00.000Z' },
      'agent_main',
      0,
    )
    expect(msg).not.toBeNull()
    expect(msg).toMatchObject({
      conversation_id: 'agent_main',
      from_agent: 'human',
      to_agent: 'main',
      content: 'do the thing',
      message_type: 'text',
    })
    expect(msg!.created_at).toBe(Math.floor(Date.parse('2026-06-24T10:00:00.000Z') / 1000))
    expect(typeof msg!.id).toBe('number')
  })

  it('maps an assistant entry (agent -> human) and flattens content blocks to text', () => {
    const msg = gatewayMessageToChatMessage(
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      'agent_main',
      1,
    )!
    expect(msg.from_agent).toBe('main')
    expect(msg.to_agent).toBeNull()
    expect(msg.content).toBe('done')
  })

  it('returns null when there is no renderable text', () => {
    expect(
      gatewayMessageToChatMessage(
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
        'agent_main',
        0,
      ),
    ).toBeNull()
    expect(gatewayMessageToChatMessage(null, 'agent_main', 0)).toBeNull()
  })
})
