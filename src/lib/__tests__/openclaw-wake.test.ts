import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable, hoisted mocks so each test can vary config/token/gateway behaviour
// before dynamically importing the module under test (resets the module-level
// debounce map between tests).
const h = vi.hoisted(() => ({
  config: { wakeUrl: 'https://waker.example/wake', gatewaySlug: 'alice-default' },
  detectedToken: 'detected-token',
  callGateway: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/config', () => ({ config: h.config }))
vi.mock('@/lib/gateway-runtime', () => ({ getDetectedGatewayToken: () => h.detectedToken }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: h.callGateway }))
vi.mock('@/lib/logger', () => ({ logger: h.logger }))

async function loadModule() {
  return import('../openclaw-wake')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  h.config.wakeUrl = 'https://waker.example/wake'
  h.config.gatewaySlug = 'alice-default'
  h.detectedToken = 'detected-token'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('wakeRemotePod', () => {
  it('POSTs the correct URL and JSON payload with an abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    const ok = await wakeRemotePod('alice', 'tok-1')

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://waker.example/wake')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(init.body).toBe(JSON.stringify({ slug: 'alice', token: 'tok-1' }))
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('defaults slug to config.gatewaySlug and token to getDetectedGatewayToken()', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    await wakeRemotePod()

    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBe(JSON.stringify({ slug: 'alice-default', token: 'detected-token' }))
  })

  it('is a no-op returning false when config.wakeUrl is unset', async () => {
    h.config.wakeUrl = ''
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    const ok = await wakeRemotePod('alice', 'tok')

    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns false and never throws when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    await expect(wakeRemotePod('alice', 'tok')).resolves.toBe(false)
  })

  it('returns false on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    await expect(wakeRemotePod('alice', 'tok')).resolves.toBe(false)
  })

  it('aborts on timeout (~5s) and returns false without throwing', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    vi.useFakeTimers()
    const pending = wakeRemotePod('slow', 'tok')
    await vi.advanceTimersByTimeAsync(5000)

    await expect(pending).resolves.toBe(false)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('debounces only after a SUCCESS (second call within 30s does not re-fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    const first = await wakeRemotePod('alice', 'tok')
    const second = await wakeRemotePod('alice', 'tok')

    expect(first).toBe(true)
    expect(second).toBe(true) // debounced-recent-success still returns true
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Observability: the debounced attempt is logged as such (Phase D).
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ debounced: true }),
      expect.anything(),
    )
  })

  it('does NOT debounce after a FAILURE (next interaction retries)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const { wakeRemotePod } = await loadModule()
    const first = await wakeRemotePod('bob', 'tok')
    const second = await wakeRemotePod('bob', 'tok')

    expect(first).toBe(false)
    expect(second).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('isGatewayUnreachableError', () => {
  it('matches each gateway-down error string', async () => {
    const { isGatewayUnreachableError } = await loadModule()
    expect(isGatewayUnreachableError(new Error('Gateway websocket error for method chat.send: boom'))).toBe(true)
    expect(isGatewayUnreachableError(new Error('Gateway websocket closed before method chat.history completed'))).toBe(true)
    expect(isGatewayUnreachableError(new Error('Gateway method sessions.list timed out after 5000ms'))).toBe(true)
  })

  it('matches an ECONNREFUSED cause code', async () => {
    const { isGatewayUnreachableError } = await loadModule()
    const err = Object.assign(new Error('connect refused'), { cause: { code: 'ECONNREFUSED' } })
    expect(isGatewayUnreachableError(err)).toBe(true)
  })

  it('matches a top-level ECONNREFUSED code (local/direct, nothing listening)', async () => {
    const { isGatewayUnreachableError } = await loadModule()
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18789'), { code: 'ECONNREFUSED' })
    expect(isGatewayUnreachableError(err)).toBe(true)
  })

  it('matches traefik 502/503/504 on the WS upgrade (backend down / scaling)', async () => {
    const { isGatewayUnreachableError } = await loadModule()
    expect(isGatewayUnreachableError(new Error('Unexpected server response: 502'))).toBe(true)
    expect(isGatewayUnreachableError(new Error('Unexpected server response: 503'))).toBe(true)
    expect(isGatewayUnreachableError(new Error('Unexpected server response: 504'))).toBe(true)
  })

  it('does NOT match auth/routing upgrade responses (waking will not fix these)', async () => {
    const { isGatewayUnreachableError } = await loadModule()
    expect(isGatewayUnreachableError(new Error('Unexpected server response: 401'))).toBe(false)
    expect(isGatewayUnreachableError(new Error('Unexpected server response: 403'))).toBe(false)
    expect(isGatewayUnreachableError(new Error('Unexpected server response: 404'))).toBe(false)
  })

  it('does not match unrelated errors', async () => {
    const { isGatewayUnreachableError } = await loadModule()
    expect(isGatewayUnreachableError(new Error('unknown method: chat.send'))).toBe(false)
    expect(isGatewayUnreachableError(new Error('boom'))).toBe(false)
    expect(isGatewayUnreachableError(null)).toBe(false)
    expect(isGatewayUnreachableError(undefined)).toBe(false)
  })
})

describe('waitForGatewayReady', () => {
  it('returns true once sessions.list succeeds within the deadline', async () => {
    h.callGateway
      .mockRejectedValueOnce(new Error('websocket error'))
      .mockRejectedValueOnce(new Error('websocket error'))
      .mockResolvedValueOnce({ sessions: [] })

    const { waitForGatewayReady } = await loadModule()
    const ready = await waitForGatewayReady({ deadlineMs: 2000, intervalMs: 1 })

    expect(ready).toBe(true)
    expect(h.callGateway).toHaveBeenCalledTimes(3)
    expect(h.callGateway).toHaveBeenCalledWith('sessions.list', {}, expect.any(Number))
  })

  it('returns false when the deadline elapses before readiness', async () => {
    h.callGateway.mockRejectedValue(new Error('websocket error'))

    const { waitForGatewayReady } = await loadModule()
    const ready = await waitForGatewayReady({ deadlineMs: 20, intervalMs: 1 })

    expect(ready).toBe(false)
    expect(h.callGateway.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
