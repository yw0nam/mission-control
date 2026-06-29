'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '@/lib/websocket'
import { useSmartPoll } from '@/lib/use-smart-poll'

interface PodConfig {
  path?: string
  parsed?: Record<string, unknown>
  resolved?: Record<string, unknown>
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/**
 * Pod-native, READ-ONLY config viewer for a viewer — renders their pod's
 * `openclaw.json` from `config.get`. The MC Settings panel (app DB settings,
 * API-key rotation, backups) is a different domain; admins keep it via the role branch.
 */
export function PodConfigPanel() {
  const { call, isConnected } = useWebSocket()
  const [cfg, setCfg] = useState<PodConfig | null>(null)

  const load = useCallback(async () => {
    if (!isConnected) return
    try {
      const r = await call('config.get')
      setCfg(r && typeof r === 'object' ? (r as PodConfig) : null)
    } catch {
      /* keep last snapshot on transient error */
    }
  }, [call, isConnected])

  useEffect(() => {
    load()
  }, [load])
  useSmartPoll(load, 60000, { pauseWhenDisconnected: true, backoff: true })

  if (!isConnected) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Connecting to your instance…</div>
  }

  const p = cfg?.parsed
  const summary: Array<[string, string | undefined]> = [
    ['Model', str(get(p, 'agents', 'defaults', 'model', 'primary'))],
    ['Sandbox', str(get(p, 'agents', 'defaults', 'sandbox', 'mode'))],
    ['Gateway mode', str(get(p, 'gateway', 'mode'))],
    ['Session scope', str(get(p, 'session', 'scope'))],
    ['Browser profile', str(get(p, 'browser', 'defaultProfile'))],
  ]

  return (
    <div className="p-4 space-y-4">
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="text-xs font-medium uppercase text-muted-foreground">Configuration</div>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {summary.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs uppercase text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 truncate font-medium">{v ?? '—'}</dd>
            </div>
          ))}
        </dl>
        {cfg?.path && <div className="mt-3 truncate text-xs text-muted-foreground">{cfg.path}</div>}
      </div>

      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
          Full config (read-only)
        </summary>
        <pre className="overflow-auto px-4 py-3 text-xs leading-relaxed">
          {p ? JSON.stringify(p, null, 2) : '—'}
        </pre>
      </details>
    </div>
  )
}
