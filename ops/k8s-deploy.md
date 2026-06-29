# Mission Control — k3s multi-tenant deploy (B: operator-only)

Hosted-SaaS model: end-users use the MC UI/API only and never touch Kubernetes.
MC provisions each tenant directly via `kubectl` using a **scoped** ServiceAccount
(no cluster-admin). The openclaw-operator owns instance pods + scale-to-zero + status.

## Components
- **openclaw-operator** — reconciles `OpenClawInstance` CRs (StatefulSet/Service/PVC/`spec.suspended`/`.status.phase`).
- **mission-control** — control plane: identity, approval/two-person, audit, UI; renders
  Namespace + ResourceQuota + LimitRange + egress NetworkPolicy + Secret + OpenClawInstance and `kubectl apply`s them.

(No Capsule. Reconsider only if power-users/customer-admins ever need direct kubectl — then Capsule can adopt existing namespaces by label.)

## Install order
1. **openclaw-operator** (CRDs + controller):
   ```bash
   cd repos/openclaw-operator
   helm install openclaw-operator ./charts/openclaw-operator -n openclaw-system --create-namespace --wait
   kubectl get crd | grep openclaw    # openclawinstances/openclawclusterdefaults/openclawselfconfigs.openclaw.rocks
   ```
2. **MC scoped RBAC**:
   ```bash
   kubectl apply -f ops/k8s-provisioner-rbac.yaml
   kubectl auth can-i --list --as=system:serviceaccount:mission-control:mc-provisioner   # confirm minimal
   ```
3. **Generate the MC kubeconfig** from the SA token (store securely, mode 600, OUTSIDE the repo):
   ```bash
   SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')   # for off-host MC use the node IP, not 127.0.0.1
   TOKEN=$(kubectl get secret mc-provisioner-token -n mission-control -o jsonpath='{.data.token}' | base64 -d)
   CADATA=$(kubectl get secret mc-provisioner-token -n mission-control -o jsonpath='{.data.ca\.crt}')
   cat > /etc/mission-control/kubeconfig.yaml <<EOF
   apiVersion: v1
   kind: Config
   clusters: [{name: k3s, cluster: {server: $SERVER, certificate-authority-data: $CADATA}}]
   contexts: [{name: mc, context: {cluster: k3s, user: mc}}]
   current-context: mc
   users: [{name: mc, user: {token: $TOKEN}}]
   EOF
   chmod 600 /etc/mission-control/kubeconfig.yaml
   ```

## MC environment
```
MC_PROVISIONER_BACKEND=k8s
KUBECONFIG=/etc/mission-control/kubeconfig.yaml      # kubectl picks this up (MC shells out via runCommand)
MC_KUBECTL_PATH=/usr/local/bin/kubectl              # this host's real path (default /usr/bin/kubectl is wrong here)
MC_K8S_OPENAI_BASE_URL=http://192.168.0.41:18032/v1 # external vLLM (GPT-OSS-120B)
MC_SUPER_PROVISION_EXEC=true                         # required for non-dry-run provisioning
```

## Notes / gotchas
- **egress + DNAT:** k3s evaluates NetworkPolicy on the post-DNAT destination, so ClusterIP
  service access (10.43.x) is blocked unless you also allow the node IPs. The external vLLM
  (direct IP 192.168.0.41) is unaffected. If tenants must reach in-cluster services, extend
  the egress NetworkPolicy with the node IPs.
- **instance init egress:** the openclaw image's init containers may fetch external deps
  (PyPI etc.) which the egress-lockdown blocks. If a tenant pod hangs in Init, either bake deps
  into the image or add a temporary provisioning egress allowance. (Instance-layer concern.)
- The SA token is long-lived (Secret of type service-account-token). Rotate by deleting/recreating the secret.
