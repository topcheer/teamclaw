import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import { getRole } from "../roles.js";
import { createRoleTaskExecutor } from "../task-executor.js";
import { installRecommendedSkills } from "../worker/skill-installer.js";
import type {
  PluginConfig,
  RoleId,
  TaskAssignmentPayload,
  TaskExecutionEventInput,
  TeamMessage,
  TeamState,
  WorkerInfo,
} from "../types.js";

const INPROCESS_WORKER_PREFIX = "inprocess-";

type InProcessWorkerRecord = {
  workerId: string;
  role: RoleId;
  executor: ReturnType<typeof createRoleTaskExecutor>;
  busy: boolean;
  idleSince: number; // timestamp when the worker became idle (0 if busy)
};

export type InProcessWorkerManagerDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  reportExecutionEvent?: (taskId: string, event: TaskExecutionEventInput) => Promise<void> | void;
};

/**
 * Manages virtual workers that execute tasks in the same process as the
 * controller via `runtime.subagent.run()`.  Used when `processModel: "single"`.
 *
 * Unlike LocalWorkerManager (which spawns child gateway processes), this
 * manager runs everything in the controller's own event loop.
 */
export class InProcessWorkerManager {
  private readonly workers = new Map<string, InProcessWorkerRecord>();
  private readonly deps: InProcessWorkerManagerDeps;

  constructor(deps: InProcessWorkerManagerDeps) {
    this.deps = deps;
  }

  /** Late-bind the execution event callback (set after controller HTTP server starts). */
  setReportExecutionEvent(cb: (taskId: string, event: TaskExecutionEventInput) => Promise<void> | void): void {
    (this.deps as InProcessWorkerManagerDeps).reportExecutionEvent = cb;
  }

  // ── Worker lifecycle ──────────────────────────────────────────────────

  /** Ensure a virtual worker exists for `role`. No-op if already present. */
  ensureWorker(role: RoleId): string {
    const workerId = getInProcessWorkerId(role);
    if (this.workers.has(workerId)) {
      return workerId;
    }

    const executor = createRoleTaskExecutor({
      runtime: this.deps.runtime,
      logger: this.deps.logger,
      role,
      taskTimeoutMs: this.deps.config.taskTimeoutMs,
      getSessionKey: (a) => a.executionSessionKey || `teamclaw-task-${a.taskId}`,
      getIdempotencyKey: (a) => a.executionIdempotencyKey,
      reportExecutionEvent: (...args) => this.deps.reportExecutionEvent?.(...args),
    });

    this.workers.set(workerId, { workerId, role, executor, busy: false, idleSince: Date.now() });
    this.deps.logger.info(`InProcessWorker: created virtual worker ${workerId} (role=${role})`);
    return workerId;
  }

  /** Remove a virtual worker. */
  removeWorker(role: RoleId): void {
    const workerId = getInProcessWorkerId(role);
    this.workers.delete(workerId);
  }

  /** Register all managed workers into TeamState. Also removes stale in-process entries. */
  syncState(state: TeamState): boolean {
    let changed = false;
    const now = Date.now();

    for (const record of this.workers.values()) {
      const existing = state.workers[record.workerId];
      if (!existing) {
        const roleDef = getRole(record.role);
        state.workers[record.workerId] = {
          id: record.workerId,
          role: record.role,
          label: roleDef?.label ?? record.role,
          status: record.busy ? "busy" : "idle",
          transport: "in-process",
          url: "",
          lastHeartbeat: now,
          capabilities: roleDef?.capabilities ?? [],
          registeredAt: now,
        };
        changed = true;
      } else {
        // Keep heartbeat fresh and status in sync.
        // In-process workers managed by this class are always alive —
        // override any stale "offline" status from previous runs.
        existing.lastHeartbeat = now;
        existing.transport = "in-process";
        const desiredStatus = record.busy ? "busy" : "idle";
        if (existing.status !== desiredStatus) {
          existing.status = desiredStatus;
          changed = true;
        }
      }
    }

    // Remove stale in-process worker entries that are no longer managed.
    for (const [workerId, worker] of Object.entries(state.workers)) {
      if (worker.transport === "in-process" && !this.workers.has(workerId)) {
        delete state.workers[workerId];
        changed = true;
      }
    }

    return changed;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  hasWorkers(): boolean {
    return this.workers.size > 0;
  }

  isInProcessWorkerId(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  isInProcessWorker(worker: Pick<WorkerInfo, "id" | "transport">): boolean {
    return worker.transport === "in-process" && this.workers.has(worker.id);
  }

  getIdleWorkerForRole(role: RoleId): string | null {
    const workerId = getInProcessWorkerId(role);
    const record = this.workers.get(workerId);
    if (record && !record.busy) {
      return workerId;
    }
    return null;
  }

  /**
   * Remove in-process workers that have been idle longer than `idleTtlMs`.
   * Returns the list of removed worker IDs (caller must clean up TeamState).
   */
  reapIdleWorkers(idleTtlMs: number): string[] {
    if (idleTtlMs <= 0) {
      return [];
    }
    const now = Date.now();
    const reaped: string[] = [];
    for (const [workerId, record] of this.workers) {
      if (!record.busy && record.idleSince > 0 && now - record.idleSince > idleTtlMs) {
        this.workers.delete(workerId);
        this.deps.logger.info(`InProcessWorker: reaped idle worker ${workerId} (idle ${Math.round((now - record.idleSince) / 1000)}s)`);
        reaped.push(workerId);
      }
    }
    return reaped;
  }

  // ── Task dispatch ─────────────────────────────────────────────────────

  /**
   * Dispatch a task to an in-process virtual worker.
   * Returns `true` if accepted (execution starts asynchronously).
   */
  async dispatchTask(workerId: string, assignment: TaskAssignmentPayload): Promise<boolean> {
    const record = this.workers.get(workerId);
    if (!record) {
      return false;
    }
    if (record.busy) {
      this.deps.logger.warn(`InProcessWorker: ${workerId} is busy, rejecting task ${assignment.taskId}`);
      return false;
    }

    record.busy = true;
    record.idleSince = 0;
    void this.executeTask(record, assignment);
    return true;
  }

  /** Queue a message for an in-process worker (currently a no-op log). */
  async queueMessage(workerId: string, message: TeamMessage): Promise<boolean> {
    if (!this.workers.has(workerId)) {
      return false;
    }
    this.deps.logger.info(`InProcessWorker: message queued for ${workerId}: ${message.content?.slice(0, 80) ?? "(empty)"}`);
    return true;
  }

  async cancelTask(workerId: string, taskId: string): Promise<boolean> {
    const record = this.workers.get(workerId);
    if (!record) {
      return false;
    }
    // Subagent cancellation is best-effort via the runtime.
    this.deps.logger.info(`InProcessWorker: cancel requested for task ${taskId} on ${workerId}`);
    return true;
  }

  async stop(): Promise<void> {
    this.workers.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async executeTask(
    record: InProcessWorkerRecord,
    assignment: TaskAssignmentPayload,
  ): Promise<void> {
    const { logger } = this.deps;
    const { workerId, role } = record;
    const taskId = assignment.taskId;

    try {
      // Skill preflight — same as external workers
      if (assignment.recommendedSkills?.length) {
        try {
          const skillResult = await installRecommendedSkills(assignment, logger);
          for (const event of skillResult.events) {
            await this.reportEvent(taskId, event);
          }
          if (skillResult.installed.length > 0) {
            logger.info(`InProcessWorker: installed skills [${skillResult.installed.join(", ")}] for task ${taskId}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`InProcessWorker: skill preflight failed for task ${taskId}: ${msg}`);
          await this.reportEvent(taskId, {
            type: "error",
            phase: "skills_preflight_failed",
            source: "worker",
            status: "running",
            message: msg,
          });
        }
      }

      logger.info(`InProcessWorker: ${workerId} starting task ${taskId}`);
      const execResult = await record.executor(assignment.description, assignment);
      const resultText = execResult.text;
      const contract = execResult.contract;
      logger.info(`InProcessWorker: ${workerId} completed task ${taskId} (${resultText.length} chars${contract ? ", with contract" : ""})`);

      await this.postResultToController(taskId, workerId, role, resultText, undefined, contract);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`InProcessWorker: ${workerId} failed task ${taskId}: ${message}`);

      await this.postResultToController(taskId, workerId, role, "", message);
    } finally {
      record.busy = false;
      record.idleSince = Date.now();
    }
  }

  private async reportEvent(taskId: string, event: TaskExecutionEventInput): Promise<void> {
    if (!this.deps.reportExecutionEvent) return;
    try {
      await Promise.resolve(this.deps.reportExecutionEvent(taskId, event));
    } catch {
      // best-effort
    }
  }

  private controllerPort = 0;

  setControllerPort(port: number): void {
    this.controllerPort = port;
  }

  private async postResultToController(
    taskId: string,
    workerId: string,
    role: RoleId,
    result: string,
    error?: string,
    contract?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.controllerPort) {
      this.deps.logger.warn(`InProcessWorker: cannot post result — controller port not set`);
      return;
    }

    try {
      const body: Record<string, unknown> = {
        taskId,
        workerId,
        role,
        status: error ? "failed" : "completed",
        result: result || undefined,
        error: error || undefined,
      };
      if (contract) {
        body.resultContract = contract;
      }
      const res = await fetch(`http://127.0.0.1:${this.controllerPort}/api/v1/tasks/${taskId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.deps.logger.warn(`InProcessWorker: result post failed (${res.status}) for task ${taskId}`);
      }
    } catch (err) {
      this.deps.logger.warn(
        `InProcessWorker: failed to post result for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function getInProcessWorkerId(role: RoleId): string {
  return `${INPROCESS_WORKER_PREFIX}${role}`;
}

export function isInProcessWorkerId(workerId: string): boolean {
  return workerId.startsWith(INPROCESS_WORKER_PREFIX);
}
