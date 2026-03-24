import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import JSON5 from "json5";
import type { PluginLogger } from "../../api.js";
import { generateId } from "../protocol.js";
import {
  resolveDefaultOpenClawConfigPath,
  resolveDefaultTeamClawRuntimeRootDir,
} from "../openclaw-workspace.js";
import { ROLES } from "../roles.js";
import type {
  PluginConfig,
  ProvisionedWorkerRecord,
  ProvisionedWorkerStatus,
  RoleId,
  TaskInfo,
  TeamProvisioningState,
  TeamState,
  WorkerProvisioningType,
  WorkerStatus,
} from "../types.js";

const DEFAULT_CONTAINER_WORKER_PORT = 9527;
const DEFAULT_CONTAINER_GATEWAY_PORT = 18789;
const PROVISIONING_RECORD_RETENTION_MS = 6 * 60 * 60 * 1000;
const PROVISIONING_FAILURE_COOLDOWN_MS = 30_000;
const PROCESS_TERMINATION_TIMEOUT_MS = 10_000;
const DOCKER_API_VERSION = "v1.41";

export type WorkerProvisioningManagerDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
};

type LaunchSpec = {
  workerId: string;
  role: RoleId;
  launchToken: string;
  controllerUrl: string;
  workerPort: number;
  gatewayPort: number;
  workspaceDir?: string;
  env: Record<string, string>;
  configJson: string;
};

type LaunchResult = {
  instanceId?: string;
  instanceName?: string;
  runtimeHomeDir?: string;
};

interface WorkerProvisionerBackend {
  readonly type: WorkerProvisioningType;
  launch(spec: LaunchSpec): Promise<LaunchResult>;
  terminate(record: ProvisionedWorkerRecord): Promise<void>;
  stop?(): Promise<void>;
}

export class WorkerProvisioningManager {
  private readonly deps: WorkerProvisioningManagerDeps;
  private readonly backend: WorkerProvisionerBackend | null;
  private baseConfigPromise: Promise<Record<string, unknown>> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private reconcileQueued = false;
  private stopped = false;

  constructor(deps: WorkerProvisioningManagerDeps) {
    this.deps = deps;
    this.backend = createProvisionerBackend(deps.config, deps.logger);
  }

  isEnabled(): boolean {
    return this.backend !== null;
  }

  hasManagedWorker(workerId: string): boolean {
    return Boolean(this.deps.getTeamState()?.provisioning?.workers?.[workerId]);
  }

  syncState(state: TeamState): boolean {
    if (!this.backend) {
      return false;
    }
    return this.refreshProvisioningState(state, Date.now());
  }

  validateRegistration(
    workerId: string,
    role: RoleId,
    launchToken: string | undefined,
  ): { ok: boolean; managed: boolean; reason?: string } {
    const record = this.deps.getTeamState()?.provisioning?.workers?.[workerId];
    if (!record) {
      return { ok: true, managed: false };
    }

    if (record.role !== role) {
      return {
        ok: false,
        managed: true,
        reason: `Provisioned worker ${workerId} expected role ${record.role}, got ${role}`,
      };
    }
    if (!launchToken || launchToken !== record.launchToken) {
      return {
        ok: false,
        managed: true,
        reason: `Provisioned worker ${workerId} is missing a valid launch token`,
      };
    }
    if (record.status === "failed" || record.status === "terminated" || record.status === "terminating") {
      return {
        ok: false,
        managed: true,
        reason: `Provisioned worker ${workerId} is no longer allowed to register (${record.status})`,
      };
    }

    return { ok: true, managed: true };
  }

  onWorkerRegistered(workerId: string): void {
    if (!this.backend) {
      return;
    }
    this.deps.updateTeamState((state) => {
      const record = ensureProvisioningState(state).workers[workerId];
      if (!record) {
        return;
      }
      const now = Date.now();
      record.status = "registered";
      record.registeredAt = record.registeredAt ?? now;
      record.updatedAt = now;
      record.idleSince = now;
      delete record.lastError;
    });
  }

  onWorkerHeartbeat(workerId: string, status: WorkerStatus): void {
    if (!this.backend) {
      return;
    }
    this.deps.updateTeamState((state) => {
      const record = ensureProvisioningState(state).workers[workerId];
      if (!record) {
        return;
      }
      const now = Date.now();
      if (record.status === "launching") {
        record.status = "registered";
        record.registeredAt = record.registeredAt ?? now;
      }
      record.updatedAt = now;
      if (status === "idle") {
        record.idleSince = record.idleSince ?? now;
      } else {
        delete record.idleSince;
      }
    });
  }

  async onWorkerRemoved(workerId: string, reason: string): Promise<void> {
    if (!this.backend) {
      return;
    }
    const record = this.deps.getTeamState()?.provisioning?.workers?.[workerId];
    if (!record || record.status === "terminated" || record.status === "failed") {
      return;
    }

    this.deps.logger.info(`Provisioner: terminating managed worker ${workerId} (${reason})`);
    await this.terminateManagedWorker(workerId, reason, "terminated");
  }

  async requestReconcile(reason: string): Promise<void> {
    if (!this.backend || this.stopped) {
      return;
    }

    if (this.reconcilePromise) {
      this.reconcileQueued = true;
      return this.reconcilePromise;
    }

    this.reconcilePromise = this.runReconcileLoop(reason)
      .catch((err) => {
        this.deps.logger.warn(
          `Provisioner: reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.reconcilePromise = null;
      });

    return this.reconcilePromise;
  }

  async stop(): Promise<void> {
    if (!this.backend) {
      return;
    }

    this.stopped = true;

    const state = this.deps.getTeamState();
    const managedWorkerIds = state?.provisioning
      ? Object.entries(state.provisioning.workers)
          .filter(([, record]) => record.provider === this.backend?.type && record.status !== "terminated")
          .map(([workerId]) => workerId)
      : [];

    for (const workerId of managedWorkerIds) {
      try {
        await this.terminateManagedWorker(workerId, "controller shutdown", "terminated");
      } catch (err) {
        this.deps.logger.warn(
          `Provisioner: failed to stop worker ${workerId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.backend.stop?.();
  }

  private async runReconcileLoop(initialReason: string): Promise<void> {
    let reason = initialReason;
    do {
      this.reconcileQueued = false;
      await this.reconcileOnce(reason);
      reason = "queued reconcile";
    } while (this.reconcileQueued && !this.stopped);
  }

  private async reconcileOnce(reason: string): Promise<void> {
    if (!this.backend) {
      return;
    }

    const now = Date.now();
    this.deps.updateTeamState((state) => {
      this.refreshProvisioningState(state, now);
    });

    await this.expireStalledLaunches(now);

    const state = this.deps.getTeamState();
    if (!state) {
      return;
    }

    const roles = this.getProvisionableRoles(state);
    for (const role of roles) {
      const demand = this.computeRoleDemand(state, role);
      if (demand > 0) {
        if (
          this.deps.config.workerProvisioningRoles.length > 0 &&
          !this.deps.config.workerProvisioningRoles.includes(role)
        ) {
          this.deps.logger.info(
            `Provisioner: allowing role ${role} because pending task demand exists outside configured workerProvisioningRoles`,
          );
        }
        this.deps.logger.info(`Provisioner: role ${role} needs ${demand} additional worker(s) (${reason})`);
      }
      for (let i = 0; i < demand; i += 1) {
        if (this.hasRecentProvisioningFailure(role)) {
          this.deps.logger.warn(`Provisioner: recent ${role} launch failure detected; cooling down`);
          break;
        }
        await this.launchWorker(role);
      }
    }

    await this.scaleDownIdleWorkers(now);
  }

  private async expireStalledLaunches(now: number): Promise<void> {
    const state = this.deps.getTeamState();
    if (!state?.provisioning) {
      return;
    }

    const timedOut = Object.values(state.provisioning.workers)
      .filter((record) => record.status === "launching")
      .filter((record) => now - record.requestedAt > this.deps.config.workerProvisioningStartupTimeoutMs);

    for (const record of timedOut) {
      await this.terminateManagedWorker(
        record.workerId,
        `startup timeout exceeded (${this.deps.config.workerProvisioningStartupTimeoutMs}ms)`,
        "failed",
      );
    }
  }

  private async scaleDownIdleWorkers(now: number): Promise<void> {
    const state = this.deps.getTeamState();
    if (!state?.provisioning) {
      return;
    }

    const roles = this.getProvisionableRoles(state);
    for (const role of roles) {
      const activeWorkers = Object.values(state.workers).filter(
        (worker) => worker.role === role && worker.status !== "offline",
      );
      const pendingDemand = this.countPendingTasksForRole(state, role);
      if (pendingDemand > 0) {
        continue;
      }

      let remainingActive = activeWorkers.length;
      const managedIdleWorkers = activeWorkers
        .filter((worker) => worker.status === "idle")
        .map((worker) => ({
          worker,
          record: state.provisioning?.workers[worker.id],
        }))
        .filter((entry): entry is { worker: typeof activeWorkers[number]; record: ProvisionedWorkerRecord } => Boolean(entry.record))
        .filter(({ record }) => record.status === "registered")
        .sort((a, b) => (a.record.idleSince ?? Number.MAX_SAFE_INTEGER) - (b.record.idleSince ?? Number.MAX_SAFE_INTEGER));

      for (const entry of managedIdleWorkers) {
        if (remainingActive <= this.deps.config.workerProvisioningMinPerRole) {
          break;
        }
        if (!entry.record.idleSince || now - entry.record.idleSince < this.deps.config.workerProvisioningIdleTtlMs) {
          continue;
        }
        await this.terminateManagedWorker(entry.worker.id, "idle TTL exceeded", "terminated");
        remainingActive -= 1;
      }
    }
  }

  private hasRecentProvisioningFailure(role: RoleId): boolean {
    const now = Date.now();
    const records = this.deps.getTeamState()?.provisioning?.workers ?? {};
    return Object.values(records).some((record) =>
      record.role === role &&
      record.status === "failed" &&
      now - record.updatedAt < PROVISIONING_FAILURE_COOLDOWN_MS
    );
  }

  private async launchWorker(role: RoleId): Promise<void> {
    if (!this.backend) {
      return;
    }

    const workerId = `provisioned-${role}-${generateId()}`;
    const launchToken = `${generateId()}-${generateId()}`;
    const controllerUrl = this.resolveControllerUrl();
    const workerPort = this.backend.type === "process"
      ? await reserveEphemeralPort()
      : DEFAULT_CONTAINER_WORKER_PORT;
    const gatewayPort = this.backend.type === "process"
      ? await reserveEphemeralPort()
      : DEFAULT_CONTAINER_GATEWAY_PORT;
    const now = Date.now();

    this.deps.updateTeamState((state) => {
      ensureProvisioningState(state).workers[workerId] = {
        workerId,
        role,
        provider: this.backend!.type,
        status: "launching",
        launchToken,
        requestedAt: now,
        updatedAt: now,
      };
    });

    try {
      const baseConfig = await this.loadBaseOpenClawConfig();
      const workerConfig = buildProvisionedWorkerConfig(baseConfig, this.deps.config, {
        role,
        controllerUrl,
        workerPort,
        gatewayPort,
        workspaceDir: buildProvisionedWorkspaceDir(this.backend.type, this.deps.config, role, workerId),
      });
      const launchResult = await this.backend.launch({
        workerId,
        role,
        launchToken,
        controllerUrl,
        workerPort,
        gatewayPort,
        workspaceDir: getConfiguredWorkerWorkspaceDir(workerConfig),
        env: this.buildForwardedEnv(),
        configJson: `${JSON.stringify(workerConfig, null, 2)}\n`,
      });

      this.deps.updateTeamState((state) => {
        const record = ensureProvisioningState(state).workers[workerId];
        if (!record) {
          return;
        }
        record.instanceId = launchResult.instanceId ?? record.instanceId;
        record.instanceName = launchResult.instanceName ?? record.instanceName;
        record.runtimeHomeDir = launchResult.runtimeHomeDir ?? record.runtimeHomeDir;
        record.updatedAt = Date.now();
      });

      this.deps.logger.info(`Provisioner: launched ${role} worker ${workerId} via ${this.backend.type}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.updateTeamState((state) => {
        const record = ensureProvisioningState(state).workers[workerId];
        if (!record) {
          return;
        }
        record.status = "failed";
        record.updatedAt = Date.now();
        record.lastError = message;
      });
      this.deps.logger.warn(`Provisioner: failed to launch ${role} worker ${workerId}: ${message}`);
    }
  }

  private async terminateManagedWorker(
    workerId: string,
    reason: string,
    terminalStatus: Extract<ProvisionedWorkerStatus, "failed" | "terminated">,
  ): Promise<void> {
    if (!this.backend) {
      return;
    }

    const state = this.deps.getTeamState();
    const record = state?.provisioning?.workers?.[workerId];
    if (!record) {
      return;
    }

    this.deps.updateTeamState((draft) => {
      const current = ensureProvisioningState(draft).workers[workerId];
      if (!current) {
        return;
      }
      current.status = "terminating";
      current.updatedAt = Date.now();
      if (draft.workers[workerId]) {
        draft.workers[workerId].status = "offline";
        draft.workers[workerId].currentTaskId = undefined;
      }
    });

    try {
      await this.backend.terminate(record);
    } catch (err) {
      this.deps.logger.warn(
        `Provisioner: backend terminate failed for ${workerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.deps.updateTeamState((draft) => {
      const current = ensureProvisioningState(draft).workers[workerId];
      if (!current) {
        return;
      }
      current.status = terminalStatus;
      current.updatedAt = Date.now();
      delete current.idleSince;
      if (terminalStatus === "failed") {
        current.lastError = reason;
      } else {
        delete current.lastError;
      }
    });
  }

  private getProvisionableRoles(state: TeamState | null): RoleId[] {
    const roleIds = new Set<RoleId>(
      this.deps.config.workerProvisioningRoles.length > 0
        ? this.deps.config.workerProvisioningRoles
        : ROLES.map((role) => role.id),
    );

    if (!state) {
      return [...roleIds];
    }

    for (const task of Object.values(state.tasks)) {
      if (task.status !== "pending" && task.status !== "assigned") {
        continue;
      }
      const taskRole = this.inferTaskRole(task);
      if (taskRole) {
        roleIds.add(taskRole);
      }
    }

    for (const worker of Object.values(state.workers)) {
      roleIds.add(worker.role);
    }
    for (const record of Object.values(state.provisioning?.workers ?? {})) {
      roleIds.add(record.role);
    }

    return [...roleIds];
  }

  private countPendingTasksForRole(state: TeamState, role: RoleId): number {
    return Object.values(state.tasks).filter((task) => this.doesTaskNeedRole(task, state, role)).length;
  }

  private doesTaskNeedRole(task: TaskInfo, state: TeamState, role: RoleId): boolean {
    if (task.status !== "pending" && task.status !== "assigned") {
      return false;
    }
    if (task.assignedWorkerId) {
      const assignedWorker = state.workers[task.assignedWorkerId];
      if (assignedWorker && assignedWorker.status !== "offline") {
        return false;
      }
    }
    if (task.assignedRole) {
      return task.assignedRole === role;
    }
    return this.inferTaskRole(task) === role;
  }

  private inferTaskRole(task: TaskInfo): RoleId | null {
    if (task.assignedRole) {
      return task.assignedRole;
    }

    const text = `${task.title} ${task.description}`.toLowerCase();
    let bestRole: RoleId | null = null;
    let bestScore = 0;

    for (const role of ROLES) {
      const roleTokens = [
        role.id,
        role.label,
        ...role.capabilities,
      ].flatMap((entry) => entry.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
      const uniqueTokens = [...new Set(roleTokens)];
      const score = uniqueTokens.reduce((count, token) => count + (text.includes(token) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestRole = role.id;
      }
    }

    return bestScore > 0 ? bestRole : null;
  }

  private computeRoleDemand(state: TeamState, role: RoleId): number {
    const pendingDemand = this.countPendingTasksForRole(state, role);
    const activeWorkers = Object.values(state.workers).filter(
      (worker) => worker.role === role && worker.status !== "offline",
    );
    const idleWorkers = activeWorkers.filter((worker) => worker.status === "idle").length;
    const launchingWorkers = Object.values(state.provisioning?.workers ?? {}).filter(
      (record) => record.role === role && record.status === "launching",
    ).length;

    const warmShortfall = Math.max(
      0,
      this.deps.config.workerProvisioningMinPerRole - (activeWorkers.length + launchingWorkers),
    );
    const queueDrivenNeed = Math.max(0, pendingDemand - idleWorkers - launchingWorkers);
    const cap = Math.max(
      0,
      this.deps.config.workerProvisioningMaxPerRole - activeWorkers.length - launchingWorkers,
    );

    return Math.min(cap, Math.max(warmShortfall, queueDrivenNeed));
  }

  private resolveControllerUrl(): string {
    if (this.deps.config.workerProvisioningControllerUrl) {
      return this.deps.config.workerProvisioningControllerUrl;
    }
    if (this.backend?.type === "process") {
      return `http://127.0.0.1:${this.deps.config.port}`;
    }
    throw new Error(
      `workerProvisioningControllerUrl is required when workerProvisioningType=${this.backend?.type}`,
    );
  }

  private buildForwardedEnv(): Record<string, string> {
    const env: Record<string, string> = {
      ...this.deps.config.workerProvisioningExtraEnv,
    };
    for (const name of this.deps.config.workerProvisioningPassEnv) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0) {
        env[name] = value;
      }
    }
    return env;
  }

  private async loadBaseOpenClawConfig(): Promise<Record<string, unknown>> {
    if (!this.baseConfigPromise) {
      this.baseConfigPromise = loadOpenClawConfig(resolveDefaultOpenClawConfigPath());
    }
    return cloneJson(await this.baseConfigPromise);
  }

  private refreshProvisioningState(state: TeamState, now: number): boolean {
    let changed = !state.provisioning || typeof state.provisioning !== "object";
    const provisioning = ensureProvisioningState(state);

    for (const [workerId, record] of Object.entries(provisioning.workers)) {
      const worker = state.workers[workerId];
      if (worker && worker.status !== "offline") {
        if (record.status === "launching") {
          record.status = "registered";
          record.registeredAt = record.registeredAt ?? worker.registeredAt ?? now;
          changed = true;
        }
        if (record.status === "registered") {
          if (worker.status === "idle") {
            if (!record.idleSince) {
              record.idleSince = now;
              changed = true;
            }
          } else if (record.idleSince) {
            delete record.idleSince;
            changed = true;
          }
          if (record.updatedAt < worker.lastHeartbeat) {
            record.updatedAt = worker.lastHeartbeat;
            changed = true;
          }
        }
      }

      if ((record.status === "failed" || record.status === "terminated") &&
          now - record.updatedAt > PROVISIONING_RECORD_RETENTION_MS) {
        delete provisioning.workers[workerId];
        changed = true;
      }
    }

    return changed;
  }
}

class ProcessProvisioner implements WorkerProvisionerBackend {
  readonly type = "process" as const;
  private readonly logger: PluginLogger;
  private readonly processByWorkerId = new Map<string, ChildProcess>();
  private readonly baseDirPromise: Promise<string>;

  constructor(logger: PluginLogger) {
    this.logger = logger;
    const provisionedRoot = path.join(resolveDefaultTeamClawRuntimeRootDir(), "provisioned-workers");
    this.baseDirPromise = fs.mkdir(provisionedRoot, { recursive: true })
      .then(() => fs.mkdtemp(path.join(provisionedRoot, "session-")));
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    const baseDir = await this.baseDirPromise;
    const runtimeHomeDir = await fs.mkdtemp(path.join(baseDir, `${sanitizePathSegment(spec.role)}-`));
    const stateDir = path.join(runtimeHomeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, spec.configJson, "utf8");

    const gatewayEntrypoint = resolveGatewayEntrypoint();
    const child = spawn(process.execPath, [
      gatewayEntrypoint,
      "gateway",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(spec.gatewayPort),
    ], {
      cwd: path.dirname(gatewayEntrypoint),
      env: {
        ...process.env,
        ...spec.env,
        HOME: runtimeHomeDir,
        OPENCLAW_HOME: runtimeHomeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        TEAMCLAW_WORKER_ID: spec.workerId,
        TEAMCLAW_LAUNCH_TOKEN: spec.launchToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.processByWorkerId.set(spec.workerId, child);
    attachChildLogs(child, this.logger, `ProvisionedWorker[${spec.role}]`);
    child.on("exit", (code: number | null, signal: string | null) => {
      this.processByWorkerId.delete(spec.workerId);
      this.logger.info(
        `Provisioner: process worker ${spec.workerId} exited (code=${String(code)}, signal=${String(signal)})`,
      );
    });

    return {
      instanceId: child.pid ? `pid:${child.pid}` : undefined,
      instanceName: spec.workerId,
      runtimeHomeDir,
    };
  }

  async terminate(record: ProvisionedWorkerRecord): Promise<void> {
    const child = this.processByWorkerId.get(record.workerId);
    if (child) {
      await stopChildProcess(child);
      this.processByWorkerId.delete(record.workerId);
    } else if (record.instanceId?.startsWith("pid:")) {
      const pid = Number(record.instanceId.slice("pid:".length));
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // ignore
        }
      }
    }

    if (record.runtimeHomeDir) {
      await fs.rm(record.runtimeHomeDir, { recursive: true, force: true }).catch(() => {
        // ignore
      });
    }
  }

  async stop(): Promise<void> {
    for (const child of this.processByWorkerId.values()) {
      await stopChildProcess(child).catch(() => {
        // ignore
      });
    }
    this.processByWorkerId.clear();
  }
}

class DockerProvisioner implements WorkerProvisionerBackend {
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

    const script = buildContainerBootstrapScript();
    const response = await this.client.requestJson<{ Id?: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(instanceName)}`,
      {
        Image: this.config.workerProvisioningImage,
        Cmd: ["sh", "-lc", script],
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Labels: {
          "teamclaw.managed": "true",
          "teamclaw.team": this.config.teamName,
          "teamclaw.role": spec.role,
          "teamclaw.worker_id": spec.workerId,
        },
        HostConfig: {
          Binds: buildDockerBinds(this.config),
          NetworkMode: this.config.workerProvisioningDockerNetwork || undefined,
        },
      },
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

class KubernetesProvisioner implements WorkerProvisionerBackend {
  readonly type = "kubernetes" as const;
  private readonly config: PluginConfig;
  private readonly logger: PluginLogger;

  constructor(config: PluginConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    if (!this.config.workerProvisioningImage) {
      throw new Error("workerProvisioningImage is required for kubernetes provisioning");
    }

    const instanceName = buildManagedInstanceName(this.config.teamName, spec.role, spec.workerId);
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

    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: instanceName,
        namespace: this.config.workerProvisioningKubernetesNamespace,
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
            args: [buildContainerBootstrapScript()],
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

    await runCommand(
      "kubectl",
      [
        ...buildKubectlContextArgs(this.config.workerProvisioningKubernetesContext),
        "apply",
        "-f",
        "-",
      ],
      JSON.stringify(manifest),
    );
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

    await runCommand("kubectl", [
      ...buildKubectlContextArgs(this.config.workerProvisioningKubernetesContext),
      "-n",
      this.config.workerProvisioningKubernetesNamespace,
      "delete",
      "pod",
      podName,
      "--ignore-not-found=true",
      "--grace-period=0",
      "--force",
    ]);
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
    const finalPath = `/${DOCKER_API_VERSION}${requestPath}`;

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

function createProvisionerBackend(
  config: PluginConfig,
  logger: PluginLogger,
): WorkerProvisionerBackend | null {
  switch (config.workerProvisioningType) {
    case "process":
      return new ProcessProvisioner(logger);
    case "docker":
      return new DockerProvisioner(config, logger);
    case "kubernetes":
      return new KubernetesProvisioner(config, logger);
    case "none":
    default:
      return null;
  }
}

function buildProvisionedWorkerConfig(
  baseConfig: Record<string, unknown>,
  controllerConfig: PluginConfig,
  spec: {
    role: RoleId;
    controllerUrl: string;
    workerPort: number;
    gatewayPort: number;
    workspaceDir?: string;
  },
): Record<string, unknown> {
  const config = cloneJson(baseConfig);
  const agents = ensureRecord(config.agents);
  const agentDefaults = ensureRecord(agents.defaults);
  delete agentDefaults.repoRoot;
  if (spec.workspaceDir) {
    agentDefaults.workspace = spec.workspaceDir;
  } else {
    delete agentDefaults.workspace;
  }
  agents.defaults = agentDefaults;
  config.agents = agents;

  const gateway = ensureRecord(config.gateway);
  gateway.mode = "local";
  gateway.bind = "loopback";
  gateway.port = spec.gatewayPort;
  config.gateway = gateway;

  const plugins = ensureRecord(config.plugins);
  plugins.enabled = true;
  const entries = ensureRecord(plugins.entries);
  const teamclawEntry = ensureRecord(entries.teamclaw);
  teamclawEntry.enabled = true;
  const teamclawConfig = ensureRecord(teamclawEntry.config);
  teamclawConfig.mode = "worker";
  teamclawConfig.role = spec.role;
  teamclawConfig.port = spec.workerPort;
  teamclawConfig.controllerUrl = spec.controllerUrl;
  teamclawConfig.teamName = controllerConfig.teamName;
  teamclawConfig.heartbeatIntervalMs = controllerConfig.heartbeatIntervalMs;
  teamclawConfig.taskTimeoutMs = controllerConfig.taskTimeoutMs;
  teamclawConfig.gitEnabled = controllerConfig.gitEnabled;
  teamclawConfig.gitRemoteUrl = controllerConfig.gitRemoteUrl;
  teamclawConfig.gitDefaultBranch = controllerConfig.gitDefaultBranch;
  teamclawConfig.gitAuthorName = controllerConfig.gitAuthorName;
  teamclawConfig.gitAuthorEmail = controllerConfig.gitAuthorEmail;
  teamclawConfig.localRoles = [];
  teamclawConfig.workerProvisioningType = "none";
  teamclawConfig.workerProvisioningControllerUrl = "";
  teamclawConfig.workerProvisioningRoles = [];
  teamclawConfig.workerProvisioningMinPerRole = 0;
  teamclawConfig.workerProvisioningMaxPerRole = 1;
  teamclawConfig.workerProvisioningIdleTtlMs = controllerConfig.workerProvisioningIdleTtlMs;
  teamclawConfig.workerProvisioningStartupTimeoutMs = controllerConfig.workerProvisioningStartupTimeoutMs;
  teamclawConfig.workerProvisioningImage = "";
  teamclawConfig.workerProvisioningPassEnv = [];
  teamclawConfig.workerProvisioningExtraEnv = {};
  teamclawConfig.workerProvisioningDockerNetwork = "";
  teamclawConfig.workerProvisioningDockerMounts = [];
  teamclawConfig.workerProvisioningWorkspaceRoot = "";
  teamclawConfig.workerProvisioningDockerWorkspaceVolume = "";
  teamclawConfig.workerProvisioningKubernetesNamespace = "default";
  teamclawConfig.workerProvisioningKubernetesContext = "";
  teamclawConfig.workerProvisioningKubernetesServiceAccount = "";
  teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim = "";
  teamclawConfig.workerProvisioningKubernetesLabels = {};
  teamclawConfig.workerProvisioningKubernetesAnnotations = {};
  teamclawEntry.config = teamclawConfig;
  entries.teamclaw = teamclawEntry;
  plugins.entries = entries;
  config.plugins = plugins;

  return config;
}

function ensureProvisioningState(state: TeamState): TeamProvisioningState {
  if (!state.provisioning || typeof state.provisioning !== "object") {
    state.provisioning = { workers: {} };
  }
  if (!state.provisioning.workers || typeof state.provisioning.workers !== "object") {
    state.provisioning.workers = {};
  }
  return state.provisioning;
}

async function loadOpenClawConfig(configPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configPath, "utf8");
  return parseLooseJsonObject(raw, configPath);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function parseLooseJsonObject(raw: string, configPath: string): Record<string, unknown> {
  try {
    return JSON5.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse OpenClaw config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function reserveEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((err: Error | undefined | null) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error("Failed to reserve ephemeral port"));
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function resolveGatewayEntrypoint(): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Unable to resolve OpenClaw gateway entrypoint");
  }
  return path.resolve(scriptPath);
}

function attachChildLogs(child: ChildProcess, logger: PluginLogger, prefix: string): void {
  if (child.stdout) {
    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      logger.info(`${prefix}: ${line}`);
    });
  }
  if (child.stderr) {
    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line: string) => {
      logger.warn(`${prefix}: ${line}`);
    });
  }
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      resolve();
    }, PROCESS_TERMINATION_TIMEOUT_MS);
    const timer = timeout as unknown as { unref?: () => void };
    timer.unref?.();

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

function sanitizePathSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "worker";
}

function sanitizeName(value: string, maxLength = 63): string {
  const normalized = sanitizePathSegment(value).slice(0, maxLength).replace(/^-+|-+$/g, "");
  return normalized || "teamclaw";
}

function buildManagedInstanceName(teamName: string, role: RoleId, workerId: string): string {
  return buildManagedName("teamclaw", teamName, role, workerId, {
    teamBudget: 18,
    roleBudget: 12,
    workerBudget: 12,
    hashLength: 8,
    maxLength: 63,
  });
}

function buildManagedHostname(teamName: string, role: RoleId, workerId: string): string {
  return buildManagedName("tc", teamName, role, workerId, {
    teamBudget: 10,
    roleBudget: 8,
    workerBudget: 6,
    hashLength: 6,
    maxLength: 40,
  });
}

function buildManagedName(
  prefix: string,
  teamName: string,
  role: RoleId,
  workerId: string,
  options: {
    teamBudget: number;
    roleBudget: number;
    workerBudget: number;
    hashLength: number;
    maxLength: number;
  },
): string {
  const teamPart = sanitizeLeadingSegment(teamName, options.teamBudget, "team");
  const rolePart = sanitizeLeadingSegment(role, options.roleBudget, "worker");
  const workerPart = sanitizeTrailingSegment(workerId, options.workerBudget, "worker");
  const hash = shortStableHash(`${teamName}:${role}:${workerId}`).slice(0, options.hashLength);
  return sanitizeName(`${prefix}-${teamPart}-${rolePart}-${workerPart}-${hash}`, options.maxLength);
}

function shortStableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sanitizeLeadingSegment(value: string, maxLength: number, fallback: string): string {
  const normalized = sanitizePathSegment(value).slice(0, maxLength).replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function sanitizeTrailingSegment(value: string, maxLength: number, fallback: string): string {
  const normalized = sanitizePathSegment(value).slice(-maxLength).replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function buildContainerBootstrapScript(): string {
  return [
    "set -eu",
    "mkdir -p \"$OPENCLAW_STATE_DIR\"",
    "if [ -n \"${TEAMCLAW_WORKSPACE_DIR:-}\" ]; then mkdir -p \"$TEAMCLAW_WORKSPACE_DIR\"; fi",
    "node -e 'const fs=require(\"fs\"); const configPath=process.env.OPENCLAW_CONFIG_PATH; const raw=Buffer.from(process.env.TEAMCLAW_BOOTSTRAP_CONFIG_B64||\"\", \"base64\").toString(\"utf8\"); fs.mkdirSync(require(\"path\").dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, raw);'",
    "exec node dist/index.js gateway --allow-unconfigured",
  ].join("\n");
}

function buildDockerBinds(config: PluginConfig): string[] {
  const binds = [...config.workerProvisioningDockerMounts];
  if (config.workerProvisioningDockerWorkspaceVolume && config.workerProvisioningWorkspaceRoot) {
    binds.unshift(`${config.workerProvisioningDockerWorkspaceVolume}:${config.workerProvisioningWorkspaceRoot}`);
  }
  return [...new Set(binds)];
}

function buildProvisionedWorkspaceDir(
  provider: WorkerProvisioningType,
  config: PluginConfig,
  role: RoleId,
  workerId: string,
): string {
  if (
    (provider !== "docker" && provider !== "kubernetes") ||
    !config.workerProvisioningWorkspaceRoot
  ) {
    return "";
  }

  return path.posix.join(
    config.workerProvisioningWorkspaceRoot,
    sanitizePathSegment(config.teamName),
    sanitizePathSegment(role),
    sanitizePathSegment(workerId),
  );
}

function getConfiguredWorkerWorkspaceDir(config: Record<string, unknown>): string {
  const agents = ensureRecord(config.agents);
  const defaults = ensureRecord(agents.defaults);
  return typeof defaults.workspace === "string" ? defaults.workspace : "";
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

    child.stdout?.on("data", (chunk: Uint8Array | string) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Uint8Array | string) => {
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
