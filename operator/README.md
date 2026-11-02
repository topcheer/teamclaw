# TeamClaw Operator

Kubernetes operator deploying TeamClaw controllers as `TeamClaw` custom
resources (`teamclaw.dev/v1`). Companion to the helm chart — same runtime
semantics (deployment template translated from `deploy/helm/teamclaw`),
plus continuous reconcile and CR status.

## Scope (P0)

- Assembles per-TeamClaw: ServiceAccount + Role/RoleBinding (worker
  provisioning), workspace PVC, controller Deployment (replicas=1 +
  Recreate until team-state storage is externalized — see D4 in the
  design thread), Service, optional Ingress (with `ingressClassName`).
- `status`: Ready/ConfigReady conditions, controller endpoint, worker pod
  counts (from `teamclaw.managed=true` labels).
- Operator HTTP face on :9090 — `healthz` + token-guarded `/api/v1/teams`
  (NodePort service in `config/manager/`, ingress example alongside).
- Config injection: `spec.controller.modelConfigSecretRef` references a
  Secret with an `openclaw.json` key (same contract as the chart).

Workers themselves are provisioned by the controller's built-in
KubernetesProvisioner; the operator reconciles the platform around it
(P1 adds in-controller pod watch/repair on the TS side).

## Quick start (k3s)

```bash
make -C operator crd-install
kubectl apply -f operator/config/rbac/operator-rbac.yaml
kubectl apply -f operator/config/manager/deployment.yaml
# UI: http://<node>:30990 (Bearer token from TEAMCLAW_OPERATOR_UI_TOKEN secret)

kubectl create secret generic demo-team-openclaw-config \
  --from-file=openclaw.json=<your openclaw.json>
kubectl apply -f operator/config/samples/teamclaw_v1_teamclaw.yaml
kubectl get teamclaw demo-team -w
```

## Layout

- `api/v1/` — CRD types (`controller-gen` markers)
- `internal/controller/` — reconciler
- `cmd/` — manager entrypoint + UI face
- `config/` — CRD bases, operator RBAC/manager manifests, samples

## Development

```bash
cd operator
go build ./... && go vet ./... && go test ./...
make manifests   # regenerate config/crd/bases
```

CI: `.github/workflows/teamclaw-operator-ci.yml` (build + generated-CRD
drift check + test).
