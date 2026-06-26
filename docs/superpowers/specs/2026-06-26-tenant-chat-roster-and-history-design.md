# Tenant Chat — Agent Roster + History-Pull — Design

Date: 2026-06-26
Status: design agreed + reviewed (3 specialist reviews folded in: ready-with-changes → resolved).
Scope: completes P1 of the unified scoped console
(`2026-06-26-unified-scoped-console-design.md`) for a **viewer** in their own pod.

## 1. Context

P1 re-sourced the chat/sessions/transcript panels to the pod gateway over `/ws/gateway`
(committed `9c56360`). Browser verification (viewer `alice`) confirmed sessions list, history
load, and send round-trip against the pod. Two gaps remain before P1 is usable:

1. **No new-conversation roster.** `chat-workspace.tsx loadAgents()` and `conversation-list.tsx`
   still fetch host `/api/agents` (viewer 403: `ChatWorkspace: Failed to load agents`). A viewer can
   continue an existing session but cannot start a new conversation; "N online" / status are empty.
2. **Reply delivery depends on a live WS stream.** P1 removed the original REST message poll and
   relies on `chat.message` WS events, which only arrive while connected and watching; navigating
   away, closing the UI, or scale-to-zero loses them.

## 2. Verified facts (live, 2026-06-26)

- **`agents.list`** → `{ defaultId:"main", mainKey:"main", scope:"per-sender", agents:[{ id:"main" }] }`.
  One agent (`main`) today; only `id` per agent (no status/role/model).
- **`models.list`** → full Bedrock Claude catalog (real model choice exists; unused here).
- **Session key form** `agent:<agentId>:<bareKey>`; gateway auto-creates a session on first
  `chat.send` to a new key.
- **vLLM backend** `192.168.0.41:18032` (OpenAI-compatible) responds (http 200, `GPT-OSS-120B`,
  `/v1/chat/completions` ok); pod egress allows it. **Caveat:** GPT-OSS-120B is a *reasoning* model —
  under a tight token budget output lands in `reasoning` with `content:null`
  (`finish_reason:"length"`); `gatewayMessageToChatMessage` returns `null` for an empty-text turn
  (`gateway-adapters.ts:275`), so such a turn renders nowhere.

### 2b. Operator-grounded facts (repos = mission-control + openclaw-operator only; the openclaw
gateway/agent runtime is the published image `ghcr.io/openclaw/openclaw` — no local source, so
gateway-behavior facts are empirical probes)
- **Transcripts persist across suspend — CONFIRMED in the operator.** It mounts a per-tenant RWO PVC
  at `/home/openclaw/.openclaw` with retain-on-scale-to-zero/delete (`internal/resources/pvc.go`,
  `statefulset.go`). So `chat.history` survives idle-suspend; §4's premise holds without a probe.
- **Model / token / reasoning config is APP-LAYER, set via the CR `spec.config.raw`** (e.g.
  `agents.defaults.model.*`, `models.providers.*`). The operator only injects API keys /
  `OPENAI_BASE_URL` via `spec.env`/`envFrom` and force-protects `gateway.*` (`configmap.go`,
  `docs/custom-providers.md`). → The §4b "make it demonstrable" knob and the §6 reasoning-only fix
  are **CR `spec.config.raw` changes (operator/CR touch, outside MC)**, not a vLLM request param.
- **`last-active` is stamped by the MC broker on EVERY browser→pod frame** (operator
  `internal/controller/idlesuspend.go` reads the annotation; MC `reportActivity` writes it). So a 10s
  `chat.history` poll DOES bump last-active → a left-open chat panel keeps the pod awake until the tab
  is hidden (when `useSmartPoll` pauses). Accept for P1; tab-hidden pause is the mitigation (§4a).

### 2c. Remaining live probe (gateway source unavailable)
- **`chat.history` echoes the USER turn** (not only assistant): if not, the poll merge could drop the
  user's own message — confirm live before relying on the §4a merge contract.

## 3. Item 2 — Agent roster from `agents.list` (wired for N agents)

Keep the agent-picker UX (OpenClaw is multi-agent; one agent today, wiring must scale to N).

### 3a. Data-source swap (name ALL call sites)
- `chat-workspace.tsx` `loadAgents()` (~:82-94): `apiFetch('/api/agents')` → `call('agents.list')`.
- The real new-conversation handler is **`chat-workspace.tsx handleNewConversation` (~:213)** (passed
  as `onNewConversation` at ~:395) — change it (not only `conversation-list.tsx`).
- **Remove the now-orphaned legacy `agent_` paths:** `handleNewConversation` building `agent_${name}`
  (~:214) and `handleSend`'s `to = activeConversation.replace('agent_', '')` (~:152-154) become dead
  once keys are gateway form — delete them; derive any needed agent id via `agentFromKey()`
  (`gateway-adapters.ts:65`).
- Display: header/status do `.replace('agent_', '')` (~:406-414, ~:902-914) — map the active gateway
  key back through `agentFromKey()` for the agent name, else the header literally shows
  `agent:main:main`.

### 3b. Adapter (pure, TDD)
Add `gatewayAgentsToAgents(result)` to `gateway-adapters.ts`, mirroring the existing tolerant pure
pattern (returns `[]` on junk). Maps the **full `agents[]` array** → UI `Agent[]`:
- `name = agent.id`; `id` (numeric, required) = array index + 1 (stable identity is all it needs —
  `renderAgentItem` keys on `name`); `role = ''`; `created_at`/`updated_at` = 0; **`status = 'idle'`**
  (see §3d). Return `mainKey`/`defaultId` to the caller **separately** (not threaded into each
  `Agent`) for §3c key-building.
- Unit test includes a **synthetic 2-agent fixture** to prove the "scales to N" claim, plus
  empty/malformed cases.

### 3c. Agent → session-key mapping (the crux)
Clicking agent `X` opens that agent's primary session, keyed `agent:${X}:${mainKey}` using the
`mainKey` field from `agents.list` (**not** a hard-coded `"main"`). Set `activeConversation` to that
gateway key so `chat.send`/`chat.history` (which key on `sessionKey`) work. **Reconcile identity
(review A3/C1):** if `conversations` already has a row whose `session.sessionKey` equals that key
(from `sessions.list`, whose row `id` is `session:gateway:<sessionId>`), select **that existing row**
instead of the raw key — avoids a phantom duplicate entry. Otherwise use the raw key (session is
auto-created on first send).
**P1 limitation (explicit):** one persistent conversation per agent — clicking reopens the existing
thread, it does **not** fork a new one. Multi-session-per-agent + a model picker are out of scope.

### 3d. Status / "N online"
`agents.list` has no per-agent status. Map a reachable agent to **`status:'idle'`** (the existing
filters at `chat-workspace.tsx:338` and `conversation-list.tsx:246` test `idle|busy`, so `'idle'`
reads correctly as "online, not busy" with zero consumer edits). This is the laziest correct value;
do not invent `busy`. "N online" then = count of reachable agents while the pod is connected.

## 4. Item 1 — Reply delivery via history pull (single source of truth)

`chat.history` (pod PVC, survives navigation/close/suspend — §2b) is authoritative. The user is not
expected to watch replies live.

### 4a. Mechanism — ONE source (drop the WS path for this feature)
- Fetch `chat.history` on session open/select (already wired) **and** poll it on a fixed **10s**
  interval while a session is open, via the existing `useSmartPoll` with **`pauseWhenDisconnected:
  true, backoff: true`** (do **not** pass `pauseWhenSseConnected` — the poll must run while the WS is
  up). `useSmartPoll` already pauses when the tab is hidden.
- **Do NOT wire or depend on the `chat.message` WS event for replies.** Leave the handler
  (`websocket.ts:612-627`) untouched for other consumers, but it is not a reply source here. (Three
  id spaces — optimistic negative ids, WS server ids, history `timestamp+index` ids — never
  reconcile via the positive-id-only `addChatMessage` dedup, so keeping it would duplicate turns.)
- **Merge contract (do NOT blind-replace):** the poll currently `setChatMessages(mapped)` full-replace
  (`chat-workspace.tsx:116`), which would wipe the in-flight optimistic user bubble (negative id,
  `:158-171`). Instead: render = `mappedHistory` **plus** any optimistic message whose
  `pendingStatus` is `sending`/`failed` and whose content is not yet present in `mappedHistory` for
  this session. Once history contains the user's turn, the optimistic copy drops naturally.
- Poll is read-only (`chat.history`); it never re-issues `chat.send`, so no idempotency interaction.
- Pod-awake interaction: if a `chat.history` poll stamps `last-active` (§2b), a left-open panel keeps
  the pod awake until the tab is hidden/closed; accept this for P1 (tab-hidden pause + 10s cadence is
  the mitigation). If §2b shows it does not stamp, even better.

### 4b. Verification
Split so the MC change is verifiable independent of the model:
- **(MC-owned, must pass)** A turn that EXISTS in `chat.history` renders in the viewer's chat on
  poll/refresh/re-entry (Playwright). Seed/guarantee a persisted turn via the pod's openclaw config
  (CR `spec.config.raw`: a larger token budget or a content-emitting `agents.defaults.model`) — an
  operator/CR change (§2b), outside MC, that makes this demonstrable now.
- **(pod-config, may defer)** The live GPT-OSS-120B agent persists a visible turn unaided. If it
  doesn't (reasoning-only), file the separate pod-agent issue (§6) — Item 1 is still verifiably done.
- Also verify §2b: history survives a suspend/resume; the user turn is echoed by `chat.history`.

## 5. Components / files
- `src/components/chat/gateway-adapters.ts` (+ `__tests__/gateway-adapters.test.ts`) —
  `gatewayAgentsToAgents` (+ 2-agent fixture, key/display via existing `agentFromKey`).
- `src/components/chat/chat-workspace.tsx` — `loadAgents()`→gateway; `handleNewConversation` key
  mapping + identity reconcile; remove orphan `agent_` branches; header/status via `agentFromKey`;
  add the 10s `chat.history` poll with the merge contract.
- `src/components/chat/conversation-list.tsx` — agent rows from gateway roster; `renderAgentItem`
  status read works as-is given §3d (`status:'idle'`).
- No backend/broker/auth/websocket.ts changes.

## 6. Risks / out-of-scope
- **Pod agent must persist a visible turn** — handled by the §4b split (MC-owned criterion no longer
  depends on it). Reasoning-only/no-content output is fixed in the **CR `spec.config.raw`** (model /
  token budget — operator-owned, §2b), not in MC; filed separately if it surfaces.
- **Out of scope (YAGNI):** multi-session per agent, model picker on new chat, per-agent live status,
  re-enabling a realtime WS stream.
- In-flight run during suspend (lifecycle B2) unchanged.

## 7. Success criteria (verifiable)
1. Viewer sees the agent roster (today `main`) from `agents.list`; no `/api/agents` 403 from chat;
   the picker renders N agents unchanged (proven by the 2-agent unit fixture).
2. Clicking an agent opens `agent:<id>:<mainKey>` (or its existing session row); sending reaches the
   pod (`chat.send`); the optimistic user bubble does not flicker/vanish under the poll (merge
   contract).
3a. **(must pass)** A persisted `chat.history` turn renders on poll/refresh/re-entry — Playwright,
   model-independent.
3b. **(may defer)** The live GPT-OSS agent emits a visible turn; if not, separate pod-config issue.
4. `gatewayAgentsToAgents` and the agent→session-key mapping are unit-tested (TDD), incl. 2-agent.
5. No regression in committed P1 paths (sessions list, history load, send); no `chat.message` wiring.
