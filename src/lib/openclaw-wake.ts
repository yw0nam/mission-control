import { config } from '@/lib/config'
import { getDetectedGatewayToken } from '@/lib/gateway-runtime'
import { callOpenClawGateway } from '@/lib/openclaw-gateway'
import { logger } from '@/lib/logger'

// Abort a hung waker so a down endpoint never stalls a chat request
// (mirrors the abort pattern in src/app/api/gateways/health/route.ts).
const WAKE_TIMEOUT_MS = 5000
// Suppress repeat wakes per slug for this window, but only after a SUCCESS —
// a failed wake stays retryable so the next interaction can wake the pod.
const WAKE_DEBOUNCE_MS = 30_000
const lastWakeSuccessBySlug = new Map<string, number>()

// Readiness gate: a cold StatefulSet boot (schedule + image pull + PVC attach +
// agent + gateway WS) routinely exceeds a single RPC timeout, so poll instead.
const READINESS_DEADLINE_MS = 90_000
const READINESS_INTERVAL_MS = 3000
const READINESS_MAX_INTERVAL_MS = 10_000
const READINESS_PROBE_TIMEOUT_MS = 5000

/**
 * Wake a suspended remote pod by POSTing {slug, token} to the cluster waker
 * (config.wakeUrl). No-op returning false when no waker is configured
 * (local/self-hosted deploys). Debounced on success only; never throws.
 */
export async function wakeRemotePod(
  slug: string = config.gatewaySlug,
  token: string = getDetectedGatewayToken(),
): Promise<boolean> {
  if (!config.wakeUrl) return false

  const now = Date.now()
  const lastSuccess = lastWakeSuccessBySlug.get(slug)
  if (lastSuccess !== undefined && now - lastSuccess < WAKE_DEBOUNCE_MS) {
    logger.info({ slug, outcome: 'ok', latencyMs: 0, debounced: true }, 'wakeRemotePod skipped (recent success)')
    return true
  }

  const start = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS)
  try {
    const res = await fetch(config.wakeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, token }),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - start
    if (res.ok) {
      lastWakeSuccessBySlug.set(slug, Date.now())
      logger.info({ slug, outcome: 'ok', latencyMs, debounced: false }, 'wakeRemotePod succeeded')
      return true
    }
    logger.warn({ slug, outcome: `http_${res.status}`, latencyMs, debounced: false }, 'wakeRemotePod non-2xx')
    return false
  } catch (err) {
    const latencyMs = Date.now() - start
    const outcome = (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'error'
    logger.warn({ err, slug, outcome, latencyMs, debounced: false }, 'wakeRemotePod failed')
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Detect a "gateway is down / unreachable" error (suspended pod, connection
 * refused) — distinct from an RPC-level failure. Mirrors isUnknownMethodError
 * (src/lib/openclaw-gateway.ts). Note: callOpenClawGateway rethrows the RAW ws
 * error, so this must match the underlying shapes:
 *  - traefik 502/503/504 on the WS upgrade (Ingress route present, Service has
 *    0 endpoints while the pod is suspended/scaling) -> "Unexpected server
 *    response: 50x". Auth/routing codes (401/403/404) are deliberately excluded:
 *    waking will not fix them.
 *  - ECONNREFUSED (nothing listening) -> `code` is set at the top level for the
 *    raw system error, or nested under `cause` when wrapped.
 */
export function isGatewayUnreachableError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase()
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code
  return (
    msg.includes('websocket error') ||
    msg.includes('closed before') ||
    msg.includes('timed out') ||
    (msg.includes('unexpected server response') &&
      (msg.includes('502') || msg.includes('503') || msg.includes('504'))) ||
    code === 'ECONNREFUSED'
  )
}

/**
 * Poll the default chat gateway's `sessions.list` in a bounded backoff loop
 * until it answers (returns true) or the deadline elapses (returns false).
 * This is the readiness primitive for the single chat gateway — NOT
 * /api/gateways/health, which is a POST probing all gateways over HTTP.
 */
export async function waitForGatewayReady(
  opts: { deadlineMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadlineMs = opts.deadlineMs ?? READINESS_DEADLINE_MS
  let interval = opts.intervalMs ?? READINESS_INTERVAL_MS
  const deadline = Date.now() + deadlineMs

  for (;;) {
    try {
      await callOpenClawGateway('sessions.list', {}, READINESS_PROBE_TIMEOUT_MS)
      return true
    } catch {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, interval))
      interval = Math.min(interval * 2, READINESS_MAX_INTERVAL_MS)
    }
  }
}
