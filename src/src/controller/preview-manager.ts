import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { PluginLogger } from "../../api.js";
import { resolveDefaultOpenClawWorkspaceDir } from "../openclaw-workspace.js";
import type { DynamicPreviewRecord, TeamState, WorkerTaskResultContract, WorkerTaskResultDeliverable } from "../types.js";
import { spawnManagedCommandProcess, stopManagedProcess } from "./managed-gateway-process.js";

const PREVIEW_LAUNCH_TIMEOUT_MS = 120_000;
const PREVIEW_HEALTH_INTERVAL_MS = 1_500;
const PREVIEW_STOP_TIMEOUT_MS = 5_000;

const GENERIC_SERVE_COMMAND = "npx -y serve -l {PORT}";

/**
 * Detect the tech stack from files in `cwd` and return a suitable preview command.
 * Only overrides `existingCommand` when it is the generic static file server
 * and the deliverable explicitly specifies a runnable framework.
 *
 * IMPORTANT: The worker (LLM) is responsible for providing the real preview
 * command in its result contract. This function only provides a lightweight
 * fallback for static file directories.
 */
async function resolveSmartPreviewCommand(cwd: string, existingCommand: string): Promise<string> {
  if (existingCommand !== GENERIC_SERVE_COMMAND) {
    return existingCommand;
  }
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    const filenames = entries.filter((e) => e.isFile()).map((e) => e.name);

    // Only detect package.json with a dev/start script — let the framework's
    // own dev server handle everything. The worker should provide the command
    // but this is a reasonable fallback for Node.js projects.
    if (filenames.includes("package.json")) {
      const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf-8").catch(() => "");
      if (pkgRaw) {
        try {
          const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
          if (pkg.scripts?.dev) {
            return "npm run dev -- --port {PORT}";
          }
          if (pkg.scripts?.start) {
            return "npm start -- --port {PORT}";
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  } catch {
    // cwd may not exist yet or be unreadable
  }
  return existingCommand;
}

type PreviewManagerDeps = {
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
};

type DynamicPreviewSpec = {
  previewId: string;
  taskId: string;
  deliverableIndex: number;
  deliverableValue: string;
  previewCommand: string;
  previewCwd: string;
  previewReadyPath: string;
  liveUrl: string;
};

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizePreviewReadyPath(value: unknown): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return "/";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizePreviewCwd(deliverable: WorkerTaskResultDeliverable): string | undefined {
  const explicit = normalizeOptionalText(deliverable.previewCwd);
  if (explicit) {
    return explicit;
  }
  const value = normalizeOptionalText(deliverable.value);
  if (!value) {
    return undefined;
  }
  if (deliverable.kind === "directory") {
    return value;
  }
  const directory = path.posix.dirname(value);
  return directory === "." ? "." : directory;
}

function buildPreviewId(taskId: string, deliverableIndex: number): string {
  return `preview-${taskId}-${deliverableIndex}`;
}

function buildPreviewLiveUrl(previewId: string): string {
  return `/api/v1/previews/${encodeURIComponent(previewId)}/`;
}

function isWorkspacePathInsideRoot(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspaceDirectory(rootDir: string, relativePath: string): string | null {
  const resolved = path.resolve(rootDir, relativePath);
  return isWorkspacePathInsideRoot(rootDir, resolved) ? resolved : null;
}

export class PreviewManager {
  private readonly processes = new Map<string, ChildProcess>();
  private readonly stoppingPreviewIds = new Set<string>();
  private healthMonitorTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly HEALTH_MONITOR_INTERVAL_MS = 30_000; // check every 30s

  constructor(private readonly deps: PreviewManagerDeps) {}

  /** Start periodic health monitoring for all healthy previews. */
  startHealthMonitor(): void {
    if (this.healthMonitorTimer) return;
    this.healthMonitorTimer = setInterval(() => {
      void this.runHealthChecks();
    }, PreviewManager.HEALTH_MONITOR_INTERVAL_MS);
    this.healthMonitorTimer.unref?.();
  }

  stopHealthMonitor(): void {
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
  }

  /** Re-check all "healthy" previews; mark failed if process gone or not responding. */
  private async runHealthChecks(): Promise<void> {
    const state = this.deps.getTeamState();
    if (!state) return;
    const healthyPreviews = Object.values(state.previews ?? {}).filter(
      (p) => p.status === "healthy",
    );
    for (const preview of healthyPreviews) {
      // Check if process is still alive
      const proc = this.processes.get(preview.id);
      if (!proc) {
        this.markPreviewFailed(preview.id, "Preview process is no longer running.");
        continue;
      }
      // Check if still responding to HTTP
      const healthy = await this.checkPreviewHealth(preview);
      if (!healthy) {
        this.deps.logger.warn(`Controller: preview ${preview.id} failed periodic health check`);
        this.markPreviewFailed(preview.id, "Preview stopped responding to health checks.");
      } else {
        this.deps.updateTeamState((s) => {
          const p = s.previews?.[preview.id];
          if (p) p.lastHealthCheckAt = Date.now();
        });
      }
    }
  }

  async syncTaskPreviews(taskId: string): Promise<void> {
    const state = this.deps.getTeamState();
    const task = state?.tasks[taskId];
    if (!task || task.status !== "completed" || !task.resultContract) {
      await this.stopTaskPreviews(taskId, !task ? "task removed" : `task moved to ${task.status}`);
      return;
    }

    const specs = await this.collectPreviewSpecs(taskId, task.resultContract);
    const desiredIds = new Set(specs.map((spec) => spec.previewId));
    const existingIds = Object.values(state?.previews ?? {})
      .filter((preview) => preview.taskId === taskId)
      .map((preview) => preview.id);

    for (const previewId of existingIds) {
      if (!desiredIds.has(previewId)) {
        await this.removePreview(previewId, "preview no longer declared on the task result");
      }
    }

    for (const spec of specs) {
      await this.ensurePreview(spec);
    }
    if (specs.length > 0) this.startHealthMonitor();
  }

  async stopTaskPreviews(taskId: string, reason: string): Promise<void> {
    const previewIds = Object.values(this.deps.getTeamState()?.previews ?? {})
      .filter((preview) => preview.taskId === taskId)
      .map((preview) => preview.id);
    for (const previewId of previewIds) {
      await this.removePreview(previewId, reason);
    }
  }

  private static isPreviewableDeliverable(d: WorkerTaskResultDeliverable): boolean {
    return d.artifactType === "web-app" || d.artifactType === "static-site" || d.artifactType === "rest-api";
  }

  async restorePreviewsOnStartup(): Promise<void> {
    const state = this.deps.getTeamState();
    if (!state) {
      this.deps.logger.warn("PreviewManager: restorePreviewsOnStartup called but no team state");
      return;
    }
    const completedTasks = Object.values(state.tasks).filter((t) => t.status === "completed" && t.resultContract);
    const tasksWithPreviews = completedTasks.filter((t) =>
      t.resultContract!.deliverables.some((d) => PreviewManager.isPreviewableDeliverable(d)),
    );
    this.deps.logger.info(`PreviewManager: restorePreviewsOnStartup: ${tasksWithPreviews.length} tasks with previews out of ${completedTasks.length} completed`);

    for (const preview of Object.values(state.previews ?? {})) {
      const task = state.tasks[preview.taskId];
      const deliverable = task?.resultContract?.deliverables?.[preview.deliverableIndex];
      if (!task || task.status !== "completed" || !deliverable || !PreviewManager.isPreviewableDeliverable(deliverable)) {
        await this.removePreview(preview.id, "preview can no longer be restored from task state");
      }
    }
    for (const task of Object.values(state.tasks)) {
      if (task.status !== "completed" || !task.resultContract) {
        continue;
      }
      if (!task.resultContract.deliverables.some((d) => PreviewManager.isPreviewableDeliverable(d))) {
        continue;
      }
      try {
        await this.syncTaskPreviews(task.id);
      } catch (err) {
        this.deps.logger.warn(`Controller: failed to restore preview(s) for ${task.id}: ${String(err)}`);
      }
    }
    this.startHealthMonitor();
  }

  async stopAll(reason = "controller shutdown"): Promise<void> {
    this.stopHealthMonitor();
    const previewIds = Array.from(new Set([
      ...this.processes.keys(),
      ...Object.keys(this.deps.getTeamState()?.previews ?? {}),
    ]));
    for (const previewId of previewIds) {
      await this.stopPreviewProcess(previewId, reason, { removeRecord: false, clearLiveUrl: false });
    }
  }

  private async collectPreviewSpecs(taskId: string, contract: WorkerTaskResultContract): Promise<DynamicPreviewSpec[]> {
    const workspaceRoot = resolveDefaultOpenClawWorkspaceDir();
    const specs: DynamicPreviewSpec[] = [];

    for (const [deliverableIndex, deliverable] of contract.deliverables.entries()) {
      if (deliverable.artifactType !== "web-app" && deliverable.artifactType !== "static-site" && deliverable.artifactType !== "rest-api") {
        continue;
      }
      const rawCommand = normalizeOptionalText(deliverable.previewCommand) ?? GENERIC_SERVE_COMMAND;
      const previewCwd = normalizePreviewCwd(deliverable);
      if (!previewCwd) {
        this.deps.logger.warn(
          `Controller: skipping preview for task ${taskId} deliverable[${deliverableIndex}] — cannot resolve previewCwd from value "${deliverable.value}"`,
        );
        continue;
      }

      // Resolve the actual working directory for file-system detection
      const resolvedCwd = resolveWorkspaceDirectory(workspaceRoot, previewCwd);
      const previewCommand = resolvedCwd
        ? await resolveSmartPreviewCommand(resolvedCwd, rawCommand)
        : rawCommand;

      specs.push({
        previewId: buildPreviewId(taskId, deliverableIndex),
        taskId,
        deliverableIndex,
        deliverableValue: deliverable.value,
        previewCommand,
        previewCwd,
        previewReadyPath: normalizePreviewReadyPath(deliverable.previewReadyPath),
        liveUrl: buildPreviewLiveUrl(buildPreviewId(taskId, deliverableIndex)),
      });
    }
    return specs;
  }

  private async ensurePreview(spec: DynamicPreviewSpec): Promise<void> {
    const current = this.deps.getTeamState()?.previews?.[spec.previewId];
    this.setTaskDeliverableLiveUrl(spec.taskId, spec.deliverableIndex, spec.liveUrl);

    const isSameConfiguration = current
      && current.previewCommand === spec.previewCommand
      && current.previewCwd === spec.previewCwd
      && current.previewReadyPath === spec.previewReadyPath
      && current.deliverableValue === spec.deliverableValue;

    if (
      isSameConfiguration
      && this.processes.has(spec.previewId)
      && (current?.status === "healthy" || current?.status === "launching")
    ) {
      return;
    }

    if (current || this.processes.has(spec.previewId)) {
      await this.stopPreviewProcess(spec.previewId, "preview configuration refreshed", {
        removeRecord: false,
        clearLiveUrl: false,
      });
    }
    const targetPort = await this.reserveEphemeralPort();
    const now = Date.now();
    const record: DynamicPreviewRecord = {
      id: spec.previewId,
      taskId: spec.taskId,
      deliverableIndex: spec.deliverableIndex,
      deliverableValue: spec.deliverableValue,
      previewCommand: spec.previewCommand,
      previewCwd: spec.previewCwd,
      previewReadyPath: spec.previewReadyPath,
      liveUrl: spec.liveUrl,
      targetPort,
      status: "launching",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };

    this.deps.updateTeamState((state) => {
      if (!state.previews) {
        state.previews = {};
      }
      state.previews[spec.previewId] = record;
      const task = state.tasks[spec.taskId];
      const deliverable = task?.resultContract?.deliverables?.[spec.deliverableIndex];
      if (deliverable) {
        deliverable.liveUrl = spec.liveUrl;
      }
    });

    await this.launchPreview(record);
  }

  private async launchPreview(record: DynamicPreviewRecord): Promise<void> {
    const workspaceRoot = resolveDefaultOpenClawWorkspaceDir();
    const cwd = resolveWorkspaceDirectory(workspaceRoot, record.previewCwd);
    if (!cwd) {
      this.markPreviewFailed(record.id, `Dynamic preview path must stay inside the workspace: ${record.previewCwd}`);
      return;
    }

    try {
      await fs.access(cwd, fs.constants.R_OK);
    } catch {
      this.markPreviewFailed(record.id, `Dynamic preview cwd does not exist or is not readable: ${cwd}`);
      return;
    }

    const resolvedCommand = record.previewCommand
      .replace(/\{PORT\}/gu, String(record.targetPort));
    const child = spawnManagedCommandProcess({
      command: resolvedCommand,
      cwd,
      env: {
        ...process.env,
        HOST: "0.0.0.0",
        PORT: String(record.targetPort),
        TEAMCLAW_PREVIEW_BASE_PATH: record.liveUrl.replace(/\/$/u, ""),
        TEAMCLAW_PREVIEW_URL: record.liveUrl,
      },
    });
    this.processes.set(record.id, child);
    this.deps.updateTeamState((state) => {
      const preview = state.previews?.[record.id];
      if (!preview) {
        return;
      }
      preview.pid = child.pid ?? undefined;
      preview.status = "launching";
      preview.updatedAt = Date.now();
      delete preview.lastError;
    });

    let settled = false;
    const finish = async (status: "healthy" | "failed", errorMessage?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(healthTimer);
      clearTimeout(launchTimeout);
      if (status === "healthy") {
        this.markPreviewHealthy(record.id);
      } else {
        this.markPreviewFailed(record.id, errorMessage ?? "Preview launch failed");
      }
    };

    const healthTimer = setInterval(() => {
      void this.checkPreviewHealth(record)
        .then((healthy) => {
          if (healthy) {
            void finish("healthy");
          }
        })
        .catch(() => {
          // keep polling until timeout or exit
        });
    }, PREVIEW_HEALTH_INTERVAL_MS);
    healthTimer.unref?.();

    const launchTimeout = setTimeout(() => {
      void finish(
        "failed",
        `Dynamic preview did not become ready within ${Math.round(PREVIEW_LAUNCH_TIMEOUT_MS / 1000)} seconds.`,
      ).finally(() => {
        void this.stopPreviewProcess(record.id, "dynamic preview launch timed out", {
          removeRecord: false,
          clearLiveUrl: false,
          nextStatus: "failed",
          lastError: `Dynamic preview did not become ready within ${Math.round(PREVIEW_LAUNCH_TIMEOUT_MS / 1000)} seconds.`,
        });
      });
    }, PREVIEW_LAUNCH_TIMEOUT_MS);
    launchTimeout.unref?.();

    child.once("exit", (code, signal) => {
      clearInterval(healthTimer);
      clearTimeout(launchTimeout);
      this.processes.delete(record.id);
      if (this.stoppingPreviewIds.has(record.id)) {
        this.stoppingPreviewIds.delete(record.id);
        return;
      }
      if (!settled) {
        void finish(
          "failed",
          `Dynamic preview exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        );
        return;
      }
      this.markPreviewFailed(
        record.id,
        `Dynamic preview process exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      );
    });
  }

  private async removePreview(previewId: string, reason: string): Promise<void> {
    await this.stopPreviewProcess(previewId, reason, {
      removeRecord: true,
      clearLiveUrl: true,
    });
  }

  private async stopPreviewProcess(
    previewId: string,
    reason: string,
    options: {
      removeRecord: boolean;
      clearLiveUrl: boolean;
      nextStatus?: DynamicPreviewRecord["status"];
      lastError?: string;
    },
  ): Promise<void> {
    const child = this.processes.get(previewId);
    if (child) {
      this.stoppingPreviewIds.add(previewId);
      this.processes.delete(previewId);
      await stopManagedProcess(child, PREVIEW_STOP_TIMEOUT_MS).catch((err) => {
        this.deps.logger.warn(`Controller: failed to stop preview ${previewId}: ${String(err)}`);
      });
      this.stoppingPreviewIds.delete(previewId);
    }

    this.deps.updateTeamState((state) => {
      const preview = state.previews?.[previewId];
      if (!preview) {
        return;
      }
      const task = state.tasks[preview.taskId];
      const deliverable = task?.resultContract?.deliverables?.[preview.deliverableIndex];
      if (deliverable && options.clearLiveUrl && deliverable.liveUrl === preview.liveUrl) {
        delete deliverable.liveUrl;
      }
      if (options.removeRecord) {
        delete state.previews?.[previewId];
        return;
      }
      preview.status = options.nextStatus ?? "stopped";
      preview.updatedAt = Date.now();
      preview.lastError = options.lastError ?? reason;
      delete preview.pid;
    });
  }

  private setTaskDeliverableLiveUrl(taskId: string, deliverableIndex: number, liveUrl: string): void {
    this.deps.updateTeamState((state) => {
      const task = state.tasks[taskId];
      const deliverable = task?.resultContract?.deliverables?.[deliverableIndex];
      if (!deliverable || deliverable.liveUrl === liveUrl) {
        return;
      }
      deliverable.liveUrl = liveUrl;
      task.updatedAt = Date.now();
    });
  }

  private markPreviewHealthy(previewId: string): void {
    this.deps.updateTeamState((state) => {
      const preview = state.previews?.[previewId];
      if (!preview) {
        return;
      }
      preview.status = "healthy";
      preview.updatedAt = Date.now();
      preview.lastHealthCheckAt = Date.now();
      delete preview.lastError;
    });
  }

  private markPreviewFailed(previewId: string, errorMessage: string): void {
    this.deps.updateTeamState((state) => {
      const preview = state.previews?.[previewId];
      if (!preview) {
        return;
      }
      preview.status = "failed";
      preview.updatedAt = Date.now();
      preview.lastError = errorMessage;
      delete preview.pid;
    });
  }

  private async checkPreviewHealth(record: DynamicPreviewRecord): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${record.targetPort}${record.previewReadyPath}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  private async reserveEphemeralPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(port);
        });
      });
      server.on("error", reject);
    });
  }
}
