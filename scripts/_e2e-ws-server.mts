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

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || hostname}`)
  if (url.pathname !== '/ws/gateway') { upgradeNext(req, socket, head); return }
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
