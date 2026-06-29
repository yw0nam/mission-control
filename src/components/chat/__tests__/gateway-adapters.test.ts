import { describe, it, expect } from 'vitest'
import {
  gatewaySessionToConversation,
  gatewaySessionsToConversations,
  gatewayColorTag,
  gatewayHistoryToTranscript,
  gatewayMessageToChatMessage,
  gatewayAgentsToAgents,
  mergeHistoryWithPending,
  gatewaySkillsToSkills,
  parseGatewayLogLine,
  gatewayLogsToEntries,
  gatewayCostToOverview,
  gatewayStatusToOverview,
  gatewayHealthToPodHealth,
  gatewayRosterFromStatus,
  type GatewaySession,
} from '../gateway-adapters'
import type { ChatMessage } from '@/store'

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

describe('gatewayAgentsToAgents', () => {
  // agents.list returns { defaultId, mainKey, scope, agents:[{ id }] } (only id per agent).
  it('maps an N-agent payload into Agent[] keyed on id (name) and passes mainKey through', () => {
    const { agents, mainKey } = gatewayAgentsToAgents({
      defaultId: 'main',
      mainKey: 'main',
      scope: 'per-sender',
      agents: [{ id: 'main' }, { id: 'researcher' }],
    })
    expect(agents).toHaveLength(2)
    expect(agents.map((a) => a.name)).toEqual(['main', 'researcher'])
    expect(mainKey).toBe('main')
  })

  it('returns [] for an empty agents list (keeping mainKey when present)', () => {
    expect(gatewayAgentsToAgents({ agents: [] })).toEqual({ agents: [], mainKey: undefined })
    expect(gatewayAgentsToAgents({ mainKey: 'main', agents: [] })).toEqual({
      agents: [],
      mainKey: 'main',
    })
  })

  it('tolerates malformed input instead of throwing', () => {
    expect(gatewayAgentsToAgents(null)).toEqual({ agents: [], mainKey: undefined })
    expect(gatewayAgentsToAgents({})).toEqual({ agents: [], mainKey: undefined })
    expect(gatewayAgentsToAgents({ agents: 'nope' })).toEqual({ agents: [], mainKey: undefined })
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

describe('mergeHistoryWithPending', () => {
  const historyMsg = (content: string, id: number): ChatMessage => ({
    id,
    conversation_id: 'agent:main:main',
    from_agent: 'human',
    to_agent: 'main',
    content,
    message_type: 'text',
    created_at: 0,
  })
  const pending = (content: string, id: number, status: 'sending' | 'failed' | 'sent'): ChatMessage => ({
    id,
    conversation_id: 'agent:main:main',
    from_agent: 'human',
    to_agent: 'main',
    content,
    message_type: 'text',
    created_at: 0,
    pendingStatus: status,
  })

  it('returns history unchanged when there are no pending messages', () => {
    const history = [historyMsg('hi', 1), historyMsg('there', 2)]
    expect(mergeHistoryWithPending(history, [])).toEqual(history)
  })

  it('keeps a sending optimistic message whose content is not yet in history', () => {
    const history = [historyMsg('earlier', 1)]
    const current = [historyMsg('earlier', 1), pending('new turn', -1, 'sending')]
    const merged = mergeHistoryWithPending(history, current)
    expect(merged).toHaveLength(2)
    expect(merged[merged.length - 1]).toMatchObject({ content: 'new turn', pendingStatus: 'sending' })
  })

  it('drops the optimistic message once history contains the same content', () => {
    const history = [historyMsg('earlier', 1), historyMsg('new turn', 2)]
    const current = [historyMsg('earlier', 1), pending('new turn', -1, 'sending')]
    const merged = mergeHistoryWithPending(history, current)
    expect(merged).toEqual(history)
  })
})

describe('gatewaySkillsToSkills', () => {
  // Real shape captured from skills.status on tenant alice.
  const fixture = {
    workspaceDir: '/home/openclaw/.openclaw/workspace',
    skills: [
      { name: '1password', description: 'Use 1Password CLI', source: 'openclaw-bundled', skillKey: '1password', filePath: '/app/skills/1password/SKILL.md', emoji: '🔐', eligible: false },
      { name: 'git', description: 'git helper', source: 'openclaw-bundled', skillKey: 'git', filePath: '/app/skills/git/SKILL.md' },
      { name: 'custom', description: 'a custom one', source: 'workspace', skillKey: 'custom', filePath: '/ws/custom/SKILL.md' },
    ],
  }

  it('maps gateway skills to SkillSummary rows (id←skillKey, path←filePath)', () => {
    const { skills, total } = gatewaySkillsToSkills(fixture)
    expect(total).toBe(3)
    expect(skills[0]).toEqual({
      id: '1password',
      name: '1password',
      source: 'openclaw-bundled',
      path: '/app/skills/1password/SKILL.md',
      description: 'Use 1Password CLI',
      registry_slug: null,
      security_status: null,
    })
  })

  it('synthesizes groups by source', () => {
    const { groups } = gatewaySkillsToSkills(fixture)
    const bundled = groups.find((g) => g.source === 'openclaw-bundled')
    const ws = groups.find((g) => g.source === 'workspace')
    expect(bundled?.skills).toHaveLength(2)
    expect(ws?.skills).toHaveLength(1)
  })

  it('tolerates junk', () => {
    expect(gatewaySkillsToSkills(null)).toEqual({ skills: [], groups: [], total: 0 })
    expect(gatewaySkillsToSkills({ skills: [{ no: 'name' }] })).toEqual({ skills: [], groups: [], total: 0 })
  })
})

describe('parseGatewayLogLine / gatewayLogsToEntries', () => {
  // Real line captured from logs.tail on tenant alice.
  const realLine =
    '{"0":"{\\"subsystem\\":\\"gateway/ws\\"}","1":"\\u21c4 res \\u2713 skills.status 213ms","_meta":{"runtime":"node","hostname":"alice-0","parentNames":["openclaw"],"date":"2026-06-29T03:19:28.518Z","logLevelName":"INFO"},"time":"2026-06-29T03:19:28.519Z"}'

  it('parses a real gateway log line into a LogEntry', () => {
    const entry = parseGatewayLogLine(realLine, 0)
    expect(entry.level).toBe('info')
    expect(entry.source).toBe('gateway/ws')
    expect(entry.message).toBe('⇄ res ✓ skills.status 213ms')
    expect(entry.timestamp).toBe(Date.parse('2026-06-29T03:19:28.519Z'))
    expect(entry.id).toContain('-0')
  })

  it('extracts the human message from a multi-arg line (message under "2", not "1")', () => {
    // Real shape: log({subsystem}, {structured}, "heartbeat: started")
    const line =
      '{"0":"{\\"subsystem\\":\\"gateway/heartbeat\\"}","1":{"intervalMs":1800000},"2":"heartbeat: started","_meta":{"logLevelName":"INFO","parentNames":["openclaw"]},"time":"2026-06-29T02:49:47.066Z"}'
    const entry = parseGatewayLogLine(line, 0)
    expect(entry.source).toBe('gateway/heartbeat')
    expect(entry.message).toBe('heartbeat: started')
  })

  it('maps WARN/ERROR/FATAL/TRACE level names', () => {
    const mk = (lvl: string) => parseGatewayLogLine(`{"1":"m","_meta":{"logLevelName":"${lvl}"},"time":"x"}`, 0, 1000).level
    expect(mk('WARN')).toBe('warn')
    expect(mk('ERROR')).toBe('error')
    expect(mk('FATAL')).toBe('error')
    expect(mk('TRACE')).toBe('debug')
  })

  it('falls back to the raw string for non-JSON lines', () => {
    const entry = parseGatewayLogLine('plain text log', 2, 1000)
    expect(entry.message).toBe('plain text log')
    expect(entry.level).toBe('info')
    expect(entry.timestamp).toBe(1000)
  })

  it('gatewayLogsToEntries maps the lines array and tolerates junk', () => {
    expect(gatewayLogsToEntries({ lines: [realLine] })).toHaveLength(1)
    expect(gatewayLogsToEntries(null)).toEqual([])
  })
})

describe('gatewayCostToOverview', () => {
  const fixture = {
    updatedAt: 1,
    days: 2,
    daily: [
      { date: '2026-06-26', totalTokens: 9545, totalCost: 0 },
      { date: '2026-06-27', totalTokens: 100, totalCost: 1.5 },
    ],
    totals: { totalTokens: 9645, totalCost: 1.5, input: 9517, output: 28 },
  }

  it('maps totals to the summary and daily to trends', () => {
    const { summary, trends } = gatewayCostToOverview(fixture)
    expect(summary.totalTokens).toBe(9645)
    expect(summary.totalCost).toBe(1.5)
    expect(trends).toEqual([
      { timestamp: '2026-06-26', tokens: 9545, cost: 0, requests: 0 },
      { timestamp: '2026-06-27', tokens: 100, cost: 1.5, requests: 0 },
    ])
  })

  it('tolerates junk', () => {
    expect(gatewayCostToOverview(null)).toEqual({
      summary: { totalTokens: 0, totalCost: 0, requestCount: 0, avgTokensPerRequest: 0, avgCostPerRequest: 0 },
      trends: [],
    })
  })
})

describe('gatewayStatusToOverview', () => {
  const fixture = {
    heartbeat: { defaultAgentId: 'main', agents: [{ id: 'main' }] },
    sessions: {
      count: 10,
      recent: [
        { key: 'agent:main:main', agentId: 'main', model: 'GPT-OSS-120B', totalTokens: 10677, updatedAt: 1782700471279 },
      ],
    },
  }

  it('maps status into the pod overview view-model', () => {
    const o = gatewayStatusToOverview(fixture)
    expect(o.defaultAgentId).toBe('main')
    expect(o.sessionCount).toBe(10)
    expect(o.recent[0]).toEqual({
      key: 'agent:main:main',
      agentId: 'main',
      model: 'GPT-OSS-120B',
      totalTokens: 10677,
      updatedAtMs: 1782700471279,
    })
  })

  it('tolerates junk', () => {
    expect(gatewayStatusToOverview(null)).toEqual({ defaultAgentId: undefined, sessionCount: 0, recent: [] })
  })
})

describe('gatewayHealthToPodHealth', () => {
  it('maps health into the pod health view-model', () => {
    const h = gatewayHealthToPodHealth({
      ok: true,
      durationMs: 12,
      heartbeatSeconds: 30,
      defaultAgentId: 'main',
      agents: [{ agentId: 'main', isDefault: true }],
      sessions: { count: 5 },
    })
    expect(h).toEqual({ ok: true, durationMs: 12, heartbeatSeconds: 30, defaultAgentId: 'main', agents: ['main'], sessionCount: 5 })
  })

  it('tolerates junk', () => {
    expect(gatewayHealthToPodHealth(null).ok).toBe(false)
  })
})

describe('gatewayRosterFromStatus', () => {
  const agents = { defaultId: 'main', mainKey: 'main', agents: [{ id: 'main' }, { id: 'helper' }] }
  const status = {
    sessions: {
      byAgent: [
        {
          agentId: 'main',
          count: 10,
          recent: [
            { model: 'GPT-OSS-120B', updatedAt: 100 },
            { model: 'GPT-OSS-120B', updatedAt: 500 },
          ],
        },
      ],
    },
  }

  it('joins the id-only roster with per-agent session stats', () => {
    const rows = gatewayRosterFromStatus(agents, status)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 'main', sessionCount: 10, model: 'GPT-OSS-120B', lastActivityMs: 500 })
    // agent with no session stats still appears, zeroed
    expect(rows[1]).toEqual({ id: 'helper', sessionCount: 0, model: undefined, lastActivityMs: 0 })
  })

  it('tolerates junk', () => {
    expect(gatewayRosterFromStatus(null, null)).toEqual([])
  })
})
