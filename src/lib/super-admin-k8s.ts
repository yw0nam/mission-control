/**
 * Kubernetes (k3s) provisioning backend for the multi-tenant OpenClaw PoC.
 *
 * Mirrors the systemd backend in super-admin.ts but emits `kubectl` steps instead
 * of useradd/systemctl. The job/approval/audit/dry-run machinery in
 * executeProvisionJob() is backend-agnostic, so this only supplies the step list
 * and the rendered manifests.
 *
 * Backend is selected by env: MC_PROVISIONER_BACKEND=k8s
 *
 * Manifests below are the PoC's validated working manifests (poc/*.yaml) with
 * per-tenant placeholders. Tenant = namespace `user-<slug>` + OpenClawInstance `<slug>`.
 *
 * ponytail: cluster-wide constants (vLLM endpoint, CIDRs) are NOT per-tenant.
 * vLLM base URL is the one calibration knob (MC_K8S_OPENAI_BASE_URL); the egress
 * CIDRs live in EGRESS_TEMPLATE and are edited once per cluster, not per tenant.
 */
import fs from 'fs'
import path from 'path'
import { config as appConfig } from './config'
import type { ProvisionStep } from './super-admin'

const KUBECTL = process.env.MC_KUBECTL_PATH || '/usr/bin/kubectl'

export function provisionerBackend(): 'k8s' | 'systemd' {
  return String(process.env.MC_PROVISIONER_BACKEND || 'systemd').trim().toLowerCase() === 'k8s'
    ? 'k8s'
    : 'systemd'
}

export function k8sNamespace(slug: string): string {
  return `user-${slug}`
}

function artifactDir(slug: string): string {
  return path.join(appConfig.dataDir, 'provisioner', slug, 'k8s')
}

// --- Manifests (verbatim from poc/*.yaml, placeholders __NS__ / __NAME__ / __OPENAI_BASE_URL__) ---

const INSTANCE_TEMPLATE = `apiVersion: v1
kind: Secret
metadata:
  name: openclaw-api-keys
  namespace: __NS__
stringData:
  OPENAI_API_KEY: "EMPTY"
  OPENAI_BASE_URL: "__OPENAI_BASE_URL__"
---
apiVersion: openclaw.rocks/v1alpha1
kind: OpenClawInstance
metadata:
  name: __NAME__
  namespace: __NS__
spec:
  image:
    repository: ghcr.io/openclaw/openclaw
    tag: "2026.2.3"
    pullPolicy: IfNotPresent
  envFrom:
    - secretRef: { name: openclaw-api-keys }
  config:
    raw:
      agents:
        defaults:
          model: { primary: "openai/GPT-OSS-120B" }
          sandbox: { mode: "off" }
      session: { scope: "per-sender" }
  storage:
    persistence: { enabled: true, size: 2Gi }
  security:
    networkPolicy:
      enabled: false
`

const EGRESS_TEMPLATE = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: egress-lockdown
  namespace: __NS__
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - to:
        - ipBlock: { cidr: 10.42.0.0/16 }
        - ipBlock: { cidr: 10.43.0.0/16 }
    - to:
        - ipBlock: { cidr: 192.168.0.41/32 }
      ports:
        - { protocol: TCP, port: 18032 }
`

const QUOTA_TEMPLATE = `apiVersion: v1
kind: ResourceQuota
metadata: { name: tenant-quota, namespace: __NS__ }
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 2Gi
    limits.cpu: "4"
    limits.memory: 6Gi
    pods: "5"
---
apiVersion: v1
kind: LimitRange
metadata: { name: tenant-limits, namespace: __NS__ }
spec:
  limits:
    - type: Container
      default:        { cpu: 500m, memory: 512Mi }
      defaultRequest: { cpu: 100m, memory: 128Mi }
      max:            { cpu: "2",  memory: 5Gi }
`

function render(template: string, slug: string): string {
  const ns = k8sNamespace(slug)
  const baseUrl = String(process.env.MC_K8S_OPENAI_BASE_URL || 'http://192.168.0.41:18032/v1')
  return template
    .replaceAll('__NS__', ns)
    .replaceAll('__NAME__', slug)
    .replaceAll('__OPENAI_BASE_URL__', baseUrl)
}

/** Renders the three tenant manifests to disk before a bootstrap job runs. */
export function ensureK8sArtifacts(slug: string): { dir: string } {
  if (!slug) throw new Error('Missing tenant slug for k8s artifact generation')
  const dir = artifactDir(slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'instance.yaml'), render(INSTANCE_TEMPLATE, slug), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'egress-lockdown.yaml'), render(EGRESS_TEMPLATE, slug), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'tenant-quota.yaml'), render(QUOTA_TEMPLATE, slug), { mode: 0o600 })
  return { dir }
}

// --- Plan builders ---

export function buildK8sBootstrapPlan(slug: string): ProvisionStep[] {
  const ns = k8sNamespace(slug)
  const dir = artifactDir(slug)
  return [
    {
      key: 'create-namespace',
      title: `Create namespace ${ns}`,
      command: [KUBECTL, 'create', 'namespace', ns],
      requires_root: false,
      timeout_ms: 15000,
    },
    {
      key: 'apply-quota',
      title: `Apply ResourceQuota + LimitRange to ${ns}`,
      command: [KUBECTL, 'apply', '-f', path.join(dir, 'tenant-quota.yaml')],
      requires_root: false,
      timeout_ms: 15000,
    },
    {
      key: 'apply-egress-lockdown',
      title: `Apply egress lockdown NetworkPolicy to ${ns}`,
      command: [KUBECTL, 'apply', '-f', path.join(dir, 'egress-lockdown.yaml')],
      requires_root: false,
      timeout_ms: 15000,
    },
    {
      key: 'apply-instance',
      title: `Apply OpenClawInstance ${slug} to ${ns}`,
      command: [KUBECTL, 'apply', '-f', path.join(dir, 'instance.yaml')],
      requires_root: false,
      timeout_ms: 30000,
    },
  ]
}

/** Scale-to-zero (PoC observation 3): patch spec.suspended=true. */
export function buildK8sSuspendPlan(slug: string): ProvisionStep[] {
  const ns = k8sNamespace(slug)
  return [
    {
      key: 'suspend-instance',
      title: `Suspend (scale-to-zero) OpenClawInstance ${slug}`,
      command: [
        KUBECTL, 'patch', 'openclawinstance', slug, '-n', ns,
        '--type=merge', '-p', '{"spec":{"suspended":true}}',
      ],
      requires_root: false,
      timeout_ms: 30000,
    },
  ]
}

export function buildK8sResumePlan(slug: string): ProvisionStep[] {
  const ns = k8sNamespace(slug)
  return [
    {
      key: 'resume-instance',
      title: `Resume OpenClawInstance ${slug}`,
      command: [
        KUBECTL, 'patch', 'openclawinstance', slug, '-n', ns,
        '--type=merge', '-p', '{"spec":{"suspended":false}}',
      ],
      requires_root: false,
      timeout_ms: 30000,
    },
  ]
}

/** Full teardown: delete the tenant namespace (cascades all child objects). */
export function buildK8sDecommissionPlan(slug: string): ProvisionStep[] {
  const ns = k8sNamespace(slug)
  return [
    {
      key: 'delete-namespace',
      title: `Delete namespace ${ns}`,
      command: [KUBECTL, 'delete', 'namespace', ns, '--ignore-not-found=true'],
      requires_root: false,
      timeout_ms: 120000,
    },
  ]
}
