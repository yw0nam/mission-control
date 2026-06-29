import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, afterAll, afterEach, vi } from 'vitest'
import {
  k8sNamespace,
  buildK8sBootstrapPlan,
  buildK8sSuspendPlan,
  buildK8sResumePlan,
  buildK8sDecommissionPlan,
  ensureK8sArtifacts,
  mapPhaseToStatus,
} from '@/lib/super-admin-k8s'

const SLUG = 'k8s-test-alice'
const ORIGINAL_KUBECTL = process.env.MC_KUBECTL_PATH

afterEach(() => {
  // Tests below mutate MC_KUBECTL_PATH and re-import the module; restore the env and
  // reset the module registry so the global KUBECTL/phase cache can't leak between tests.
  if (ORIGINAL_KUBECTL === undefined) delete process.env.MC_KUBECTL_PATH
  else process.env.MC_KUBECTL_PATH = ORIGINAL_KUBECTL
  vi.resetModules()
})

afterAll(() => {
  // ensureK8sArtifacts writes under <dataDir>/provisioner/<slug>; clean it up.
  try {
    const { dir } = ensureK8sArtifacts(SLUG)
    fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('k8s provisioning backend', () => {
  it('namespaces a tenant as user-<slug>', () => {
    expect(k8sNamespace(SLUG)).toBe('user-k8s-test-alice')
  })

  it('bootstrap plan applies ns (idempotent) then quota, egress, instance in order', () => {
    const plan = buildK8sBootstrapPlan(SLUG)
    expect(plan.map((s) => s.key)).toEqual([
      'create-namespace',
      'apply-quota',
      'apply-egress-lockdown',
      'apply-instance',
    ])
    // namespace step is now an idempotent `kubectl apply -f .../namespace.yaml`,
    // NOT `kubectl create namespace` (which errors on re-run).
    expect(plan[0].command.join(' ')).toMatch(/apply -f .*namespace\.yaml$/)
    expect(plan[0].command.join(' ')).not.toContain('create namespace')
    // every step shells kubectl, none needs root (unlike the systemd backend)
    for (const step of plan) {
      expect(step.command[0]).toMatch(/kubectl$/)
      expect(step.requires_root).toBe(false)
    }
    // all bootstrap steps are idempotent applies pointed at rendered artifacts
    expect(plan[1].command.join(' ')).toMatch(/apply -f .*tenant-quota\.yaml$/)
    expect(plan[2].command.join(' ')).toMatch(/apply -f .*egress-lockdown\.yaml$/)
    expect(plan[3].command.join(' ')).toMatch(/apply -f .*instance\.yaml$/)
  })

  it('suspend/resume patch spec.suspended (scale-to-zero toggle)', () => {
    const suspend = buildK8sSuspendPlan(SLUG)[0]
    expect(suspend.command.join(' ')).toContain('patch openclawinstance k8s-test-alice -n user-k8s-test-alice')
    expect(suspend.command.join(' ')).toContain('{"spec":{"suspended":true}}')

    const resume = buildK8sResumePlan(SLUG)[0]
    expect(resume.command.join(' ')).toContain('{"spec":{"suspended":false}}')
  })

  it('decommission deletes the whole namespace', () => {
    const plan = buildK8sDecommissionPlan(SLUG)
    expect(plan).toHaveLength(1)
    expect(plan[0].command.join(' ')).toBe(
      `${plan[0].command[0]} delete namespace user-k8s-test-alice --ignore-not-found=true`
    )
  })

  it('renders manifests with the tenant namespace and no leftover placeholders', () => {
    const { dir } = ensureK8sArtifacts(SLUG)
    const namespace = fs.readFileSync(path.join(dir, 'namespace.yaml'), 'utf8')
    const instance = fs.readFileSync(path.join(dir, 'instance.yaml'), 'utf8')
    const egress = fs.readFileSync(path.join(dir, 'egress-lockdown.yaml'), 'utf8')
    const quota = fs.readFileSync(path.join(dir, 'tenant-quota.yaml'), 'utf8')

    for (const doc of [instance, egress, quota]) {
      expect(doc).toContain('namespace: user-k8s-test-alice')
      expect(doc).not.toMatch(/__[A-Z_]+__/) // all placeholders substituted
    }
    // namespace.yaml declares the Namespace object itself (name:, not namespace:)
    // and, like the others, must have every placeholder substituted.
    expect(namespace).toContain('kind: Namespace')
    expect(namespace).toContain('name: user-k8s-test-alice')
    expect(namespace).not.toMatch(/__[A-Z_]+__/)
    // instance keeps the validated PoC gotchas
    expect(instance).toContain('name: k8s-test-alice')
    expect(instance).toContain('sandbox: { mode: "off" }') // object form, not `true`
    expect(instance).toMatch(/networkPolicy:\s*\n\s*enabled: false/) // delta-1
    expect(egress).toContain('port: 18032') // on-prem vLLM port
    // wires a working vLLM provider (reasoning model needs the completions API)
    expect(instance).toContain('primary: "vllm/GPT-OSS-120B"')
    expect(instance).toMatch(/vllm:/)
    expect(instance).toContain('api: "openai-completions"')
    expect(instance).toContain('reasoning: true')
    expect(instance).not.toContain('__OPENAI_BASE_URL__')
  })

  it('mapPhaseToStatus maps handled phases, and unknown/empty -> null', () => {
    // Running -> active
    expect(mapPhaseToStatus('Running')).toBe('active')
    // Suspended -> suspended
    expect(mapPhaseToStatus('Suspended')).toBe('suspended')
    // Pending / Provisioning -> provisioning
    expect(mapPhaseToStatus('Pending')).toBe('provisioning')
    expect(mapPhaseToStatus('Provisioning')).toBe('provisioning')
    // Failed / Degraded -> error
    expect(mapPhaseToStatus('Failed')).toBe('error')
    expect(mapPhaseToStatus('Degraded')).toBe('error')
    // Terminating -> decommissioning
    expect(mapPhaseToStatus('Terminating')).toBe('decommissioning')
    // Operator phases with no MC Tenant.status counterpart -> null (caller keeps DB value)
    expect(mapPhaseToStatus('BackingUp')).toBeNull()
    expect(mapPhaseToStatus('Restoring')).toBeNull()
    expect(mapPhaseToStatus('Updating')).toBeNull()
    // Unknown / empty / null / undefined -> null (caller keeps existing DB value)
    expect(mapPhaseToStatus('Bananas')).toBeNull()
    expect(mapPhaseToStatus('')).toBeNull()
    expect(mapPhaseToStatus(null)).toBeNull()
    expect(mapPhaseToStatus(undefined)).toBeNull()
    // surrounding whitespace is trimmed before matching
    expect(mapPhaseToStatus('  Running  ')).toBe('active')
  })

  it('readInstancePhase returns null when kubectl yields empty stdout (no real cluster)', async () => {
    // KUBECTL is captured at module import time, so re-import with /bin/true
    // pointed in — it ignores args and exits 0 with empty stdout, exercising the
    // "empty phase -> null" branch without ever touching a real cluster.
    vi.resetModules()
    process.env.MC_KUBECTL_PATH = '/bin/true'
    const mod = await import('@/lib/super-admin-k8s')
    await expect(mod.readInstancePhase(SLUG)).resolves.toBeNull()
    // empty slug short-circuits to null too
    await expect(mod.readInstancePhase('')).resolves.toBeNull()
  })

  it('readInstancePhase resolves the phase string when kubectl prints one', async () => {
    // Point MC_KUBECTL_PATH at a tiny shim that ignores args and prints a phase,
    // exercising the success branch without a real cluster.
    const shim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kubectl-shim-')), 'kubectl')
    fs.writeFileSync(shim, '#!/bin/sh\necho Running\n', { mode: 0o755 })
    vi.resetModules()
    process.env.MC_KUBECTL_PATH = shim
    const mod = await import('@/lib/super-admin-k8s')
    // distinct slug so the 15s TTL cache (module-level Map) can't return a stale value
    await expect(mod.readInstancePhase('k8s-test-bob')).resolves.toBe('Running')
    fs.rmSync(path.dirname(shim), { recursive: true, force: true })
  })
})
