// W1 of issue #226 (worker-provisioning god-file split): the provisioner
// backend contract and the host-port policy shared by the facade and the
// backend modules, extracted VERBATIM from controller/worker-provisioning.ts.
// Pure types + pure functions: this module must never import a backend
// implementation or worker-provisioning.ts (dependency direction is one-way).
import type {
  PluginConfig,
  ProvisionedWorkerRecord,
  RoleId,
  WorkerProvisioningType,
} from "../../types.js";

export type LaunchSpec = {
  workerId: string;
  role: RoleId;
  launchToken: string;
  controllerUrl: string;
  workerPort: number;
  gatewayPort: number;
  publishedHostPort?: number;
  workspaceDir?: string;
  env: Record<string, string>;
  configJson: string;
  /** #rate-limit-999: provider rate-limit retry budget written into the
   * worker's settings.json by every backend (process writes the file; docker/
   * kubernetes embed it in the bootstrap script). */
  rateLimitMaxRetries: number;
};

export type LaunchResult = {
  instanceId?: string;
  instanceName?: string;
  runtimeHomeDir?: string;
};

export interface WorkerProvisionerBackend {
  readonly type: WorkerProvisioningType;
  launch(spec: LaunchSpec): Promise<LaunchResult>;
  terminate(record: ProvisionedWorkerRecord): Promise<void>;
  stop?(): Promise<void>;
}

export function requiresDedicatedHostPortsForProvisioner(
  provider: WorkerProvisioningType,
  config: PluginConfig,
): boolean {
  if (provider === "process") {
    return true;
  }
  return provider === "docker" && isDockerHostNetwork(config.workerProvisioningDockerNetwork);
}

export function isDockerHostNetwork(networkMode: string): boolean {
  return networkMode.trim().toLowerCase() === "host";
}
