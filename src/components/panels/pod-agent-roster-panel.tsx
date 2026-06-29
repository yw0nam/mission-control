'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '@/lib/websocket'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { gatewayRosterFromStatus, type PodAgentRow } from '@/components/chat/gateway-adapters'

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
 * Pod-native agent roster for a viewer — joins `agents.list` (id-only) with
 * `status.sessions.byAgent`. Read-only; the host agent-management panel (model
 * config, soul/memory, spawn) has no gateway data so admins keep that via the role branch.
 */
export function PodAgentRosterPanel() {
  const { call, isConnected } = useWebSocket()
  const [rows, setRows] = useState<PodAgentRow[]>([])

  const load = useCallback(async () => {
    if (!isConnected) return
    try {
      const [agents, status] = await Promise.all([call('agents.list'), call('status')])
      setRows(gatewayRosterFromStatus(agents, status))
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
    <div className="p-4">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
          Agents
        </div>
        {rows.length > 0 ? (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="truncate font-medium">{r.id}</span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {r.model && <span>{r.model}</span>}
                  <span>{r.sessionCount} session{r.sessionCount === 1 ? '' : 's'}</span>
                  <span>{ageMs(r.lastActivityMs)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No agents.</div>
        )}
      </div>
    </div>
  )
}
