/**
 * Session-bound gateway resolution — the isolation heart of the multi-tenant PoC.
 *
 * A non-admin (일반사용자/owner) is bound to EXACTLY their own tenant's pod gateway,
 * resolved server-side from their session. They cannot supply a target and never
 * fall back to the global/host gateway. Admins keep the existing global behavior.
 *
 * Split into two layers so the security-critical decision is testable without a
 * cluster:
 *  - resolveTenantForUser(user): identity → which tenant (DB only, pure-ish, tested).
 *  - resolveTenantGateway(user): adds the live gateway address+token (kubectl reads).
 */
import { getTenantForOwner } from './super-admin'
import { readGatewayEndpoint, readGatewayToken } from './super-admin-k8s'
import type { Tenant } from './db'

interface ResolverUser {
  id: number
  role: 'admin' | 'operator' | 'viewer'
}

export type TenantResolution =
  | { kind: 'admin' } // use the existing global/host gateway target
  | { kind: 'denied' } // non-admin with no bound tenant → caller returns 403
  | { kind: 'tenant'; tenant: Tenant }

/**
 * Decide which tenant a request is scoped to, from the session user alone.
 * - admin (incl. synthetic API-key user id <= 0) → 'admin' (global target).
 * - non-admin → their owned tenant, or 'denied'. NEVER the global gateway.
 * Pure w.r.t. the cluster (DB lookup only) so it is unit-testable.
 */
export function resolveTenantForUser(user: ResolverUser): TenantResolution {
  // Synthetic/global principals (API key id 0, agent keys id < 0) are admin-host,
  // never routed through the per-tenant owner branch.
  if (user.role === 'admin' || !Number.isInteger(user.id) || user.id <= 0) {
    return { kind: 'admin' }
  }
  const tenant = getTenantForOwner(user.id)
  if (!tenant) return { kind: 'denied' }
  return { kind: 'tenant', tenant }
}

export type GatewayResolution =
  | { kind: 'admin' }
  | { kind: 'denied' }
  | { kind: 'unavailable'; tenant: Tenant } // owns a tenant but no live gateway yet
  | {
      kind: 'tenant'
      tenant: Tenant
      host: string
      port: number
      token: string
    }

/**
 * Full resolution for the broker: identity → tenant → live gateway address + token.
 * Reads the gateway endpoint/token from the operator CR status (server-side; the
 * token never reaches the browser). Returns 'unavailable' when the user owns a
 * tenant but its gateway address/token can't be read yet (e.g. mid-provision).
 */
export async function resolveTenantGateway(user: ResolverUser): Promise<GatewayResolution> {
  const decision = resolveTenantForUser(user)
  if (decision.kind !== 'tenant') return decision
  const { tenant } = decision
  const endpoint = await readGatewayEndpoint(tenant.slug)
  const token = endpoint ? await readGatewayToken(tenant.slug) : null
  if (!endpoint || !token) return { kind: 'unavailable', tenant }
  return { kind: 'tenant', tenant, host: endpoint.host, port: endpoint.port, token }
}
