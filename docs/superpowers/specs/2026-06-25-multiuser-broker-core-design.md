# Multi-Tenant OpenClaw via MC Broker — Core Design (v2)

Date: 2026-06-25
Status: revised after 3 independent reviews (architecture / security / fact-check); pre-plan
Repo: `yw0nam/mission-control` (fork), branch `feat/k8s-multiuser-self-service`

> v2 changelog: topology decided (MC server-side reverse-proxy); isolation moved
> to the API layer with default-deny; resolver now covers on-disk state reads,
> not just the network gateway URL; corrected env-var / migration / resource
> facts; added schema, concurrency, rate-limit, kill-switch, and a 4-stream
> build order. See "Review deltas" at the end.

## Goal

Turn Mission Control from a single-host operator dashboard into a multi-tenant
portal for the OpenClaw k3s ecosystem:

1. A user requests an account; an admin reviews and grants it. Granting =
   provisioning **one OpenClaw pod** (`OpenClawInstance`) for that user. The pod
   is suspended when idle and resumed when the user returns.
2. A user acts **only inside their own pod**. They cannot see other pods' info
   or host-server data. (Today MC leaks host data to any logged-in user — this
   design closes that **at the API layer**.)
3. The user's pod is reached **through MC**; inside it the user runs their own
   skills/workflows. Data is per-user isolated and **persists across
   suspend → kill → wake**.
4. A user views their **own** usage/results in the **same MC dashboard**; only
   the data source changes (their pod), enforced server-side.

Team-lead aggregate dashboard is deferred to Phase 2 (issue #12).

## Model

**k8s owns isolation; MC is a server-side broker.** MC does login, admin
approval, provisioning, lifecycle, and a per-user-scoped dashboard. For
non-admins, **MC is the only path to a pod**: it reverse-proxies all
gateway traffic server-side, so pod gateways stay `ClusterIP` and per-pod
tokens never reach the browser.

Isolation is enforced **at the API layer, not by hiding UI**. Hiding the
operator dashboard is necessary but not sufficient: today every gateway/host
API route is reachable by a non-admin with a session cookie. The core of this
design is **default-deny on those routes**, plus a single session-bound
resolver.

## Already built and verified (do not rebuild)

- Admin creates tenant → two-person approve → bootstrap → operator brings up the
  pod. (`super-admin.ts`, `super-admin-k8s.ts`)
- `spec.suspended` = scale-to-zero; resume = wake (measured ~8s cold on dev43);
  **PVC persists data across the cycle** — verified live 2026-06-25.
- Per-namespace isolation: `ResourceQuota`, egress-lockdown `NetworkPolicy`,
  operator per-instance `NetworkPolicy` + `Role`/`RoleBinding`.
- Owner self-service: `tenants.owner_user_id` (migration 051), `/api/me/instance`
  view/suspend/resume, two-person exempt for suspend/resume
  (`super-admin.ts:924-932`).
- Operator exposes, per instance, in `OpenClawInstance.status` (verified live):
  `gatewayEndpoint` = `<name>.user-<slug>.svc:18789` (ClusterIP, in-cluster
  only) and `managedResources.gatewayTokenSecret` = `<name>-gateway-token`.
  **The resolver reads these from CR status — do not hardcode the naming.**

## Build order (4 work-streams)

The resolver is meaningless until the deployment topology exists, so author
order ≠ build order. Build **WS2 → WS1 → WS3 → WS4**:

- **WS2 — In-cluster deploy + RBAC + state.** Blocks everything broker-side.
- **WS1 — Schema + per-tenant secrets access.** Resolver inputs.
- **WS3 — Resolver + API default-deny + server-side proxy.** The isolation heart.
- **WS4 — Auto suspend/wake controller.** Lifecycle automation.

---

## WS2 — In-cluster deployment

Pod gateways are `ClusterIP`, reachable only in-cluster, so **MC must run
in-cluster** to broker and to read per-tenant token Secrets. Deliverables:

- MC Deployment + Service in the cluster; a `ServiceAccount` with **namespaced**
  RBAC (see WS1 / fork issue #7 — NOT cluster-wide `secrets get`).
- k8s access from inside the pod: choose embedded client (`@kubernetes/client-node`)
  over shelling to `kubectl`; today `super-admin-k8s.ts` shells to a host kubectl
  binary that won't exist in the pod. (Decision recorded in the plan.)
- `PersistentVolumeClaim` for `.data` (SQLite + provisioner state dir), which is
  host-FS today (`super-admin-k8s.ts:38-39, 145-151`).
- Host-process mode remains for **single-operator/dev** use; the broker features
  target the in-cluster topology only. `pnpm dev` on the host cannot reach
  ClusterIP gateways without a port-forward — documented as a dev limitation.

## WS1 — Schema + per-tenant secrets

- Migration `052_tenant_activity`: add `tenants.last_active_at INTEGER NULL`.
  (Gateway host/port/token are read from CR status at request time, not stored —
  avoids drift. Only activity needs persisting.)
- `getTenantGateway(slug)` module: reads `OpenClawInstance.status.gatewayEndpoint`
  + `.status.managedResources.gatewayTokenSecret`, then reads that Secret **via a
  namespaced client scoped to `user-<slug>`** — never a cluster-wide secret get.
  **Fork issue #7 (per-tenant Role, drop cluster-wide `secrets get`) is a BLOCKING
  prerequisite**, not a follow-up: a single resolver bug or RCE in an MC with
  cluster-wide secret read = every tenant's token.
- Audit-log every per-tenant secret read as `{actor, tenant}` so a cross-tenant
  read is detectable.

## WS3 — Resolver + API default-deny + server-side proxy (the isolation heart)

### 3a. Default-deny the data/host API surface
The leak is in the API, not the UI. Produce a **route classification table** (an
acceptance artifact) splitting every route under `src/app/api/**` into
`host-scoped` (admin-only) vs `tenant-scoped` (resolver-bound) vs `public`.
Then:
- Gate all **host-reading** routes `admin` at the handler: host `~/.claude`
  sessions (`/api/sessions`, `/api/claude/sessions`), host provider subs
  (`/api/status` provider fields), `/api/agents/discover`*, `/api/gateways`
  (registry), `/api/gateways/connect`, `/api/gateways/discover`,
  `/api/gateways/control`, host flight-deck/system-monitor/logs/memory.
  (`requireRole('viewer')` today; ~60 viewer-gated routes — the table enumerates
  them. *some, e.g. `/api/agents/sync`, are already admin-gated.)
- Non-admin handlers must **not read** any client-supplied `id/host/port/slug/url`
  for gateway selection. Enforce with a typed split so it can't regress.

### 3b. Session-bound resolver — the single decision point
Add `resolveTenantContext(session)`:
- **admin** → host/global target (unchanged behavior).
- **owner (non-admin)** → their tenant via `getTenantForOwner(session.userId)`;
  derive gateway from CR status (WS1). Returns `null` if the user owns no tenant
  → caller returns 403. **Never fall back to the global gateway for a non-admin.**

Converge ALL gateway/state access onto this resolver. The fact-check found the
real targets (the v1 spec named the wrong env var):
- Network gateway: `config.gatewayHost` / `config.gatewayPort` (from
  `OPENCLAW_GATEWAY_HOST` / `OPENCLAW_GATEWAY_PORT`, `config.ts:96-97`) and the
  token resolver in `gateway-runtime.ts` (`OPENCLAW_GATEWAY_TOKEN`). Used by
  `callOpenClawGateway` (`openclaw-gateway.ts:82-93`), which **takes no session
  today** — thread the resolved context through it.
- **On-disk reads:** usage and session listings read the gateway's on-disk
  `OPENCLAW_STATE_DIR`, not the network gateway (`tokens/route.ts:200`,
  `sessions/route.ts:23-24`, `sessions.ts:68`). A URL-only resolver will NOT
  redirect these — for a tenant these must resolve to that tenant's data (proxied
  from the pod, since in-cluster MC has no host state dir for them), or be served
  from MC-side per-tenant records. Treat on-disk state as a first-class resolver
  output, not an afterthought.
- Scattered helpers to fold in: `gatewayUrl()` in `gateway-config/route.ts:15`
  and `exec-approvals/route.ts:8`; `buildGatewayWebSocketUrl()`
  (`gateway-url.ts:70`).

### 3c. Server-side reverse-proxy
- MC proxies the live WS/HTTP gateway paths (chat, terminal/transcript, control)
  to the resolved tenant gateway **in-cluster**; the per-tenant token is attached
  server-side and never sent to the browser. This re-plumbs the currently
  browser-direct path (`gateways/connect/route.ts:155-205` hands the browser a
  raw token + ws_url) — a substantial item, scoped explicitly here.
- Forbid the `NEXT_PUBLIC_GATEWAY_URL` browser-WS override for non-admins
  (`connect/route.ts:156-161`).

### 3d. CI guard (anti-regression)
A test fails if any file under `src/app/api/**` constructs a gateway target or
reads `config.gatewayHost`/`getDetectedGatewayToken`/`OPENCLAW_STATE_DIR`
outside the resolver. Prevents a new route silently re-introducing the global
target = a fresh cross-tenant leak.

### 3e. Privileged-principal handling
- The synthetic global API-key user (`auth.ts:471-500`, `id:0`, `role:'admin'`)
  and negative-id agent keys must be treated as **admin-host**, never routed
  through the per-tenant owner branch.
- In broker mode, forbid `MC_PROXY_AUTH_DEFAULT_ROLE=admin` and do not co-locate
  the global API key in the in-cluster MC (use the ServiceAccount for cluster ops).

## WS4 — Auto suspend / wake

- **Activity signal:** stamp `tenants.last_active_at` in the resolver on every
  brokered request (single choke point).
- **Auto-wake (on access):** if the resolved tenant is `Suspended`, resume then
  proceed (~8s). **Rate-limit per tenant** (resume cooldown + flap backoff) — a
  user can otherwise flap suspend/auto-wake to burn shared vLLM (DoS/cost).
- **Idle suspend (cron):** suspend tenants past `idle_window` (default 30 min,
  configurable). Make it **operator-authoritative and atomic**, not check-then-act:
  - re-check `last_active_at` + active sessions **inside** the transition;
  - use the existing compare-and-set `expected` arg of `updateTenantStatus`
    (`super-admin.ts:388-407`) and `provision_jobs.idempotency_key`
    (`migrations.ts:312`) so wake-while-suspending and double-resume cannot land;
  - the operator/controller refuses to scale a pod that reports an in-flight job
    (MC's read may be stale → authority is the operator).
  - cap the maximum "active-session pin" so a user can't keep a no-op session to
    defeat idle-suspend forever.
- All owner lifecycle actions go through `runSelfServiceLifecycle(user, kind)`
  (tenant derived from session); never expose a `tenantId`-taking lifecycle
  endpoint below `admin` (`createTenantLifecycleJob` stays admin-only).

## Data flow (regular user)

```
user → MC login → (owner) scoped dashboard
  → request hits a tenant-scoped route
  → resolveTenantContext(session) → tenant gateway (CR status) + on-disk scope
     (403 if no tenant; never global)                          [WS3b]
  → if Suspended: rate-limited resume (auto-wake)              [WS4]
  → MC reverse-proxies to the pod gateway, token server-side    [WS3c]
  → stamp tenant.last_active_at                                 [WS4]
user runs skills/workflows in their pod; data on PVC (persists across suspend)
idle cron suspends idle tenants (atomic, operator-authoritative) [WS4]
```

## Isolation guarantees

- pod↔pod / pod↔host network: `NetworkPolicy` + egress-lockdown (done).
- user↔user / user↔host: **every** tenant-scoped route resolves only via
  `resolveTenantContext`; host routes are admin-only at the handler; non-admins
  cannot supply a gateway target and never receive a token (server-side proxy).
- ownership: server-side from session (`getTenantForOwner`), no client tenant id.
- regression: CI guard (3d) + the route classification table as living acceptance.

## Safety / rollout

- `MC_BROKER_MODE` kill-switch: off → today's single-host behavior; on → broker +
  default-deny. Ship behind the flag.
- **Acceptance gate:** an automated cross-tenant isolation test (user A cannot
  read user B's gateway/state/usage via any route) must pass before enabling.
- Failure-mode table (pod Failed/Degraded, token Secret missing, resume timeout,
  cluster unreachable → resolver returns null → 403, not a silent global
  fallback) with the user-facing behavior for each, incl. the ~8s wake loading
  state.

## Out of scope (YAGNI for core)

- Public self-signup (admin approval only); >1 pod per user; `plan_tier` → quota
  (#5); team-lead dashboard (Phase 2, #12); finer activity detection beyond
  brokered-request recency + active-session guard.

## Review deltas (what changed from v1)

- **Topology decided:** MC server-side reverse-proxy (v1 was ambiguous and
  contradicted the browser-direct connect path + ClusterIP claim).
- **Isolation moved to API layer / default-deny** (v1 implied UI gating sufficed —
  it does not; ~60 viewer-gated routes leak via `curl`).
- **Resolver covers on-disk `OPENCLAW_STATE_DIR` reads**, not just the network
  URL (v1 would have left usage/session reads pointed at host).
- **Facts corrected:** env is `OPENCLAW_GATEWAY_HOST/_PORT`(+`_TOKEN`), not
  `OPENCLAW_GATEWAY_URL`; workspace attribution is migration 023, not 025; the
  ClusterIP Service + `<name>-gateway-token` Secret are operator-rendered (read
  from CR status), not in MC code.
- **Added:** schema migration `052`, namespaced secrets access with #7 as a
  blocking prereq, concurrency design (CAS + idempotency + operator authority),
  auto-wake rate-limit, privileged-principal handling, CI anti-regression guard,
  `MC_BROKER_MODE` kill-switch + cross-tenant isolation acceptance test, 4-stream
  build order.
