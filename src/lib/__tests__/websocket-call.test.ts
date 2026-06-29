import { describe, it, expect, vi } from 'vitest'
import { GatewayCallRegistry, shouldSkipClientHandshake } from '../websocket'

describe('shouldSkipClientHandshake', () => {
  it('returns true for the same-origin /ws/gateway broker path', () => {
    expect(shouldSkipClientHandshake('/ws/gateway')).toBe(true)
    expect(shouldSkipClientHandshake('wss://app.example.com/ws/gateway')).toBe(true)
  })

  it('returns false for host-gateway WebSocket URLs', () => {
    expect(shouldSkipClientHandshake('ws://192.168.1.10:18789/')).toBe(false)
    expect(shouldSkipClientHandshake('wss://gateway.example.com/socket')).toBe(false)
  })
})

describe('GatewayCallRegistry', () => {
  let sent: any[]

  const makeRegistry = (sendImpl?: (frame: any) => boolean) => {
    sent = []
    let idSeq = 0
    const send = sendImpl ?? ((frame: any) => { sent.push(frame); return true })
    return new GatewayCallRegistry(send, () => `id-${++idSeq}`)
  }

  it('sends a req frame and resolves with result on a matching ok res', async () => {
    const reg = makeRegistry()
    const p = reg.call('agents.list', { foo: 1 })
    expect(sent[0]).toEqual({ type: 'req', method: 'agents.list', id: 'id-1', params: { foo: 1 } })
    expect(reg.handleFrame({ type: 'res', id: 'id-1', ok: true, result: { agents: [] } })).toBe(true)
    await expect(p).resolves.toEqual({ agents: [] })
  })

  it('resolves with payload when the gateway returns data under `payload` (openclaw)', async () => {
    const reg = makeRegistry()
    const p = reg.call('sessions.list', {})
    // Real openclaw gateway frames carry the result under `payload`, not `result`.
    expect(reg.handleFrame({ type: 'res', id: 'id-1', ok: true, payload: { sessions: [] } })).toBe(true)
    await expect(p).resolves.toEqual({ sessions: [] })
  })

  it('rejects with the error message on an ok:false res', async () => {
    const reg = makeRegistry()
    const p = reg.call('x')
    reg.handleFrame({ type: 'res', id: 'id-1', ok: false, error: { message: 'boom' } })
    await expect(p).rejects.toThrow('boom')
  })

  it('ignores responses with an unknown id', () => {
    const reg = makeRegistry()
    reg.call('x')
    expect(reg.handleFrame({ type: 'res', id: 'nope', ok: true, result: 1 })).toBe(false)
  })

  it('rejects on timeout', async () => {
    vi.useFakeTimers()
    try {
      const reg = makeRegistry()
      const p = reg.call('slow', undefined, 1000)
      const assertion = expect(p).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes two concurrent calls to the right result by id', async () => {
    const reg = makeRegistry()
    const a = reg.call('a')
    const b = reg.call('b')
    // Respond out of order to prove id-correlation.
    reg.handleFrame({ type: 'res', id: 'id-2', ok: true, result: 'B' })
    reg.handleFrame({ type: 'res', id: 'id-1', ok: true, result: 'A' })
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
  })

  it('rejects immediately when the send path is closed', async () => {
    const reg = makeRegistry(() => false)
    await expect(reg.call('x')).rejects.toThrow(/not connected/i)
  })

  it('rejectAll settles every pending call (disconnect cleanup, no leaks)', async () => {
    const reg = makeRegistry()
    const p = reg.call('x')
    reg.rejectAll(new Error('disconnected'))
    await expect(p).rejects.toThrow('disconnected')
    // A late response for the rejected id is now a no-op.
    expect(reg.handleFrame({ type: 'res', id: 'id-1', ok: true, result: 1 })).toBe(false)
  })
})
