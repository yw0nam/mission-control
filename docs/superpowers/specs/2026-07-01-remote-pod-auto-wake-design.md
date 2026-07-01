# Remote Pod Auto-Wake — Design

**Date:** 2026-07-01
**Status:** Approved (design) — pending implementation plan
**Related:** yw0nam/mission-control#17 (broader remote-mode rewiring — out of scope here)

## Problem

OpenClaw agent pods run in a Kubernetes cluster with **scale-to-zero**: the operator
patches `spec.suspended=true` after 1h idle (judged solely by the
`openclaw.rocks/last-active` annotation), which scales the StatefulSet to 0 replicas.
The pod's gateway then goes down.

Mission Control (MC) runs **outside the cluster, installed on each user's local
machine** (docker). It connects to a pod's gateway via traefik (browser-direct
WebSocket for live events + server-side RPC via `callOpenClawGateway` for chat).

Two consequences today:
1. When a pod is suspended, the user has **no way to wake it** from MC — chat RPC and
   the browser WS both hit a down gateway (traefik 503). Auto-wake is a mandatory
   requirement.
2. The remote session list is fetched live via `sessions.list` (10s in-memory cache
   only); when the pod is suspended it returns `[]`, so the user can't even **see**
   their conversations to click into one (which would be the natural wake trigger).

## Constraints & scope

- **Topology (b):** MC is installed by end users on their own machines. Users must
  **not** have direct access to k3s / the operator API. Therefore the wake authority
  **cannot** live on the user's machine (distributing cluster credentials to every
  laptop breaks tenant isolation). The wake authority must live **in the cluster**;
  the local MC only makes an authenticated request to wake **its own** pod.
- The user's local MC already holds its pod's **gateway token** (used to connect).
  That token is the natural per-tenant credential for authenticating a wake request.
- The gateway `wake` RPC method exists but is useless here: the gateway is **down**
  when suspended, so only the k8s control plane (operator) can scale the pod back up.
- **Wake trigger policy (A): explicit interaction only.** Waking happens when the user
  actually engages an agent — opening a conversation (`chat.history`), sending a
  message (`chat.send`), or clicking an explicit "wake/connect" button. Passive
  activity — dashboard load, `sessions.list` polling, the ambient live-events WS — does
  **not** wake, preserving the point of scale-to-zero (cost).

## Data ownership & placement (governing principle)

The remote pod is the **single source of truth** for everything the agent runtime uses:
sessions, chat history, memory, soul, skills, cron, agent config, and the secrets/.env
the agent consumes. MC is a **client + display cache**; its only authoritative local
data is dashboard-operational (user auth, gateway registry, settings, alerts, audit).
Host-local tooling (the user's own Claude/Codex/etc. CLIs) is a separate concern,
hidden in remote mode.

**Rule of thumb: reads may be cached (shown stale when the pod is suspended); writes
require waking the pod.** MC never persists agent state as authoritative — writes go to
the pod via gateway RPC; MC keeps a non-authoritative mirror for display, refreshed from
the pod after a write (read-your-write).

Locked placement decisions:
- **Chat history** — pod-authoritative; MC's chat DB is demoted to a mirror/cache for
  display when disconnected.
- **Agent config / registry** — written to the pod (`config.*` / `agents.*`), mirrored
  into MC for display.
- **Memory** — pod-authoritative; the memory *chunk* graph (`/api/memory/graph`) is a
  derived, pod-internal index with no gateway RPC → hidden in remote mode.

Durability is **not** provided by the MC mirror — see Durability below. This maps to the
standard CQRS read-model / materialized-view pattern (write model = pod = single source
of truth; read model = MC cache with bounded staleness) plus offline-first *reads*. It
governs both this spec and the broader remote-mode rewiring (#17).

## Architecture

```
User's machine                     Cluster (users have no direct k8s/operator access)
┌──────────────┐                   ┌─────────────────────────────────────────────┐
│ MC (docker)  │                   │  operator (always running)                    │
│              │  POST /wake       │   POST /wake {slug, token}                     │
│ server RPC ──┼──{slug,token}────▶│    ├─ find OpenClawInstance where Name==slug   │
│ (chat.*)     │   (traefik, TLS)  │    ├─ read <slug>-gateway-token secret,        │
│              │                   │    │   constant-time compare token             │
│              │                   │    └─ if match: patch spec.suspended=false     │
│              │                   │             + annotate last-active=now          │
│ browser WS ──┼──(chat, events)──▶│   reconciler: statefulSetReplicas 0→N → pod up │
│ (live events)│ ◀─ pod up → existing reconnect loop restores the WS               │
└──────────────┘                   └─────────────────────────────────────────────┘
```

Wake authority lives only in the operator. The local MC never talks to the k8s API;
it POSTs one token-authenticated HTTP request to wake its own pod.

## Components

### 1. Operator `/wake` HTTP endpoint (Go)

Add a small `http.Server` to the operator via `mgr.Add(<Runnable>)` in
`openclaw-operator/cmd/main.go` (no new Deployment; the operator already runs
always-on and has the RBAC). New flag `--wake-bind-address` (default `:8082`).

- **Request:** `POST /wake` with JSON `{ "slug": "alice", "token": "<gateway-token>" }`.
- **Resolve:** list `OpenClawInstance` across watched namespaces, select the one with
  `metadata.name == slug`. If none → `404`. (Slug is assumed unique per tenant; even if
  two instances shared a name across namespaces, the token compare below is the real
  authority and would only match the correct tenant's secret.)
- **Authenticate:** read Secret `<slug>-gateway-token` (`GatewayTokenSecretName`,
  key `token`, `internal/resources/common.go:365`) in that instance's namespace;
  `subtle.ConstantTimeCompare` against the request token. Mismatch → `401`.
- **Wake:** if `spec.Suspended` is true, patch it to `false`; always set annotation
  `openclaw.rocks/last-active = <now unix seconds>` (`LastActiveAnnotation`,
  `internal/controller/idlesuspend.go:36`) so the idle-suspend loop doesn't
  immediately re-suspend. Use a patch (not full update) per repo reconcile rules.
- **Response:** `200 { "status": "waking" | "running", "phase": "<pod phase>" }`.
  Idempotent — repeated calls on a running pod are no-ops (only the annotation bumps).
- **Exposure:** an always-on Service + traefik route to the operator on the wake port.
- **RBAC:** existing operator permissions suffice (it already patches
  `OpenClawInstance` and has `get` on secrets).

### 2. MC server-side wake helper + wake-on-demand wrapper (TypeScript)

- **`wakeRemotePod(slug, token)`** (new, e.g. `src/lib/openclaw-wake.ts`): `POST`s to
  the operator wake URL. Config:
  - `OPENCLAW_OPERATOR_WAKE_URL` (new env) — the traefik-exposed operator wake endpoint.
  - `slug` — derived from `OPENCLAW_GATEWAY_HOST` (first DNS label, e.g.
    `alice.<ip>.nip.io` → `alice`); overridable via new `OPENCLAW_GATEWAY_SLUG`.
  - `token` — `getDetectedGatewayToken()` (`src/lib/gateway-runtime.ts`).
  - Per-pod **debounce**: skip the call if we woke this slug within the last N seconds
    (default 30s).
  - If `OPENCLAW_OPERATOR_WAKE_URL` is unset → no-op (local/self-hosted deploys).
- **Wrap `chat.history` and `chat.send`** in `src/lib/openclaw-gateway.ts` (or at the
  call sites): before the RPC, call `wakeRemotePod` (debounced); on a connection
  failure, `wakeRemotePod` then retry the RPC once. **Do not** wrap `sessions.list`.

### 3. MC manual-wake route (TypeScript)

- **`POST /api/gateways/wake { id }`** (new route under `src/app/api/gateways/`):
  resolves the gateway row → host→slug + token, calls the shared `wakeRemotePod`,
  returns `{ status, phase }`. Thin wrapper; shares the helper with component 2.

### 4. UI — wake button + suspended status (TypeScript/React)

- Add a **"Wake / Connect"** button per gateway in `multi-gateway-panel.tsx`
  (the `/gateways` panel) and/or `gateway-control-panel.tsx`, and optionally on the
  overview. Click → `POST /api/gateways/wake` → show "waking…" → poll existing
  `/api/gateways/health` until ready → existing reconnect loop restores the WS.
- Reframe suspended state: where a down pod currently shows "disconnected /
  no active connection" (an error), show **"suspended — starts on interaction"** so
  the ambient GW-retry spinner no longer reads as a failure.

### 5. Session local cache (TypeScript)

Persist the last successful `sessions.list` so suspended pods still show their
conversations (which the user can click to wake — trigger A).

- **Storage:** reuse the existing `settings` KV table (`migrations.ts:241`,
  `key/value TEXT`). Key `gateway_sessions_cache:<slug>`, value = JSON of the last
  successful mapped `GatewaySession[]`, category `cache`. Per-gateway single blob,
  overwrite-on-success — no new table, no per-row schema, no pruning.
- **`getGatewayRpcSessions()`** (`src/app/api/sessions/route.ts`) changes:
  - RPC success → return results **and** overwrite the KV blob.
  - RPC failure (pod down) → read the KV blob; return those entries with
    `active:false` and a `stale:true` flag.
- **UI:** stale sessions get a "suspended" badge; clicking one opens `chat.history`
  → wakes (trigger A). **Cold cache** (a pod MC has never talked to) → empty list →
  the manual wake button (component 3) is the fallback. Cache + button cover each
  other's gaps.
- **Non-authoritative:** this cache is a display read-model, **not** a backup (see
  Durability). After a write to a slug, refresh that slug's cache from the pod
  (read-your-write).

## Data flow

**Manual button:** UI → `POST /api/gateways/wake {id}` → MC resolves slug+token →
`wakeRemotePod` → operator `/wake` → verify + patch + stamp → `{status,phase}` →
UI polls health → WS reconnects.

**Chat (open / send):** `chat.history`/`chat.send` server RPC → wrapper calls
`wakeRemotePod` (debounced) → RPC proceeds (retry once on cold-start failure).

**Passive (no wake):** `sessions.list` and the ambient live-events WS never call
`wakeRemotePod`; the session list is served live if the pod is up, else from the KV
cache marked stale.

## Authentication & security

- The **gateway token is the only credential**, held solely by the MC server. `/wake`
  is called server-side only — the operator URL/token are never exposed to the browser.
- The operator narrows to a single CR by `slug`, then compares **only that CR's**
  secret — no cluster-wide secret scan, no ability to wake another tenant's pod.
- traefik TLS recommended on the wake route. The user's machine holds **zero** k8s
  credentials, satisfying the "users cannot access k3s/operator" constraint.

## Error handling & idle-stamp

- **Wake failure / timeout:** button shows "wake failed — retry"; the chat path
  propagates the original RPC error (idempotent, so retry is safe).
- **Cold start:** `/wake` returns immediately (pod boot is async). The chat RPC retries
  briefly until the pod is ready; the button UX polls `/api/gateways/health`.
- **Token mismatch:** operator returns `401`; MC fails quietly (logs only).
- **Idle-stamp gap:** the operator stamps `last-active=now` on every `/wake`, and every
  `chat.send`-driven wake refreshes it, so active use won't be idle-suspended
  mid-session. No separate heartbeat endpoint is needed.

## Durability (operational — not built here)

The session cache is a display convenience, **not** a backup. Durability of
pod-authoritative data against volume loss is the operator's responsibility via its
existing PVC→S3 backup/restore: `BackupSpec.Schedule` → rclone CronJob to S3 with
`RetentionDays`; `RestoreFrom` → restore before StatefulSet creation (`openclaw-operator`
`api/v1alpha1/openclawinstance_types.go:613-653`, `internal/controller/{backup,restore}.go`).

Operational follow-up (tracked outside this spec):
- Ensure the S3 backup credentials Secret exists (operator silently skips backup if not).
- Set a backup `Schedule` + `RetentionDays` on every tenant `OpenClawInstance` (incl. `alice`).
- Run periodic **canary test-restores** into a parallel namespace — "the question is not
  whether backups exist but when one was last successfully restored." StatefulSet /
  operator-managed workloads have known restore failure modes, so restores must be
  exercised, not assumed.

## Testing (TDD)

- **Operator `/wake`** (envtest / e2e): valid token → `suspended=false` + annotation;
  wrong token → `401`, CR untouched; unknown slug → `404`; already-running → idempotent
  no-op. e2e on kind verifies replicas 0→N.
- **MC `wakeRemotePod` + wrapper** (vitest): payload shape, debounce, wake-then-retry
  on failure — extracted as pure functions (mirrors the existing
  `mapGatewayRpcSessions` test pattern). Assert `sessions.list` does **not** call
  `wakeRemotePod`.
- **Session cache** (vitest): success overwrites KV blob; failure returns cached
  entries flagged `stale`/`active:false`.
- **UI button:** click → route call → status transitions.

## Deliberately out of scope (YAGNI)

- **Per-tenant rate-limit / flap-backoff** — the patch is idempotent and the idle
  window is 1h, so wake→immediate-suspend cannot happen. Add a per-slug token bucket in
  the operator only if abuse is observed.
- **Transparent activator (KEDA/Knative)** — rejected on ROI: heaviest infra
  (WS interceptor + Gateway API rewiring + collision with the operator's own suspend
  logic) for a marginal gain over a tiny MC change.
- **Separate in-cluster waker service** — dominated by hosting the endpoint on the
  existing operator (no new deployment).
- **Separate heartbeat endpoint** — `last-active` is stamped on wake / `chat.send`.
- **Broader remote-mode rewiring** (cron, files, integrations, skills, memory, etc.) —
  tracked in yw0nam/mission-control#17.
