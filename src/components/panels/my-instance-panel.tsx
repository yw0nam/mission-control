'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface Instance {
  slug: string
  display_name: string
  status: string
  plan_tier: string
}

interface ActivityEvent {
  kind: string
  status: string
  requested_by: string | null
  created_at: number
  completed_at: number | null
}

interface Usage {
  instance: { created_at: number; last_active_at: number | null }
  activity: ActivityEvent[]
  note: string
}

function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return '—'
  return new Date(epoch * 1000).toLocaleString()
}

type ConnState = 'idle' | 'connecting' | 'connected' | 'streaming' | 'closed' | 'error'

const STATUS_STYLE: Record<string, string> = {
  active: 'text-green-500',
  suspended: 'text-amber-500',
  provisioning: 'text-blue-500',
  decommissioning: 'text-red-500',
  error: 'text-red-500',
  pending: 'text-muted-foreground',
}

/**
 * Owner-facing panel — the only view a 일반사용자(non-admin) sees. Shows their single
 * instance, lets them suspend/resume it, and opens the MC-brokered connection to
 * their own pod gateway (`/ws/gateway`). The gateway token stays server-side; the
 * browser opens a same-origin socket with no token (verifiable in the network tab).
 */
export function MyInstancePanel() {
  const [instance, setInstance] = useState<Instance | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [conn, setConn] = useState<ConnState>('idle')
  const wsRef = useRef<WebSocket | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<{ instance: Instance }>('/api/me/instance')
      setInstance(data.instance)
      try { setUsage(await apiFetch<Usage>('/api/me/usage')) } catch { setUsage(null) }
    } catch (e) {
      setInstance(null)
      setError(e instanceof Error ? e.message : 'No instance assigned')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    return () => { wsRef.current?.close() }
  }, [load])

  const lifecycle = useCallback(async (kind: 'suspend' | 'resume') => {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/me/instance/${kind}`, { method: 'POST' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : `${kind} failed`)
    } finally {
      setBusy(false)
    }
  }, [load])

  const connect = useCallback(() => {
    wsRef.current?.close()
    setConn('connecting')
    const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ws/gateway`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.onopen = () => setConn('connected')
    ws.onmessage = () => setConn('streaming')
    ws.onclose = () => setConn('closed')
    ws.onerror = () => setConn('error')
  }, [])

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Loading your instance…</div>
  }

  if (!instance) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">{error || 'No instance assigned to your account.'}</p>
        <p className="mt-2 text-sm text-muted-foreground">Ask an administrator to provision one for you.</p>
      </div>
    )
  }

  const statusClass = STATUS_STYLE[instance.status] || 'text-muted-foreground'

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-primary">{instance.display_name}</h2>
            <p className="text-sm text-muted-foreground">{instance.slug} · {instance.plan_tier}</p>
          </div>
          <div className="text-right">
            <span className="text-xs text-muted-foreground">status</span>
            <div className={`text-lg font-semibold ${statusClass}`}>{instance.status}</div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={connect} disabled={instance.status === 'decommissioning'}>
            Connect to my instance
          </Button>
          {instance.status === 'active' && (
            <Button variant="outline" onClick={() => lifecycle('suspend')} disabled={busy}>
              Suspend
            </Button>
          )}
          {instance.status === 'suspended' && (
            <Button variant="outline" onClick={() => lifecycle('resume')} disabled={busy}>
              Resume
            </Button>
          )}
          <Button variant="ghost" onClick={load} disabled={busy}>Refresh</Button>
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold text-primary">Broker connection</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Connects to your pod gateway through Mission Control. The access token never
          reaches the browser — only a same-origin socket to <code>/ws/gateway</code>.
        </p>
        <div className="mt-3 text-sm">
          state: <span className="font-mono">{conn}</span>
          {(conn === 'connecting') && instance.status === 'suspended' && (
            <span className="text-muted-foreground"> (waking your instance, ~8s…)</span>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold text-primary">My usage</h3>
        {usage ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">member since</span>
                <div>{fmtTime(usage.instance.created_at)}</div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">last active</span>
                <div>{fmtTime(usage.instance.last_active_at)}</div>
              </div>
            </div>
            <div className="mt-4">
              <span className="text-xs text-muted-foreground">activity</span>
              {usage.activity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No lifecycle activity yet. Suspend/resume your instance to see history here.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {usage.activity.map((a, i) => (
                    <li key={i} className="flex justify-between">
                      <span className="font-mono">{a.kind} · {a.status}</span>
                      <span className="text-muted-foreground">{fmtTime(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{usage.note}</p>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Usage data unavailable.</p>
        )}
      </div>
    </div>
  )
}
