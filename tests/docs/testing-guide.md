# TeamClaw Supported Topology Test Guide

This guide now covers only the supported TeamClaw deployment patterns:

- dynamic process provisioning
- external worker registration
- dynamic Docker provisioning
- dynamic Kubernetes provisioning

## Supported scenarios

| ID | Topology | Worker model | Git | Script |
| --- | --- | --- | --- | --- |
| S2 | Local dynamic | `process` provisioner | false | `tests/test-local-dynamic.sh` |
| S3 | Docker external workers | controller + registered worker containers | true | `tests/run-tests.sh` |
| S4 | Docker dynamic | `docker` provisioner | true | `tests/test-docker-dynamic.sh` |
| S6 | K8s dynamic | `kubernetes` provisioner | true | `tests/test-k8s-dynamic.sh` |

## Quick start

### Local dynamic process provisioning

```bash
ZAI_API_KEY=... bash tests/test-local-dynamic.sh
```

### Docker external workers

```bash
CONTROLLER_PORT=19527 bash tests/run-tests.sh
CONTROLLER_PORT=19527 bash tests/run-tests.sh --skip-build
```

### Docker dynamic provisioning

```bash
CONTROLLER_PORT=19529 ZAI_API_KEY=... bash tests/test-docker-dynamic.sh
```

### Kubernetes dynamic provisioning

```bash
LOCAL_PORT=19528 TEAMCLAW_TEST_IMAGE=registry.iot2.win/openclaw:teamclaw-test ZAI_API_KEY=... bash tests/test-k8s-dynamic.sh
```

## Important notes

- `tests/test-api.sh` now assumes supported topologies expose real worker HTTP endpoints.
- `tests/test-e2e-delivery.sh` treats git checks as capability-based (`gitEnabled`) rather than special-casing old single-instance modes.
- The deprecated `localRoles` / `single-instance` scenarios have been removed from the supported matrix.
