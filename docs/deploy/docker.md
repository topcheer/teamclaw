# Docker Provisioning Mode

How the TeamClaw controller launches on-demand workers as Docker containers.
Source of truth: `src/src/controller/worker-provisioning.ts`, `src/src/config.ts`,
`src/src/types.ts`, `src/src/install-defaults.ts`.

The controller talks to the Docker Engine API directly (no `docker` CLI
dependency): `DOCKER_HOST` is parsed by `resolveDockerEndpoint()` and requests
go over the Unix socket or TCP. Kubernetes mode shells out to `kubectl` with
the controller's environment (see [Kubernetes notes](#kubernetes-notes)).

## Enabling

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "teamclaw": {
      "mode": "controller",
      "workerProvisioningType": "docker",
      "workerProvisioningControllerUrl": "http://host.docker.internal:9527"
    }
  }
}
```

`workerProvisioningControllerUrl` is **required** for `docker` and
`kubernetes` (the container cannot reach the controller through mDNS).
`process` workers ignore it and always use `http://127.0.0.1:<port>`.

## Configuration reference

All keys live under `plugins.teamclaw.*`. Defaults from `src/src/config.ts`.

| Key | Type / Default | Meaning |
|---|---|---|
| `workerProvisioningType` | `none` \| `process` \| `docker` \| `kubernetes` / `none` | Provisioner backend. `process` spawns same-host gateway child processes sharing the controller workspace. |
| `workerProvisioningDisabled` | bool / `false` | Hard-off switch; suppresses on-demand provisioning even where TeamClaw would default to same-host process workers. |
| `workerProvisioningControllerUrl` | string / `""` | Controller URL injected into provisioned workers. Required for `docker`/`kubernetes`. Use a URL the *container* can reach (`host.docker.internal` on Docker Desktop, a compose service name, or the host LAN IP). |
| `workerProvisioningRoles` | RoleId[] / `[]` | Preferred roles to keep warm at startup. Empty = no preferred list; startup readiness falls back to one warm `developer`. Task-required roles launch automatically even when not listed. |
| `workerProvisioningMinPerRole` | number / `0` | Minimum ready workers to keep warm per role. |
| `workerProvisioningMaxPerRole` | number / `10` | Cap on concurrent on-demand workers per role. |
| `workerProvisioningIdleTtlMs` | number / `120000` | Idle provisioned workers are terminated after this long. |
| `workerProvisioningStartupTimeoutMs` | number / `120000` | A launch fails if the worker has not registered within this window. |
| `workerProvisioningImage` | string / `ghcr.io/topcheer/teamclaw-openclaw:latest` | Image used by both `docker` and `kubernetes` provisioners. |
| `workerProvisioningPassEnv` | string[] / `[]` | **Names** of env vars copied verbatim from the controller process into every provisioned worker (only if set and non-empty on the controller). |
| `workerProvisioningExtraEnv` | Record\<string,string\> / `{}` | Env vars injected verbatim into every provisioned worker. A same-named `PassEnv` entry that exists on the controller overwrites it (pass-env is applied last). |
| `workerProvisioningDockerNetwork` | string / `""` | Docker network for worker containers (`NetworkMode`). Empty = Docker default bridge. `host` is detected and treated as host networking. |
| `workerProvisioningDockerMounts` | string[] / `[]` | Extra bind mounts in `src:dst[:ro]` form, passed straight to `HostConfig.Binds`. |
| `workerProvisioningWorkspaceRoot` | string / `""` | Path *inside* the container used as the persistent workspace root. Defaults to `/workspace-root` when a volume/PVC is configured (see below). |
| `workerProvisioningDockerWorkspaceVolume` | string / `""` | Docker **named volume or host path** mounted at the workspace root. Empty = no persistent workspace (container workspaces are ephemeral). |
| `workerProvisioningKubernetesNamespace` | string / `default` | Pod namespace (k8s only). |
| `workerProvisioningKubernetesContext` | string / `""` | Optional `kubectl --context`. |
| `workerProvisioningKubernetesServiceAccount` | string / `""` | Pod service account. |
| `workerProvisioningKubernetesImagePullSecrets` | string[] / `[]` | Pull secrets added to the pod spec. |
| `workerProvisioningKubernetesWorkspacePersistentVolumeClaim` | string / `""` | PVC mounted as the persistent workspace root. |
| `workerProvisioningKubernetesLabels` | Record / `{}` | Extra pod labels. |
| `workerProvisioningKubernetesAnnotations` | Record / `{}` | Extra pod annotations. |

Provisioning keys are stripped from the config the worker itself receives
(`buildProvisionedWorkerConfig` empties `PassEnv`/`ExtraEnv` there), so
provisioned workers cannot recursively provision.

## Environment variables the controller recognizes

| Variable | Recognized where | Behavior |
|---|---|---|
| `DOCKER_HOST` | Controller process | Docker endpoint. `unix://` (or unset) = `/var/run/docker.sock`; `tcp://`/bare host = HTTP; `https://` scheme = HTTPS with default TLS (no explicit client-cert wiring). Ports default 2375/443. |
| `NO_PROXY` / `no_proxy` | Controller process and forwarded env | TeamClaw **merges** required entries (`localhost`, `127.0.0.1`, `::1`, `[::1]`, plus the controller URL hostname) into the forwarded copy so worker→controller traffic never goes through a proxy. Your own entries are preserved, de-duplicated case-insensitively. |
| `KUBECONFIG` | Controller process | Passed through to `kubectl` child processes (k8s provisioner) with the controller's full environment. |
| `TEAMCLAW_BAKED_IN` | Controller process | `true` = running inside the published runtime image; the auto plugin bind mount is skipped (plugin already baked at `/app/extensions/teamclaw`). |

Typical `PassEnv` candidates: `HTTPS_PROXY`/`HTTP_PROXY` (only if your egress
needs it — `NO_PROXY` for the controller is managed automatically),
`GITHUB_TOKEN`-style auth vars used by openclaw, corporate CA bundles
(`NODE_EXTRA_CA_CERTS`).

## Environment variables inside a provisioned worker

Every container receives:

- Everything from `workerProvisioningExtraEnv`, plus every non-empty
  `workerProvisioningPassEnv` name copied from the controller.
- Merged `NO_PROXY`/`no_proxy` (see above).
- Bootstrap identity, written by the container entrypoint:
  `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`,
  `TEAMCLAW_BOOTSTRAP_CONFIG_B64` (base64 worker `openclaw.json`; the
  bootstrap script decodes it to disk before starting the gateway),
  `TEAMCLAW_WORKSPACE_DIR` (when a workspace root is configured), plus the
  worker identity/launch-token pair used to register with the controller.

The bootstrap script (same for docker and process) is effectively:

```sh
set -eu
mkdir -p "$OPENCLAW_STATE_DIR"
[ -n "${TEAMCLAW_WORKSPACE_DIR:-}" ] && mkdir -p "$TEAMCLAW_WORKSPACE_DIR"
node -e '...decode TEAMCLAW_BOOTSTRAP_CONFIG_B64 -> $OPENCLAW_CONFIG_PATH...'
exec node dist/index.js gateway --allow-unconfigured
```

## Mounts

`buildDockerBinds` assembles `HostConfig.Binds` in this order:

1. **Workspace volume** (if `workerProvisioningDockerWorkspaceVolume` and
   `workerProvisioningWorkspaceRoot` are both set):
   `"<volume>:<workspace-root>"`.
2. **Plugin dir** (unless the image is baked or you already mount something
   at the bundled plugin path): the controller's teamclaw plugin root is
   mounted read-only into the container so the worker loads the *same*
   plugin build as the controller.
3. Your `workerProvisioningDockerMounts` entries, verbatim.

Example — give workers Docker and a shared cache:

```jsonc
"workerProvisioningDockerMounts": [
  "/var/run/docker.sock:/var/run/docker.sock",
  "~/.npm:/home/node/.npm:rw"
]
```

(Supporting tools that shell out to `kubectl`/`docker` inside the worker
will also need the matching `KUBECONFIG`/`DOCKER_HOST` via `PassEnv` or
`ExtraEnv`.)

## Workspace volume semantics

- **`process`**: workers share the controller's agent workspace root;
  file artifacts are immediately visible to the controller without git sync.
- **`docker`/`kubernetes` with a volume/PVC configured**: each worker gets a
  private directory `<workspace-root>/<teamName>/<role>/<workerId>` inside
  the shared volume. Workspaces survive container restarts; the controller
  reconciles via git (see `gitEnabled` docs) when enabled.
- **No volume configured**: container workspaces are ephemeral — anything
  not pushed to git dies with the container. Fine for pure review roles,
  wrong for write roles that have not delivered yet.

## Kubernetes notes

The k8s provisioner shells out to `kubectl` (apply/delete/log) using the
controller's environment, so `KUBECONFIG` and any context auth flows work as
they would from your shell; `workerProvisioningKubernetesContext` adds an
explicit `--context` override. Workspace persistence uses a pre-created PVC
referenced by name — the provisioner does not create it.

## Common pitfalls

1. **Provisioning silently idle**: `workerProvisioningType` defaults to
   `none`. A controller with no reachable workers just queues tasks —
   check `GET /api/v1/workers` for registrations.
2. **Container cannot reach the controller**: `workerProvisioningControllerUrl`
   must be reachable *from inside the container network*. On Docker Desktop
   use `http://host.docker.internal:9527`; on a custom bridge network use the
   compose service name. mDNS discovery does not cross container boundaries.
3. **Proxy environments**: worker→controller traffic is protected by the
   automatic `NO_PROXY` merge, but if the controller itself needs a proxy for
   egress, pass `HTTP(S)_PROXY` explicitly — they are *not* forwarded by
   default.
4. **`https://` DOCKER_HOST**: only the scheme switches; client-certificate
   paths are not wired through the engine API client — prefer `unix://`
   socket or an unauthenticated TCP endpoint for now.
5. **Overriding the plugin mount**: any `DockerMounts` entry whose target is
   the bundled plugin path suppresses the auto-mount — point it at your own
   plugin build deliberately.
6. **`exit 78` at worker startup** historically meant an agents config with
   zero entries (the runtime requires ≥1). `buildProvisionedWorkerConfig`
   now keeps the required entry per backend (process vs container schemas
   differ); if you override the worker `agents` config via `ExtraEnv`
   bootstrap, keep at least one agent entry.
7. **Image tag `:latest`**: the default image floats. Pin a digest for
   reproducible fleets (the operator/k8s deployment path already sets
   `imagePullPolicy: Always` for `:latest`).
