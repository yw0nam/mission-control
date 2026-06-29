# Viewer Nav Expansion — Re-source Pod-Scoped Panels

**Date:** 2026-06-29
**Status:** Design (pending review)
**Repo:** mission-control (`develop`)

## 1. Goal

A tenant **viewer** today sees only My Instance + Chat. The original MC UI has a full nav.
The vision is **"same UI, different data scope"**: a viewer sees the rich console, but every
panel reads **their own pod** over `/ws/gateway` instead of host/admin APIs.

This spec re-sources the panels that have a confirmed pod-gateway data source so a viewer's
nav is populated and **every listed panel actually functions** against their pod — no 403s,
no empty host-API shells.

Chat already proved the pattern (committed `5259525`): client-side `call(method)` over the
open gateway socket + a pure adapter + `useSmartPoll`. This spec applies that pattern to the
rest of the pod-scoped panels.

## 2. Scope

### 2a. In scope — re-source to pod gateway (this spec)

Each panel's host fetch is replaced with a client-side `call(method)` + a pure adapter.
All methods below were **live-probed and confirmed on the tenant runtime (openclaw 2026.2.3)**.

| Nav id | Panel component | Gateway method | Notes |
|---|---|---|---|
| `overview` | `Dashboard` (+ `AgentCommsPanel`) | `status` (+ `health`) | summary tiles from pod status |
| `agents` | `agent-squad-panel-phase3.tsx` | `agents.list` | adapter `gatewayAgentsToAgents` **already exists** (chat work) — reuse |
| `channels` | `channels-panel.tsx` | `channels.status` | |
| `skills` | `skills-panel.tsx` | `skills.status` | |
| `logs` | `log-viewer-panel.tsx` | `logs.tail` | |
| `cost-tracker` | `cost-tracker-panel.tsx` | `usage.status`, `usage.cost` | |
| `nodes` | `nodes-panel.tsx` | `node.list` | |
| `monitor` | `system-monitor-panel.tsx` | `health` | |
| `cron` | `cron-management-panel.tsx` | `cron.list` | |
| `settings` | `settings-panel.tsx` | `config.get`, `config.schema` | read-only for viewers |

Already done (no work): `my-instance` (pod lifecycle), `chat` (`chat.*`).

### 2b. Deferred — feasible, but no direct pull method (separate spec)

| Nav id | Panel | Why deferred |
|---|---|---|
| `activity` | `activity-feed-panel.tsx` | gateway exposes a **passive event stream**, no `activity.list` pull. Needs an event-subscription accumulator — different mechanism, own spec. |
| `debug` | `debug-panel.tsx` | no single method; must **cobble** from `status`+`health`+`logs.tail`. Composition work, own spec. |

These stay hidden from viewers until their spec lands.

### 2c. Out of scope — no pod-gateway data (stay admin-only / hidden)

`tasks`, `memory` (gateway gives readiness, **not** the file-vault the panel renders),
`office`, `webhooks`, `alerts`, `integrations`, `security`, `exec-approvals`,
`gateways`/`gateway-config`, `users`, `github`, `audit`.

Reason per group:
- **No gateway RPC** (`tasks`, `memory`, `office`, `webhooks`, `alerts`, `integrations`,
  `exec-approvals`): same basis as the dropped Memory/Tasks decision — re-sourcing has no
  data source, the panel would render empty/broken.
- **Admin governance / user choice** (`users`, `github`, `audit`, `security`,
  `gateways`/`gateway-config`): user explicitly excluded Users/GitHub/Audit; the rest are
  fleet-admin infra, not a single viewer's pod.

> Open question for review: `security` and `exec-approvals` sit in a viewer's own pod
> conceptually but have **no confirmed gateway method**. Excluded for now; pull into a later
> spec if a method is found. Flag if you want either kept visible (empty-state) now.

## 3. Mechanism

**Client-side `call(method)` per panel** — the committed chat pattern, already proven at
panel level (`multi-gateway-panel.tsx`, `exec-approval-panel.tsx` use `useWebSocket()`).

Per panel:
1. `const { call, isConnected } = useWebSocket()` (singleton socket, already connected).
2. Replace the host `fetch('/api/…')` with `call('<method>', params?)`.
3. Map the gateway result → the panel's existing view-model via a **pure adapter** in
   `gateway-adapters.ts` (one function per shape, unit-tested in isolation — mirrors
   `gatewaySessionsToConversations` / `gatewayAgentsToAgents`).
4. Poll with `useSmartPoll(load, <interval>, { pauseWhenDisconnected: true, backoff: true })`
   (already used by chat + `webhook-panel`). Interval per panel: logs/monitor 10s, the rest
   30–60s (low-churn).
5. Gate render on `isConnected` (show the existing disconnected/empty state otherwise).

No backend/broker/auth/`websocket.ts` changes. No new dependency.

**Why not a server-side proxy:** the socket is already open and authenticated per-tenant;
a proxy duplicates auth + adds a hop for zero benefit. Client-side `call()` reuses what chat
already established. (YAGNI.)

## 4. Nav gating

The evaluation-phase "show everything" change (uncommitted, in `nav-rail.tsx` +
`[[...panel]]/page.tsx`) is replaced by a **curated viewer allowlist** = the 2a set + the two
already-done panels:

```
VIEWER_VISIBLE = { my-instance, chat, overview, agents, channels, skills,
                   logs, cost-tracker, nodes, monitor, cron, settings }
```

- `nav-rail.tsx`: re-add `if (!isAdmin && !VIEWER_VISIBLE.has(i.id)) return null`.
- `[[...panel]]/page.tsx`: re-add the route guard — a non-admin hitting a non-allowlisted
  tab bounces to `MyInstancePanel` (prevents deep-link to an excluded panel).

`activity`/`debug` are **not** in the allowlist until their deferred spec ships.

## 5. Runtime version

The chosen scope works entirely on **openclaw 2026.2.3** (the provisioner template tag).
The 2026.3.1 PoC (`doctor.memory.status`, `tools.catalog`, `sessions.usage`) is **not
required** by any in-scope panel. The PoC tenant (`alice`) currently runs 2026.3.1; it
should be **reverted to 2026.2.3** before final verification so the verified build matches
what new tenants get. No provisioner-template bump.

## 6. Testing

- **Unit (TDD):** one pure adapter test per new adapter (real shape fixture + empty/malformed
  tolerance), following `gateway-adapters.test.ts`. `pnpm typecheck` clean.
- **E2E (Playwright, viewer login on dev43):** each allowlisted panel loads its pod data with
  **no `/api/*` 403**, renders real content (or a graceful empty state when the pod genuinely
  has none), and survives reload. Excluded panels are absent from the nav and bounce on
  deep-link.
- **No regression** in committed chat/sessions/my-instance paths.

## 7. Execution shape

The 10 panels are the **same mechanical change** repeated → ideal for a pipeline of TDD
subagents (one panel per item: write adapter test → adapter → wire panel → green), orchestrator
verifies, then one nav-gating change + one E2E pass. Commits: Conventional Commits, **no AI
attribution** (CLAUDE.md). PRs only to `yw0nam/*`.
