'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '@/lib/websocket'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { gatewayStatusToOverview, type PodOverview, agentFromKey } from '@/components/chat/gateway-adapters'

function ageMs(ms: number): string {
  if (!ms) return '—'
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * Pod-native Overview for a viewer — reads `status` over their own pod gateway.
 * Replaces the MC-DB Dashboard (admin keeps that via the ContentRouter role branch).
 */
export function PodOverviewPanel() {
  const { call, isConnected } = useWebSocket()
  const [data, setData] = useState<PodOverview | null>(null)

  const load = useCallback(async () => {
    if (!isConnected) return
    try {
      setData(gatewayStatusToOverview(await call('status')))
    } catch {
      /* keep last snapshot on transient error */
    }
  }, [call, isConnected])

  useEffect(() => {
    load()
  }, [load])
  useSmartPoll(load, 30000, { pauseWhenDisconnected: true, backoff: true })

  if (!isConnected) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Connecting to your instance…</div>
  }

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Default agent" value={data?.defaultAgentId ?? '—'} />
        <Tile label="Sessions" value={String(data?.sessionCount ?? 0)} />
        <Tile label="Status" value={data ? 'Live' : '—'} accent={data ? 'text-green-500' : undefined} />
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
          Recent sessions
        </div>
        {data && data.recent.length > 0 ? (
          <ul className="divide-y divide-border">
            {data.recent.map((s) => (
              <li key={s.key} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="truncate font-medium">{agentFromKey(s.key) ?? s.key}</span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {s.model && <span>{s.model}</span>}
                  <span>{s.totalTokens.toLocaleString()} tok</span>
                  <span>{ageMs(s.updatedAtMs)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No sessions yet.</div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${accent ?? ''}`}>{value}</div>
    </div>
  )
}
