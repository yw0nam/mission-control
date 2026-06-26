# Tenant Chat — Agent Roster + History-Pull — Design

Date: 2026-06-26
Status: design agreed (brainstorming). Implementation plan not yet written.
Scope: completes P1 of the unified scoped console
(`2026-06-26-unified-scoped-console-design.md`) for a **viewer** in their own pod.

## 1. Context

P1 re-sourced the chat/sessions/transcript panels to the pod gateway over `/ws/gateway`
(committed: `9c56360`). Browser verification (viewer `alice`) confirmed sessions list, history
load, and send all round-trip against the pod. Two gaps remain before P1 is truly usable:

1. **No new-conversation roster.** `chat-workspace.tsx loadAgents()` and `conversation-list.tsx`
   still fetch the host `/api/agents`, which a viewer is 403'd from (console:
   `ChatWorkspace: Failed to load agents: Insufficient permissions`). So a viewer can continue an
   existing session but cannot **start a new conversation**, and the "N online" / per-conversation
   status are empty.
2. **Reply delivery depends on a live WS stream.** Task 4 removed the original REST message poll
   and relies on `chat.message` WS events. Those only arrive while the user is connected and
   watching; navigating away, closing the UI, or a scale-to-zero suspend loses them.

## 2. Verified facts (live, 2026-06-26)

- **`agents.list`** (pod gateway) → `{ defaultId:"main", mainKey:"main", scope:"per-sender",
  agents:[{ id:"main" }] }`. A single-tenant pod has **one agent (`main`)**; only `id` is
  available per agent (no status/role/model).
- **`models.list`** → full Bedrock Claude catalog (model choice is real, but not used in this spec).
- **Session key form** is `agent:<agentId>:<bareKey>` (e.g. `agent:main:main`); the gateway
  auto-creates a session on first `chat.send` to a new key (observed via probes).
- **vLLM backend** `192.168.0.41:18032` (OpenAI-compatible) responds: http 200, `GPT-OSS-120B`
  loaded, `/v1/chat/completions` works. Pod egress already allows `192.168.0.41/32:18032`.
  **Caveat:** GPT-OSS-120B is a *reasoning* model — under a tight token budget the text lands in
  a `reasoning` field with `content:null` (`finish_reason:"length"`). Whether the openclaw agent
  surfaces a visible turn is a **pod-agent-config** concern (see §6), not MC re-sourcing.

## 3. Item 2 — Agent roster from `agents.list` (wired for N agents)

The UX (an agent picker that starts a direct conversation) is **kept**, because OpenClaw supports
multiple agents per pod; today there is one (`main`) but the wiring must scale to N.

### 3a. Data-source swap
Replace the host REST roster with the gateway method, in both consumers:
- `chat-workspace.tsx` `loadAgents()` (~:82-94): `apiFetch('/api/agents')` → `call('agents.list')`.
- `conversation-list.tsx` agent rows (~:237-251): consume the same gateway-sourced `agents`.

### 3b. Adapter (pure, TDD)
Add `gatewayAgentsToAgents(result)` to `src/components/chat/gateway-adapters.ts`:
- Maps the **full `agents[]` array** → the UI `Agent[]` shape, so N agents "just work".
- Available field is `id` only → `name = id`; synthesize the rest: `status` defaults to a
  non-fabricated "available" (the agent is reachable whenever the pod is connected), `role`/`model`
  left blank/optional. Carry `defaultId`/`mainKey` through for §3c.
- Tolerant of empty/malformed (returns `[]`).

### 3c. Agent → session-key mapping (the crux)
Today clicking an agent opens a host-chat `convId = agent_<name>` (`conversation-list.tsx:244`),
which is **not** a gateway session key, so `chat.send`/`chat.history` (keyed by `sessionKey`) would
not work. Fix: clicking agent `X` opens that agent's **primary session** `agent:X:main` (using the
gateway `mainKey`), i.e. `onNewConversation` sets `activeConversation` to a real gateway session
key. Sending to it auto-creates the session in the pod if absent. Multi-session creation per agent
(a fresh `agent:X:<newKey>` per "new chat") is **out of scope** (YAGNI; add later).

### 3d. "N online" / status
`agents.list` has no per-agent status. Do **not** fabricate busy/idle. Show online state as
**pod-connected (`isConnected`) + agent count**; per-conversation status degrades to a neutral
label rather than a fake agent state.

## 4. Item 1 — Reply delivery via history pull (`chat.history` is the source of truth)

The pod-persisted transcript — not the live event stream — is authoritative. `chat.history` lives
on the pod PVC and survives navigation, UI close, and scale-to-zero (the broker auto-wakes the pod
on reconnect). The user is **not** expected to watch replies in real time.

### 4a. Mechanism
- Fetch `chat.history` on **session open/select** (already wired) **and** poll it on a **loose
  interval (5–10s) while a session is open** (re-introducing the pull the original UI had, via the
  existing `useSmartPoll`). On return/reopen, the completed reply always renders.
- The live `chat.message` WS event stays as an **opportunistic** real-time update only — kept if it
  remains cheap/already-wired; correctness must not depend on it. If it complicates, drop it.
- Polling stamps last-active only while the chat panel is open; closing it lets the pod idle-suspend
  normally (consistent with the operator-owned scale-to-zero model).

### 4b. Verification (reframed — not "live streaming")
Prove, via Playwright as viewer `alice`: send a message → the agent reply **persists in
`chat.history`** → the UI renders it on poll/refresh/re-entry. Screenshot of user message + agent
reply, sourced over `/ws/gateway`.

## 5. Components / files

- `src/components/chat/gateway-adapters.ts` — add `gatewayAgentsToAgents` (+ unit tests in
  `__tests__/gateway-adapters.test.ts`).
- `src/components/chat/chat-workspace.tsx` — `loadAgents()` → gateway; re-add loose `chat.history`
  poll while a session is open; demote the WS `chat.message` path to opportunistic.
- `src/components/chat/conversation-list.tsx` — agent rows from gateway roster; `onNewConversation`
  maps agent → `agent:<id>:main` session key.
- No backend/broker/auth changes (the gateway already exposes `agents.list`; viewer auth unchanged).

## 6. Risks / out-of-scope

- **Pod agent must persist a visible turn.** If the openclaw agent returns reasoning-only output
  (`content:null`) and never writes a turn to `chat.history`, no UI mechanism can show a reply.
  Verification step 1 confirms a turn is retrievable; if not, it is a **pod agent/model config
  issue** filed separately, **not fixed here**.
- **Multi-session-per-agent creation**, **model picker on new chat**, and **per-agent live status**
  are out of scope (YAGNI).
- In-flight run during a suspend (B2 known issue from lifecycle work) is unchanged here.

## 7. Success criteria (verifiable)

1. Viewer sees the agent roster (today: `main`) from `agents.list`; no `/api/agents` 403 from the
   chat panel; the picker would render N agents unchanged if the pod had more.
2. Clicking an agent opens `agent:<id>:main`; sending a message reaches the pod (`chat.send`).
3. Agent reply appears in the viewer's chat **on poll/refresh/re-entry** (history pull), proven by
   Playwright — independent of whether the user watched in real time.
4. `gatewayAgentsToAgents` and the agent→session-key mapping are unit-tested (TDD).
5. No regression in the committed P1 paths (sessions list, history load, send).
