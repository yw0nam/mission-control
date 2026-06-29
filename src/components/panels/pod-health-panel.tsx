'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '@/lib/websocket'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { gatewayHealthToPodHealth, type PodHealth } from '@/components/chat/gateway-adapters'

/**
 * Pod-native health card for a viewer — reads `health` over their own pod gateway.
 * Replaces the host OS system-monitor (admin keeps that via the role branch); the
 * gateway exposes liveness, not machine metrics.
 */
export function PodHealthPanel() {
  const { call, isConnected } = useWebSocket()
  const [data, setData] = useState<PodHealth | null>(null)

  const load = useCallback(async () => {
    if (!isConnected) return
    try {
      setData(gatewayHealthToPodHealth(await call('health')))
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
      <div className="rounded-lg border border-border bg-card px-4 py-4">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${data?.ok ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-lg font-semibold">{data?.ok ? 'Healthy' : data ? 'Unhealthy' : '—'}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Stat label="Check latency" value={data ? `${data.durationMs} ms` : '—'} />
          <Stat label="Heartbeat" value={data ? `${data.heartbeatSeconds}s` : '—'} />
          <Stat label="Default agent" value={data?.defaultAgentId ?? '—'} />
          <Stat label="Sessions" value={String(data?.sessionCount ?? 0)} />
          <Stat label="Agents" value={String(data?.agents.length ?? 0)} />
        </div>
      </div>

      {data && data.agents.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
            Agents
          </div>
          <ul className="divide-y divide-border">
            {data.agents.map((a) => (
              <li key={a} className="px-4 py-2 text-sm font-medium">
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-medium">{value}</div>
    </div>
  )
}
