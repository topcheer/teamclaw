import type { PluginConfig, TeamState } from "../types.js";

export function hasOnDemandWorkerProvisioning(
  config: Pick<PluginConfig, "workerProvisioningType">,
): boolean {
  return config.workerProvisioningType !== "none";
}

export function shouldBlockControllerWithoutWorkers(
  config: Pick<PluginConfig, "workerProvisioningType">,
  state: TeamState | null,
): boolean {
  return !!state && Object.keys(state.workers).length === 0 && !hasOnDemandWorkerProvisioning(config);
}

export function buildControllerNoWorkersMessage(): string {
  return [
    "No TeamClaw workers are registered and on-demand provisioning is disabled.",
    "You may analyze the requirement and identify the roles that would be needed,",
    "but do not create TeamClaw tasks and do not do the worker-role work yourself.",
    "Ask the human to bring workers online or enable process/docker/kubernetes provisioning first.",
  ].join(" ");
}
