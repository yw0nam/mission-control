import fs from 'fs'
import path from 'path'
import { describe, expect, it, afterAll } from 'vitest'
import {
  k8sNamespace,
  buildK8sBootstrapPlan,
  buildK8sSuspendPlan,
  buildK8sResumePlan,
  buildK8sDecommissionPlan,
  ensureK8sArtifacts,
} from '@/lib/super-admin-k8s'

const SLUG = 'k8s-test-alice'

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

  it('bootstrap plan creates ns then applies quota, egress, instance in order', () => {
    const plan = buildK8sBootstrapPlan(SLUG)
    expect(plan.map((s) => s.key)).toEqual([
      'create-namespace',
      'apply-quota',
      'apply-egress-lockdown',
      'apply-instance',
    ])
    // create-namespace targets the tenant namespace
    expect(plan[0].command).toContain('user-k8s-test-alice')
    // every step shells kubectl, none needs root (unlike the systemd backend)
    for (const step of plan) {
      expect(step.command[0]).toMatch(/kubectl$/)
      expect(step.requires_root).toBe(false)
    }
    // apply steps point at rendered artifacts
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
    const instance = fs.readFileSync(path.join(dir, 'instance.yaml'), 'utf8')
    const egress = fs.readFileSync(path.join(dir, 'egress-lockdown.yaml'), 'utf8')
    const quota = fs.readFileSync(path.join(dir, 'tenant-quota.yaml'), 'utf8')

    for (const doc of [instance, egress, quota]) {
      expect(doc).toContain('namespace: user-k8s-test-alice')
      expect(doc).not.toMatch(/__[A-Z_]+__/) // all placeholders substituted
    }
    // instance keeps the validated PoC gotchas
    expect(instance).toContain('name: k8s-test-alice')
    expect(instance).toContain('sandbox: { mode: "off" }') // object form, not `true`
    expect(instance).toMatch(/networkPolicy:\s*\n\s*enabled: false/) // delta-1
    expect(egress).toContain('port: 18032') // on-prem vLLM port
  })
})
