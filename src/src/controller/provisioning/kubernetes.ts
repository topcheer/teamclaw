// W1 of issue #226 (worker-provisioning god-file split): the kubernetes
// backend, extracted VERBATIM from controller/worker-provisioning.ts
// (KubernetesProvisioner + the lightweight K8sApiClient with in-cluster /
// kubectl-proxy fallback + the kubectl command helpers). Never imports
// worker-provisioning.ts.
import https from "node:https";
import { spawn } from "node:child_process";
import type { PluginConfig, ProvisionedWorkerRecord } from "../../types.js";
import type { PluginLogger } from "../../../api.js";
import { sanitizeName } from "../../shared/utils.js";
import type { LaunchResult, LaunchSpec, WorkerProvisionerBackend } from "./backend-contract.js";
import {
  buildContainerBootstrapScript,
  buildManagedHostname,
  buildManagedInstanceName,
} from "./container-shared.js";

/**
 * Lightweight Kubernetes API client using in-cluster service account or
 * kubeconfig for out-of-cluster (via kubectl proxy or direct API).
 * Avoids requiring kubectl binary in the container image.
 */
class K8sApiClient {
  private token: string | undefined;
  private caCert: Buffer | undefined;
  private apiServer: string;
  private contextArgs: string;

  constructor(context: string, private readonly logger: PluginLogger) {
    this.contextArgs = context;
    // In-cluster detection: K8s injects these env vars and mounts SA token
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT;
    if (host && port) {
      this.apiServer = `https://${host}:${port}`;
      try {
        const fs = require("node:fs");
        this.token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
        this.caCert = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
      } catch {
        logger.warn("K8sApiClient: in-cluster but cannot read service account token — falling back to kubectl");
      }
    } else {
      // Out-of-cluster: delegate to kubectl
      this.apiServer = "";
    }
  }

  private get inCluster(): boolean {
    return Boolean(this.apiServer && this.token);
  }

  async createPod(namespace: string, manifest: unknown): Promise<void> {
    if (this.inCluster) {
      await this.apiRequest("POST", `/api/v1/namespaces/${namespace}/pods`, manifest, [200, 201]);
    } else {
      await runCommand("kubectl", [
        ...buildKubectlContextArgs(this.contextArgs),
        "apply", "-f", "-",
      ], JSON.stringify(manifest));
    }
  }

  async deletePod(namespace: string, podName: string): Promise<void> {
    if (this.inCluster) {
      await this.apiRequest("DELETE", `/api/v1/namespaces/${namespace}/pods/${podName}?gracePeriodSeconds=0`, undefined, [200, 202, 404]);
    } else {
      await runCommand("kubectl", [
        ...buildKubectlContextArgs(this.contextArgs),
        "-n", namespace,
        "delete", "pod", podName,
        "--ignore-not-found=true", "--grace-period=0", "--force",
      ]);
    }
  }

  private async apiRequest(method: string, apiPath: string, body: unknown, okStatuses: number[]): Promise<string> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    return new Promise<string>((resolve, reject) => {
      const url = new URL(apiPath, this.apiServer);
      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "Authorization": `Bearer ${this.token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        ...(this.caCert ? { ca: this.caCert } : { rejectUnauthorized: false }),
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          if (okStatuses.includes(res.statusCode ?? 0)) {
            resolve(data);
          } else {
            reject(new Error(`K8s API ${method} ${apiPath} returned ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

export class KubernetesProvisioner implements WorkerProvisionerBackend {
  readonly type = "kubernetes" as const;
  private readonly config: PluginConfig;
  private readonly logger: PluginLogger;
  private readonly k8sApi: K8sApiClient;

  constructor(config: PluginConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
    this.k8sApi = new K8sApiClient(config.workerProvisioningKubernetesContext, logger);
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    if (!this.config.workerProvisioningImage) {
      throw new Error("workerProvisioningImage is required for kubernetes provisioning");
    }

    const instanceName = buildManagedInstanceName(this.config.teamName, spec.role, spec.workerId);
    const ns = this.config.workerProvisioningKubernetesNamespace;
    const env = {
      ...spec.env,
      HOME: "/home/node",
      OPENCLAW_HOME: "/home/node",
      OPENCLAW_STATE_DIR: "/home/node/.openclaw",
      OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      TEAMCLAW_BOOTSTRAP_CONFIG_B64: Buffer.from(spec.configJson, "utf8").toString("base64"),
      TEAMCLAW_WORKER_ID: spec.workerId,
      TEAMCLAW_LAUNCH_TOKEN: spec.launchToken,
      ...(spec.workspaceDir ? { TEAMCLAW_WORKSPACE_DIR: spec.workspaceDir } : {}),
    };
    const workspaceRoot = this.config.workerProvisioningWorkspaceRoot;
    const hasPersistentWorkspace = Boolean(
      workspaceRoot && this.config.workerProvisioningKubernetesWorkspacePersistentVolumeClaim,
    );
    const imagePullSecrets = this.config.workerProvisioningKubernetesImagePullSecrets
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name }));

    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: instanceName,
        namespace: ns,
        labels: {
          app: "teamclaw-worker",
          "teamclaw.managed": "true",
          "teamclaw.team": sanitizeName(this.config.teamName, 40),
          "teamclaw.role": sanitizeName(spec.role, 40),
          ...this.config.workerProvisioningKubernetesLabels,
        },
        annotations: {
          ...this.config.workerProvisioningKubernetesAnnotations,
        },
      },
      spec: {
        restartPolicy: "Never",
        hostname: buildManagedHostname(this.config.teamName, spec.role, spec.workerId),
        serviceAccountName: this.config.workerProvisioningKubernetesServiceAccount || undefined,
        imagePullSecrets: imagePullSecrets.length > 0 ? imagePullSecrets : undefined,
        securityContext: hasPersistentWorkspace
          ? {
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
            }
          : undefined,
        volumes: hasPersistentWorkspace
          ? [
              {
                name: "workspace",
                persistentVolumeClaim: {
                  claimName: this.config.workerProvisioningKubernetesWorkspacePersistentVolumeClaim,
                },
              },
            ]
          : undefined,
        containers: [
          {
            name: "worker",
            image: this.config.workerProvisioningImage,
            command: ["sh", "-lc"],
            args: [buildContainerBootstrapScript(spec.rateLimitMaxRetries)],
            env: Object.entries(env).map(([name, value]) => ({ name, value })),
            volumeMounts: hasPersistentWorkspace
              ? [
                  {
                    name: "workspace",
                    mountPath: workspaceRoot,
                  },
                ]
              : undefined,
          },
        ],
      },
    };

    await this.k8sApi.createPod(ns, manifest);
    this.logger.info(`Provisioner: applied kubernetes pod ${instanceName}`);

    return {
      instanceId: instanceName,
      instanceName,
    };
  }

  async terminate(record: ProvisionedWorkerRecord): Promise<void> {
    const podName = record.instanceName || record.instanceId;
    if (!podName) {
      return;
    }
    const ns = this.config.workerProvisioningKubernetesNamespace;
    await this.k8sApi.deletePod(ns, podName);
  }
}

async function runCommand(command: string, args: string[], stdin?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    let stdout = "";

    if (stdin) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${(stderr || stdout).trim()}`));
    });
  });
}

function buildKubectlContextArgs(context: string): string[] {
  return context ? ["--context", context] : [];
}
