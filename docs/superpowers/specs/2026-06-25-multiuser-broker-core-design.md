# Multi-Tenant OpenClaw via MC Broker — Core Design

Date: 2026-06-25
Status: approved direction, pre-plan
Repo: `yw0nam/mission-control` (fork), branch `feat/k8s-multiuser-self-service`

## Goal

Turn Mission Control from a single-host operator dashboard into a multi-tenant
portal for the OpenClaw k3s ecosystem, with these user-facing rules:

1. A user requests an account; an admin reviews and grants it. Granting =
   provisioning **one OpenClaw pod** (an `OpenClawInstance`) for that user.
   The pod is suspended when the user is idle and resumed when they return.
2. A user can act **only inside their own pod**. They cannot see other pods'
   info or host-server data. (Today MC leaks host data to any logged-in user —
   this design closes that.)
3. The user's pod is reached **through MC**. Inside it the user runs their own
   skills/workflows. Data is per-user isolated and **persists across
   suspend → kill → wake**.
4. A user views their **own** usage/results in the **same MC dashboard** — only
   the data source changes (their pod gateway, not the host).

Team-lead aggregate dashboard is deferred to Phase 2 (issue #12).

## Model

**k8s owns isolation; MC is the broker.** MC does login, admin approval,
provisioning, lifecycle, and a per-user-scoped dashboard. Non-admin users never
render the operator/host (Local-mode) dashboard, so host-data exposure is
structurally impossible.

## Already built and verified (do not rebuild)

- Admin creates tenant → two-person approve → bootstrap → operator brings up the
  pod. (`super-admin.ts`, `super-admin-k8s.ts`)
- `spec.suspended` = scale-to-zero; resume = wake (measured ~8s cold on dev43);
  **PVC persists data across the cycle** — verified live 2026-06-25.
- Per-namespace isolation: `ResourceQuota`, egress-lockdown `NetworkPolicy`,
  operator per-instance `NetworkPolicy` + `Role`/`RoleBinding`.
- Owner self-service: user↔tenant binding (`tenants.owner_user_id`),
  `/api/me/instance` view/suspend/resume, two-person exempt for suspend/resume.

## Core delta (this spec)

### 1. Per-session gateway resolver — the isolation heart
Today MC resolves the gateway target from **global env** (`OPENCLAW_GATEWAY_URL`)
and several routes hold their own `gatewayUrl()` helper built from env
(`gateway-config`, `exec-approvals`, …). MC's data layer already reads usage,
sessions, transcripts, alerts, and chat from a gateway when in gateway mode.

Add `resolveGatewayForRequest(session)`:
- **admin** → global/host target (unchanged).
- **owner (regular user)** → that user's tenant gateway: host:port from the
  tenant record + token from the pod's `<name>-gateway-token` Secret.
- Converge the scattered `gatewayUrl()` / WS-URL builders onto this resolver so
  there is **one** server-side decision point. The user cannot point elsewhere
  (no client-supplied gateway URL for non-admins).

This is what makes requirements 2, 3, and 4 true at once: same dashboard, data
sourced server-side from the caller's own pod only.

### 2. Non-admin entry gating
- Non-admins land on their scoped dashboard, never the operator views
  (host Fleet, host Activity, Local-mode banner, provisioning).
- Host/Local-mode endpoints (host `~/.claude` sessions, host provider
  subscriptions, fleet-from-host) become **admin-only**.

### 3. Auto-wake on access
When a non-admin's request resolves to a tenant whose pod is **suspended**, MC
resumes it (existing resume path) and then proceeds. ~8s cold start.

### 4. Idle auto-suspend
- Record `last_active_at` per tenant on every gateway request brokered for that
  tenant (the resolver is the natural choke point).
- A cron/controller suspends tenants where `now - last_active_at > idle_window`
  (default 30 min, configurable).
- **Active-session guard:** before suspending, check the pod gateway for active
  sessions; skip if busy (avoid killing a running workflow).
- `ponytail:` ceiling — activity = brokered-request recency + active-session
  guard. If finer idle detection is needed later, query gateway session state
  directly.

### 5. MC in-cluster deployment
Pod gateways are `ClusterIP` (`<name>.user-<slug>.svc:18789`), reachable only
from inside the cluster. For MC to broker and hold per-tenant tokens it must run
**in-cluster**, not as a host process. Aligns with fork issue #4 (k8s deploy
prereqs). Today's host-process mode remains valid for single-operator/dev use.

## Data flow (regular user)

```
user → MC login → (owner) scoped dashboard
  → request hits a gateway-backed route
  → resolveGatewayForRequest(session) → tenant gateway (host:port + token)
  → if suspended: resume (auto-wake)        [#3]
  → proxy/query the user's pod gateway       [#1]
  → stamp tenant.last_active_at              [#4]
user runs skills/workflows in their pod; data on PVC (persists across suspend)
idle cron suspends idle tenants (active-session guarded)   [#4]
```

## Isolation guarantees

- pod↔pod / pod↔host network: `NetworkPolicy` + egress-lockdown (done).
- user↔user: resolver binds to caller's own tenant; non-admins have no operator
  dashboard and cannot supply a gateway target.
- host data: no render path for non-admins; host endpoints admin-gated (#2).
- ownership: server-side from session (existing self-service pattern), no
  client-supplied tenant id.

## Out of scope (YAGNI for core)

- Public self-signup (admin approval only).
- More than one pod per user.
- `plan_tier` → quota mapping (fork issue #5).
- Team-lead aggregate dashboard (Phase 2, issue #12).
- Sophisticated activity detection beyond brokered-request + active-session
  guard.

## Open dependencies / risks

- In-cluster MC deploy (#5) is a deployment shift; needs a manifest + the
  per-tenant token access path (ties to fork issue #7: scope provisioner
  secrets per-tenant, avoid cluster-wide `secrets get`).
- OpenClaw app container Ready depends on the shared vLLM endpoint; unrelated to
  this design but affects perceived wake latency.
