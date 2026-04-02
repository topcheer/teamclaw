# TeamClaw Testing Strategy

TeamClaw's supported topology matrix is now intentionally smaller:

| Scenario | Topology | Worker pattern | Git | Environment |
| --- | --- | --- | --- | --- |
| S2 | Local dynamic | process provisioner | false | local macOS / OpenClaw |
| S3 | Docker external workers | registered worker containers | true | Docker |
| S4 | Docker dynamic | docker provisioner | true | Docker + docker.sock |
| S6 | Kubernetes dynamic | kubernetes provisioner | true | K8s + RBAC + PVC |

## Why the matrix changed

Deprecated static topologies were removed:

- no more `localRoles`
- no more `single-instance` controller + embedded worker test paths
- no more K8s single-pod fake-worker topology

The product now validates only two worker models:

- dynamically provisioned workers (`process`, `docker`, `kubernetes`)
- externally registered workers (`mode: "worker"`)

## Primary test entry points

- `bash tests/test-local-dynamic.sh`
- `bash tests/run-tests.sh`
- `bash tests/test-docker-dynamic.sh`
- `bash tests/test-k8s-dynamic.sh`
- `bash tests/test-scenario-matrix.sh`

## Regression anchors

- `node tests/test-installer.mjs`
- `node tests/test-controller-intake.mjs`
- `node tests/test-worker-contracts.mjs`
- `node tests/test-role-registry.mjs`

## Validation principle

Any new feature or topology change should be validated against at least one supported dynamic or external-worker path. New work should not reintroduce static local-role execution paths.
