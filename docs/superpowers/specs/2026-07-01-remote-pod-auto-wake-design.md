# Remote Pod Auto-Wake — Design (v2)

**Date:** 2026-07-01
**Status:** Approved (design) — pending implementation plan
**Related:** #17 (remote-mode rewiring), #18 (backup/durability ops),
#19 (autonomous keep-alive — out of scope here)

> v2 incorporates a design review: wake is hosted by a **dedicated minimal waker
> service** (not the operator); the idle-stamp scope is narrowed to *interactive*
> use (autonomous keep-alive → #19); plus security/cold-start/timeout/observability
> fixes.

## Problem

OpenClaw agent pods run in Kubernetes with **scale-to-zero**: the operator patches
`spec.suspended=true` after an idle window (`OPENCLAW_IDLE_SUSPEND_AFTER`, env-configured
and **disabled if unset** — "1h" is only a doc example), judged solely by the
`openclaw.rocks/last-active` annotation (`internal/controller/idlesuspend.go:41-60`).
Suspending scales the StatefulSet to 0 and the pod's gateway goes down.

Mission Control (MC) runs **outside the cluster, installed on each user's local machine**
(docker). It reaches a pod's gateway via traefik (browser-direct WebSocket for live
events + server-side RPC `callOpenClawGateway` for chat).

Problems:
1. A suspended pod cannot be woken from MC — chat RPC and the browser WS both hit a down
   gateway (traefik 503). **Auto-wake is mandatory.**
2. The remote session list is fetched live via `sessions.list` (10s in-memory cache);
   when suspended it returns `[]`, so the user can't even see conversations to click into
   (the natural wake trigger).

### Who writes `last-active` today (verified)

**Nothing writes it continuously.** The operator only *reads* it; its comment attributes
writes to a "Mission Control gateway broker" that belonged to an earlier *in-cluster*
design and does not exist in this topology. The openclaw runtime tracks activity in
memory (`lastActiveAt`, `openclaw/src/infra/agent-events.ts:436`) but never bridges it to
the CR annotation; MC never touches k8s. So `last-active` is written once (provisioning)
then goes stale.

Consequence for scope: this spec's stamping (on wake / chat interaction) keeps
**interactive** chat alive, but an **autonomous run with no user input** would suspend
mid-run. Fixing that requires the runtime to self-stamp — split out to **#19**.

## Constraints & scope

- **Topology (b):** MC is installed by end users on their own machines. Users must NOT
  have direct k3s / operator access. Wake authority must live in the cluster; the local
  MC only makes an authenticated request to wake **its own** pod.
- The local MC already holds its pod's **gateway token**; that token is the per-tenant
  credential authenticating a wake request.
- The gateway `wake` RPC is useless here: the gateway is down when suspended, so only the
  k8s control plane can scale the pod back up.
- **Wake trigger policy (A): explicit interaction only.** Wake happens when the user
  engages an agent — opening a conversation (`chat.history`), sending a message
  (`chat.send`), or clicking a wake button. Passive activity (dashboard load,
  `sessions.list` polling, the ambient live-events WS) does NOT wake, preserving
  scale-to-zero.

## Data ownership & placement (governing principle)

The remote pod is the **single source of truth** for all agent state (sessions, chat,
memory, soul, skills, cron, agent config, secrets). MC is a **client + display cache**;
its only authoritative local data is dashboard-operational (auth, gateway registry,
settings, alerts, audit). Host-local tooling (the user's own CLIs) is a separate concern,
hidden in remote mode.

**Rule of thumb: reads may be cached (shown stale when suspended); writes require waking
the pod.** MC never persists agent state as authoritative — writes go to the pod via RPC;
MC keeps a non-authoritative mirror for display, refreshed from the pod after a write
(read-your-write). Locked decisions: chat history = pod-authoritative (MC chat DB → mirror
cache); agent config/registry = pod-write + MC mirror; memory chunk graph
(`/api/memory/graph`) = derived, no RPC → hidden in remote mode. Durability is NOT the MC
mirror's job (see Durability). Maps to CQRS read-model / materialized-view + offline-first
*reads*; governs this spec and #17.

## Architecture

```
User's machine                  Cluster (users have no direct k8s/operator access)
┌──────────────┐                ┌──────────────────────────────────────────────┐
│ MC (docker)  │                │  waker (dedicated Deployment, minimal RBAC)    │
│              │ POST /wake     │   POST /wake {slug, token}   (traefik + TLS)   │
│ server RPC ──┼─{slug,token}──▶│    ├─ find OpenClawInstance(s) name==slug      │
│ (chat.*)     │                │    ├─ read <slug>-gateway-token secret,        │
│              │                │    │   constant-time compare (dummy on miss)   │
│              │                │    └─ if ok: patch spec.suspended=false         │
│              │                │             + stamp last-active=now             │
│ browser WS ──┼─(chat,events)─▶│  operator reconciler: replicas 0→1 → pod up    │
│ (live events)│ ◀─ pod up → MC readiness-poll → existing reconnect restores WS  │
└──────────────┘                └──────────────────────────────────────────────┘
   RBAC: waker SA = get secrets + get/patch openclawinstances ONLY (no rbac/others).
   The operator is untouched (no internet listener on the high-privilege component).
```

## Components

### 1. Waker service (Go, new minimal Deployment)

A small standalone HTTP service in the cluster (its own Deployment + ServiceAccount).
Chosen over hosting on the operator because: the operator's `mgr.Add` Runnable runs only
on the leader (drops on restart/failover); the operator holds cluster-wide RBAC
(instances, secrets, roles/rolebindings) and must not expose an internet listener; a
handler panic would take down reconcilers. A dedicated service isolates blast radius,
is leader-election-free, and is trivially HA.

- **RBAC (minimal):** `get` secrets + `get`/`patch` openclawinstances. Nothing else.
- **Request:** `POST /wake` JSON `{ "slug": "alice", "token": "<gateway-token>" }`.
  Strict JSON parse, request-body size cap, `recover()` around the handler,
  `context.WithTimeout` on all k8s client calls.
- **Resolve:** list `OpenClawInstance` across namespaces; **iterate all** with
  `metadata.name == slug` (cross-namespace name collisions are disambiguated by the token
  compare below).
- **Authenticate:** read Secret `<slug>-gateway-token` (`GatewayTokenSecretName`, key
  `token`, `internal/resources/common.go:365`); `subtle.ConstantTimeCompare`. On a miss
  (unknown slug or bad token) run a **dummy constant-time compare** and return a
  **uniform** response identical to the bad-token case (no 404-vs-401 enumeration oracle).
- **Wake:** if `spec.Suspended`, patch it `false` (resume yields **1** replica, or `nil`
  when HPA-managed — `internal/resources/statefulset.go:2784`); always set annotation
  `openclaw.rocks/last-active=<now unix s>`. A stateless `Patch` is used (avoids read-modify
  races); the operator's own idle path uses `r.Update` on the CR with optimistic locking,
  so a wake racing an in-flight suspend self-heals via RV conflict + requeue.
- **Response:** uniform `200 { "status": "ok" }` on success; uniform failure on
  miss/bad-token. Idempotent (repeat calls only bump the annotation).
- **Exposure (must be built):** Service + traefik route (kustomize **and** Helm) with
  **required TLS**, DNS, and a **NetworkPolicy allow-rule** (the project ships deny-all
  baselines). **Rate-limiting at traefik** (not in-process) to blunt request-flood DoS.

### 2. MC server-side wake helper + wake-on-demand wrapper (TypeScript)

- **`wakeRemotePod(slug, token)`** (new, e.g. `src/lib/openclaw-wake.ts`): `POST`s to the
  waker URL with an **`AbortController` timeout** (mirror `gateways/health/route.ts:211-217`,
  ~5s) so a down waker never hangs a chat request. Config:
  - `OPENCLAW_WAKE_URL` (new env) — the traefik-exposed waker endpoint. Unset → no-op
    (local/self-hosted deploys). **Server-only**; never a `NEXT_PUBLIC_*` variant.
  - `slug` from `OPENCLAW_GATEWAY_HOST` first DNS label (override `OPENCLAW_GATEWAY_SLUG`).
  - `token` from `getDetectedGatewayToken()` (server-side, sync).
  - **Debounce on success only:** record a successful wake per slug for N s (default 30s);
    a failed wake does not suppress retries.
- **Wrap `chat.history` and `chat.send`** (in `openclaw-gateway.ts` or the call sites):
  call `wakeRemotePod` (debounced); then **readiness-gate** the RPC — poll
  `/api/gateways/health` until ready with a bounded deadline (~60-120s, backoff) rather
  than a single retry, because a cold StatefulSet boot (schedule + image pull + PVC attach
  + agent + gateway WS) routinely exceeds the RPC's 12-15s timeout. Do **not** wrap
  `sessions.list`.
- **Gateway scope:** server-side `callOpenClawGateway` targets the single global
  `config.gatewayHost` + `getDetectedGatewayToken()`. This spec assumes the primary
  gateway for the chat auto-wake path; per-gateway wake is covered by the manual button
  (component 3). Full multi-gateway server-side routing is deferred to #17.

### 3. MC manual-wake route (TypeScript)

`POST /api/gateways/wake { id }` — resolves the gateway row → host→slug + token, calls the
shared `wakeRemotePod`, returns status. Thin wrapper sharing the helper with component 2.

### 4. UI — wake button + suspended status (TypeScript/React)

- "Wake / Connect" button per gateway in `multi-gateway-panel.tsx` (and/or
  `gateway-control-panel.tsx`). Click → `POST /api/gateways/wake` → "waking…" → poll
  readiness → existing reconnect loop restores the WS.
- Reframe a down pod from "disconnected / no active connection" (error) to
  **"suspended — starts on interaction."**
- **Readiness-poll caveat (load-bearing, #17 dependency):** the health route probes the
  stored host/port (default 18789) and probes *all* gateways per call
  (`gateways/health/route.ts:129-156`). A traefik-fronted remote pod answers on 443, so
  the `gateways` row must carry the correct remote host/port for readiness polling to work.

### 5. Session local cache (TypeScript)

Persist the last successful `sessions.list` so suspended pods still list their
conversations (clickable → `chat.history` → wake).

- **Storage:** reuse the `settings` KV table (`migrations.ts:238-252`). Key
  `gateway_sessions_cache:<slug>`, value = JSON of last-good mapped `GatewaySession[]`,
  category `cache`. Per-gateway blob, overwrite-on-success — no new table/pruning.
- **`getGatewayRpcSessions()`** (`src/app/api/sessions/route.ts`): RPC success → return +
  overwrite blob; RPC failure → read blob, return entries with `active:false` + `stale:true`.
- **Type:** add a `stale?: boolean` field to `GatewaySession` (`src/lib/sessions.ts:5-20`)
  (or attach at the route layer).
- **Non-authoritative:** a display read-model, **not** a backup (see Durability). After a
  write to a slug, refresh that slug's cache from the pod (read-your-write) **best-effort**:
  if the pod is still cold, defer/retry the refresh; never block the user action on it.
- **Interaction with existing fallback:** `chat.history` already silently falls back to a
  disk transcript on RPC failure (`sessions/transcript/gateway/route.ts:44`); in a
  remote-only deploy that disk is empty, so the RPC/cache path is authoritative.
- **UI:** stale sessions get a "suspended" badge. **Cold cache** (never-contacted pod) →
  empty list → the manual wake button (component 3) is the fallback.

## Data flow

- **Manual button:** UI → `POST /api/gateways/wake {id}` → MC resolves slug+token →
  `wakeRemotePod` (timeout) → waker `/wake` → verify + patch + stamp → uniform status →
  MC readiness-polls → WS reconnects.
- **Chat (open/send):** `chat.history`/`chat.send` → wrapper `wakeRemotePod` (debounced) →
  readiness-gate → RPC.
- **Passive (no wake):** `sessions.list` + ambient WS never wake; session list served live
  if up, else from KV cache marked stale.

## Authentication & security

- **Correction:** the gateway token is **already returned to the browser** for the
  browser-direct WS (`gateways/connect/route.ts:180-185` → `websocket.ts:282`). So "can
  also wake" adds **no** privilege over what a token-holder already has. Wake security
  therefore reduces to **token secrecy + endpoint reachability + TLS**, not "server-only
  calls." (The narrower true claim: the *waker URL* is server-only — never expose a
  `NEXT_PUBLIC_OPENCLAW_WAKE_URL`.)
- **TLS is required** (not "recommended"): token-in-POST-body is safe only over enforced
  TLS. Consider an extra edge control (mTLS or a traefik-enforced front-door header).
- **Blast radius:** the dedicated waker holds only `get secrets` + `get/patch instances`,
  so an internet-facing listener there is far safer than on the operator.
- **Enumeration/DoS:** uniform response for unknown-slug vs bad-token + dummy constant-time
  compare on miss; rate-limit at traefik. `ConstantTimeCompare` alone is insufficient while
  the slug lookup precedes it — hence the uniform/dummy handling.

## Error handling & idle-stamp

- **Wake failure/timeout:** `wakeRemotePod` aborts on timeout; button shows "wake failed —
  retry"; the chat path surfaces the error (idempotent → retry safe).
- **Cold start:** wake returns immediately (async boot); RPC is readiness-gated with a
  bounded deadline (see component 2), not a single retry.
- **Auth failure:** uniform failure response; MC fails quietly (logs only).
- **Idle-stamp (interactive only):** wake and each `chat.send` stamp `last-active=now`, so
  interactive use stays alive as long as gaps < idle window. **Autonomous runs are NOT
  covered here → #19** (runtime self-stamp).

## Durability (operational — not built here)

The session cache is a display convenience, **not** a backup. Durability against volume
loss is the operator's existing PVC→S3 backup/restore (`BackupSpec.Schedule` → rclone
CronJob; `RestoreFrom` → restore before StatefulSet creation). Operational follow-up in
**#18**: enable a backup `Schedule` + `RetentionDays` per tenant and run periodic canary
test-restores ("the question is not whether backups exist but when one was last
successfully restored"; StatefulSet/operator-managed restores have known failure modes).

## Observability

- **Waker:** a wake counter + latency histogram + outcome labels (ok / bad-token /
  not-found / patch-error). Expose via Prometheus (operator infra already uses
  Prometheus/OTLP).
- **MC:** structured logs on every `wakeRemotePod` (slug, outcome, latency, debounced?)
  to triage wake storms / failures.

## Testing (TDD)

- **Waker `/wake`** (Go unit + envtest / e2e): valid token → `suspended=false` +
  annotation; bad token and unknown slug → **identical** uniform failure (assert no oracle);
  already-running → idempotent; handler recovers from panic; body-size cap enforced. e2e on
  kind verifies replicas 0→1.
- **MC `wakeRemotePod` + wrapper** (vitest): payload, timeout/abort, debounce-on-success,
  readiness-gate loop, error propagation — pure functions (mirrors `mapGatewayRpcSessions`
  test pattern). Assert `sessions.list` never calls `wakeRemotePod`.
- **Session cache** (vitest): success overwrites blob; failure returns cached entries
  flagged `stale`/`active:false`.
- **UI button:** click → route → status transitions.

## Deliberately out of scope (YAGNI / split)

- **Autonomous keep-alive** (runtime self-stamps `last-active`) → **#19**.
- **Broader remote-mode rewiring** (cron, files, integrations, skills, memory, etc.) → **#17**.
- **Backup enablement + test-restore** → **#18**.
- **Full multi-gateway server-side wake routing** → #17 (manual per-row button covers it
  for now).
- **Per-tenant wake rate-limit / flap-backoff in-app** — the patch is idempotent; do
  request-flood rate-limiting at traefik instead. Add per-slug buckets only if abuse is seen.
- **Transparent activator (KEDA/Knative)** — rejected on ROI (heaviest infra; WS
  interceptor + Gateway API rewiring + collision with operator suspend).
