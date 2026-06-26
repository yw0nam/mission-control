// TEMP e2e server (not committed). Next dev + committed /ws/gateway broker.
import { createServer } from 'node:http'
import next from 'next'

const port = Number(process.env.PORT || 3000)
const hostname = process.env.HOSTNAME || '127.0.0.1'

const app = next({ dev: true, hostname, port })
await app.prepare()
const handle = app.getRequestHandler()
const upgradeNext = app.getUpgradeHandler()
let gatewayUpgrade: any

const server = createServer((req, res) => handle(req, res))

// Next dev lazily attaches its OWN 'upgrade' listener (HMR) on the first request
// — it grabs the server via req.socket.server. With two upgrade listeners, Next's
// fires too and resets any upgrade it doesn't own, killing our /ws/gateway broker
// socket (~40ms after our handshake). Fix: intercept upgrade-listener registration
// so Next's handler is CAPTURED as our delegate instead of being attached. Our
// router stays the sole real 'upgrade' listener; non-gateway upgrades (HMR) are
// forwarded to the captured handler.
let nextUpgrade: (req: any, socket: any, head: any) => void = upgradeNext
const origOn = server.on.bind(server)
const intercept = (orig: (e: string, l: any) => any) => (event: string, listener: any) => {
  if (event === 'upgrade') { nextUpgrade = listener; return server }
  return orig(event, listener)
}
server.on = intercept(origOn) as any
server.addListener = intercept(server.addListener.bind(server)) as any
server.prependListener = intercept(server.prependListener.bind(server)) as any

origOn('upgrade', async (req: any, socket: any, head: any) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || hostname}`)
  if (url.pathname !== '/ws/gateway') { nextUpgrade(req, socket, head); return }
  try {
    if (!gatewayUpgrade) gatewayUpgrade = (await import('../src/lib/gateway-proxy-ws')).handleGatewayUpgrade
    const ok = await gatewayUpgrade(req, socket, head)
    if (!ok) socket.destroy()
  } catch (err) {
    console.error('[e2e-ws] gateway upgrade THREW:', err)
    try { socket.destroy() } catch {}
  }
})

server.listen(port, hostname, () => console.log(`[e2e-ws] ready on http://${hostname}:${port}`))
