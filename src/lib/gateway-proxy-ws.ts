/**
 * Gateway WebSocket broker — server-side reverse-proxy on /ws/gateway.
 *
 * A non-admin (owner) connects here; MC resolves their OWN tenant pod gateway,
 * auto-wakes it if suspended, opens a port-forward to the ClusterIP gateway, and
 * pipes raw frames between the browser and the pod. The per-tenant token is
 * attached server-side and NEVER sent to the browser. This is the only
 * default-denied path in the PoC (resolver → 403); it is what demonstrates
 * isolation. Admins keep the existing browser-direct /api/gateways/connect path.
 *
 * Topology = PoC-A: MC runs as a host process, so it reaches the in-cluster
 * ClusterIP gateway via an on-demand `kubectl port-forward` (torn down on close).
 */
import { type IncomingMessage } from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { requireRole } from '@/lib/auth'
import { logger } from './logger'
import { config } from './config'
import { getDetectedGatewayToken } from './gateway-runtime'
import { resolveTenantGateway } from './tenant-gateway'
import { runSelfServiceLifecycle, markTenantActive } from './super-admin'
import { readInstancePhase, k8sNamespace, stampLastActive } from './super-admin-k8s'

const log = logger.child({ module: 'gateway-proxy-ws' })
const KUBECTL = process.env.MC_KUBECTL_PATH || '/usr/bin/kubectl'

// Activity-report throttle (spec: B1). Each brokered browser->pod frame is real
// user interaction, but we only re-stamp the CR annotation at most once per
// window per slug so kubectl spawns stay bounded. In-memory is fine: a single MC
// process owns the broker, and a stale entry only costs one extra stamp.
const STAMP_THROTTLE_MS = 60_000
const lastStampAt = new Map<string, number>()
function reportActivity(slug: string): void {
  const now = Date.now()
  if (now - (lastStampAt.get(slug) ?? 0) < STAMP_THROTTLE_MS) return
  lastStampAt.set(slug, now)
  void stampLastActive(slug)
}

interface ProxyContext {
  upstreamUrl: string
  pfProc: ChildProcess | null
  slug?: string // tenant slug, present for owner (non-admin) sessions — drives activity reporting
}

let wss: WebSocketServer | null = null

function writeWsHttpError(socket: any, status: number, message: string): void {
  const statusText = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : 'Bad Request'
  const body = JSON.stringify({ error: message })
  const response = [
    `HTTP/1.1 ${status} ${statusText}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n')
  try { socket.write(response) } catch { /* ignore */ }
  try { socket.destroy() } catch { /* ignore */ }
}

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host || 'localhost'
  const url = new URL(req.url || '/', `http://${host}`).toString()
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '))
    else if (typeof value === 'string') headers.set(key, value)
  }
  return new Request(url, { method: req.method || 'GET', headers })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start `kubectl port-forward svc/<slug>` and resolve the auto-assigned local port. */
function startPortForward(slug: string, remotePort: number): Promise<{ localPort: number; proc: ChildProcess }> {
  const ns = k8sNamespace(slug)
  const proc = spawn(KUBECTL, ['port-forward', `svc/${slug}`, '-n', ns, `:${remotePort}`])
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; try { proc.kill() } catch {} ; reject(new Error('port-forward timeout')) } }, 20000)
    proc.stdout?.on('data', (d: Buffer) => {
      const m = String(d).match(/Forwarding from 127\.0\.0\.1:(\d+)/)
      if (m && !done) { done = true; clearTimeout(timer); resolve({ localPort: Number(m[1]), proc }) }
    })
    proc.on('exit', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('port-forward exited before ready')) } })
    proc.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err) } })
  })
}

function initServer(): WebSocketServer {
  if (wss) return wss
  wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (browserWs: WebSocket, req: IncomingMessage) => {
    const ctx: ProxyContext | undefined = (req as any).__gwctx
    if (!ctx) { browserWs.close(); return }

    const upstream = new WebSocket(ctx.upstreamUrl)
    const queue: Array<{ data: any; binary: boolean }> = []
    let upstreamOpen = false

    const cleanup = () => {
      if (ctx.pfProc) { try { ctx.pfProc.kill() } catch { /* ignore */ } ; ctx.pfProc = null }
    }

    upstream.on('open', () => {
      upstreamOpen = true
      for (const m of queue) { try { upstream.send(m.data, { binary: m.binary }) } catch {} }
      queue.length = 0
    })
    upstream.on('message', (data: Buffer, isBinary: boolean) => {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.send(data, { binary: isBinary })
    })
    upstream.on('close', () => { try { browserWs.close() } catch {} ; cleanup() })
    upstream.on('error', (err) => { log.warn({ err: err?.message }, 'upstream gateway error'); try { browserWs.close() } catch {} ; cleanup() })

    browserWs.on('message', (data: Buffer, isBinary: boolean) => {
      // A browser->pod frame is user interaction (UI click/command): report activity
      // to the cluster (throttled) so the operator's idle-suspend stays off while the
      // owner is actively working.
      if (ctx.slug) reportActivity(ctx.slug)
      if (upstreamOpen) { try { upstream.send(data, { binary: isBinary }) } catch {} }
      else queue.push({ data, binary: isBinary })
    })
    browserWs.on('close', () => { try { upstream.close() } catch {} ; cleanup() })
    browserWs.on('error', () => { try { upstream.close() } catch {} ; cleanup() })
  })

  return wss
}

/** Handle an HTTP upgrade for /ws/gateway. Returns true if it owned the request. */
export async function handleGatewayUpgrade(req: IncomingMessage, socket: any, head: Buffer): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/ws/gateway') return false

  const auth = requireRole(toRequest(req), 'viewer')
  if ('error' in auth) {
    writeWsHttpError(socket, auth.status || 401, auth.error || 'Authentication required')
    return true
  }
  const user = auth.user

  let upstreamUrl: string
  let pfProc: ChildProcess | null = null
  let slug: string | undefined

  try {
    const res = await resolveTenantGateway({ id: user.id, role: user.role })

    if (res.kind === 'denied') {
      writeWsHttpError(socket, 403, 'No instance assigned to this user')
      return true
    }
    if (res.kind === 'admin') {
      // Admins use the global/host gateway directly (host-reachable, no port-forward).
      const token = getDetectedGatewayToken()
      upstreamUrl = `ws://${config.gatewayHost}:${config.gatewayPort}/?token=${encodeURIComponent(token)}`
    } else if (res.kind === 'unavailable') {
      writeWsHttpError(socket, 503, 'Instance is not ready yet')
      return true
    } else {
      // tenant: auto-wake if suspended, then port-forward to the ClusterIP gateway.
      if (res.tenant.status === 'suspended') {
        log.info({ slug: res.tenant.slug }, 'auto-wake on gateway access')
        await runSelfServiceLifecycle({ id: user.id, username: user.username }, 'resume')
        for (let i = 0; i < 20; i++) {
          if ((await readInstancePhase(res.tenant.slug)) === 'Running') break
          await sleep(1500)
        }
      }
      const pf = await startPortForward(res.tenant.slug, res.port)
      pfProc = pf.proc
      upstreamUrl = `ws://127.0.0.1:${pf.localPort}/?token=${encodeURIComponent(res.token)}`
      markTenantActive(res.tenant.id)
      slug = res.tenant.slug
      // Report activity to the cluster on connect (operator reads it to decide idle).
      reportActivity(slug)
    }
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'gateway upgrade failed')
    writeWsHttpError(socket, 503, 'Failed to reach instance gateway')
    return true
  }

  if (!wss) initServer()
  ;(req as any).__gwctx = { upstreamUrl, pfProc, slug } as ProxyContext
  wss!.handleUpgrade(req, socket, head, (ws) => {
    wss!.emit('connection', ws, req)
  })
  return true
}
