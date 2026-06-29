/**
 * Pure mapping helpers that translate pod-gateway RPC payloads into the existing
 * Mission Control UI types. These are the data-source-swap glue for re-sourcing
 * the chat workspace from host REST routes to gateway RPC over the WebSocket.
 *
 * Shapes here were captured against the REAL pod gateway (tenant alice, broker
 * `/ws/gateway`). The gateway returns RPC results under `frame.payload`:
 *   sessions.list -> { ts, path, count, defaults, sessions: GatewaySession[] }
 *   chat.history  -> { sessionKey, messages: GatewayHistoryMessage[], thinkingLevel }
 *   chat.send     -> { runId, status }
 *
 * Kept free of DOM/node imports so it can be unit-tested in isolation.
 */
import type { Conversation, ChatMessage, Agent } from '@/store'
import type { SessionTranscriptMessage } from './session-message'

export interface GatewaySession {
  key?: string
  kind?: string
  displayName?: string
  chatType?: string
  origin?: {
    label?: string
    provider?: string
    surface?: string
    chatType?: string
    from?: string
    to?: string
  }
  updatedAt?: number // epoch ms
  sessionId?: string
  systemSent?: boolean
  abortedLastRun?: boolean
  totalTokens?: number
  modelProvider?: string
  model?: string
  deliveryContext?: Record<string, unknown>
  lastChannel?: string
  lastTo?: string
}

export interface GatewaySessionsResult {
  sessions?: unknown[]
  count?: number
  defaults?: { modelProvider?: string; model?: string; contextTokens?: number }
}

// Mirror of the tag palette rendered in conversation-list.tsx (TAG_COLORS).
const TAG_COLOR_NAMES = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'teal'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/** Deterministic color tag derived from a session key (stable across reloads). */
export function gatewayColorTag(key: string): (typeof TAG_COLOR_NAMES)[number] {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  return TAG_COLOR_NAMES[hash % TAG_COLOR_NAMES.length]
}

/** Extract the owning agent id from a gateway session key (`agent:<id>:<rest>`). */
export function agentFromKey(key: string): string | undefined {
  const parts = key.split(':')
  if (parts[0] === 'agent' && parts[1]) return parts[1]
  return undefined
}

/** Short human age (`now` / `5m` / `2h` / `3d`) from a ms delta. */
function formatAgeMs(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) deltaMs = 0
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const ACTIVE_WINDOW_MS = 60 * 60 * 1000

/**
 * Map a single gateway session into the existing `Conversation` shape used by
 * conversation-list.tsx. Returns null for entries without a usable key.
 */
export function gatewaySessionToConversation(
  session: GatewaySession,
  nowMs: number = Date.now(),
): Conversation | null {
  if (!session || typeof session !== 'object') return null
  const key = typeof session.key === 'string' ? session.key : undefined
  if (!key) return null

  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : key
  const convId = `session:gateway:${sessionId}`
  const prefKey = `gateway:${sessionId}`
  const displayName = session.displayName || key
  const updatedAtMs = typeof session.updatedAt === 'number' ? session.updatedAt : 0
  const updatedAtSec = updatedAtMs > 0 ? Math.floor(updatedAtMs / 1000) : Math.floor(nowMs / 1000)
  const active = updatedAtMs > 0 ? nowMs - updatedAtMs < ACTIVE_WINDOW_MS : false
  const age = formatAgeMs(nowMs - (updatedAtMs || nowMs))
  const model = typeof session.model === 'string' ? session.model : undefined
  const tokens = typeof session.totalTokens === 'number' ? String(session.totalTokens) : undefined

  const summary = [model, typeof session.totalTokens === 'number' && session.totalTokens > 0
    ? `${session.totalTokens} tokens`
    : '']
    .filter(Boolean)
    .join(' • ')

  return {
    id: convId,
    name: displayName,
    kind: 'gateway',
    source: 'session',
    session: {
      prefKey,
      sessionId,
      // chat.history / chat.send accept the full `agent:<id>:<rest>` key.
      sessionKey: key,
      sessionKind: 'gateway',
      agent: agentFromKey(key),
      displayName,
      colorTag: gatewayColorTag(key),
      model,
      tokens,
      workingDir: null,
      lastUserPrompt: null,
      active,
      age,
    },
    participants: [],
    lastMessage: {
      id: updatedAtSec,
      conversation_id: convId,
      from_agent: 'system',
      to_agent: null,
      content: summary,
      message_type: 'system',
      created_at: updatedAtSec,
    },
    unreadCount: 0,
    updatedAt: updatedAtSec,
  }
}

/**
 * Map the full `sessions.list` payload into a sorted `Conversation[]`
 * (newest first). Tolerates an empty/zero-session result and malformed entries.
 */
export function gatewaySessionsToConversations(
  result: GatewaySessionsResult | undefined | null,
  nowMs: number = Date.now(),
): Conversation[] {
  const sessions = isObject(result) && Array.isArray(result.sessions) ? result.sessions : []
  return sessions
    .map((s) => gatewaySessionToConversation(s as GatewaySession, nowMs))
    .filter((c): c is Conversation => c !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Map the gateway `agents.list` result (`{ defaultId, mainKey, scope, agents:[{ id }] }`)
 * into the existing UI `Agent[]` shape. Only `id` is present per agent, so the rest are
 * minimal defaults. Tolerates malformed input (returns no agents). Scales to N agents.
 */
export function gatewayAgentsToAgents(
  result: unknown,
): { agents: Agent[]; mainKey: string | undefined } {
  const mainKey =
    isObject(result) && typeof result.mainKey === 'string' ? result.mainKey : undefined
  const list = isObject(result) && Array.isArray(result.agents) ? result.agents : []
  const agents = list
    .map((entry, i): Agent | null => {
      if (!isObject(entry) || typeof entry.id !== 'string') return null
      return {
        id: i + 1,
        name: entry.id,
        role: '',
        status: 'idle',
        created_at: 0,
        updated_at: 0,
      }
    })
    .filter((a): a is Agent => a !== null)
  return { agents, mainKey }
}

/**
 * Merge a freshly-mapped `chat.history` array with the current in-memory
 * messages, preserving in-flight optimistic turns (negative-id `sending`/`failed`
 * bubbles) that history has not echoed back yet. Once history contains the user's
 * turn (same content), the optimistic copy drops naturally. Pure / unit-testable.
 */
export function mergeHistoryWithPending(
  mappedHistory: ChatMessage[],
  currentMessages: ChatMessage[],
): ChatMessage[] {
  const historyContents = new Set(mappedHistory.map((m) => m.content))
  const pending = currentMessages.filter(
    (m) =>
      (m.pendingStatus === 'sending' || m.pendingStatus === 'failed') &&
      !historyContents.has(m.content),
  )
  return [...mappedHistory, ...pending]
}

// --- transcript / message mapping ---------------------------------------------

type MessageContentPart = SessionTranscriptMessage['parts'][number]

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/i

function isSilentReplyText(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text.trim())
}

/**
 * Flatten a gateway message `content` (string OR Claude content-block array)
 * into transcript parts. Mirrors the server-side parseTranscriptParts so the
 * pod-RPC path renders identically to the legacy disk/host path.
 */
function parseContentParts(content: unknown): MessageContentPart[] {
  const parts: MessageContentPart[] = []

  if (typeof content === 'string') {
    if (content.trim() && !isSilentReplyText(content)) {
      parts.push({ type: 'text', text: content.trim().slice(0, 8000) })
    }
    return parts
  }

  if (!Array.isArray(content)) return parts

  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      if (!isSilentReplyText(block.text)) {
        parts.push({ type: 'text', text: block.text.trim().slice(0, 8000) })
      }
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push({ type: 'thinking', thinking: block.thinking.slice(0, 4000) })
    } else if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : 'unknown',
        input: JSON.stringify(block.input ?? {}).slice(0, 500),
      })
    } else if (block.type === 'tool_result') {
      const raw = block.content
      const resultContent = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : '')).join('\n')
          : ''
      if (resultContent.trim()) {
        parts.push({
          type: 'tool_result',
          toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: resultContent.trim().slice(0, 8000),
          isError: block.is_error === true,
        })
      }
    }
  }

  return parts
}

function normalizeRole(role: unknown): SessionTranscriptMessage['role'] {
  return role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user'
}

/**
 * Map a `chat.history` `messages` array into `SessionTranscriptMessage[]` for
 * the SessionConversationView transcript. Drops messages that render to nothing.
 */
export function gatewayHistoryToTranscript(
  messages: unknown[] | undefined | null,
): SessionTranscriptMessage[] {
  if (!Array.isArray(messages)) return []
  const out: SessionTranscriptMessage[] = []
  for (const value of messages) {
    if (!isObject(value)) continue
    const parts = parseContentParts(value.content ?? value.text)
    if (parts.length === 0) continue
    out.push({
      role: normalizeRole(value.role),
      parts,
      timestamp: typeof value.timestamp === 'string' ? value.timestamp : undefined,
    })
  }
  return out
}

/** Collapse transcript parts to a single plain-text string for ChatMessage. */
function partsToText(parts: MessageContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_use' ? `[tool: ${p.name}]` : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Map a `chat.history` entry into the store `ChatMessage` shape used by the
 * MessageList (direct `agent_<name>` conversations). Returns null when there is
 * no renderable text. `conversationId` is the MC conversation id (== sessionKey).
 */
export function gatewayMessageToChatMessage(
  entry: unknown,
  conversationId: string,
  index: number,
): ChatMessage | null {
  if (!isObject(entry)) return null
  const parts = parseContentParts(entry.content ?? entry.text)
  const text = partsToText(parts)
  if (!text) return null

  const role = normalizeRole(entry.role)
  const agent = conversationId.startsWith('agent_')
    ? conversationId.slice('agent_'.length)
    : agentFromKey(conversationId) || 'agent'

  const tsMs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const createdAt = Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : Math.floor(Date.now() / 1000)

  return {
    id: Number.isFinite(tsMs) ? Math.floor(tsMs) + index : index + 1,
    conversation_id: conversationId,
    from_agent: role === 'assistant' ? agent : 'human',
    to_agent: role === 'assistant' ? null : agent,
    content: text,
    message_type: 'text',
    created_at: createdAt,
  }
}
