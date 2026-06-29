# Tenant Chat — Agent Roster + History-Pull — Design

Date: 2026-06-26 (validated + finalized 2026-06-29)
Status: design agreed + reviewed (3 specialist reviews folded in) + risky assumptions live-validated.
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
  `/v1/chat/completions` ok); pod egress allows it. GPT-OSS-120B is a *reasoning* model. With the
  provider wired correctly (`models.providers.vllm`: `api:"openai-completions"`, model marked
  `reasoning:true`, `maxTokens:8192`) it emits a `thinking` block **and** a `text` block, both of
  which persist — see §2d. A residual edge: `gatewayMessageToChatMessage` returns `null` for a
  *pure-thinking* turn with no text (`gateway-adapters.ts:275`); real turns carry text so this is rare.

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
- **`last-active` is stamped by the MC broker on browser→pod frames, THROTTLED to ~1/60s**
  (`gateway-proxy-ws.ts:33` `STAMP_THROTTLE_MS=60_000`; operator `idlesuspend.go` reads the
  annotation). So a 10s `chat.history` poll re-stamps at the **60s cadence, not the 10s poll cadence** —
  a left-open chat panel holds the pod awake (at ~1 stamp/min) until the tab is hidden (when
  `useSmartPoll` pauses). The cost is real but smaller than "every frame"; accept for P1 (tab-hidden
  pause is the mitigation, §4a).

### 2c. Provisioning prerequisite (operator/CR, NOT MC) — root cause of "no replies"
The earlier "send works but no reply ever appears" symptom was **not** an MC or openclaw limitation:
alice's pod had `model.primary` set but **no provider wired** (no `OPENAI_BASE_URL`, no
`models.providers.*`), so every run failed to produce a turn. Fixed by replacing the CR's
`/spec/config/raw` (mergeMode `overwrite`) with a `models.providers.vllm` block + model ref
`vllm/GPT-OSS-120B`. **Implication for the spec:** a tenant pod with chat enabled MUST have its model
provider wired at provision time, or chat produces no replies — this is an operator/CR concern,
tracked separately from MC. (Gotcha for whoever wires it: `kubectl patch --type merge` *recursively
merges* `spec.config.raw` and never removes stale keys → crashloops; use `--type=json` `replace` on
`/spec/config/raw` to swap the whole subtree.)

### 2d. Live validation — chat.history persists & echoes BOTH turns (CONFIRMED 2026-06-29)
After wiring (§2c), a `chat.send` → poll `chat.history` probe returned, at **t≈4s**, two messages:
`user[text]` **and** `assistant[thinking|text]`. This decisively confirms the assumptions §4 depends on:
- `chat.history` **echoes the USER turn** (not only assistant) — so the §4a merge contract is sound
  (the poll reflects the user's own message within seconds; the optimistic bubble drops naturally).
- The assistant turn **persists with thinking+text content** within ~4s — so a 10s poll easily catches
  it, and the history-pull-as-single-source premise (§4) holds.
- `chat`/`agent` events also stream during the run (bonus; not relied upon — §4a keeps WS out).

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
  `agent:main:main`. **Source the key from `selectedConversation.session.sessionKey`** (already
  populated, `gateway-adapters.ts:124`), **not** from `activeConversation` — for a `sessions.list` row
  the active id is `session:gateway:<sessionId>`, and `agentFromKey('session:gateway:…')` → undefined.

### 3b. Adapter (pure, TDD)
Add `gatewayAgentsToAgents(result)` to `gateway-adapters.ts`, mirroring the existing tolerant pure
pattern (returns `[]` on junk). Maps the **full `agents[]` array** → UI `Agent[]`:
- `name = agent.id`; `id` (numeric, required) = array index + 1 (stable identity is all it needs —
  `renderAgentItem` keys on `name`); `role = ''`; `created_at`/`updated_at` = 0; **`status = 'idle'`**
  (see §3d). Return `mainKey`/`defaultId` to the caller **separately** (not threaded into each
  `Agent`) for §3c key-building. **Return a plain object literal `{ agents, mainKey }`** — do **not**
  introduce a `GatewayAgentsResult` interface/type (mirror the existing `gatewaySessionsToConversations`
  which just returns an array).
- Unit test includes a **synthetic 2-agent fixture** to prove the "scales to N" claim, plus
  empty/malformed cases.

### 3c. Agent → session-key mapping (the crux)
Clicking agent `X` opens that agent's primary session, keyed `agent:${X}:${mainKey}` using the
`mainKey` field from `agents.list` (**not** a hard-coded `"main"`). Set `activeConversation` to that
**raw gateway key** — always, never a `sessions.list` row id.

**Do NOT reconcile to an existing `session:gateway:<id>` row (correction, live-validated 2026-06-29).**
An earlier draft selected the matching session-list row when one existed (to avoid a "phantom
duplicate"). In practice that routes the click into the `SessionConversationView` path, which (a) is
**not** covered by the §4a 10s `chat.history` poll, and (b) flips to an empty view after send when the
re-fetched conversations list momentarily drops the selected row. The raw gateway key instead routes
to the direct-agent view (`MessageList` + the §4a poll + an enabled composer), and the key is stable,
so it **reopens the same session's history** on every click — satisfying "reopen existing, else new"
(`canSendMessage` is true because the id does not start with `session:`; `chat.send`/`chat.history`
key on `sessionKey === activeConversation`). The session may also appear as a `sessions.list` row;
that duplicate listing is harmless. Net: `setActiveConversation(`agent:${X}:${mainKey}`)`, no `.find`.
**New-conversation UX (user-confirmed 2026-06-29):** keep MC's existing agent-picker click behavior —
clicking agent `X` **reopens its existing session if one exists, otherwise opens a new session** (the
raw key auto-creates on first send). This is exactly the reconcile above; no forking of a second
thread per agent. Note multi-session-per-agent is technically free (a fresh bareKey yields a distinct
session), but it is **deliberately not exposed** in P1 — kept out of scope with the model picker.

### 3d. Status / "N online"
`agents.list` has no per-agent status. Map a reachable agent to **`status:'idle'`** (the existing
filters at `chat-workspace.tsx:338` and `conversation-list.tsx:246` test `idle|busy`, so `'idle'`
reads correctly as "online, not busy" with zero consumer edits). This is the laziest correct value;
do not invent `busy`. "N online" then = count of reachable agents while the pod is connected.
- **Dot color — verify at implementation (reviewers disagreed):** `STATUS_COLORS.idle` is yellow
  (`conversation-list.tsx:38`), but `renderAgentItem` (~:260) may render its own green `online` dot
  instead of using `STATUS_COLORS`. Either reads as "online, not busy" — just confirm which path the
  agent rows take so the dot color is intentional, not a surprise. No code change implied by §3d itself.

## 4. Item 1 — Reply delivery via history pull (single source of truth)

`chat.history` (pod PVC, survives navigation/close/suspend — §2b) is authoritative. The user is not
expected to watch replies live.

### 4a. Mechanism — ONE source (drop the WS path for this feature)
- Fetch `chat.history` on session open/select (already wired) **and** poll it on a fixed **10s**
  interval while a session is open, via the existing `useSmartPoll` with **`pauseWhenDisconnected:
  true, backoff: true`** (do **not** pass `pauseWhenSseConnected` — the poll must run while the WS is
  up). `useSmartPoll` already pauses when the tab is hidden.
- **Why always-on (not run-gated):** a leaner option is to poll only while a run is in-flight
  (`isGenerating` or a `sending` optimistic message) and otherwise fetch-on-focus — this removes most
  of the §2b pod-awake cost. We **reject it for P1** because a reply can land *after* the user
  navigates away and back (the whole point of history-as-source-of-truth, §4), and run-gating adds
  start/stop state for a poll that is already cheap (one read every 10s, stamped only ~1/60s). Revisit
  if pod-awake cost proves material; the swap is a one-line guard on the `useSmartPoll` enable flag.
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
- **(pod-config, DONE on alice)** The live GPT-OSS-120B agent persists a visible turn — validated
  §2d (assistant `thinking|text` at t≈4s) once the provider was wired (§2c). For other tenant pods
  this reduces to the provisioning prerequisite (§2c), not an MC task.
- §2b/§2d already covered: `chat.history` echoes the user turn (CONFIRMED §2d); history persists on
  the PVC across suspend/resume (operator-grounded §2b).

## 5. Components / files
- `src/components/chat/gateway-adapters.ts` (+ `__tests__/gateway-adapters.test.ts`) —
  `gatewayAgentsToAgents` (+ 2-agent fixture, key/display via existing `agentFromKey`).
- `src/components/chat/chat-workspace.tsx` — `loadAgents()`→gateway; `handleNewConversation` key
  mapping + identity reconcile; remove orphan `agent_` branches; header/status via `agentFromKey`;
  add the 10s `chat.history` poll with the merge contract. **Factor the merge as a pure helper**
  (`mappedHistory + optimistic-not-yet-in-history`) so it is unit-testable in isolation — this is the
  subtle logic (the negative/positive/`tsMs+index` id spaces never reconcile via `addChatMessage`'s
  positive-id-only dedup, `store/index.ts`), the kind that regresses silently.
- `src/components/chat/conversation-list.tsx` — agent rows from gateway roster; `renderAgentItem`
  status read works as-is given §3d (`status:'idle'`).
- No backend/broker/auth/websocket.ts changes.

## 6. Risks / out-of-scope
- **Pod agent must persist a visible turn** — VALIDATED on alice (§2d). The general case reduces to
  the provisioning prerequisite (§2c: provider wired in CR `spec.config.raw`), operator-owned, not MC.
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
3b. **(validated §2d)** The live GPT-OSS agent emits a visible `thinking|text` turn (provider wired,
   §2c); for other pods this is the §2c provisioning prerequisite, not an MC criterion.
4. `gatewayAgentsToAgents` and the agent→session-key mapping are unit-tested (TDD), incl. 2-agent.
   The pure merge helper (§5: history + optimistic-not-in-history) has its own unit test.
5. No regression in committed P1 paths (sessions list, history load, send); no `chat.message` wiring.
