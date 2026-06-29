# Unified Scoped Console — Design

Date: 2026-06-26
Status: design agreed + reviewed (Software Architect: ready-with-changes, corrections folded in).
**Next step paused by user — implementation plan NOT yet written.**

## 1. Goal & guiding principle

End users and admins use the **same Mission Control UI**. The only difference is **data
scope**, never the set of features:

- **user scope** — sees only *their own* data (their pod).
- **admin scope** — same panels, but can select a managed user and view *that user's* data.

**Hard principle (security baseline):** **No human (user OR admin) ever touches the host.**
Everyone operates inside an isolated pod. Admin is *not* special-cased to the host gateway —
admin is just a tenant with a wider scope. The only way external data enters a pod is an
explicit user action (e.g. file upload) into **their own** pod. The host is pure infrastructure
(k3s nodes, the operator, the MC server process); never a place a human reads/acts in.

## 2. Verified facts (empirical, 2026-06-26)

These de-risk the design; all checked live against tenant `alice`'s pod gateway.

- **Token-only connect works.** Pod gateway sends `connect.challenge` (nonce); a `connect` reply
  carrying only `auth:{token}` (no Ed25519) is accepted → `hello-ok, protocol 3`. The broker can
  answer the challenge server-side; the browser never needs the token.
- **Pod gateway exposes a rich read/write method surface** (`features.methods`), so almost every
  panel is per-tenant via the gateway — far more than MC's current REST/DB wiring suggested:
  `chat.send`, `chat.history` (per `sessionKey`), `chat.abort`; `sessions.list` (verified returns
  sessions), `sessions.preview/patch/reset/delete/compact`; `agents.list`, `agents.files.*`;
  `models.list`; `config.get/set/patch/schema`; `channels.status`; `cron.*`; `skills.*`;
  `exec.approval*`; `usage.status/cost`; `logs.tail`; `browser.request`; `node.*`; `device.pair.*`.
  A session entry carries `{key, displayName, kind, updatedAt, sessionId, abortedLastRun,
  totalTokens, model}` — i.e. **a session is the per-tenant unit of work**.
  **The one core panel with NO pod equivalent = the MC host "Tasks board"** (no `tasks.*` method).
- **Per-tenant PVC survives scale-to-zero.** Operator builds `<slug>-data` as a standalone PVC
  (RWO), mounted at `/home/openclaw/.openclaw` etc.; suspend sets replicas=0 but the PVC stays
  Bound. (KI-1: storageclass `local-path` is node-pinned — see §8.)

## 3. Core model

### 3a. One scope abstraction → a target pod
Every gateway access resolves a **target pod** from the caller:
- `viewer` → their own pod (fixed; cannot supply a target).
- `admin` → their own pod by default; or an admin-selected tenant pod (authorized).
- **host → removed.** No host target exists in any product flow.

Resolution lives in `resolveTenantGateway` / `resolveTenantForUser` (`src/lib/tenant-gateway.ts`).
**This is a REWRITE, not a deletion:** today `role==='admin'` short-circuits to `{kind:'admin'}`
(host) *before* any `getTenantForOwner` lookup (`tenant-gateway.ts:36`). The new branch must
resolve the admin's OWN tenant first, plus an optional authorized `?target`. Define explicitly
what admin sees before picking a user (decision: **own pod**, same as any tenant).

### 3b. Gateway target parameterization (the swap — scoped to what viewers reach)
`callOpenClawGateway` (`src/lib/openclaw-gateway.ts:82-93`) hardwires `config.gatewayHost/Port +
getDetectedGatewayToken()`. Give it a scope-resolved **`target` {host, port, token}** (always a
pod). **Caveat (reviewer):** `callOpenClawGateway` is NOT the only host-hardwired caller — raw
HTTP/CLI/TCP paths also hit the host gateway: `channels/route.ts`, `nodes/route.ts`,
`exec-approvals/route.ts`, `gateway-config/route.ts`, `debug`/`diagnostics`/`status`, the CLI
`runOpenClaw([...'gateway','call'])` in `chat/messages/route.ts:526` + `task-dispatch.ts`, and
`agent-runtimes.ts` raw TCP. **None are reachable by a viewer** (the auth allowlist blocks them),
so they are admin/operator/background flows, explicitly **out of the tenant swap**. The plan must
treat them separately, not pretend one edit covers them.

### 3c. Realtime via broker (not host gateway)
`useWebSocket` (`src/lib/websocket.ts`) is a module-level singleton connected at boot in
`page.tsx` to the **host gateway** today (`connectWithPrimaryGateway` / env fallback). Change boot
to connect same-origin to **`/ws/gateway`** (the broker). The broker answers `connect.challenge`
**server-side with the per-tenant token** (verified §2); the browser stays a dumb pipe.
**Scope switch = reconnect**, and this is the **highest-risk detail** (reviewer §4c): the singleton
early-returns when `OPEN||CONNECTING` and auto-reconnects to `reconnectUrl.current`. A naive
`connect()` will be swallowed or a backoff timer will resurrect the **stale** target. Required
sequence: **`disconnect()` → clear all reconnect/backoff timers → set new url → connect**, guarded
by a **generation/epoch counter** so a late timer for the old scope cannot win.

### 3d. Broker target capability (new) — default-deny
`/ws/gateway?target=<slug>` (`src/lib/gateway-proxy-ws.ts`):
- `viewer` → `target` ignored; always own pod.
- `admin` → if **authorized** for `<slug>`, route to that tenant's pod; else **403**. Never a
  silent own-pod fallback (that would mask an authz bug).
- Replaces today's `admin → host` broker branch (`gateway-proxy-ws.ts:158-161`).
- **Auto-wake is a privileged side effect**: the broker resumes a suspended target on connect
  (`:167-174`); once admin `?target` exists, gate wake behind the **same** authz as targeting.

## 4. Data model (reuse, don't rebuild)

- **Per-tenant content** (chat, sessions, transcripts, agent state) lives on the per-tenant PVC
  (operator-provisioned). Read **only via the pod's gateway API** — never by mounting another
  pod's volume (RWO + isolation forbid it).
- **MC host SQLite DB = control plane only** (which users/tenants exist, lifecycle). It does NOT
  hold per-user content.
- **Tenant chat never touches the REST chat route.** (Reviewer correction: a viewer cannot reach
  `/api/chat/messages` at all — POST requires `operator` and the path isn't allowlisted; there is
  no host-DB write to "skip".) Tenant chat send/history/stream flow **entirely over `/ws/gateway`**;
  history comes from the gateway (`chat.history` per `sessionKey`, enumerated via `sessions.list`).
- **Volume = private storage; Gateway = access API.**

## 5. UI (components unchanged; nav + scope differ)

- **Same panels** for user and admin.
- **Work tracking = Sessions** (pod-sourced): each session = a unit of agent work
  (`sessions.list`/`sessions.preview`), plus `cron.*` (scheduled) and `chat.history` (record).
  This is the per-tenant work tracker — **nothing is lost** by not having the host Tasks board.
- **Nav filter by data availability, not role.** Panels with a pod equivalent (chat, sessions,
  transcript, agents via `agents.list`, models via `models.list`, channels, cron, skills, usage,
  exec-approvals, config) show for everyone, scoped. The **MC host "Tasks board"** is a host
  fleet-orchestration concept (no `tasks.*`); it is **excluded from the unified console** entirely
  (not just hidden for users). If fleet orchestration is ever needed, it is a separate ops tool
  outside this console.
- **Admin scope switcher**: a user picker that sets the scope target and triggers the §3c reconnect.

### Re-sourcing reality (reviewer correction)
For a viewer, **every** REST route the chat UI calls today is 403 by the allowlist (`/api/sessions`,
`/api/chat/messages`, `/api/chat/session-prefs`, `/api/agents`, `/api/sessions/transcript/gateway`).
So the chat/sessions/transcript panels render **nothing** until re-sourced to the gateway WS.
**Re-sourcing is the bulk of P1, not "~1/3 free swap."** It is feasible because §2 confirms the
methods exist; the work is moving each panel's data source from REST/DB to the gateway WS, and
ensuring UI components that assumed REST shapes accept gateway frames.

## 6. Isolation & security invariants

1. `auth.ts` viewer whitelist unchanged — viewer reaches only `/ws/gateway` + `/api/me/*`;
   cannot supply a target. Deleting the host path does not touch this guard.
2. Admin → tenant targeting is **authorized in the broker** (default-deny, 403 on
   unknown/unauthorized slug, no silent fallback). For now admin may target **all** tenants
   (per-admin ownership table deferred — §7).
3. No host gateway target anywhere in product code (host path **deleted**, not dormant).
4. Cross-pod / cross-tenant data access is **only** via the gateway API; never shared volumes.
5. Data ingress into a pod = explicit user action into **own** pod (e.g. upload).
6. **Synthetic principals** (`id <= 0`: API-key id 0, agent keys < 0) currently map to
   `{kind:'admin'}` (host) in `resolveTenantForUser`. Before deleting the admin→host branch,
   **verify no agent/cron/API-key principal opens `/ws/gateway`** (they use REST/MCP, not the
   browser WS) so the rewrite doesn't change their behavior.

## 7. Phasing (value-ordered)

- **P1 — user scope core:** chat + sessions + transcript + live stream scoped to the user's own
  pod. = gateway-target param + **re-source chat/sessions/transcript to the gateway WS** (the bulk)
  + broker realtime + scope-switch teardown/epoch guard. Delivers the core vision.
- **P2 — admin scope:** scope switcher (user picker) + broker `?target` default-deny authz +
  rewrite resolver (admin own-pod default) + delete `admin → host` branches.
- **P3 — nav + lifecycle cleanup:** hide non-per-tenant items; exclude host Tasks board; provision
  admin's own pod (OpenClawInstance) so `getTenantForOwner(adminId)` resolves.

## 8. Assumptions / open / out-of-scope

- **Assumption:** admin (role=admin) may target *all* tenants. Per-admin "manages this subset"
  needs an admin↔tenant ownership table — **deferred**.
- **Admin needs a pod:** admin currently owns no tenant/pod; must be provisioned an
  OpenClawInstance (operator/seed touchpoint), coupled to the §3a resolver rewrite.
- **MC server topology:** MC runs as a host process today (PoC-A) = control-plane infra, not a
  human touching the host; moving MC in-cluster is a deployment concern, **out of scope**.
- **Out of scope:** server-resource/cluster dashboard; MC host Tasks board / fleet orchestration;
  per-admin ownership; file-upload ingress mechanics (named as the sanctioned ingress, detailed
  later); the admin/operator host-hardwired callers in §3b (kept as-is, out of the tenant swap).

## 9. Known issues (tracked elsewhere)

- **KI-1** (repos/PROGRESS-lifecycle-automation.md §8): tenant storage uses `local-path`
  (node-pinned) → multi-node reschedule impossible. Fix = networked CSI storageclass
  (Longhorn/Ceph/EBS, RWO); model (PVC-per-tenant) unchanged. Pre-production.

## 10. Success criteria (verifiable)

1. A `viewer` logs in → shared UI with chat/sessions/transcript (+agents/models/etc.) populated
   **from their own pod**; host Tasks board absent; host data unreachable (403 unchanged).
2. `viewer` chat: send → agent in *their* pod responds; history + live stream from the pod;
   **no REST chat route touched** (no host `messages` row).
3. `admin` logs in → own pod view by default; selecting user X → same panels showing **X's** pod
   data via broker; switching back works cleanly (no stale-scope frames); admin cannot reach the
   host gateway (no such path).
4. No product code path reachable by a viewer references `config.gatewayHost` / host gateway.
5. Broker answers `connect.challenge` server-side; browser never receives a token.
6. Cross-tenant probe (user A targeting B; admin targeting unauthorized tenant) → 403; auto-wake
   gated by the same authz.
7. Scope switch under load does not leave a reconnect timer pointed at the previous target
   (epoch guard holds).
