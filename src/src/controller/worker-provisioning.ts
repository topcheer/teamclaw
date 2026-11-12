// W1 of issue #226 (worker-provisioning god-file split): this module is now
// the provisioner facade. WorkerProvisioningManager keeps the reconcile
// loop, role-demand computation, startup-readiness tracking and the
// launch/terminate orchestration; everything it delegates to moved VERBATIM
// (zero behavior change) into:
//   - provisioning-config.ts            worker config synthesis, controller
//                                       auth-profile copy, no-proxy env
//   - provisioning/backend-contract.ts  backend interface + host-port policy
//   - provisioning/plugin-root.ts       TeamClaw plugin root resolution
//   - provisioning/process-supervisor.ts  local process backend
//   - provisioning/docker.ts / kubernetes.ts  container backends + API clients
//   - provisioning/container-shared.ts  managed names + bootstrap script
//   - shared/utils.ts                   generic utils (pathExists/sleep/...)
// Dependency direction: this facade imports the modules above; none of them
// imports this file (no cycles). The external face is unchanged -
// WorkerProvisioningManager plus the buildProvisionedWorkerConfig re-export
// below keep their historical module path and signatures.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { PluginLogger } from "../../api.js";
import { generateId, generateLaunchToken, secretsEqual } from "../protocol.js";
// Issue #255 P0-1: the launch-token check at registration uses the shared
// constant-time secret equality (same helper the device gate and tunnel gate
// use). controller -> controller edge; security.ts never imports back here,
// so the module graph stays acyclic.
import {
  resolveDefaultOpenClawConfigPath,
  resolveDefaultTeamClawRuntimeRootDir,
  resolveTeamClawAgentDir,
  resolveTeamClawAgentWorkspaceRootDir,
  resolveTeamClawWorkspaceDir,
} from "../openclaw-workspace.js";
// Phase 1.3: the role universe and the fallback role come from the active
// TeamProfile loader (software-rd baseline).
import { getActiveRoleIds, getActiveDefaultRole } from "../profile-loader.js";
import { inferTaskRole } from "./role-inference.js";
import type {
  PluginConfig,
  ProvisionedWorkerRecord,
  ProvisionedWorkerStatus,
  RoleId,
  StartupProvisioningReadiness,
  TaskInfo,
  TeamProvisioningState,
  TeamState,
  WorkerStatus,
} from "../types.js";
import { cloneJson, sleep } from "../shared/utils.js";
import {
  appendNoProxyEntries,
  buildProvisionedWorkspaceDir,
  buildProvisionedWorkerConfig,
  getConfiguredWorkerWorkspaceDir,
  loadOpenClawConfig,
} from "./provisioning-config.js";
import type { WorkerProvisionerBackend } from "./provisioning/backend-contract.js";
import { journalRecord } from "./journal.js";
import {
  isDockerHostNetwork,
  requiresDedicatedHostPortsForProvisioner,
} from "./provisioning/backend-contract.js";
import { ProcessProvisioner } from "./provisioning/process-supervisor.js";
import { DockerProvisioner } from "./provisioning/docker.js";
import { KubernetesProvisioner } from "./provisioning/kubernetes.js";

// Historical export face kept stable for tests / external tooling.
export { buildProvisionedWorkerConfig } from "./provisioning-config.js";


const DEFAULT_CONTAINER_WORKER_PORT = 9527;
const DEFAULT_CONTAINER_GATEWAY_PORT = 18789;

const PROVISIONING_RECORD_RETENTION_MS = 6 * 60 * 60 * 1000;
const PROVISIONING_FAILURE_COOLDOWN_MS = 30_000;
const PROCESS_TERMINATION_TIMEOUT_MS = 10_000;
const STARTUP_READINESS_POLL_INTERVAL_MS = 1_000;
const STARTUP_READINESS_RETRY_INTERVAL_MS = 5_000;

export type WorkerProvisioningManagerDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
  /** Actual HTTP port once the controller server has bound (may differ from config.port). */
  actualControllerPort?: number;
};

export class WorkerProvisioningManager {
  private deps: WorkerProvisioningManagerDeps;
  private readonly backend: WorkerProvisionerBackend | null;
  private baseConfigPromise: Promise<Record<string, unknown>> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private reconcileQueued = false;
  private stopped = false;
  // Phase 2.1 (design 2.3, switch step 2): while a team profile switch drains
  // and archives the old team, the periodic reconcile must not fight the
  // drain by launching replacement workers for the outgoing profile's
  // pending tasks. Suspended reconcile calls return immediately; it is
  // lifted before the new profile's warmup so normal operation resumes.
  private reconcileSuspended = false;

  constructor(deps: WorkerProvisioningManagerDeps) {
    this.deps = deps;
    this.backend = createProvisionerBackend(deps.config, deps.logger);
  }

  /** Update the actual controller port after the HTTP server binds. */
  setActualPort(port: number): void {
    this.deps = { ...this.deps, actualControllerPort: port };
  }

  isEnabled(): boolean {
    return this.backend !== null;
  }

  hasManagedWorker(workerId: string): boolean {
    return Boolean(this.deps.getTeamState()?.provisioning?.workers?.[workerId]);
  }

  /** Returns true when the worker was provisioned as a local process (shared filesystem). */
  isSharedWorkspaceWorker(workerId: string): boolean {
    const record = this.deps.getTeamState()?.provisioning?.workers?.[workerId];
    return Boolean(record && record.provider === "process");
  }

  syncState(state: TeamState): boolean {
    if (!this.backend) {
      return false;
    }
    return this.refreshProvisioningState(state, Date.now());
  }

  primeStartupReadiness(): void {
    if (!this.backend || this.stopped) {
      return;
    }
    const now = Date.now();
    const previousAttempts = this.deps.getTeamState()?.provisioning?.startupReadiness?.attempts ?? 0;
    this.updateStartupReadiness({
      status: "checking",
      startedAt: now,
      checkedAt: now,
      attempts: previousAttempts,
      requiredRoles: this.determineStartupReadinessRoles(),
      readyWorkerIds: [],
      message: "Controller started; waiting for startup provisioning warm-up.",
    });
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
    // Issue #255 P0-1: constant-time equality. Semantics unchanged (old
    // PRNG-era tokens in upgraded TeamStates still match their own value);
    // only the timing side channel of `!==` goes away.
    if (!launchToken || !secretsEqual(launchToken, record.launchToken)) {
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
    journalRecord("provisioner", "terminated", `${workerId} (${reason})`);
    await this.terminateManagedWorker(workerId, reason, "terminated");
  }

  /** Phase 2.1: suspend/resume the reconcile loop during a team profile switch. */
  setReconcileSuspended(suspended: boolean): void {
    this.reconcileSuspended = suspended;
  }

  async requestReconcile(reason: string): Promise<void> {
    if (!this.backend || this.stopped || this.reconcileSuspended) {
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

  async runStartupReadinessCheck(): Promise<void> {
    if (!this.backend || this.stopped) {
      return;
    }

    const requiredRoles = this.determineStartupReadinessRoles();
    const previousAttempts = this.deps.getTeamState()?.provisioning?.startupReadiness?.attempts ?? 0;
    const startedAt = Date.now();
    this.updateStartupReadiness({
      status: "checking",
      startedAt,
      checkedAt: startedAt,
      attempts: previousAttempts + 1,
      requiredRoles,
      readyWorkerIds: [],
      message: `Warming startup workers for ${requiredRoles.join(", ")}.`,
    });

    try {
      await this.ensureStartupProvisioningPrerequisites();
      await this.ensureWarmWorkersForRoles(requiredRoles, "startup readiness warmup");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStartupReadiness({
        status: "degraded",
        startedAt,
        checkedAt: Date.now(),
        attempts: previousAttempts + 1,
        requiredRoles,
        readyWorkerIds: [],
        message,
      });
      this.deps.logger.warn(`Provisioner: startup readiness prerequisites failed: ${message}`);
      return;
    }

    const deadline = Date.now() + this.deps.config.workerProvisioningStartupTimeoutMs;
    let lastRetryAt = 0;
    while (!this.stopped && Date.now() < deadline) {
      const readiness = this.collectRoleReadiness(requiredRoles);
      if (readiness.missingRoles.length === 0) {
        this.updateStartupReadiness({
          status: "ready",
          startedAt,
          checkedAt: Date.now(),
          attempts: previousAttempts + 1,
          requiredRoles,
          readyWorkerIds: readiness.readyWorkerIds,
          message: `Startup provisioning ready with ${readiness.readyWorkerIds.length} warm worker(s).`,
        });
        return;
      }

      if (Date.now() - lastRetryAt >= STARTUP_READINESS_RETRY_INTERVAL_MS) {
        lastRetryAt = Date.now();
        await this.ensureWarmWorkersForRoles(readiness.missingRoles, "startup readiness retry");
        await this.requestReconcile("startup readiness poll");
      }

      await sleep(STARTUP_READINESS_POLL_INTERVAL_MS);
    }

    const finalReadiness = this.collectRoleReadiness(requiredRoles);
    const failureDetails = this.describeStartupReadinessFailure(finalReadiness.missingRoles);
    this.updateStartupReadiness({
      status: "degraded",
      startedAt,
      checkedAt: Date.now(),
      attempts: previousAttempts + 1,
      requiredRoles,
      readyWorkerIds: finalReadiness.readyWorkerIds,
      message: failureDetails,
    });
    this.deps.logger.warn(`Provisioner: startup readiness degraded: ${failureDetails}`);
  }

  /**
   * Phase 2.1 (design 2.3, switch step 5): warm the new profile's warmupRoles
   * through the standard launch path after a profile switch. Dispatches the
   * launches (prerequisites + ensureWarmWorkersForRoles); the workers then
   * register asynchronously exactly like a cold start, so readiness tracking
   * (startupReadiness polling / reconcile) covers the rest.
   */
  async warmRolesForTeamSwitch(roles: RoleId[], reason: string): Promise<void> {
    if (!this.backend || this.stopped) {
      return;
    }
    await this.ensureStartupProvisioningPrerequisites();
    await this.ensureWarmWorkersForRoles(roles, reason);
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
        journalRecord("provisioner", "demand", `${role} needs +${demand} (${reason})`);
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

  private determineStartupReadinessRoles(): RoleId[] {
    const configured = this.deps.config.workerProvisioningRoles;
    if (configured.length > 0) {
      return [...new Set(configured)];
    }
    return [getActiveDefaultRole()];
  }

  private async ensureStartupProvisioningPrerequisites(): Promise<void> {
    await ensureWritableDirectory(resolveTeamClawAgentWorkspaceRootDir());
    await ensureWritableDirectory(resolveTeamClawWorkspaceDir());
    await ensureWritableDirectory(resolveDefaultTeamClawRuntimeRootDir());
    if (this.deps.config.workerProvisioningType === "process") {
      await ensureWritableDirectory(resolveTeamClawAgentDir());
    }
  }

  private async ensureWarmWorkersForRoles(roles: RoleId[], reason: string): Promise<void> {
    const state = this.deps.getTeamState();
    for (const role of roles) {
      if (this.hasActiveOrLaunchingWorkerForRole(state, role)) {
        continue;
      }
      if (this.hasRecentProvisioningFailure(role)) {
        this.deps.logger.warn(`Provisioner: startup warmup skipped ${role} due to recent failure`);
        continue;
      }
      this.deps.logger.info(`Provisioner: warming ${role} worker (${reason})`);
      journalRecord("provisioner", "warming", `warming ${role} (${reason})`);
      await this.launchWorker(role);
    }
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

  private hasActiveOrLaunchingWorkerForRole(state: TeamState | null, role: RoleId): boolean {
    if (!state) {
      return false;
    }
    const activeWorker = Object.values(state.workers).some((worker) =>
      worker.role === role && worker.status !== "offline"
    );
    if (activeWorker) {
      return true;
    }
    return Object.values(state.provisioning?.workers ?? {}).some((record) =>
      record.role === role && (record.status === "launching" || record.status === "registered")
    );
  }

  private collectRoleReadiness(roles: RoleId[]): { readyWorkerIds: string[]; missingRoles: RoleId[] } {
    const state = this.deps.getTeamState();
    const readyWorkerIds: string[] = [];
    const missingRoles: RoleId[] = [];
    for (const role of roles) {
      const worker = Object.values(state?.workers ?? {}).find((candidate) =>
        candidate.role === role && (candidate.status === "idle" || candidate.status === "busy")
      );
      if (worker) {
        readyWorkerIds.push(worker.id);
      } else {
        missingRoles.push(role);
      }
    }
    return { readyWorkerIds, missingRoles };
  }

  private describeStartupReadinessFailure(missingRoles: RoleId[]): string {
    const records = Object.values(this.deps.getTeamState()?.provisioning?.workers ?? {});
    const relevant = records.filter((record) => missingRoles.includes(record.role));
    const detail = relevant
      .map((record) => `${record.role}:${record.status}${record.lastError ? ` (${record.lastError})` : ""}`)
      .join(", ");
    const suffix = detail ? ` Latest records: ${detail}` : "";
    return `Startup worker readiness failed for roles: ${missingRoles.join(", ")}.${suffix}`;
  }

  private updateStartupReadiness(readiness: StartupProvisioningReadiness): void {
    this.deps.updateTeamState((state) => {
      ensureProvisioningState(state).startupReadiness = readiness;
    });
  }

  private async launchWorker(role: RoleId): Promise<void> {
    if (!this.backend) {
      return;
    }

    const workerId = `provisioned-${role}-${generateId()}`;
    // Issue #255 P0-1: 256-bit CSPRNG token (see generateLaunchToken) -
    // replaces the old two-generateId construction whose PRNG-derived
    // fragments made tokens predictable from observed output.
    const launchToken = generateLaunchToken();
    const controllerUrl = this.resolveControllerUrl();
    const requiresDedicatedHostPorts = requiresDedicatedHostPortsForProvisioner(
      this.backend.type,
      this.deps.config,
    );
    const workerPort = requiresDedicatedHostPorts
      ? await reserveEphemeralPort()
      : DEFAULT_CONTAINER_WORKER_PORT;
    const gatewayPort = requiresDedicatedHostPorts
      ? await reserveEphemeralPort()
      : DEFAULT_CONTAINER_GATEWAY_PORT;
    // Docker bridge networks need a host port to publish so the controller
    // (running on the host) can reach the worker container.
    const needsPublishedPort =
      this.backend.type === "docker" &&
      !isDockerHostNetwork(this.deps.config.workerProvisioningDockerNetwork);
    const publishedHostPort = needsPublishedPort ? await reserveEphemeralPort() : undefined;
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
        publishedHostPort,
        workspaceDir: getConfiguredWorkerWorkspaceDir(workerConfig),
        env: this.buildForwardedEnv(controllerUrl),
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
      journalRecord("provisioner", "launched", `${role} ${workerId} via ${this.backend.type}`);
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
        : getActiveRoleIds(),
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
    return inferTaskRole(task);
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
    if (this.backend?.type === "process") {
      // Process workers run on the same host — always use loopback regardless
      // of workerProvisioningControllerUrl (which may target Docker DNS).
      const port = this.deps.actualControllerPort ?? this.deps.config.port;
      return `http://127.0.0.1:${port}`;
    }
    if (this.deps.config.workerProvisioningControllerUrl) {
      return this.deps.config.workerProvisioningControllerUrl;
    }
    throw new Error(
      `workerProvisioningControllerUrl is required when workerProvisioningType=${this.backend?.type}`,
    );
  }

  private buildForwardedEnv(controllerUrl: string): Record<string, string> {
    const env: Record<string, string> = {
      ...this.deps.config.workerProvisioningExtraEnv,
    };
    for (const name of this.deps.config.workerProvisioningPassEnv) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0) {
        env[name] = value;
      }
    }
    return appendNoProxyEntries(env, controllerUrl);
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

function ensureProvisioningState(state: TeamState): TeamProvisioningState {
  if (!state.provisioning || typeof state.provisioning !== "object") {
    state.provisioning = { workers: {} };
  }
  if (!state.provisioning.workers || typeof state.provisioning.workers !== "object") {
    state.provisioning.workers = {};
  }
  return state.provisioning;
}

async function ensureWritableDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const probePath = path.join(dir, `.teamclaw-write-probe-${process.pid}-${Date.now()}`);
  await fs.writeFile(probePath, "ok\n", "utf8");
  await fs.rm(probePath, { force: true });
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
