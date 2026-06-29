# Viewer Nav Expansion — Pod-Scoped Panels

**Date:** 2026-06-29
**Status:** Design (pending review)
**Repo:** mission-control (`develop`)

## 1. Goal

A tenant **viewer** today sees only My Instance + Chat. The vision is **"same UI, different
data scope"**: a viewer sees a rich console, but every panel reads **their own pod** over
`/ws/gateway` instead of host/admin APIs.

Chat already proved the mechanism (committed `5259525`): client-side `call(method)` over the
open gateway socket + a pure adapter + `useSmartPoll`. This spec applies that to the rest of
the pod-scoped panels — **but only where the existing panel's UI actually fits pod-gateway
data.** §2 records a live compatibility probe (openclaw 2026.2.3 on tenant `alice`) that
determined which panels re-source cleanly, which need adapter work, and which must be rebuilt.

## 2. Compatibility findings (live probe, 2026-06-29)

Each candidate panel's view-model was compared against the real gateway response shape.

| Panel | Method | Verdict | Why |
|---|---|---|---|
| **Skills** | `skills.status` | ✅ clean | Returns 51 rich skill objects (`name`, `description`, `source`, eligibility). *Richer* than the panel uses. |
| **Channels** | `channels.status` | ✅ clean | Shape is identical to host `/api/channels`. Renders empty until a channel is linked. |
| **Cron** | `cron.list` | ✅ clean | Shape matches `CronJob`. Renders empty until jobs exist. |
| **Logs** | `logs.tail` | ⚠️ needs parser | Returns **raw JSON log strings** (`_meta.logLevelName`, `time`, subsystem, message). Adapter must parse each line into `LogEntry`. |
| **Cost** | `usage.cost` | ⚠️ partial | Gives top-line `totals` + short `daily` trend → Overview tiles only. Per-agent/session/task views are MC-DB concepts with no gateway data. |
| **Agents** | `agents.list` | ⚠️ id-only | Returns `[{id:"main"}]` — **names only**. The heavy `agent-squad-panel` (model/status/task-stats, soul/memory edit, wake, spawn, sync) is ~90% dead. |
| **Nodes** | `node.list` | ✖ dropped | A single tenant pod has 0 nodes; device-pairing tab is host-only. Near-always empty. |
| **Overview** | `status` | ✖ wrong domain | `Dashboard` is built on MC-DB aggregates (tasks/audit/notifications/pipelines/backup). `status` gives pod heartbeat + sessions. |
| **Monitor** | `health` | ✖ wrong domain | `system-monitor-panel` wants OS metrics (CPU/mem/disk/GPU/processes). `health` is liveness only. |
| **Settings** | `config.get` | ✖ wrong domain | Panel manages MC app settings (DB key-values, API-key rotation, Hermes, backup). `config.get` returns the pod's `openclaw.json`. |

**Conclusion:** "same UI, different data" holds for Skills/Channels/Cron and (with work)
Logs/Cost. For Overview/Monitor/Settings/Agents the existing panel is built around
MC-host/DB concepts — re-sourcing shows the wrong thing. Those get **purpose-built pod-native
panels** instead (decision below), not a re-source.

## 3. Scope

### Group A — Re-source existing panel, clean adapter

| Nav id | Panel | Method | Notes |
|---|---|---|---|
| `skills` | `skills-panel.tsx` | `skills.status` | adapter: gateway skill → `SkillSummary` (`id←skillKey`, `path←filePath`; synth `groups`/`total`). |
| `channels` | `channels-panel.tsx` | `channels.status` | shape passes through; empty-state for unlinked tenant. |
| `cron` | `cron-management-panel.tsx` | `cron.list` | shape passes through; empty-state until jobs. |

### Group B — Re-source existing panel + real work

| Nav id | Panel | Method | Work |
|---|---|---|---|
| `logs` | `log-viewer-panel.tsx` | `logs.tail` | **pure line-parser adapter** `parseGatewayLogLine(str) → LogEntry` (JSON.parse → `level`/`timestamp`/`source`/`message`), unit-tested against a real captured line. |
| `cost-tracker` | `cost-tracker-panel.tsx` | `usage.cost` | viewer scope renders **Overview view only** (top-line totals + `daily` trend); Agents/Sessions/Tasks tabs hidden when pod-scoped (no data). |

### Group C — Rebuild pod-native (new lightweight viewer panels)

The existing MC panel is kept for admins; a viewer gets a new pod-scoped component, branched
by role in `ContentRouter` (`page.tsx`): `return isAdmin ? <ExistingPanel/> : <PodPanel/>`.

| Nav id | New component | Method | Renders |
|---|---|---|---|
| `overview` | `PodOverviewPanel` | `status` (+`health`) | pod summary tiles: default agent, session count, recent sessions (from `status.sessions.recent`), liveness. |
| `monitor` | `PodHealthPanel` | `health` | liveness card: `ok`, `durationMs`, heartbeat, per-agent health, recent sessions. (No OS charts.) |
| `settings` | `PodConfigPanel` | `config.get` | **read-only** rendered `openclaw.json` (`parsed`/`resolved`) — model provider, gateway mode, browser, session scope. |
| `agents` | `PodAgentRosterPanel` | `agents.list` (+`status`) | thin roster: agent id, active-session count + model + last activity (joined from `status.sessions.byAgent`). No management actions. |

These are small read-only components (a card + a list each), not ports of the heavy panels.

### Deferred (separate spec)

`activity` (passive event stream, no pull method), `debug` (cobble `status`+`health`+`logs`).
Hidden from viewers until shipped.

### Dropped / excluded (no pod data or admin-only)

`nodes`, `memory`, `tasks`, `office`, `webhooks`, `alerts`, `integrations`, `security`,
`exec-approvals`, `gateways`/`gateway-config`, `users`, `github`, `audit`.

> All Group A/B panels are **read-only** for viewers: host mutation routes (channel-link,
> cron-add, skill-install, etc.) need gateway mutation methods that are out of scope. Buttons
> that would call them are hidden in the pod-scoped render path.

## 4. Mechanism

Per panel (the committed chat pattern; `multi-gateway-panel`/`exec-approval-panel` already use
`useWebSocket()` at panel level):

1. `const { call, isConnected } = useWebSocket()` — singleton socket, already connected.
2. Replace host `fetch('/api/…')` with `call('<method>', params?)`.
3. Map result → view-model via a **pure adapter** in `gateway-adapters.ts` (one fn per shape,
   unit-tested — mirrors `gatewaySessionsToConversations`/`gatewayAgentsToAgents`).
4. Poll with `useSmartPoll(load, <interval>, { pauseWhenDisconnected:true, backoff:true })`
   (logs 10s; skills/channels/cron/cost/overview/monitor/agents 30–60s).
5. Gate render on `isConnected`.

No backend/broker/auth/`websocket.ts` changes. No new dependency.

## 5. Nav gating

Replace the evaluation-phase "show everything" change (uncommitted, `nav-rail.tsx` +
`[[...panel]]/page.tsx`) with a curated viewer allowlist:

```
VIEWER_VISIBLE = { my-instance, chat,                 // done
                   skills, channels, cron,            // group A
                   logs, cost-tracker,                // group B
                   overview, monitor, settings, agents } // group C (pod-native)
```

- `nav-rail.tsx`: re-add `if (!isAdmin && !VIEWER_VISIBLE.has(i.id)) return null`.
- `page.tsx` `ContentRouter`: re-add the non-admin route guard (deep-link to a non-allowlisted
  tab bounces to `MyInstancePanel`); add the Group C role branches.

## 6. Runtime version

Entire scope works on **openclaw 2026.2.3** (the provisioner template tag). The 2026.3.1 PoC
is **not required**. Revert `alice` to 2026.2.3 before final verification; no template bump.

## 7. Testing

- **Unit (TDD):** one pure-adapter test per adapter — skills, log-line parser (real captured
  line), cost-totals, pod-overview, pod-health, pod-config, pod-roster. Empty/malformed
  tolerance each. `pnpm typecheck` clean.
- **E2E (Playwright, viewer on dev43):** every allowlisted panel loads pod data, **no `/api/*`
  403**, renders real content or a graceful empty state, survives reload. Admin still gets the
  original Overview/Monitor/Settings/Agents panels (role branch). Excluded panels absent from
  nav + bounce on deep-link.
- **No regression** in committed chat/sessions/my-instance paths.

## 8. Execution shape

Group A/B = same mechanical re-source repeated → pipeline of TDD subagents (one panel per item:
adapter test → adapter → wire → green). Group C = four small new components (TDD: adapter +
render). Then one nav-gating change + one E2E pass. Commits: Conventional Commits, **no AI
attribution**. PRs only to `yw0nam/*`.
