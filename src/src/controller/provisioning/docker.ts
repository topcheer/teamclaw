// W1 of issue #226 (worker-provisioning god-file split): the docker backend,
// extracted VERBATIM from controller/worker-provisioning.ts (DockerProvisioner
// + the unauthenticated local-socket DockerApiClient + endpoint / bind / API
// version helpers). Never imports worker-provisioning.ts.
import http from "node:http";
import https from "node:https";
import type { PluginConfig, ProvisionedWorkerRecord } from "../../types.js";
import type { PluginLogger } from "../../../api.js";
import type { LaunchResult, LaunchSpec, WorkerProvisionerBackend } from "./backend-contract.js";
import { buildContainerBootstrapScript, buildManagedInstanceName } from "./container-shared.js";
import { resolveCurrentTeamClawPluginRootDir } from "./plugin-root.js";

const DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR = "/app/extensions/teamclaw";

const DOCKER_API_VERSION = resolveDockerApiVersion();

export class DockerProvisioner implements WorkerProvisionerBackend {
  readonly type = "docker" as const;
  private readonly config: PluginConfig;
  private readonly logger: PluginLogger;
  private readonly client: DockerApiClient;

  constructor(config: PluginConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
    this.client = new DockerApiClient();
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    if (!this.config.workerProvisioningImage) {
      throw new Error("workerProvisioningImage is required for docker provisioning");
    }

    const instanceName = buildManagedInstanceName(this.config.teamName, spec.role, spec.workerId);
    const env: Record<string, string> = {
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

    // When workers share a Docker network with the controller container, advertise
    // the container name and internal worker port so sibling containers can reach it
    // directly. When the controller runs on the host, fall back to publishing a host
    // port and advertising localhost for host-side callbacks.
    const usePortPublishing = spec.publishedHostPort !== undefined;
    if (this.config.workerProvisioningDockerNetwork) {
      env.TEAMCLAW_ADVERTISE_HOST = instanceName;
      env.TEAMCLAW_ADVERTISE_PORT = String(spec.workerPort);
    } else if (usePortPublishing) {
      env.TEAMCLAW_ADVERTISE_HOST = "localhost";
      env.TEAMCLAW_ADVERTISE_PORT = String(spec.publishedHostPort);
    }

    const hostConfig: Record<string, unknown> = {
      Binds: buildDockerBinds(this.config),
      NetworkMode: this.config.workerProvisioningDockerNetwork || undefined,
    };

    if (usePortPublishing) {
      hostConfig.PortBindings = {
        [`${spec.workerPort}/tcp`]: [{ HostPort: String(spec.publishedHostPort) }],
      };
    }

    const containerConfig: Record<string, unknown> = {
      Image: this.config.workerProvisioningImage,
      Cmd: ["sh", "-lc", buildContainerBootstrapScript(spec.rateLimitMaxRetries)],
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      User: "root",
      Labels: {
        "teamclaw.managed": "true",
        "teamclaw.team": this.config.teamName,
        "teamclaw.role": spec.role,
        "teamclaw.worker_id": spec.workerId,
      },
      HostConfig: hostConfig,
    };

    if (usePortPublishing) {
      containerConfig.ExposedPorts = { [`${spec.workerPort}/tcp`]: {} };
    }

    const response = await this.client.requestJson<{ Id?: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(instanceName)}`,
      containerConfig,
      [201],
    );

    const instanceId = typeof response.Id === "string" ? response.Id : undefined;
    if (!instanceId) {
      throw new Error("Docker create did not return a container ID");
    }

    await this.client.requestVoid("POST", `/containers/${instanceId}/start`, undefined, [204]);
    this.logger.info(`Provisioner: started docker worker container ${instanceName} (${instanceId})`);

    return {
      instanceId,
      instanceName,
    };
  }

  async terminate(record: ProvisionedWorkerRecord): Promise<void> {
    const target = record.instanceId || record.instanceName;
    if (!target) {
      return;
    }
    await this.client.requestVoid("DELETE", `/containers/${target}?force=1`, undefined, [204, 404]);
  }
}

class DockerApiClient {
  private readonly endpoint: DockerEndpoint;

  constructor() {
    this.endpoint = resolveDockerEndpoint();
  }

  async requestJson<T>(method: string, requestPath: string, body?: unknown, okStatuses: number[] = [200]): Promise<T> {
    const response = await this.request(method, requestPath, body, okStatuses);
    if (!response.body) {
      return {} as T;
    }
    return JSON.parse(response.body) as T;
  }

  async requestVoid(method: string, requestPath: string, body?: unknown, okStatuses: number[] = [200]): Promise<void> {
    await this.request(method, requestPath, body, okStatuses);
  }

  private async request(
    method: string,
    requestPath: string,
    body: unknown,
    okStatuses: number[],
  ): Promise<{ status: number; body: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // Prefer the daemon's negotiated default unless the operator pins a version explicitly.
    const finalPath = DOCKER_API_VERSION ? `/${DOCKER_API_VERSION}${requestPath}` : requestPath;

    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const transport = this.endpoint.protocol === "https:" ? https : http;
      const req = transport.request({
        method,
        socketPath: this.endpoint.socketPath,
        hostname: this.endpoint.hostname,
        port: this.endpoint.port,
        path: finalPath,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      }, (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 500;
          if (!okStatuses.includes(status)) {
            const message = extractDockerErrorMessage(text) || `Docker API ${method} ${requestPath} failed with ${status}`;
            reject(new Error(message));
            return;
          }
          resolve({ status, body: text });
        });
      });
      req.on("error", reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}

type DockerEndpoint = {
  protocol: "http:" | "https:";
  socketPath?: string;
  hostname?: string;
  port?: number;
};

function resolveDockerApiVersion(): string | null {
  const configured = process.env.DOCKER_API_VERSION?.trim();
  if (!configured) {
    return null;
  }
  return configured.startsWith("v") ? configured : `v${configured}`;
}

function extractDockerBindTarget(bind: string): string | null {
  for (const part of bind.split(":").reverse()) {
    const trimmed = part.trim();
    if (trimmed.startsWith("/")) {
      return trimmed;
    }
  }
  return null;
}

function buildDockerBinds(config: PluginConfig): string[] {
  const binds = [...config.workerProvisioningDockerMounts];
  if (!binds.some((bind) => extractDockerBindTarget(bind) === DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR)) {
    const _pd = resolveCurrentTeamClawPluginRootDir();
    if (_pd) binds.unshift(`${_pd}:${DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR}:ro`);
  }
  if (config.workerProvisioningDockerWorkspaceVolume && config.workerProvisioningWorkspaceRoot) {
    binds.unshift(`${config.workerProvisioningDockerWorkspaceVolume}:${config.workerProvisioningWorkspaceRoot}`);
  }
  return [...new Set(binds)];
}

function resolveDockerEndpoint(): DockerEndpoint {
  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (!dockerHost) {
    return {
      protocol: "http:",
      socketPath: "/var/run/docker.sock",
    };
  }

  if (dockerHost.startsWith("unix://")) {
    return {
      protocol: "http:",
      socketPath: dockerHost.slice("unix://".length),
    };
  }

  const normalized = dockerHost.startsWith("tcp://")
    ? dockerHost.replace(/^tcp:\/\//, "http://")
    : dockerHost;
  const url = new URL(normalized);
  return {
    protocol: url.protocol === "https:" ? "https:" : "http:",
    hostname: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 2375),
  };
}

function extractDockerErrorMessage(body: string): string | null {
  if (!body.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : body;
  } catch {
    return body;
  }
}
