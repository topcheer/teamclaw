import type { PluginConfig } from "./types.js";
import { parsePluginConfig } from "./types.js";
import { ROLE_IDS } from "./roles.js";
import { TEAMCLAW_PUBLISHED_RUNTIME_IMAGE } from "./install-defaults.js";

function buildConfigSchema() {
  return {
    jsonSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string" as const,
          enum: ["controller", "worker"],
          default: "worker",
          description: "Plugin mode: controller manages the team, worker executes tasks",
        },
        port: {
          type: "number" as const,
          default: 9527,
          description: "HTTP server port for this instance",
        },
        role: {
          type: "string" as const,
          default: "developer",
          description: "Worker role (only used in worker mode)",
        },
        controllerUrl: {
          type: "string" as const,
          default: "",
          description: "Manual controller URL fallback (used when mDNS discovery fails)",
        },
        teamName: {
          type: "string" as const,
          default: "default",
          description: "Team name for mDNS identification",
        },
        heartbeatIntervalMs: {
          type: "number" as const,
          default: 10000,
          description: "Heartbeat interval in milliseconds",
        },
        taskTimeoutMs: {
          type: "number" as const,
          default: 1800000,
          description: "Maximum time in milliseconds to wait for a role task to finish",
        },
        gitEnabled: {
          type: "boolean" as const,
          default: true,
          description: "Enable TeamClaw git-backed workspace collaboration",
        },
        gitRemoteUrl: {
          type: "string" as const,
          default: "",
          description: "Optional remote repository URL for distributed worker clone/pull/push",
        },
        gitDefaultBranch: {
          type: "string" as const,
          default: "main",
          description: "Default branch name for the shared TeamClaw workspace repository",
        },
        gitAuthorName: {
          type: "string" as const,
          default: "TeamClaw",
          description: "Git author name used for TeamClaw-managed workspace commits",
        },
        gitAuthorEmail: {
          type: "string" as const,
          default: "teamclaw@local",
          description: "Git author email used for TeamClaw-managed workspace commits",
        },
        localRoles: {
          type: "array" as const,
          default: [],
          description: "Controller-local roles executed in this same OpenClaw instance",
          items: {
            type: "string" as const,
            enum: ROLE_IDS,
          },
        },
        workerProvisioningType: {
          type: "string" as const,
          enum: ["none", "process", "docker", "kubernetes"],
          default: "none",
          description: "Controller-only on-demand worker launch backend",
        },
        workerProvisioningControllerUrl: {
          type: "string" as const,
          default: "",
          description: "Controller URL injected into provisioned workers; required for docker/kubernetes",
        },
        workerProvisioningRoles: {
          type: "array" as const,
          default: [],
          description: "Restrict on-demand launches to specific roles; empty means all roles",
          items: {
            type: "string" as const,
            enum: ROLE_IDS,
          },
        },
        workerProvisioningMinPerRole: {
          type: "number" as const,
          default: 0,
          description: "Minimum number of ready workers to keep warm per role",
        },
        workerProvisioningMaxPerRole: {
          type: "number" as const,
          default: 1,
          description: "Maximum on-demand workers to launch per role",
        },
        workerProvisioningIdleTtlMs: {
          type: "number" as const,
          default: 120000,
          description: "Terminate provisioned idle workers after this many milliseconds",
        },
        workerProvisioningStartupTimeoutMs: {
          type: "number" as const,
          default: 120000,
          description: "Fail a launch if the worker does not register within this many milliseconds",
        },
        workerProvisioningImage: {
          type: "string" as const,
          default: TEAMCLAW_PUBLISHED_RUNTIME_IMAGE,
          description: "Container image used by docker/kubernetes provisioners",
        },
        workerProvisioningPassEnv: {
          type: "array" as const,
          default: [],
          description: "Environment variable names copied from the controller into provisioned workers",
          items: {
            type: "string" as const,
          },
        },
        workerProvisioningExtraEnv: {
          type: "object" as const,
          default: {},
          description: "Extra environment variables injected into provisioned workers",
          additionalProperties: {
            type: "string" as const,
          },
        },
        workerProvisioningDockerNetwork: {
          type: "string" as const,
          default: "",
          description: "Optional Docker network name for launched worker containers",
        },
        workerProvisioningDockerMounts: {
          type: "array" as const,
          default: [],
          description: "Optional Docker bind mounts for launched worker containers",
          items: {
            type: "string" as const,
          },
        },
        workerProvisioningWorkspaceRoot: {
          type: "string" as const,
          default: "",
          description: "Optional persistent workspace root path inside docker/kubernetes workers; defaults to /workspace-root when a Docker volume or PVC is configured",
        },
        workerProvisioningDockerWorkspaceVolume: {
          type: "string" as const,
          default: "",
          description: "Optional Docker named volume or host path mounted as the persistent workspace root",
        },
        workerProvisioningKubernetesNamespace: {
          type: "string" as const,
          default: "default",
          description: "Kubernetes namespace for launched worker pods",
        },
        workerProvisioningKubernetesContext: {
          type: "string" as const,
          default: "",
          description: "Optional kubectl context used by the Kubernetes provisioner",
        },
        workerProvisioningKubernetesServiceAccount: {
          type: "string" as const,
          default: "",
          description: "Optional service account name for launched worker pods",
        },
        workerProvisioningKubernetesWorkspacePersistentVolumeClaim: {
          type: "string" as const,
          default: "",
          description: "Optional PVC mounted as the persistent workspace root for launched worker pods",
        },
        workerProvisioningKubernetesLabels: {
          type: "object" as const,
          default: {},
          description: "Extra labels applied to launched worker pods",
          additionalProperties: {
            type: "string" as const,
          },
        },
        workerProvisioningKubernetesAnnotations: {
          type: "object" as const,
          default: {},
          description: "Extra annotations applied to launched worker pods",
          additionalProperties: {
            type: "string" as const,
          },
        },
      },
    },
    uiHints: {
      mode: { label: "Mode", help: "controller manages the team, worker executes tasks" },
      port: { label: "Port", help: "HTTP server port for this instance" },
      role: { label: "Role", help: "Worker role (worker mode only)" },
      controllerUrl: { label: "Controller URL", help: "Manual fallback if mDNS discovery fails" },
      teamName: { label: "Team Name", help: "Team identifier for mDNS" },
      heartbeatIntervalMs: { label: "Heartbeat Interval", help: "In milliseconds, minimum 1000" },
      taskTimeoutMs: {
        label: "Task Timeout",
        help: "Maximum time to wait for a role task to finish before marking it failed (in milliseconds)",
      },
      gitEnabled: {
        label: "Git Collaboration",
        help: "Enable automatic git-backed workspace bootstrapping and worker repo sync",
      },
      gitRemoteUrl: {
        label: "Git Remote URL",
        help: "Optional remote repository URL; when empty, distributed workers use controller-hosted git bundles",
      },
      gitDefaultBranch: {
        label: "Git Default Branch",
        help: "Default branch name for the TeamClaw workspace repository",
      },
      gitAuthorName: {
        label: "Git Author Name",
        help: "Author name for TeamClaw-managed workspace commits",
      },
      gitAuthorEmail: {
        label: "Git Author Email",
        help: "Author email for TeamClaw-managed workspace commits",
      },
      localRoles: {
        label: "Local Roles",
        help: "Controller mode only: run these roles as local virtual workers inside the same OpenClaw instance",
      },
      workerProvisioningType: {
        label: "On-demand Worker Provider",
        help: "Launch missing workers on demand using process, Docker, or Kubernetes",
      },
      workerProvisioningControllerUrl: {
        label: "Provisioned Worker Controller URL",
        help: "URL that launched workers use to call back into the controller",
      },
      workerProvisioningRoles: {
        label: "Provisioned Roles",
        help: "Only launch these roles on demand; leave empty for all roles",
      },
      workerProvisioningMinPerRole: {
        label: "Warm Workers Per Role",
        help: "Minimum idle workers to keep warm per role",
      },
      workerProvisioningMaxPerRole: {
        label: "Max Workers Per Role",
        help: "Maximum concurrent on-demand workers per role",
      },
      workerProvisioningIdleTtlMs: {
        label: "Idle TTL",
        help: "Terminate an idle provisioned worker after this many milliseconds",
      },
      workerProvisioningStartupTimeoutMs: {
        label: "Startup Timeout",
        help: "Fail a launch if the worker does not register in time",
      },
      workerProvisioningImage: {
        label: "Provisioning Image",
        help: "Container image for docker/kubernetes provisioners",
      },
      workerProvisioningPassEnv: {
        label: "Pass-through Env",
        help: "Environment variable names copied from controller to provisioned workers",
      },
      workerProvisioningExtraEnv: {
        label: "Extra Env",
        help: "Static environment variables injected into provisioned workers",
      },
      workerProvisioningDockerNetwork: {
        label: "Docker Network",
        help: "Optional Docker network for launched worker containers",
      },
      workerProvisioningDockerMounts: {
        label: "Docker Mounts",
        help: "Optional Docker bind mounts for launched worker containers",
      },
      workerProvisioningWorkspaceRoot: {
        label: "Workspace Root",
        help: "Optional persistent workspace root path inside docker/kubernetes workers; defaults to /workspace-root when persistence is configured",
      },
      workerProvisioningDockerWorkspaceVolume: {
        label: "Docker Workspace Volume",
        help: "Optional Docker named volume or host path mounted as the persistent workspace root",
      },
      workerProvisioningKubernetesNamespace: {
        label: "Kubernetes Namespace",
        help: "Namespace for launched worker pods",
      },
      workerProvisioningKubernetesContext: {
        label: "Kubernetes Context",
        help: "Optional kubectl context for the Kubernetes provider",
      },
      workerProvisioningKubernetesServiceAccount: {
        label: "Kubernetes Service Account",
        help: "Optional service account for launched worker pods",
      },
      workerProvisioningKubernetesWorkspacePersistentVolumeClaim: {
        label: "Kubernetes Workspace PVC",
        help: "Optional PVC mounted as the persistent workspace root for launched worker pods",
      },
      workerProvisioningKubernetesLabels: {
        label: "Kubernetes Labels",
        help: "Extra labels applied to launched worker pods",
      },
      workerProvisioningKubernetesAnnotations: {
        label: "Kubernetes Annotations",
        help: "Extra annotations applied to launched worker pods",
      },
    },
    parse(raw: unknown): PluginConfig {
      return parsePluginConfig(raw as Record<string, unknown>);
    },
  };
}

export { buildConfigSchema };
