# Deploying TeamClaw on Kubernetes

Complete reference for running TeamClaw teams on a Kubernetes cluster with the
TeamClaw operator and the helm charts. For the 5-minute path see
[INSTALL.md](../../INSTALL.md#option-0-kubernetes-operator--helm-one-command);
this document covers every customizable surface.

- [Architecture](#architecture)
- [Install the operator](#install-the-operator)
- [Create a team](#create-a-team)
- [Customization reference](#customization-reference)
  - [Service exposure (service type, node port)](#service-exposure-service-type-node-port)
  - [Ingress (host, ingress class, TLS, cert-manager)](#ingress-host-ingress-class-tls-cert-manager)
  - [Storage (workspace PVC, storage class)](#storage-workspace-pvc-storage-class)
  - [Runtime image](#runtime-image)
  - [OpenClaw configuration (config secret, providers)](#openclaw-configuration-config-secret-providers)
  - [Operator UI auth](#operator-ui-auth)
  - [Resources, scheduling, tolerations](#resources-scheduling-tolerations)
- [TeamClaw CR reference](#teamclaw-cr-reference)
- [Operations](#operations)
  - [Upgrades](#upgrades)
  - [Scaling workers](#scaling-workers)
  - [Logs and debugging](#logs-and-debugging)
  - [Uninstall](#uninstall)
- [Known constraints](#known-constraints)

## Architecture

```
teamclaw-operator (Deployment, 1 replica)
  ├─ watches TeamClaw CRs cluster-wide
  ├─ per TeamClaw: controller Deployment + Service (+Ingress) + workspace PVC
  └─ operator UI (token-guarded, :9090 / NodePort 30990)

TeamClaw CR (one per team, any namespace)
  └─ controller pod runs openclaw gateway + teamclaw plugin (mode: controller)
       ├─ workers: process (in-pod) | docker | kubernetes provisioning
       └─ runtime image: ghcr.io/topcheer/teamclaw-openclaw (official base + plugin)
```

The operator chart and the runtime image publish from CI on every merge to
`main`. Charts are OCI artifacts on GHCR - there is no `helm repo add` step.

## Install the operator

```bash
helm install teamclaw-operator oci://ghcr.io/topcheer/charts/teamclaw-operator \
  --version 0.1.0 --create-namespace -n teamclaw \
  --set token.token=$(openssl rand -hex 24)
```

All chart values (see `deploy/helm/teamclaw-operator/values.yaml`):

| Value | Default | Description |
| --- | --- | --- |
| `image.repository` | `ghcr.io/topcheer/teamclaw-operator` | Operator image |
| `image.tag` | `latest` | Pin a `sha-<rev>` tag for reproducible installs |
| `image.pullPolicy` | `Always` | Required for the rolling `latest` tag |
| `replicaCount` | `1` | Leader election allows >1 |
| `serviceAccount.name` | `teamclaw-operator` | SA used by the manager |
| `ui.type` | `NodePort` | `NodePort`, `ClusterIP` or `LoadBalancer` |
| `ui.port` | `9090` | Container port for the UI + API |
| `ui.nodePort` | `30990` | NodePort number (ignored otherwise) |
| `ui.ingress.enabled` | `false` | Expose the operator UI via Ingress |
| `ui.ingress.host` | *(required if enabled)* | FQDN for the UI |
| `ui.ingress.ingressClassName` | *(cluster default)* | e.g. `traefik`, `nginx` |
| `ui.ingress.tlsSecretName` | *(none)* | TLS secret for the UI host |
| `token.token` | *(required)* | Bearer token guarding UI + API |
| `token.existingSecret` | *(chart-generated)* | Use an existing secret instead |
| `token.key` | `token` | Key inside `existingSecret` |
| `leaderElection.enabled` | `true` | Lease-based leader election |
| `resources` / `nodeSelector` / `tolerations` / `affinity` | `{}` | Standard pod scheduling |

**Prefer an existing secret** over `--set token.token` (it lands in the helm
release values and may leak via `helm get values`):

```bash
kubectl -n teamclaw create secret generic operator-ui-token \
  --from-literal=token=$(openssl rand -hex 24)
helm install teamclaw-operator oci://ghcr.io/topcheer/charts/teamclaw-operator \
  -n teamclaw --set token.existingSecret=operator-ui-token
```

### Raw manifests (no helm)

The chart is a thin wrapper over `operator/config/`; applying
`operator/config/rbac/operator-rbac.yaml` + `operator/config/manager/deployment.yaml`
plus the CRD from the chart's `templates/crd.yaml` is equivalent.

## Create a team

From the operator UI (`http://<node>:30990`, sign in with the token):

1. **New Team** - name, team name, image (default the published runtime image)
2. Paste an `openclaw.json` - the operator creates `<name>-config` Secret and
   wires `spec.controller.modelConfigSecretRef` automatically
3. Optionally set workspace size/storage class and ingress host/class/TLS
4. Save - the controller Deployment/Service/PVC appear and `Ready` flips True

Or declaratively:

```yaml
apiVersion: teamclaw.dev/v1
kind: TeamClaw
metadata:
  name: demo-team
  namespace: teamclaw
spec:
  teamName: demo-team
  image: ghcr.io/topcheer/teamclaw-openclaw:latest
  controller:
    modelConfigSecretRef: demo-team-openclaw-config
  workspace:
    enabled: true
    size: 20Gi
    storageClassName: local-path
  network:
    ingress:
      host: demo-team.example.com
      ingressClassName: nginx
      tlsSecretName: demo-team-tls
```

```bash
kubectl apply -f demo-team.yaml
```

The controller Service is `ClusterIP` named `<team>-controller` on port 9527
(plugin API) - reach it via the ingress above or `kubectl port-forward`.

## Customization reference

### Service exposure (service type, node port)

Both layers are independently customizable:

- **Operator UI**: set at install time (`ui.type` / `ui.nodePort`)
- **Team controller**: per team via `spec.network.serviceType`
  (`ClusterIP` default, `NodePort`, `LoadBalancer`) and
  `spec.network.nodePort` (explicit node port for NodePort teams):

```yaml
network:
  serviceType: NodePort
  nodePort: 30127
```

### Ingress (host, ingress class, TLS, cert-manager)

Per team, `spec.network.ingress` accepts:

| Field | Meaning |
| --- | --- |
| `host` | FQDN routed to this team's controller |
| `ingressClassName` | Override the cluster default (k3s ships `traefik`) |
| `tlsSecretName` | Existing TLS secret; enables HTTPS on the ingress |
| `annotations` | Free-form map merged onto the Ingress |

**CRD lifecycle**: the chart ships the TeamClaw CRD as a regular release
asset (no Helm 2 `crd-install` hook - that hook point is dead in Helm 3
and silently skipped CRD installation entirely). Consequences, verified
against Helm 3:

- `helm install` creates the CRD; `helm upgrade` refreshes its schema
  (new spec fields land on upgrade, no manual apply needed)
- `helm uninstall` deletes the CRD, and deleting a CRD cascades **all
  TeamClaw CRs in every namespace**. To keep team definitions across an
  operator reinstall, back them up first
  (`kubectl get teamclaws -A -o yaml > teams-backup.yaml`) and restore
  after, or `kubectl patch crd teamclaws.teamclaw.dev -p '{"metadata":{"finalizers":[]}}'`
  is NOT needed - simply avoid uninstalling when you want data kept.
- If the CRD pre-exists from a kubectl apply (ownership outside Helm),
  Helm skips it silently - manage that copy with
  `kubectl apply -f operator/config/crd/bases/teamclaw.dev_teamclaws.yaml`
  on upgrades.

**cert-manager** (first-class since 2026.11): set `certManager` on the
ingress and the operator injects the issuer annotations plus an
auto-named TLS secret (`<team>-controller-tls`):

```yaml
network:
  ingress:
    host: demo-team.example.com
    certManager:
      issuerRef: letsencrypt-prod   # or kind: Issuer + a namespaced ref
```

Plain `annotations` remain available for anything else.

### Storage (workspace PVC, storage class)

`spec.workspace`:

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Set false for stateless teams |
| `size` | `20Gi` | Grow-only on existing claims (spec otherwise immutable) |
| `storageClassName` | cluster default | Only settable at claim creation |
| `existingClaim` | *(none)* | Reuse an existing PVC instead of managing one |

### Runtime image

`spec.image` defaults to the published
`ghcr.io/topcheer/teamclaw-openclaw:latest`, which layers the plugin onto the
official openclaw base. Pin `sha-<rev>` tags (published per merge) for
controlled rollouts. Controller pods use `imagePullPolicy: Always` so the
rolling `latest` tag actually rolls.

### OpenClaw configuration (config secret, providers)

The controller boots from the `openclaw.json` inside
`spec.controller.modelConfigSecretRef`. Rules learned the hard way on
openclaw 2026.10.10:

- `gateway.bind: "lan"` **requires** `gateway.auth.token` - set one
- provider `apiKey` must be an **inline string**; `file:` references do not
  resolve inside pods
- `agents.entries` is accepted natively (new schema); provisioning folds it
  appropriately per worker backend

### Operator UI auth

Token via `token.token` or `token.existingSecret`. Rotate by updating the
secret and restarting the operator; sessions re-lock on the next 401.

### Resources, scheduling, tolerations

Operator-level values apply to the operator pod. Per-team:

- resources: `spec.controller.resources` (standard ResourceRequirements)
- scheduling: `spec.controller.scheduling` with `nodeSelector`, `affinity`
  and `tolerations` (standard corev1 objects, applied verbatim)
- LoadBalancer fine-tuning: `spec.network.serviceAnnotations` merges onto
  the controller Service (cloud LB annotations etc.)

## TeamClaw CR reference

`spec`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `teamName` | string | *(required)* | Team identity for the plugin |
| `image` | string | published latest | Controller/worker runtime image |
| `controller.modelConfigSecretRef` | string | *(required)* | Secret with `openclaw.json` |
| `workspace.{enabled,size,storageClassName,existingClaim}` | object | true/20Gi | Workspace PVC |
| `network.ingress.{host,ingressClassName,tlsSecretName,annotations}` | object | *(none)* | Ingress exposure |

`status`: `controllerEndpoint`, `workerPods.{running,pending}`,
`conditions` (`Ready`, `ConfigReady`).

## Operations

### Upgrades

- Charts: bump `--version` and `helm upgrade`; the CI publishes on chart changes
- Runtime image: `latest` rolls on restart (`imagePullPolicy: Always`); pinned
  tags need a spec change. `kubectl -n teamclaw rollout restart deploy/<team>-controller`
- Operator: `kubectl -n <ns> rollout restart deploy/teamclaw-operator` after a
  new image publish

### Scaling workers

Workers are provisioned by the controller per
`workerProvisioningType`/`workerProvisioningMaxPerRole` in the team's
`openclaw.json` (see [docker.md](./docker.md) / README topology table). The
operator does not manage worker replicas itself.

### Logs and debugging

```bash
kubectl -n teamclaw get teamclaw demo-team            # conditions + workers
kubectl -n teamclaw logs deploy/demo-team-controller  # gateway + plugin
kubectl -n teamclaw describe teamclaw demo-team       # events
kubectl -n <op-ns> logs deploy/teamclaw-operator      # reconcile errors
```

### Uninstall

```bash
kubectl delete teamclaw <name> -n teamclaw   # cascades controller resources
helm uninstall teamclaw-operator -n teamclaw # operator + CRD stays (hook)
kubectl delete crd teamclaws.teamclaw.dev    # optional final cleanup
```

## Known constraints

- Controller Service is ClusterIP-only (no per-team NodePort/LoadBalancer yet)
- cert-manager integration is annotation-based (no dedicated CR field)
- Per-team controller resources/affinity not yet exposed on the CR
- The operator chart's CRD uses the `crd-install` hook - `helm uninstall`
  leaves it behind intentionally
