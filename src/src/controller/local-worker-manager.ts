import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import JSON5 from "json5";
import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import { getRole } from "../roles.js";
import type {
  PluginConfig,
  RoleId,
  TaskAssignmentPayload,
  TeamMessage,
  TeamState,
  WorkerIdentity,
  WorkerInfo,
} from "../types.js";
import {
  resolveDefaultOpenClawConfigPath,
  resolveDefaultOpenClawStateDir,
  resolveDefaultTeamClawRuntimeRootDir,
  resolveDefaultOpenClawWorkspaceDir,
} from "../openclaw-workspace.js";

const LOCAL_WORKER_RESTART_DELAY_MS = 1_000;
const LOCAL_WORKER_STOP_TIMEOUT_MS = 5_000;

type ManagedLocalWorkerRecord = {
  workerId: string;
  role: RoleId;
  workerPort: number;
  gatewayPort: number;
  homeDir: string;
  stateDir: string;
  process?: ChildProcess;
  stopping: boolean;
  restartTimer?: ReturnType<typeof setTimeout>;
};

export class LocalWorkerManager {
  private readonly controllerUrl: string;
  private readonly managedWorkers = new Map<string, ManagedLocalWorkerRecord>();
  private workerBaseDir: string | null = null;
  private stoppingAll = false;

  constructor(private readonly deps: {
    config: PluginConfig;
    logger: PluginLogger;
    runtime: OpenClawPluginApi["runtime"];
  }) {
    this.controllerUrl = `http://127.0.0.1:${deps.config.port}`;

    for (const role of deps.config.localRoles) {
      const workerId = getLocalWorkerId(role);
      this.managedWorkers.set(workerId, {
        workerId,
        role,
        workerPort: 0,
        gatewayPort: 0,
        homeDir: "",
        stateDir: "",
        stopping: false,
      });
    }
  }

  hasLocalWorkers(): boolean {
    return this.managedWorkers.size > 0;
  }

  isLocalWorker(_worker: Pick<WorkerInfo, "id" | "url" | "transport">): boolean {
    // localRoles now run as controller-managed child gateways and still heartbeat/register over HTTP.
    // Keep the controller timeout path aligned with normal workers instead of treating them as in-process sessions.
    return false;
  }

  isLocalWorkerId(workerId: string): boolean {
    return this.managedWorkers.has(workerId);
  }

  getIdentityForSession(_sessionKey?: string | null): WorkerIdentity | null {
    // Local roles no longer execute inside the controller's own OpenClaw runtime.
    return null;
  }

  getMessageQueueForSession(_sessionKey?: string | null): null {
    return null;
  }

  syncState(state: TeamState): boolean {
    let changed = false;
    const now = Date.now();
    const desiredWorkerIds = new Set(this.managedWorkers.keys());

    for (const task of Object.values(state.tasks)) {
      if (!task.assignedWorkerId || !desiredWorkerIds.has(task.assignedWorkerId)) {
        continue;
      }
      if (task.status === "completed" || task.status === "failed") {
        continue;
      }

      task.assignedRole = task.assignedRole ?? resolveRoleIdFromLocalWorkerId(task.assignedWorkerId) ?? undefined;
      task.assignedWorkerId = undefined;
      if (task.status !== "blocked") {
        task.status = "pending";
      }
      task.updatedAt = now;
      changed = true;
    }

    for (const [workerId, worker] of Object.entries(state.workers)) {
      if (desiredWorkerIds.has(workerId) || isManagedLoopbackWorker(worker, this.deps.config.localRoles)) {
        delete state.workers[workerId];
        changed = true;
      }
    }

    return changed;
  }

  async start(): Promise<void> {
    if (!this.hasLocalWorkers() || this.workerBaseDir) {
      return;
    }

    this.stoppingAll = false;
    const workerBaseRoot = path.join(resolveDefaultTeamClawRuntimeRootDir(), "local-workers");
    await fs.mkdir(workerBaseRoot, { recursive: true });
    this.workerBaseDir = await fs.mkdtemp(
      path.join(workerBaseRoot, `${sanitizePathSegment(this.deps.config.teamName)}-`),
    );

    const sourceStateDir = resolveDefaultOpenClawStateDir();
    const sourceWorkspaceDir = resolveDefaultOpenClawWorkspaceDir();
    const sourceConfigPath = resolveDefaultOpenClawConfigPath();
    const baseConfig = await loadOpenClawConfig(sourceConfigPath);

    for (const record of this.managedWorkers.values()) {
      await this.startManagedWorker(record, sourceStateDir, sourceWorkspaceDir, baseConfig);
    }
  }

  async stop(): Promise<void> {
    this.stoppingAll = true;

    await Promise.all([...this.managedWorkers.values()].map(async (record) => {
      record.stopping = true;
      if (record.restartTimer) {
        clearTimeout(record.restartTimer);
        record.restartTimer = undefined;
      }
      await stopManagedWorker(record, this.deps.logger);
    }));

    if (this.workerBaseDir) {
      await fs.rm(this.workerBaseDir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup; managed runtime dirs are safe to leave behind.
      });
      this.workerBaseDir = null;
    }
  }

  async dispatchTask(workerId: string, assignment: TaskAssignmentPayload): Promise<boolean> {
    return await this.postToManagedWorker(workerId, "/api/v1/tasks/assign", assignment, `dispatch task ${assignment.taskId}`);
  }

  async queueMessage(workerId: string, message: TeamMessage): Promise<boolean> {
    return await this.postToManagedWorker(workerId, "/api/v1/messages", message, "queue message");
  }

  async cancelTaskExecution(workerId: string, taskId: string): Promise<boolean> {
    const record = this.managedWorkers.get(workerId);
    if (!record || record.workerPort <= 0) {
      return false;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${record.workerPort}/api/v1/tasks/${taskId}/cancel`, {
        method: "POST",
      });
      if (!res.ok) {
        this.deps.logger.warn(`Controller: local worker cancel failed for ${taskId} on ${workerId} (${res.status})`);
        return false;
      }
      this.deps.logger.info(`Controller: cancelled local execution for task ${taskId} on ${workerId}`);
      return true;
    } catch (err) {
      this.deps.logger.warn(
        `Controller: failed to cancel local execution for task ${taskId} on ${workerId}: ${String(err)}`,
      );
      return false;
    }
  }

  private async startManagedWorker(
    record: ManagedLocalWorkerRecord,
    sourceStateDir: string,
    sourceWorkspaceDir: string,
    baseConfig: Record<string, unknown>,
  ): Promise<void> {
    if (!this.workerBaseDir) {
      throw new Error("Local worker base directory not initialized");
    }

    record.stopping = false;
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
      record.restartTimer = undefined;
    }

    record.workerPort = record.workerPort || await reserveEphemeralPort();
    record.gatewayPort = record.gatewayPort || await reserveEphemeralPort();
    record.homeDir = await fs.mkdtemp(path.join(this.workerBaseDir, `${sanitizePathSegment(record.role)}-`));
    record.stateDir = path.join(record.homeDir, ".openclaw");

    await copyStateDir(sourceStateDir, record.stateDir);
    await linkSharedWorkspace(record.stateDir, sourceWorkspaceDir);
    await clearCopiedWorkerIdentity(record.stateDir);
    await this.writeWorkerConfig(record, baseConfig);

    const gatewayEntrypoint = resolveGatewayEntrypoint();
    const child = spawn(process.execPath, [
      gatewayEntrypoint,
      "gateway",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(record.gatewayPort),
    ], {
      cwd: path.dirname(gatewayEntrypoint),
      env: {
        ...process.env,
        HOME: record.homeDir,
        OPENCLAW_HOME: record.homeDir,
        OPENCLAW_STATE_DIR: record.stateDir,
        OPENCLAW_CONFIG_PATH: path.join(record.stateDir, "openclaw.json"),
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        TEAMCLAW_WORKER_ID: record.workerId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    record.process = child;
    attachChildLogs(child, this.deps.logger, record.role);

    child.on("exit", (code, signal) => {
      record.process = undefined;
      if (record.restartTimer) {
        clearTimeout(record.restartTimer);
        record.restartTimer = undefined;
      }

      if (this.stoppingAll || record.stopping) {
        return;
      }

      this.deps.logger.warn(
        `Controller: local worker ${record.workerId} exited unexpectedly (code=${String(code)}, signal=${String(signal)}), restarting`,
      );
      record.restartTimer = setTimeout(() => {
        record.restartTimer = undefined;
        void this.startManagedWorker(record, sourceStateDir, sourceWorkspaceDir, baseConfig).catch((err) => {
          this.deps.logger.error(
            `Controller: failed to restart local worker ${record.workerId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, LOCAL_WORKER_RESTART_DELAY_MS);
      record.restartTimer.unref?.();
    });
  }

  private async writeWorkerConfig(
    record: ManagedLocalWorkerRecord,
    baseConfig: Record<string, unknown>,
  ): Promise<void> {
    const config = cloneJson(baseConfig);
    const gateway = ensureRecord(config.gateway);
    gateway.mode = "local";
    gateway.bind = "loopback";
    gateway.port = record.gatewayPort;
    config.gateway = gateway;

    const plugins = ensureRecord(config.plugins);
    plugins.enabled = true;
    const entries = ensureRecord(plugins.entries);
    const teamclawEntry = ensureRecord(entries.teamclaw);
    teamclawEntry.enabled = true;
    const teamclawConfig = ensureRecord(teamclawEntry.config);
    teamclawConfig.mode = "worker";
    teamclawConfig.role = record.role;
    teamclawConfig.port = record.workerPort;
    teamclawConfig.controllerUrl = this.controllerUrl;
    teamclawConfig.teamName = this.deps.config.teamName;
    teamclawConfig.heartbeatIntervalMs = this.deps.config.heartbeatIntervalMs;
    teamclawConfig.taskTimeoutMs = this.deps.config.taskTimeoutMs;
    teamclawConfig.localRoles = [];
    teamclawEntry.config = teamclawConfig;
    entries.teamclaw = teamclawEntry;
    plugins.entries = entries;
    config.plugins = plugins;

    const configPath = path.join(record.stateDir, "openclaw.json");
    await fs.mkdir(record.stateDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  private async postToManagedWorker(
    workerId: string,
    pathname: string,
    payload: unknown,
    action: string,
  ): Promise<boolean> {
    const record = this.managedWorkers.get(workerId);
    if (!record || record.workerPort <= 0) {
      return false;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${record.workerPort}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.deps.logger.warn(`Controller: local worker ${workerId} failed to ${action} (${res.status})`);
        return false;
      }
      return true;
    } catch (err) {
      this.deps.logger.warn(`Controller: failed to ${action} on local worker ${workerId}: ${String(err)}`);
      return false;
    }
  }
}

async function loadOpenClawConfig(configPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configPath, "utf8");
  return parseLooseJsonObject(raw, configPath);
}

async function copyStateDir(sourceStateDir: string, targetStateDir: string): Promise<void> {
  await fs.mkdir(targetStateDir, { recursive: true });
  try {
    await fs.cp(sourceStateDir, targetStateDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (sourcePath) => shouldCopyStatePath(sourcePath, sourceStateDir),
    });
  } catch {
    await fs.mkdir(targetStateDir, { recursive: true });
  }
}

async function linkSharedWorkspace(targetStateDir: string, sourceWorkspaceDir: string): Promise<void> {
  const targetWorkspacePath = path.join(targetStateDir, "workspace");
  await fs.mkdir(sourceWorkspaceDir, { recursive: true });
  await fs.rm(targetWorkspacePath, { recursive: true, force: true });
  try {
    await fs.symlink(sourceWorkspaceDir, targetWorkspacePath, "dir");
  } catch {
    await fs.mkdir(targetWorkspacePath, { recursive: true });
  }
}

async function clearCopiedWorkerIdentity(targetStateDir: string): Promise<void> {
  await fs.rm(path.join(targetStateDir, "plugins", "teamclaw", "worker-identity.json"), { force: true });
}

function shouldCopyStatePath(sourcePath: string, sourceStateDir: string): boolean {
  const relativePath = path.relative(sourceStateDir, sourcePath);
  if (!relativePath) {
    return true;
  }

  const normalizedPath = relativePath.split(path.sep).join("/");
  if (normalizedPath === "workspace" || normalizedPath.startsWith("workspace/")) {
    return false;
  }
  if (normalizedPath === "plugins/teamclaw/worker-identity.json") {
    return false;
  }
  return true;
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
      server.close((err) => {
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

function attachChildLogs(child: ChildProcess, logger: PluginLogger, role: RoleId): void {
  if (child.stdout) {
    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      logger.info(`LocalWorker[${role}]: ${line}`);
    });
  }
  if (child.stderr) {
    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      logger.warn(`LocalWorker[${role}]: ${line}`);
    });
  }
}

async function stopManagedWorker(record: ManagedLocalWorkerRecord, logger: PluginLogger): Promise<void> {
  const child = record.process;
  if (!child) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      record.process = undefined;
      resolve();
    };

    const timeout = setTimeout(() => {
      if (child.exitCode == null) {
        logger.warn(`Controller: force-killing local worker ${record.workerId}`);
        child.kill("SIGKILL");
      }
      finish();
    }, LOCAL_WORKER_STOP_TIMEOUT_MS);

    timeout.unref?.();
    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });

    child.kill("SIGTERM");
  });
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function isManagedLoopbackWorker(worker: WorkerInfo, roles: RoleId[]): boolean {
  if (!roles.includes(worker.role)) {
    return false;
  }

  try {
    const parsed = new URL(worker.url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function resolveRoleIdFromLocalWorkerId(workerId: string): RoleId | null {
  if (!workerId.startsWith("local-")) {
    return null;
  }
  const roleCandidate = workerId.slice("local-".length);
  return isRoleId(roleCandidate) ? roleCandidate : null;
}

function isRoleId(value: string): value is RoleId {
  return value === "pm" ||
    value === "architect" ||
    value === "developer" ||
    value === "qa" ||
    value === "release-engineer" ||
    value === "infra-engineer" ||
    value === "devops" ||
    value === "security-engineer" ||
    value === "designer" ||
    value === "marketing";
}

export function getLocalWorkerId(role: RoleId): string {
  return `local-${role}`;
}

export function buildLocalWorkerLabel(role: RoleId): string {
  const roleDef = getRole(role);
  return roleDef ? `${roleDef.label} (Local)` : `${role} (Local)`;
}
