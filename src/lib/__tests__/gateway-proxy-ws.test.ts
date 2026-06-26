import { describe, expect, it } from 'vitest'
import { createGatewayBroker } from '@/lib/gateway-proxy-ws'
import { buildConnectFrame } from '@/lib/openclaw-gateway'

const TOKEN = 'tenant-secret-token'

function challengeFrame(nonce = 'nonce-1') {
  return JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce, ts: Date.now() } })
}

describe('buildConnectFrame', () => {
  it('carries the per-tenant token at params.auth.token with the gateway schema', () => {
    const frame: any = buildConnectFrame(TOKEN, 'connect-1')
    expect(frame.type).toBe('req')
    expect(frame.method).toBe('connect')
    expect(frame.id).toBe('connect-1')
    expect(frame.params.auth).toEqual({ token: TOKEN })
    expect(frame.params.minProtocol).toBe(3)
    expect(frame.params.maxProtocol).toBe(3)
    expect(frame.params.role).toBe('operator')
    expect(frame.params.client.id).toBe('gateway-client')
    expect(frame.params.client.mode).toBe('backend')
    expect(Array.isArray(frame.params.scopes)).toBe(true)
  })

  it('omits auth when no token is supplied', () => {
    const frame: any = buildConnectFrame(undefined, 'connect-2')
    expect(frame.params.auth).toBeUndefined()
  })
})

describe('createGatewayBroker — upstream handshake', () => {
  it('answers connect.challenge with a connect frame carrying the token, and swallows the challenge', () => {
    const broker = createGatewayBroker(TOKEN)
    const action = broker.onUpstreamFrame(challengeFrame())
    expect(action.forwardToBrowser).toBe(false)
    expect(action.sendUpstream).toBeDefined()
    expect((action.sendUpstream as any).method).toBe('connect')
    expect((action.sendUpstream as any).id).toBe(broker.connectId)
    expect((action.sendUpstream as any).params.auth).toEqual({ token: TOKEN })
  })

  it('swallows the connect res(ok:true) and marks the handshake complete', () => {
    const broker = createGatewayBroker(TOKEN)
    broker.onUpstreamFrame(challengeFrame())
    const res = JSON.stringify({ type: 'res', id: broker.connectId, ok: true, result: { protocol: 3 } })
    const action = broker.onUpstreamFrame(res)
    expect(action.forwardToBrowser).toBe(false)
    expect(action.flush).toBe(true)
    expect(broker.complete).toBe(true)
  })

  it('forwards an unrelated upstream frame (e.g. sessions.list res) to the browser', () => {
    const broker = createGatewayBroker(TOKEN)
    broker.onUpstreamFrame(challengeFrame())
    broker.onUpstreamFrame(JSON.stringify({ type: 'res', id: broker.connectId, ok: true }))
    const action = broker.onUpstreamFrame(JSON.stringify({ type: 'res', id: 'sessions-1', ok: true, result: [] }))
    expect(action.forwardToBrowser).toBe(true)
    expect(action.sendUpstream).toBeUndefined()
  })
})

describe('createGatewayBroker — browser frames', () => {
  it('drops a browser-originated connect frame (tokenless handshake must never reach the gateway)', () => {
    const broker = createGatewayBroker(TOKEN)
    const action = broker.onBrowserFrame(JSON.stringify({ type: 'req', method: 'connect', id: 'x', params: {} }))
    expect(action.drop).toBe(true)
    expect(action.sendUpstream).toBeFalsy()
  })

  it('queues browser frames before the handshake completes, then forwards after ok:true', () => {
    const broker = createGatewayBroker(TOKEN)
    const before = broker.onBrowserFrame(JSON.stringify({ type: 'req', method: 'sessions.list', id: '1' }))
    expect(before.queue).toBe(true)
    expect(before.sendUpstream).toBeFalsy()

    broker.onUpstreamFrame(challengeFrame())
    broker.onUpstreamFrame(JSON.stringify({ type: 'res', id: broker.connectId, ok: true }))

    const after = broker.onBrowserFrame(JSON.stringify({ type: 'req', method: 'sessions.list', id: '2' }))
    expect(after.sendUpstream).toBe(true)
    expect(after.queue).toBeFalsy()
  })
})
