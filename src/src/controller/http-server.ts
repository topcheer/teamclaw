import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import type {
  ClarificationRequest,
  ControllerOrchestrationManifest,
  ControllerRunInfo,
  ControllerRunSource,
  GitRepoState,
  PluginConfig,
  RepoSyncInfo,
  RoleId,
  StartupProvisioningReadiness,
  TaskExecution,
  TaskExecutionEvent,
  TaskExecutionEventInput,
  TaskAssignmentPayload,
  TaskExecutionSummary,
  TaskInfo,
  TaskPriority,
  TaskStatus,
  TeamMessage,
  TeamState,
  TeamSwitchTransition,
  WorkerProgressContract,
  WorkerInfo,
  WorkerTaskResultContract,
  WorkerTaskResultDeliverable,
} from "../types.js";
import {
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendError,
  generateId,
} from "../protocol.js";
import { saveTeamState, archiveTeamState, listArchivedTeams, findTeamSwitchArchive } from "../state.js";
import { listWorkspaceTree, listWorkspaceSubtree, readWorkspaceFile, readWorkspaceRawFile } from "../workspace-browser.js";
// Phase 1.3: runtime role data comes from the active TeamProfile loader
// (software-rd baseline) instead of the roles.ts registry; roles.ts/role-ids.ts
// remain the type layer and the generator source.
import {
  BUILTIN_PROFILES,
  getActiveProfile,
  getActiveRoles,
  getActiveDefaultRole,
  hasProfile,
  normalizeRecommendedSkills,
  resolveActiveRoleSkills,
  setActiveProfileId,
  validateActiveRoleId,
  type TeamProfileCapabilities,
} from "../profile-loader.js";
import {
  buildRepoSyncInfo,
  ensureControllerGitRepo,
  exportControllerGitBundle,
  importControllerGitBundle,
  removeTrackedWorkspaceSubtree,
} from "../git-collaboration.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import type { WorkerProvisioningManager } from "./worker-provisioning.js";
import type { PreviewManager } from "./preview-manager.js";
import { createControllerPromptInjector } from "./prompt-injector.js";
import { getGithubAuthManager } from "./github-auth.js";
import { createTunnelManager, gatePageHtml, computeGateCookie, GATE_COOKIE_NAME, selfHostedTokenFromEnv, type TunnelManager } from "./tunnel-manager.js";
import { createGithubClient } from "../teamauto/github-client.js";
import type { TeamAutoScheduler } from "../teamauto/scheduler.js";
import { buildControllerNoWorkersMessage, shouldBlockControllerWithoutWorkers } from "./controller-capacity.js";
import { generateDeliveryReport, isSessionComplete, renderReportHtml, type DeliveryReport } from "./delivery-report.js";
import {
  backfillWorkerProgressContract,
  backfillWorkerTaskResultContract,
  ensureTeamMessageContract,
  normalizeTaskHandoffContract,
  normalizeWorkerProgressContract,
  normalizeWorkerTaskResultContract,
  enrichDeliverablesWithPreviewInference,
} from "../interaction-contracts.js";
import {
  buildTeamClawProjectWorkspacePath,
  buildTeamClawAgentSessionKey,
  getTeamClawModelReadiness,
  resolveTeamClawAgentWorkspaceRootDir,
  resolveTeamClawWorkspaceDir,
  resolveTeamClawProjectsDir,
  deriveStableProjectKey,
  deriveProjectSlug,
  teamClawWorkspaceIsDefault,
  updateTeamClawWorkspaceDir,
  getTeamClawModelCatalog,
  updateTeamClawModelConfig,
} from "../openclaw-workspace.js";
import { resolvePreferredLanAddress } from "../networking.js";
import { normalizeClarificationQuestionSchema, normalizeControllerManifest } from "./orchestration-manifest.js";
import type { KickoffHandler } from "./controller-service.js";

export type ControllerHttpDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
  taskRouter: TaskRouter;
  messageRouter: MessageRouter;
  wsServer: TeamWebSocketServer;
  workerProvisioningManager?: WorkerProvisioningManager | null;
  previewManager?: PreviewManager;
  /** Late-bound kickoff handler for automatic team kickoff on complex projects. */
  getKickoffHandler?: () => KickoffHandler | undefined;
  /** Late-bound TeamAuto scheduler (autonomous repo collaboration). */
  getTeamAutoScheduler?: () => TeamAutoScheduler | null;
};

const MAX_TASK_EXECUTION_EVENTS = 250;
const MAX_CONTROLLER_RUNS = 40;
const MAX_RECENT_TASK_CONTEXT = 3;
const MAX_TASK_CONTEXT_SUMMARY_CHARS = 500;
const CONTROLLER_INTAKE_SESSION_PREFIX = "teamclaw-controller-web:";
const CONTROLLER_INTAKE_AGENT_SESSION_RE = /^agent:[^:]+:(teamclaw-controller-web:[a-zA-Z0-9:_-]{1,120})$/;
const CONTROLLER_RUN_WAIT_SLICE_MS = 30_000;
const CONTROLLER_SESSION_PROGRESS_MESSAGE_LIMIT = 200;
const MAX_SESSION_PROGRESS_MESSAGE_CHARS = 4000;
const TOOL_CALL_BLOCK_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["tool_result", "tool_result_error"]);
const EXISTING_PROJECT_REUSE_HINT_RE = /\b(existing|optimi(?:s|z)e|optimi(?:s|z)ation|improvement|enhanc(?:e|ement)|follow[- ]?up|extend|update|bugfix|bug fix)\b/iu;
const GENERIC_PROJECT_FOLLOW_UP_RE = /\b(continue|continuing|next step|what else|what's next|follow[- ]?up|more|remaining)\b|继续|接下来|下一步|还有哪些|还可以做什么/u;
const PROJECT_MATCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "build",
  "complete",
  "existing",
  "follow",
  "for",
  "hub",
  "improvement",
  "improvements",
  "internal",
  "optimization",
  "product",
  "project",
  "requirement",
  "request",
  "studio",
  "system",
  "the",
  "this",
  "up",
  "update",
  "web",
]);
const CONTROLLER_RATE_LIMIT_STALL_PROBE_MS = 5 * 60 * 1000;
const CONTROLLER_RATE_LIMIT_PROBE_TIMEOUT_MS = 60_000;
const CONTROLLER_INACTIVITY_PROBE_TIMEOUT_MS = 60_000;
const CONTROLLER_RATE_LIMIT_WAITING_SENTINEL = "TEAMCLAW_STILL_WAITING";
const CONTROLLER_INTAKE_MAX_RETRIES = 2;
const CONTROLLER_INTAKE_RETRY_DELAY_MS = 3_000;
const CONTROLLER_INTAKE_RETRYABLE_ERROR_PATTERN = /(500|502|503|server error|internal error|overloaded|unavailable)/i;
const controllerIntakeQueue = new Map<string, Promise<void>>();
const EXTERNAL_WORKER_INSTALL_SPEC = "@teamclaws/teamclaw";

export function buildControllerIntakeSystemPrompt(
  deps: Pick<ControllerHttpDeps, "config" | "getTeamState">,
): string {
  const injector = createControllerPromptInjector({
    config: deps.config,
    getTeamState: deps.getTeamState,
  });
  return injector()?.prependSystemContext ?? "";
}

function resolveRequestPort(req: IncomingMessage, fallbackPort: number): number {
  const hostHeader = req.headers.host?.trim();
  if (!hostHeader) {
    return fallbackPort;
  }
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return parsed.port ? Number(parsed.port) : fallbackPort;
  } catch {
    return fallbackPort;
  }
}

function resolveRecommendedLanControllerUrl(req: IncomingMessage, fallbackPort: number): string {
  const port = resolveRequestPort(req, fallbackPort);
  const preferredLan = resolvePreferredLanAddress();
  return preferredLan ? `http://${preferredLan}:${port}` : "";
}

function shellEscapeSingleQuotes(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildExternalWorkerInstallInfo(req: IncomingMessage, config: PluginConfig): Record<string, unknown> {
  const recommendedControllerUrl = resolveRecommendedLanControllerUrl(req, config.port);
  return {
    teamName: config.teamName,
    recommendedControllerUrl,
    defaultRole: getActiveDefaultRole(),
    roles: getActiveRoles().map((role) => ({ id: role.id, label: role.label, icon: role.icon })),
    autoDiscoveryCommandPrefix:
      `npx -y ${EXTERNAL_WORKER_INSTALL_SPEC} install --yes --install-mode worker --team-name ${shellEscapeSingleQuotes(config.teamName)} --worker-role `,
    manualCommandPrefix:
      `npx -y ${EXTERNAL_WORKER_INSTALL_SPEC} install --yes --install-mode worker --team-name ${shellEscapeSingleQuotes(config.teamName)} --worker-role `,
    manualControllerUrlFlag: recommendedControllerUrl
      ? ` --controller-url ${shellEscapeSingleQuotes(recommendedControllerUrl)}`
      : "",
    manualControllerWarning: recommendedControllerUrl
      ? "Manual worker installs must use the controller LAN IP, not localhost/127.0.0.1."
      : "No private LAN IPv4 address was detected on this controller host yet, so manual worker install commands are unavailable until a LAN address exists.",
    autoDiscoveryWarning: "mDNS auto-discovery only works when the worker and controller are reachable on the same LAN.",
  };
}

function mapTaskStatusToExecutionStatus(taskStatus: TaskStatus, current?: TaskExecution["status"]): TaskExecution["status"] {
  switch (taskStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "in_progress":
    case "review":
      return "running";
    case "pending":
    case "assigned":
      return current ?? "pending";
    case "blocked":
      return current ?? "running";
    default:
      return current ?? "pending";
  }
}

function ensureTaskExecution(task: TaskInfo): TaskExecution {
  if (!task.execution) {
    task.execution = {
      status: mapTaskStatusToExecutionStatus(task.status),
      startedAt: task.startedAt,
      endedAt: task.completedAt,
      lastUpdatedAt: task.updatedAt,
      events: [],
    };
  }

  if (!Array.isArray(task.execution.events)) {
    task.execution.events = [];
  }

  task.execution.status = task.execution.status ?? mapTaskStatusToExecutionStatus(task.status);
  task.execution.startedAt = task.execution.startedAt ?? task.startedAt;
  task.execution.endedAt = task.execution.endedAt ?? task.completedAt;
  task.execution.lastUpdatedAt = task.execution.lastUpdatedAt ?? task.updatedAt;

  return task.execution;
}

function resetTaskForFreshAttempt(task: TaskInfo): void {
  delete task.startedAt;
  delete task.completedAt;
  delete task.result;
  delete task.error;
  delete task.resultContract;
  if (task.execution) {
    task.execution.status = "pending";
    delete task.execution.runId;
    delete task.execution.sessionKey;
    delete task.execution.startedAt;
    delete task.execution.endedAt;
    task.execution.lastUpdatedAt = Date.now();
  }
}

function buildTaskExecutionIdentity(taskId: string, workerId: string): {
  executionSessionKey: string;
  executionIdempotencyKey: string;
} {
  const attemptId = generateId();
  return {
    executionSessionKey: buildTeamClawAgentSessionKey(`teamclaw-task-${taskId}-${attemptId}`),
    executionIdempotencyKey: `teamclaw-${taskId}-${workerId}-${attemptId}`,
  };
}

function appendTaskExecutionEvent(task: TaskInfo, input: TaskExecutionEventInput): TaskExecutionEvent {
  const now = input.createdAt ?? Date.now();
  const execution = ensureTaskExecution(task);

  if (input.runId) {
    execution.runId = input.runId;
  }
  if (input.sessionKey) {
    execution.sessionKey = input.sessionKey;
  }
  if (input.status) {
    execution.status = input.status;
  } else {
    execution.status = mapTaskStatusToExecutionStatus(task.status, execution.status);
  }

  if ((input.status === "running" || input.phase === "run_started") && !execution.startedAt) {
    execution.startedAt = now;
  }
  if ((input.status === "running" || input.phase === "run_started") && !task.startedAt) {
    task.startedAt = now;
  }
  if ((input.status === "running" || input.phase === "run_started") && (task.status === "pending" || task.status === "assigned")) {
    task.status = "in_progress";
  }

  if (execution.status === "completed" || execution.status === "failed") {
    execution.endedAt = execution.endedAt ?? now;
  }

  execution.lastUpdatedAt = now;
  task.updatedAt = now;

  const event: TaskExecutionEvent = {
    id: generateId(),
    type: input.type,
    createdAt: now,
    message: input.message,
    phase: input.phase,
    source: input.source,
    stream: input.stream,
    role: input.role ?? task.assignedRole,
    workerId: input.workerId ?? task.assignedWorkerId,
  };

  execution.events.push(event);
  if (execution.events.length > MAX_TASK_EXECUTION_EVENTS) {
    execution.events = execution.events.slice(-MAX_TASK_EXECUTION_EVENTS);
  }

  return event;
}

function buildTaskExecutionSummary(execution?: TaskExecution): TaskExecutionSummary | undefined {
  if (!execution) {
    return undefined;
  }

  return {
    status: execution.status,
    runId: execution.runId,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    lastUpdatedAt: execution.lastUpdatedAt,
    eventCount: execution.events.length,
    lastEvent: execution.events[execution.events.length - 1],
  };
}

function ensureControllerRunExecution(run: ControllerRunInfo): TaskExecution {
  if (!run.execution) {
    run.execution = {
      status: run.status,
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.completedAt,
      lastUpdatedAt: run.updatedAt,
      events: [],
    };
  }

  if (!Array.isArray(run.execution.events)) {
    run.execution.events = [];
  }

  run.execution.status = run.status;
  run.execution.runId = run.runId ?? run.execution.runId;
  run.execution.startedAt = run.startedAt ?? run.execution.startedAt;
  run.execution.endedAt = run.completedAt ?? run.execution.endedAt;
  run.execution.lastUpdatedAt = run.updatedAt ?? run.execution.lastUpdatedAt;
  return run.execution;
}

function appendControllerRunEvent(run: ControllerRunInfo, input: TaskExecutionEventInput): TaskExecutionEvent {
  const now = input.createdAt ?? Date.now();
  const execution = ensureControllerRunExecution(run);

  if (input.runId) {
    run.runId = input.runId;
    execution.runId = input.runId;
  }
  if (input.sessionKey) {
    execution.sessionKey = input.sessionKey;
  }
  if (input.status) {
    run.status = input.status;
    execution.status = input.status;
  }

  if ((input.status === "running" || input.phase === "run_started") && !run.startedAt) {
    run.startedAt = now;
    execution.startedAt = now;
  }
  if (run.status === "completed" || run.status === "failed") {
    run.completedAt = run.completedAt ?? now;
    execution.endedAt = execution.endedAt ?? now;
  }

  run.updatedAt = now;
  execution.lastUpdatedAt = now;

  const event: TaskExecutionEvent = {
    id: generateId(),
    type: input.type,
    createdAt: now,
    message: input.message,
    phase: input.phase,
    source: input.source,
    stream: input.stream,
  };

  execution.events.push(event);
  if (execution.events.length > MAX_TASK_EXECUTION_EVENTS) {
    execution.events = execution.events.slice(-MAX_TASK_EXECUTION_EVENTS);
  }

  return event;
}

function trimControllerRuns(state: TeamState): void {
  const runs = Object.values(state.controllerRuns)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  if (runs.length <= MAX_CONTROLLER_RUNS) {
    return;
  }
  for (const run of runs.slice(0, runs.length - MAX_CONTROLLER_RUNS)) {
    delete state.controllerRuns[run.id];
  }
}

type TaskCleanupSummary = {
  deletedTaskIds: string[];
  deletedClarificationIds: string[];
  deletedMessageIds: string[];
  stoppedPreviewIds: string[];
  deletedReportIds: string[];
  deletedProjectDirs: string[];
};

function buildEmptyTaskCleanupSummary(): TaskCleanupSummary {
  return {
    deletedTaskIds: [],
    deletedClarificationIds: [],
    deletedMessageIds: [],
    stoppedPreviewIds: [],
    deletedReportIds: [],
    deletedProjectDirs: [],
  };
}

function resolveSafeProjectDirectory(projectDir: string | undefined): string | null {
  const normalized = String(projectDir ?? "").trim().replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return null;
  }
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  const projectsRoot = path.resolve(resolveTeamClawProjectsDir());
  const projectPath = path.resolve(projectsRoot, normalized);
  const relative = path.relative(projectsRoot, projectPath);
  if (!relative || relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return projectPath;
}

async function deleteProjectDirectoryIfUnused(
  projectDir: string | undefined,
  deps: ControllerHttpDeps,
  summary: TaskCleanupSummary,
): Promise<void> {
  if (!projectDir) {
    return;
  }
  const state = deps.getTeamState();
  const stillReferencedByTask = Object.values(state?.tasks ?? {}).some((task) => task.projectDir === projectDir);
  const stillReferencedByRun = Object.values(state?.controllerRuns ?? {}).some((run) => run.projectDir === projectDir);
  if (stillReferencedByTask || stillReferencedByRun) {
    return;
  }

  const safeProjectPath = resolveSafeProjectDirectory(projectDir);
  if (!safeProjectPath) {
    deps.logger.warn(`Controller: skipped unsafe project directory cleanup for ${String(projectDir)}`);
    return;
  }
  if (!fs.existsSync(safeProjectPath)) {
    return;
  }
  await removeTrackedWorkspaceSubtree(deps.config, deps.logger, safeProjectPath);
  await fs.promises.rm(safeProjectPath, { recursive: true, force: true });
  if (fs.existsSync(safeProjectPath)) {
    throw new Error(`Project directory cleanup could not be confirmed for ${projectDir}`);
  }

  deps.updateTeamState((stateDraft) => {
    const projectRecord = findProjectRecordByDir(stateDraft, projectDir);
    if (projectRecord) {
      delete stateDraft.projects[projectRecord.id];
    }
  });
  summary.deletedProjectDirs.push(projectDir);
}

function isTaskTerminalForCleanup(task: TaskInfo | undefined): boolean {
  if (!task) {
    return true;
  }
  return task.status === "completed" || task.status === "failed";
}

function canAutoDeleteStaleControllerRun(
  run: ControllerRunInfo,
  state: TeamState | null,
  now: number,
  staleAfterMs: number,
): boolean {
  if (run.status !== "pending" && run.status !== "running") {
    return false;
  }
  const lastActivityAt = run.execution?.lastUpdatedAt ?? run.updatedAt ?? run.createdAt ?? 0;
  if (!lastActivityAt || now - lastActivityAt < staleAfterMs) {
    return false;
  }
  const ownedTasks = Object.values(state?.tasks ?? {}).filter((task) => task.controllerRunId === run.id);
  if (ownedTasks.some((task) => !isTaskTerminalForCleanup(task))) {
    return false;
  }
  const hasPendingClarification = Object.values(state?.clarifications ?? {}).some((clarification) =>
    clarification.controllerRunId === run.id && clarification.status === "pending",
  );
  return !hasPendingClarification;
}

async function pruneStaleControllerRuns(
  deps: ControllerHttpDeps,
  options?: { excludeRunId?: string },
): Promise<void> {
  const state = deps.getTeamState();
  const now = Date.now();
  const staleAfterMs = deps.config.taskTimeoutMs * 2;
  const staleRunIds = Object.values(state?.controllerRuns ?? {})
    .filter((run) => run.id !== options?.excludeRunId)
    .filter((run) => canAutoDeleteStaleControllerRun(run, state, now, staleAfterMs))
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((run) => run.id);
  for (const staleRunId of staleRunIds) {
    await deleteControllerRunCascade(staleRunId, deps, { preserveSessionArtifacts: true });
  }
}

async function deleteProjectCascade(
  projectDir: string,
  deps: ControllerHttpDeps,
): Promise<{ deleted: boolean; summary: TaskCleanupSummary & { projectDir?: string } }> {
  const safeProjectPath = resolveSafeProjectDirectory(projectDir);
  if (!safeProjectPath) {
    return { deleted: false, summary: { ...buildEmptyTaskCleanupSummary(), projectDir: undefined } };
  }

  const summary: TaskCleanupSummary & { projectDir?: string } = {
    ...buildEmptyTaskCleanupSummary(),
    projectDir,
  };
  const state = deps.getTeamState();
  const runIds = Object.values(state?.controllerRuns ?? {})
    .filter((run) => run.projectDir === projectDir)
    .map((run) => run.id);
  const taskIds = Object.values(state?.tasks ?? {})
    .filter((task) => task.projectDir === projectDir)
    .map((task) => task.id);

  for (const runId of runIds) {
    const result = await deleteControllerRunCascade(runId, deps);
    if (!result.deleted) {
      continue;
    }
    summary.deletedTaskIds.push(...result.summary.deletedTaskIds);
    summary.deletedClarificationIds.push(...result.summary.deletedClarificationIds);
    summary.deletedMessageIds.push(...result.summary.deletedMessageIds);
    summary.stoppedPreviewIds.push(...result.summary.stoppedPreviewIds);
    summary.deletedReportIds.push(...result.summary.deletedReportIds);
    summary.deletedProjectDirs.push(...result.summary.deletedProjectDirs);
  }

  for (const taskId of taskIds) {
    await deleteTaskCascade(taskId, deps, summary);
  }

  await deleteProjectDirectoryIfUnused(projectDir, deps, summary);
  if (!summary.deletedProjectDirs.includes(projectDir) && !fs.existsSync(safeProjectPath)) {
    summary.deletedProjectDirs.push(projectDir);
  }

  if (summary.deletedProjectDirs.includes(projectDir)) {
    deps.wsServer.broadcastUpdate({ type: "project:deleted", data: { projectDir } });
  }

  return { deleted: summary.deletedProjectDirs.includes(projectDir), summary };
}

async function deleteTaskCascade(
  taskId: string,
  deps: ControllerHttpDeps,
  summary: TaskCleanupSummary,
): Promise<boolean> {
  const existingTask = deps.getTeamState()?.tasks[taskId];
  if (!existingTask) {
    return false;
  }

  await cancelTaskExecution(taskId, existingTask.assignedWorkerId, "cleanup deletion", deps);
  await deps.previewManager?.stopTaskPreviews(taskId, "task deleted during cleanup");

  const previewIds = Object.values(deps.getTeamState()?.previews ?? {})
    .filter((preview) => preview.taskId === taskId)
    .map((preview) => preview.id);

  const deletedClarificationIds: string[] = [];
  const deletedMessageIds: string[] = [];
  const deletedReportIds: string[] = [];
  const normalizedSessionKey = existingTask.controllerSessionKey
    ? normalizeControllerIntakeSessionKey(existingTask.controllerSessionKey)
    : undefined;

  deps.updateTeamState((state) => {
    delete state.tasks[taskId];

    for (const clarification of Object.values(state.clarifications)) {
      if (clarification.taskId === taskId) {
        deletedClarificationIds.push(clarification.id);
        delete state.clarifications[clarification.id];
      }
    }

    if (state.messages.length > 0) {
      const keptMessages: TeamMessage[] = [];
      for (const message of state.messages) {
        if (message.taskId === taskId) {
          deletedMessageIds.push(message.id);
          continue;
        }
        keptMessages.push(message);
      }
      state.messages = keptMessages;
    }

    if (normalizedSessionKey && state.reports) {
      for (const report of Object.values(state.reports)) {
        if (normalizeControllerIntakeSessionKey(report.sessionKey) === normalizedSessionKey) {
          deletedReportIds.push(report.id);
          delete state.reports[report.id];
        }
      }
    }

    for (const run of Object.values(state.controllerRuns)) {
      if (run.sourceTaskId === taskId) {
        delete run.sourceTaskId;
      }
      if (run.createdTaskIds.includes(taskId)) {
        run.createdTaskIds = run.createdTaskIds.filter((id) => id !== taskId);
        run.updatedAt = Date.now();
      }
    }
  });

  summary.deletedTaskIds.push(taskId);
  summary.deletedClarificationIds.push(...deletedClarificationIds);
  summary.deletedMessageIds.push(...deletedMessageIds);
  summary.stoppedPreviewIds.push(...previewIds);
  summary.deletedReportIds.push(...deletedReportIds);
  await deleteProjectDirectoryIfUnused(existingTask.projectDir, deps, summary);

  deps.wsServer.broadcastUpdate({ type: "task:deleted", data: { taskId } });
  for (const clarificationId of deletedClarificationIds) {
    deps.wsServer.broadcastUpdate({ type: "clarification:deleted", data: { clarificationId, taskId } });
  }
  for (const messageId of deletedMessageIds) {
    deps.wsServer.broadcastUpdate({ type: "message:deleted", data: { messageId, taskId } });
  }

  return true;
}

async function deleteControllerRunCascade(
  runId: string,
  deps: ControllerHttpDeps,
  options?: {
    preserveSessionArtifacts?: boolean;
  },
): Promise<{
  deleted: boolean;
  summary: TaskCleanupSummary & { deletedRunId?: string };
}> {
  const run = deps.getTeamState()?.controllerRuns[runId];
  if (!run) {
    return { deleted: false, summary: { ...buildEmptyTaskCleanupSummary() } };
  }

  const summary: TaskCleanupSummary & { deletedRunId?: string } = {
    ...buildEmptyTaskCleanupSummary(),
    deletedRunId: undefined,
  };

  const linkedTaskIds = new Set<string>(run.createdTaskIds);
  for (const task of Object.values(deps.getTeamState()?.tasks ?? {})) {
    if (task.controllerRunId === run.id) {
      linkedTaskIds.add(task.id);
    }
  }

  for (const taskId of linkedTaskIds) {
    await deleteTaskCascade(taskId, deps, summary);
  }

  const deletedClarificationIds: string[] = [];
  const deletedReportIds: string[] = [];
  deps.updateTeamState((state) => {
    delete state.controllerRuns[runId];
    summary.deletedRunId = runId;

    for (const clarification of Object.values(state.clarifications)) {
      if (clarification.controllerRunId === runId) {
        deletedClarificationIds.push(clarification.id);
        delete state.clarifications[clarification.id];
      }
    }

    if (state.reports) {
      const normalizedSessionKey = normalizeControllerIntakeSessionKey(run.sessionKey);
      for (const report of Object.values(state.reports)) {
        if (!options?.preserveSessionArtifacts && normalizeControllerIntakeSessionKey(report.sessionKey) === normalizedSessionKey) {
          deletedReportIds.push(report.id);
          delete state.reports[report.id];
        }
      }
    }
  });

  summary.deletedClarificationIds.push(...deletedClarificationIds);
  summary.deletedReportIds.push(...deletedReportIds);

  deps.wsServer.broadcastUpdate({ type: "controller:run_deleted", data: { runId } });
  for (const clarificationId of deletedClarificationIds) {
    deps.wsServer.broadcastUpdate({ type: "clarification:deleted", data: { clarificationId, controllerRunId: runId } });
  }

  return { deleted: true, summary };
}

function serializeControllerRun(run?: ControllerRunInfo, includeExecutionEvents = true): Record<string, unknown> | undefined {
  if (!run) {
    return undefined;
  }

  const payload: Record<string, unknown> = { ...run };
  if (!run.execution) {
    return payload;
  }

  payload.execution = includeExecutionEvents
    ? {
        status: run.execution.status,
        runId: run.execution.runId,
        startedAt: run.execution.startedAt,
        endedAt: run.execution.endedAt,
        lastUpdatedAt: run.execution.lastUpdatedAt,
        events: run.execution.events.map((event) => ({ ...event })),
      }
    : buildTaskExecutionSummary(run.execution);

  return payload;
}

function buildControllerRunTitle(
  message: string,
  source: ControllerRunSource,
  sourceTaskTitle?: string,
): string {
  if (source === "task_follow_up") {
    const normalizedSourceTitle = String(sourceTaskTitle || "").replace(/\s+/g, " ").trim();
    if (normalizedSourceTitle) {
      const compactSourceTitle = normalizedSourceTitle.length <= 72
        ? normalizedSourceTitle
        : `${normalizedSourceTitle.slice(0, 72).trimEnd()}…`;
      return `Controller follow-up after ${compactSourceTitle}`;
    }
    return "Controller workflow follow-up";
  }

  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Controller intake";
  }
  if (normalized.length <= 100) {
    return normalized;
  }
  return `${normalized.slice(0, 100).trimEnd()}…`;
}

function createControllerRun(
  message: string,
  sessionKey: string,
  deps: ControllerHttpDeps,
  options?: {
    source?: ControllerRunSource;
    sourceTaskId?: string;
    sourceTaskTitle?: string;
  },
): ControllerRunInfo {
  const now = Date.now();
  const existingState = deps.getTeamState();
  const inheritedProject = options?.sourceTaskId
    ? resolveProjectIdentityForTaskId(options.sourceTaskId, existingState)
    : resolveProjectIdentityForSession(sessionKey, existingState)
      ?? resolveExistingProjectIdentityFromMessage(message, existingState);
  const explicitProjectId = extractExplicitProjectNameHint(message);
  const projectId = inheritedProject?.projectId ?? explicitProjectId;
  const projectDir = inheritedProject?.projectDir ?? projectId ?? deriveProjectSlug(message);
  const run: ControllerRunInfo = {
    id: generateId(),
    title: buildControllerRunTitle(message, options?.source ?? "human", options?.sourceTaskTitle),
    sessionKey,
    projectId: projectId || undefined,
    projectDir,
    source: options?.source ?? "human",
    sourceTaskId: options?.sourceTaskId,
    sourceTaskTitle: options?.sourceTaskTitle,
    request: message,
    createdTaskIds: [],
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const state = deps.updateTeamState((teamState) => {
    syncProjectRegistryEntry(teamState, {
      projectId: run.projectId,
      projectDir: run.projectDir,
      aliases: [run.projectId, extractExplicitProjectNameHint(message)],
      summary: run.title,
      updatedAt: now,
    });
    teamState.controllerRuns[run.id] = run;
    trimControllerRuns(teamState);
  });
  const createdRun = state.controllerRuns[run.id] ?? run;
  deps.wsServer.broadcastUpdate({ type: "controller:run", data: serializeControllerRun(createdRun) });
  return createdRun;
}

function resolveExistingProjectIdentityFromMessage(
  message: string,
  state: TeamState | null,
): { projectId?: string; projectDir?: string } | undefined {
  const normalizedMessage = normalizeProjectMatchingText(message);
  if (!normalizedMessage) {
    return undefined;
  }
  const explicitAlias = normalizeProjectMatchingText(extractExplicitProjectNameHint(message) ?? "");

  let best: { projectId?: string; projectDir: string; score: number; updatedAt: number } | null = null;
  const candidates = collectExistingProjectCandidates(state);
  for (const candidate of candidates) {
    const normalizedAliases = Array.from(candidate.aliases)
      .map((alias) => normalizeProjectMatchingText(alias))
      .filter(Boolean)
      .reduce<string[]>((acc, alias) => {
        acc.push(alias);
        return acc;
      }, []);
    const hasExplicitAliasMatch = explicitAlias
      ? normalizedAliases.some((alias) => alias.includes(explicitAlias) || explicitAlias.includes(alias))
      : false;
    if (explicitAlias && !hasExplicitAliasMatch) {
      continue;
    }
    const aliasScore = normalizedAliases
      .reduce((score, alias) => {
        if (!alias) {
          return score;
        }
        return normalizedMessage.includes(alias)
          ? Math.max(score, alias.split(" ").length + 10)
          : score;
      }, 0);
    const tokenScore = scoreProjectTokenOverlap(normalizedMessage, candidate.searchText);
    const totalScore = Math.max(aliasScore, tokenScore);
    if (totalScore < 2) {
      continue;
    }
    if (!best || totalScore > best.score || (totalScore === best.score && candidate.updatedAt > best.updatedAt)) {
      best = {
        projectId: candidate.projectId,
        projectDir: candidate.projectDir,
        score: totalScore,
        updatedAt: candidate.updatedAt,
      };
    }
  }
  if (best) {
    return { projectId: best.projectId, projectDir: best.projectDir };
  }
  if ((EXISTING_PROJECT_REUSE_HINT_RE.test(message) || GENERIC_PROJECT_FOLLOW_UP_RE.test(message)) && candidates.length === 1) {
    return {
      projectId: candidates[0]?.projectId,
      projectDir: candidates[0]?.projectDir,
    };
  }
  return undefined;
}

function collectExistingProjectCandidates(state: TeamState | null): Array<{
  projectId?: string;
  projectDir: string;
  aliases: Set<string>;
  searchText: string;
  updatedAt: number;
}> {
  const byProjectDir = new Map<string, { projectId?: string; aliases: Set<string>; texts: string[]; updatedAt: number }>();
  const addCandidate = (
    projectDir: string | undefined,
    text: string | undefined,
    updatedAt: number,
    alias?: string | null,
    projectId?: string,
  ) => {
    if (!projectDir) {
      return;
    }
    const entry = byProjectDir.get(projectDir) ?? { projectId, aliases: new Set<string>(), texts: [], updatedAt: 0 };
    if (!entry.projectId && projectId) {
      entry.projectId = projectId;
    }
    if (text && text.trim()) {
      entry.texts.push(text);
    }
    if (alias && alias.trim()) {
      entry.aliases.add(alias.trim());
    }
    entry.updatedAt = Math.max(entry.updatedAt, updatedAt);
    byProjectDir.set(projectDir, entry);
  };

  for (const project of Object.values(state?.projects ?? {})) {
    addCandidate(project.projectDir, project.summary, project.updatedAt, project.id, project.id);
    for (const alias of project.aliases ?? []) {
      addCandidate(project.projectDir, alias, project.updatedAt, alias, project.id);
    }
  }
  for (const run of Object.values(state?.controllerRuns ?? {})) {
    addCandidate(run.projectDir, run.request, run.updatedAt, extractProjectAliasFromText(run.request), run.projectId);
    addCandidate(run.projectDir, run.title, run.updatedAt, extractProjectAliasFromText(run.title), run.projectId);
    addCandidate(run.projectDir, run.manifest?.projectName, run.updatedAt, run.manifest?.projectName, run.projectId);
  }
  for (const task of Object.values(state?.tasks ?? {})) {
    addCandidate(task.projectDir, task.title, task.updatedAt, extractProjectAliasFromText(task.title), task.projectId);
    addCandidate(task.projectDir, task.description, task.updatedAt, extractProjectAliasFromText(task.description), task.projectId);
    addCandidate(task.projectDir, task.resultContract?.summary, task.updatedAt, null, task.projectId);
  }

  return Array.from(byProjectDir.entries()).map(([projectDir, entry]) => ({
    projectId: entry.projectId,
    projectDir,
    aliases: entry.aliases,
    searchText: entry.texts.join("\n"),
    updatedAt: entry.updatedAt,
  }));
}

function extractExplicitProjectNameHint(text: string | undefined): string | undefined {
  const value = String(text ?? "");
  const namedMatch = value.match(/(?:品牌|brand|project\s*name|产品名|名字)\s*[:：]?\s*[`"'“”]?([a-z][a-z0-9_-]{1,39})[`"'“”]?/iu);
  if (namedMatch?.[1]) {
    return deriveStableProjectKey(namedMatch[1]);
  }
  const inlineNames = Array.from(value.matchAll(/`([a-z][a-z0-9_-]{1,39})`/giu))
    .map((match) => deriveStableProjectKey(match[1]))
    .filter(Boolean);
  return inlineNames.length === 1 ? inlineNames[0] : undefined;
}

function findProjectRecordByDir(state: TeamState | null, projectDir: string | undefined) {
  if (!state || !projectDir) {
    return undefined;
  }
  return Object.values(state.projects ?? {}).find((project) => project.projectDir === projectDir);
}

function syncProjectRegistryEntry(
  state: TeamState,
  input: {
    projectId?: string;
    projectDir?: string;
    aliases?: Array<string | undefined | null>;
    summary?: string;
    updatedAt: number;
  },
): { projectId?: string; projectDir?: string } {
  state.projects = state.projects && typeof state.projects === "object" ? state.projects : {};
  let normalizedProjectId = deriveStableProjectKey(input.projectId ?? "");
  let existing = normalizedProjectId ? state.projects[normalizedProjectId] : undefined;
  const byDir = findProjectRecordByDir(state, input.projectDir);
  if (!existing && byDir) {
    existing = byDir;
  }
  if (!existing && input.projectDir) {
    normalizedProjectId = normalizedProjectId || deriveStableProjectKey(input.projectDir);
    if (normalizedProjectId) {
      existing = {
        id: normalizedProjectId,
        projectDir: input.projectDir,
        aliases: [],
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        lastUsedAt: input.updatedAt,
      };
      state.projects[normalizedProjectId] = existing;
    }
  }
  if (!existing) {
    return { projectId: normalizedProjectId || undefined, projectDir: input.projectDir };
  }
  if (normalizedProjectId && existing.id !== normalizedProjectId && !state.projects[normalizedProjectId]) {
    delete state.projects[existing.id];
    existing.id = normalizedProjectId;
    state.projects[normalizedProjectId] = existing;
  }
  if (!existing.projectDir && input.projectDir) {
    existing.projectDir = input.projectDir;
  }
  const aliasSet = new Set(existing.aliases ?? []);
  aliasSet.add(existing.id);
  if (existing.projectDir) {
    aliasSet.add(existing.projectDir);
  }
  for (const alias of input.aliases ?? []) {
    const normalizedAlias = deriveStableProjectKey(String(alias ?? ""));
    if (normalizedAlias) {
      aliasSet.add(normalizedAlias);
    }
  }
  existing.aliases = Array.from(aliasSet);
  existing.summary = input.summary || existing.summary;
  existing.updatedAt = Math.max(existing.updatedAt || 0, input.updatedAt);
  existing.lastUsedAt = Math.max(existing.lastUsedAt || 0, input.updatedAt);
  return { projectId: existing.id, projectDir: existing.projectDir };
}

function resolveProjectIdentityForSession(
  sessionKey: string,
  state: TeamState | null,
): { projectId?: string; projectDir?: string } | undefined {
  const runId = findLatestControllerRunIdForSession(sessionKey, state, { preferActive: true });
  if (!runId) {
    return undefined;
  }
  const run = state?.controllerRuns[runId];
  if (!run) {
    return undefined;
  }
  const project = findProjectRecordByDir(state, run.projectDir);
  return {
    projectId: run.projectId ?? project?.id,
    projectDir: run.projectDir ?? project?.projectDir,
  };
}

function resolveProjectIdentityForTaskId(
  taskId: string,
  state: TeamState | null,
): { projectId?: string; projectDir?: string } | undefined {
  const task = state?.tasks?.[taskId];
  if (!task) {
    return undefined;
  }
  const project = findProjectRecordByDir(state, task.projectDir);
  return {
    projectId: task.projectId ?? project?.id,
    projectDir: task.projectDir ?? project?.projectDir,
  };
}

function extractProjectAliasFromText(text: string | undefined): string | null {
  const firstMeaningfulLine = String(text ?? "")
    .split(/\n+/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find(Boolean);
  if (!firstMeaningfulLine) {
    return null;
  }
  const normalized = firstMeaningfulLine
    .replace(/^(product|optimization)\s+requirement[:：]\s*/iu, "")
    .replace(/^implement\s+/iu, "")
    .replace(/^design\s+/iu, "")
    .replace(/^enhance\s+/iu, "")
    .replace(/^qa[:\s-]+/iu, "")
    .replace(/\s+(architecture|application|web app|workflows?|improvements?)$/iu, "")
    .trim();
  if (normalized.length < 4 || normalized.length > 80) {
    return null;
  }
  return normalized;
}

function normalizeProjectMatchingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#:[\]()/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function scoreProjectTokenOverlap(message: string, candidateText: string): number {
  const messageTokens = tokenizeProjectMatchingText(message);
  if (messageTokens.size === 0) {
    return 0;
  }
  const candidateTokens = tokenizeProjectMatchingText(candidateText);
  let overlap = 0;
  for (const token of candidateTokens) {
    if (messageTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function tokenizeProjectMatchingText(text: string): Set<string> {
  return new Set(
    normalizeProjectMatchingText(text)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !PROJECT_MATCH_STOPWORDS.has(token)),
  );
}

function updateControllerRun(
  runId: string,
  deps: ControllerHttpDeps,
  updater: (run: ControllerRunInfo) => void,
): ControllerRunInfo | undefined {
  const state = deps.updateTeamState((teamState) => {
    const run = teamState.controllerRuns[runId];
    if (!run) {
      return;
    }
    updater(run);
    trimControllerRuns(teamState);
  });
  const updatedRun = state.controllerRuns[runId];
  if (updatedRun) {
    deps.wsServer.broadcastUpdate({ type: "controller:run", data: serializeControllerRun(updatedRun) });
  }
  return updatedRun;
}

function recordControllerRunEvent(
  runId: string,
  input: TaskExecutionEventInput,
  deps: ControllerHttpDeps,
): ControllerRunInfo | undefined {
  return updateControllerRun(runId, deps, (run) => {
    appendControllerRunEvent(run, input);
  });
}

function serializeTask(task?: TaskInfo, includeExecutionEvents = false): Record<string, unknown> | undefined {
  if (!task) {
    return undefined;
  }

  const payload: Record<string, unknown> = { ...task };
  if (!task.execution) {
    return payload;
  }

  payload.execution = includeExecutionEvents
    ? {
        status: task.execution.status,
        runId: task.execution.runId,
        startedAt: task.execution.startedAt,
        endedAt: task.execution.endedAt,
        lastUpdatedAt: task.execution.lastUpdatedAt,
        events: task.execution.events.map((event) => ({ ...event })),
      }
    : buildTaskExecutionSummary(task.execution);

  return payload;
}

function extractLastAssistantText(messages: unknown[]): string {
  const assistantMessages = messages.filter((message): message is { role?: unknown; content?: unknown } => {
    if (!message || typeof message !== "object") {
      return false;
    }
    return (message as { role?: unknown }).role === "assistant";
  });

  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  if (!lastAssistant) {
    return "";
  }

  if (typeof lastAssistant.content === "string") {
    return lastAssistant.content;
  }

  if (Array.isArray(lastAssistant.content)) {
    const textBlocks = lastAssistant.content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
      })
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean);
    if (textBlocks.length > 0) {
      return textBlocks.join("\n");
    }
  }

  return JSON.stringify(lastAssistant);
}

type SessionProgressEntry = {
  fingerprint: string;
  message: string;
  phase: string;
  stream: string;
  isRateLimit: boolean;
};

function normalizeSessionRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "toolresult") {
    return "tool_result";
  }
  return normalized;
}

function normalizeBlockType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function truncateProgressMessage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= MAX_SESSION_PROGRESS_MESSAGE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SESSION_PROGRESS_MESSAGE_CHARS)}\n… (truncated)`;
}

function normalizeProgressComparableText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function renderSessionMessage(message: Record<string, unknown>, role: string): { message: string; stream: string } {
  const content = message.content;
  if (typeof content === "string") {
    return {
      message: truncateProgressMessage(content),
      stream: role,
    };
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const toolCalls: string[] = [];
    let toolResultCount = 0;
    let toolResultErrors = 0;

    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const block = entry as Record<string, unknown>;
      const type = normalizeBlockType(block.type);
      if (type === "text") {
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (text) {
          textParts.push(text);
        }
        continue;
      }

      if (TOOL_CALL_BLOCK_TYPES.has(type)) {
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (name) {
          toolCalls.push(name);
        }
        continue;
      }

      if (TOOL_RESULT_BLOCK_TYPES.has(type)) {
        toolResultCount += 1;
        if (block.is_error === true) {
          toolResultErrors += 1;
        }
      }
    }

    const parts: string[] = [];
    if (textParts.length > 0) {
      parts.push(textParts.join("\n"));
    }
    if (toolCalls.length > 0) {
      parts.push(`[tool call] ${toolCalls.join(", ")}`);
    }
    if (toolResultCount > 0) {
      parts.push(`[tool result] ${toolResultCount}${toolResultErrors > 0 ? ` (${toolResultErrors} error)` : ""}`);
    }

    if (parts.length > 0) {
      return {
        message: truncateProgressMessage(parts.join("\n")),
        stream: textParts.length > 0 ? role : "tool",
      };
    }
  }

  const fallbackToolName = typeof message.toolName === "string"
    ? message.toolName.trim()
    : (typeof message.tool_name === "string" ? message.tool_name.trim() : "");
  if (fallbackToolName) {
    return {
      message: `[tool call] ${fallbackToolName}`,
      stream: "tool",
    };
  }

  return {
    message: truncateProgressMessage(safeJsonStringify(message)),
    stream: role || "session",
  };
}

function buildSessionProgressEntries(messages: unknown[], controllerMessage: string): SessionProgressEntry[] {
  const entries: SessionProgressEntry[] = [];
  const normalizedControllerMessage = normalizeProgressComparableText(controllerMessage);

  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object") {
      continue;
    }

    const message = rawMessage as Record<string, unknown>;
    const role = normalizeSessionRole(message.role);
    if (!role) {
      continue;
    }

    const rendered = renderSessionMessage(message, role);
    if (!rendered.message) {
      continue;
    }

    const comparableMessage = normalizeProgressComparableText(rendered.message);
    if (role === "user" && normalizedControllerMessage && comparableMessage.includes(normalizedControllerMessage)) {
      continue;
    }

    entries.push({
      fingerprint: `${rendered.stream}:${comparableMessage}`,
      message: rendered.message,
      phase: rendered.stream,
      stream: rendered.stream,
      isRateLimit: isRateLimitMessage(rendered.message),
    });
  }

  return entries;
}

function getNewSessionProgressEntries(
  entries: SessionProgressEntry[],
  previousFingerprints: string[],
): SessionProgressEntry[] {
  if (entries.length === 0) {
    return [];
  }
  if (previousFingerprints.length === 0) {
    return entries;
  }

  const currentFingerprints = entries.map((entry) => entry.fingerprint);
  const maxOverlap = Math.min(previousFingerprints.length, currentFingerprints.length);
  let overlap = 0;

  for (let size = maxOverlap; size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (previousFingerprints[previousFingerprints.length - size + index] !== currentFingerprints[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = size;
      break;
    }
  }

  return entries.slice(overlap);
}

function formatDuration(timeoutMs: number): string {
  const totalSeconds = Math.ceil(timeoutMs / 1000);
  if (totalSeconds % 3600 === 0) {
    const hours = totalSeconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
}

function isRateLimitMessage(value: string): boolean {
  return /(rate[_ ]limit|too many requests|429\b|resource has been exhausted|tokens per day|quota|throttl)/i.test(
    String(value || ""),
  );
}

function isStillWaitingResponse(value: string): boolean {
  return value.replace(/\s+/g, " ").trim() === CONTROLLER_RATE_LIMIT_WAITING_SENTINEL;
}

function normalizeControllerIntakeSessionKey(input: unknown): string {
  const fallback = `${CONTROLLER_INTAKE_SESSION_PREFIX}default`;
  if (typeof input !== "string") {
    return fallback;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }

  const runtimeMatch = trimmed.match(CONTROLLER_INTAKE_AGENT_SESSION_RE);
  if (trimmed.startsWith("agent:") && !runtimeMatch) {
    return fallback;
  }

  const logicalKey = runtimeMatch?.[1] ?? trimmed;
  if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(logicalKey)) {
    return fallback;
  }

  const normalizedLogicalKey = logicalKey.startsWith(CONTROLLER_INTAKE_SESSION_PREFIX)
    ? logicalKey
    : `${CONTROLLER_INTAKE_SESSION_PREFIX}${logicalKey}`;
  return buildTeamClawAgentSessionKey(normalizedLogicalKey);
}

async function withSerializedControllerIntake<T>(
  sessionKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const previous = controllerIntakeQueue.get(normalizedSessionKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  controllerIntakeQueue.set(normalizedSessionKey, current);
  try {
    await previous;
    return await fn();
  } finally {
    releaseCurrent();
    if (controllerIntakeQueue.get(normalizedSessionKey) === current) {
      controllerIntakeQueue.delete(normalizedSessionKey);
    }
  }
}

function collectTaskIds(state: TeamState | null): Set<string> {
  return new Set(Object.keys(state?.tasks ?? {}));
}

function normalizeControllerTaskMatchText(input: unknown): string {
  return typeof input === "string" ? input.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

function taskMatchesManifestCreatedTask(
  task: TaskInfo,
  manifestTask: ControllerOrchestrationManifest["createdTasks"][number],
): boolean {
  if (normalizeControllerTaskMatchText(task.title) !== normalizeControllerTaskMatchText(manifestTask.title)) {
    return false;
  }
  if (manifestTask.assignedRole && task.assignedRole && manifestTask.assignedRole !== task.assignedRole) {
    return false;
  }
  if (manifestTask.assignedRole && !task.assignedRole) {
    return false;
  }
  return task.createdBy === "controller";
}

function scoreControllerTaskBindingCandidate(task: TaskInfo): number {
  switch (task.status) {
    case "pending":
      return 6;
    case "assigned":
      return 5;
    case "in_progress":
      return 4;
    case "review":
      return 3;
    case "blocked":
      return 2;
    case "completed":
      return 1;
    case "failed":
    default:
      return 0;
  }
}

function reconcileControllerManifestTaskBindings(
  sessionKey: string,
  createdTaskIds: string[],
  manifest: ControllerOrchestrationManifest | undefined,
  controllerRunId: string,
  deps: ControllerHttpDeps,
): { taskIds: string[]; linkedTaskIds: string[] } {
  if (!manifest || manifest.createdTasks.length === 0) {
    return { taskIds: createdTaskIds, linkedTaskIds: [] };
  }

  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const linkedTaskIds: string[] = [];

  deps.updateTeamState((state) => {
    const usedTaskIds = new Set(createdTaskIds);
    for (const manifestTask of manifest.createdTasks) {
      const existingTaskId = Array.from(usedTaskIds).find((taskId) => {
        const task = state.tasks[taskId];
        return !!task && taskMatchesManifestCreatedTask(task, manifestTask);
      });
      const matchedTask = existingTaskId
        ? state.tasks[existingTaskId]
        : Object.values(state.tasks)
          .filter((task) => !usedTaskIds.has(task.id))
          .filter((task) => taskMatchesManifestCreatedTask(task, manifestTask))
          .sort((left, right) => {
            const scoreDelta = scoreControllerTaskBindingCandidate(right) - scoreControllerTaskBindingCandidate(left);
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            return right.updatedAt - left.updatedAt;
          })[0];

      if (!matchedTask) {
        continue;
      }

      if (matchedTask.controllerSessionKey !== normalizedSessionKey) {
        matchedTask.controllerSessionKey = normalizedSessionKey;
      }
      matchedTask.controllerRunId = controllerRunId;
      if (!usedTaskIds.has(matchedTask.id)) {
        usedTaskIds.add(matchedTask.id);
        linkedTaskIds.push(matchedTask.id);
      }
    }
  });

  return {
    taskIds: Array.from(new Set([...createdTaskIds, ...linkedTaskIds])),
    linkedTaskIds,
  };
}

function tagControllerCreatedTasks(
  taskIdsBeforeRun: Set<string>,
  controllerRunId: string,
  sessionKey: string,
  deps: ControllerHttpDeps,
): string[] {
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const taggedTaskIds: string[] = [];
  deps.updateTeamState((state) => {
    for (const task of Object.values(state.tasks)) {
      if (taskIdsBeforeRun.has(task.id)) {
        continue;
      }
      if (task.createdBy !== "controller") {
        continue;
      }
      task.controllerRunId = controllerRunId;
      if (!task.controllerSessionKey) {
        task.controllerSessionKey = normalizedSessionKey;
      }
      if (normalizeControllerIntakeSessionKey(task.controllerSessionKey) !== normalizedSessionKey) {
        continue;
      }
      taggedTaskIds.push(task.id);
    }
  });
  return taggedTaskIds;
}

function isActiveControllerRun(run: ControllerRunInfo): boolean {
  return run.status === "pending" || run.status === "running";
}

function findLatestControllerRunIdForSession(
  sessionKey: string,
  state: TeamState | null,
  options?: { preferActive?: boolean },
): string | null {
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const matchingRuns = Object.values(state?.controllerRuns ?? {})
    .filter((run) => normalizeControllerIntakeSessionKey(run.sessionKey) === normalizedSessionKey)
    .sort((left, right) => {
      if (options?.preferActive) {
        const leftScore = isActiveControllerRun(left) ? 1 : 0;
        const rightScore = isActiveControllerRun(right) ? 1 : 0;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
      }
      return right.updatedAt - left.updatedAt;
    });
  return matchingRuns[0]?.id ?? null;
}

function resolveProjectDirForSession(
  sessionKey: string,
  state: TeamState | null,
): string | undefined {
  return resolveProjectIdentityForSession(sessionKey, state)?.projectDir;
}

function resolveControllerWorkflowSessionKey(task: TaskInfo, state: TeamState | null): string | undefined {
  if (task.controllerSessionKey) {
    return normalizeControllerIntakeSessionKey(task.controllerSessionKey);
  }
  if (!state || task.createdBy !== "controller") {
    return undefined;
  }

  const sortedRuns = Object.values(state.controllerRuns)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const directRun = sortedRuns.find((run) =>
    run.sourceTaskId === task.id || run.createdTaskIds.includes(task.id),
  );
  if (directRun) {
    return normalizeControllerIntakeSessionKey(directRun.sessionKey);
  }

  const manifestRun = sortedRuns.find((run) =>
    run.manifest?.createdTasks.some((manifestTask) => taskMatchesManifestCreatedTask(task, manifestTask)),
  );
  return manifestRun ? normalizeControllerIntakeSessionKey(manifestRun.sessionKey) : undefined;
}

function buildControllerManifestEventMessage(manifest: ControllerOrchestrationManifest): string {
  const parts = [
    `Structured orchestration manifest recorded.`,
    `roles=${manifest.requiredRoles.join(", ") || "none"}`,
    `created=${manifest.createdTasks.length}`,
    `deferred=${manifest.deferredTasks.length}`,
  ];
  if (manifest.clarificationsNeeded) {
    parts.push(`clarifications=${manifest.clarificationQuestions.length}`);
  }
  if (manifest.requirementFullyComplete) {
    parts.push("requirementFullyComplete=true");
  }
  return parts.join(" ");
}

function buildControllerManifestReply(
  manifest: ControllerOrchestrationManifest | undefined,
  createdTaskIds: string[],
  state: TeamState | null,
  fallbackReply: string,
): string {
  if (!manifest) {
    const warning = "Warning: controller did not submit a structured orchestration manifest for this run.";
    return fallbackReply ? `${fallbackReply}\n\n${warning}` : warning;
  }

  const actualCreatedTasks = createdTaskIds
    .map((taskId) => state?.tasks?.[taskId])
    .filter((task): task is TaskInfo => !!task);

  const lines: string[] = [
    `Requirement summary: ${manifest.requirementSummary}`,
    `Required roles: ${manifest.requiredRoles.join(", ") || "none"}`,
  ];

  if (actualCreatedTasks.length > 0) {
    lines.push("", "Created execution-ready tasks:");
    for (const task of actualCreatedTasks) {
      const roleLabel = task.assignedRole ? ` (${task.assignedRole})` : "";
      lines.push(`- [${task.id}] ${task.title}${roleLabel}`);
    }
  } else if (manifest.createdTasks.length > 0) {
    lines.push("", "Manifest planned created tasks:");
    for (const task of manifest.createdTasks) {
      const roleLabel = task.assignedRole ? ` (${task.assignedRole})` : "";
      lines.push(`- ${task.title}${roleLabel}: ${task.expectedOutcome}`);
    }
  } else {
    lines.push("", "Created execution-ready tasks: none.");
  }

  if (manifest.deferredTasks.length > 0) {
    lines.push("", "Deferred tasks:");
    for (const task of manifest.deferredTasks) {
      const roleLabel = task.assignedRole ? ` (${task.assignedRole})` : "";
      lines.push(`- ${task.title}${roleLabel}: blocked by ${task.blockedBy}; create when ${task.whenReady}`);
    }
  }

  if (manifest.clarificationsNeeded) {
    lines.push("", "Clarifications needed:");
    for (const question of manifest.clarificationQuestions) {
      lines.push(`- ${question}`);
    }
  }

  // ── Team Kickoff Meeting (brief note; full details rendered in UI) ───
  if (manifest.kickoffPlan?.assessments?.length) {
    const kp = manifest.kickoffPlan;
    const needed = kp.assessments.filter((a) => a.needed).length;
    lines.push(
      "",
      `Team Kickoff Meeting: ${kp.assessments.length} roles assessed, ${needed} confirmed needed. See the Kickoff Meeting panel in the dashboard for full discussion details.`,
    );
  }

  if (manifest.handoffPlan) {
    lines.push("", `Handoff plan: ${manifest.handoffPlan}`);
  }
  if (manifest.notes) {
    lines.push("", `Notes: ${manifest.notes}`);
  }
  if (manifest.createdTasks.length !== createdTaskIds.length) {
    lines.push(
      "",
      `Warning: manifest declared ${manifest.createdTasks.length} created task(s), but TeamClaw recorded ${createdTaskIds.length}.`,
    );
  }

  return lines.join("\n");
}

function summarizeManifestExpectedOutcome(task: TaskInfo): string {
  const raw = task.result || task.progress || task.description || "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Produce the concrete deliverable described by this task and report the result back to the controller.";
  }
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 180).trimEnd()}…`;
}

function inferManifestRolesFromText(text: string): RoleId[] {
  const normalized = text.toLowerCase();
  const roleIds: RoleId[] = [];
  for (const role of getActiveRoles()) {
    if (normalized.includes(role.id) || normalized.includes(role.label.toLowerCase())) {
      roleIds.push(role.id);
    }
  }
  return roleIds;
}

function inferClarificationQuestionsFromReply(text: string): string[] {
  const candidates = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.includes("?"))
    .map((line) => line.replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  return Array.from(new Set(candidates)).slice(0, 5);
}

function buildBackfilledControllerManifest(
  request: string,
  rawReply: string,
  createdTaskIds: string[],
  state: TeamState | null,
): ControllerOrchestrationManifest {
  const actualCreatedTasks = createdTaskIds
    .map((taskId) => state?.tasks?.[taskId])
    .filter((task): task is TaskInfo => !!task);
  const inferredRoles = new Set<RoleId>();
  for (const task of actualCreatedTasks) {
    if (task.assignedRole) {
      inferredRoles.add(task.assignedRole);
    }
  }
  for (const roleId of inferManifestRolesFromText(rawReply)) {
    inferredRoles.add(roleId);
  }
  for (const roleId of inferManifestRolesFromText(request)) {
    inferredRoles.add(roleId);
  }
  // When no roles could be inferred at all, default the first-pass requirement analysis
  // to architect rather than developer. This keeps repository analysis, feasibility
  // assessment, and technical decomposition out of implementation-only developer tasks.
  if (inferredRoles.size === 0) {
    inferredRoles.add("architect");
  }
  const clarificationQuestions = inferClarificationQuestionsFromReply(rawReply);
  return {
    version: "1.0",
    projectName: actualCreatedTasks.find((task) => task.projectId)?.projectId,
    requirementSummary: request.replace(/\s+/g, " ").trim() || "Controller requirement summary unavailable.",
    requiredRoles: Array.from(inferredRoles),
    clarificationsNeeded: clarificationQuestions.length > 0 && actualCreatedTasks.length === 0,
    clarificationQuestions,
    clarificationSchemas: clarificationQuestions.map((question) => ({
      kind: "text",
      title: question,
      required: true,
      placeholder: "Provide the missing information",
    })),
    createdTasks: actualCreatedTasks.map((task) => ({
      title: task.title,
      assignedRole: task.assignedRole,
      expectedOutcome: summarizeManifestExpectedOutcome(task),
    })),
    deferredTasks: [],
    handoffPlan: actualCreatedTasks.length > 0
      ? "Assigned workers should complete the created execution-ready tasks, report progress, and let the controller schedule downstream work after prerequisites are satisfied."
      : undefined,
    notes: "Backfilled by the controller because the model did not submit the required structured manifest.",
  };
}

function looksLikeSoftwareRequirement(request: string): boolean {
  const normalized = request.toLowerCase();
  return /(api|backend|frontend|fastapi|react|vue|node|python|typescript|javascript|sql|database|service|app|web|mobile|docker|kubernetes|deploy|stderr|stdout|logging|logger|log file|config|yaml|json|cli|command|build|test|compile|bug|fix|output|file|repo|repository|code|测试|系统|平台|接口|服务|数据库|应用|前端|后端|日志|输出|文件|配置|命令|编译|构建|修复|代码|仓库)/.test(normalized);
}

function looksLikeManualExecutionClarification(question: string): boolean {
  const normalized = question.toLowerCase();
  return /(请先|请运行|请执行|请重试|请重新编译|请复现|run\b|rerun\b|retry\b|rebuild\b|recompile\b|git pull\b|go build\b|npm test\b|pnpm test\b|yarn test\b|pytest\b|cargo test\b|是否仍然|does it still|still crash|still fail)/i.test(normalized);
}

function extractExecutableFollowUpFromClarification(question: string): string | null {
  const trimmed = String(question || "").trim();
  if (!trimmed || !looksLikeManualExecutionClarification(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ").trim();
  return [
    "Continue the same requirement by executing the obvious validation or rebuild step yourself instead of asking the human to run it manually.",
    `Requested follow-up verification: ${normalized}`,
    "Run the needed build/test/repro steps inside the project workspace, inspect the real outcome, and then either fix the issue or report the verified blocker with concrete evidence.",
  ].join("\n\n");
}

function isArchitectureFirstRequirement(request: string): boolean {
  const normalized = request.toLowerCase();
  return /(analy[sz]e|analysis|assess|feasibility|architecture|architect|design|plan|decompose|migration|port|rewrite|refactor|audit|review|repo|repository|codebase|golang|go\b|typescript|可行性|评估|架构|设计|分析|拆分|迁移|移植|重写|审计|仓库|代码库)/.test(normalized);
}

function chooseFallbackAssignedRole(manifest: ControllerOrchestrationManifest, request: string): RoleId {
  const requiredRoles = manifest.requiredRoles;
  const implementationLikeRequest = looksLikeSoftwareRequirement(request) && !isArchitectureFirstRequirement(request);
  if (requiredRoles.length === 1 && requiredRoles[0] === "architect" && implementationLikeRequest) {
    return "developer";
  }
  if (requiredRoles.length === 0) {
    return isArchitectureFirstRequirement(request) ? "architect" : "developer";
  }
  if (isArchitectureFirstRequirement(request)) {
    if (requiredRoles.includes("architect")) {
      return "architect";
    }
    if (requiredRoles.includes("pm")) {
      return "pm";
    }
  }
  if (requiredRoles.includes("developer") && requiredRoles.length === 1) {
    return "developer";
  }
  return requiredRoles[0] ?? (isArchitectureFirstRequirement(request) ? "architect" : "developer");
}

function buildFallbackControllerTaskTitle(request: string, assignedRole?: RoleId): string {
  const firstMeaningfulLine = request
    .split(/\n+/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (firstMeaningfulLine) {
    const normalized = firstMeaningfulLine.replace(/^需求[:：]?\s*/, "").trim();
    if (normalized.length > 0) {
      const capped = normalized.slice(0, 72).trim();
      return /[\u4e00-\u9fff]/.test(capped)
        ? `实现${capped}`
        : `Implement ${capped}`;
    }
  }
  if (assignedRole === "architect") {
    return "Analyze the repository and produce an architecture/feasibility plan";
  }
  return assignedRole === getActiveDefaultRole()
    ? "Implement the requested software deliverable"
    : `Perform the requested ${assignedRole || "software"} work`;
}

function looksLikeSupplementalHumanContextUpdate(request: string): boolean {
  const normalized = request.toLowerCase();
  const hasEndpointOrCredentialHint = /(apikey|api key|token|credential|endpoint|base url|provider|model list|models接口|连接信息|兼容接口|供应商|可用模型)/i.test(request);
  const urlCount = (request.match(/https?:\/\//gi) || []).length;
  const looksLikeFreshImplementationAsk = /(implement|build|create|write|develop|fix|refactor|design|架构|设计|实现|开发|修复|重构|创建)/i.test(normalized);
  return !looksLikeFreshImplementationAsk && (hasEndpointOrCredentialHint || urlCount >= 2);
}

function getActiveTasksForSupplementalHumanContext(
  controllerRunId: string,
  sessionKey: string,
  manifest: ControllerOrchestrationManifest,
  state: TeamState | null,
): TaskInfo[] {
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const runProjectDir = state?.controllerRuns?.[controllerRunId]?.projectDir;
  const requiredRoles = new Set(manifest.requiredRoles);
  return Object.values(state?.tasks ?? {})
    .filter((task) => task.status === "assigned" || task.status === "in_progress" || task.status === "review")
    .filter((task) => normalizeControllerIntakeSessionKey(task.controllerSessionKey) === normalizedSessionKey)
    .filter((task) => !runProjectDir || task.projectDir === runProjectDir)
    .filter((task) => requiredRoles.size === 0 || (task.assignedRole ? requiredRoles.has(task.assignedRole) : false))
    .sort((left, right) => {
      const leftScore = left.status === "in_progress" ? 2 : left.status === "assigned" ? 1 : 0;
      const rightScore = right.status === "in_progress" ? 2 : right.status === "assigned" ? 1 : 0;
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return right.updatedAt - left.updatedAt;
    });
}

async function forwardSupplementalHumanContextToActiveTasks(
  controllerRunId: string,
  sessionKey: string,
  request: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerHttpDeps,
): Promise<string[]> {
  if (!looksLikeSupplementalHumanContextUpdate(request)) {
    return [];
  }
  const state = deps.getTeamState();
  const targetTasks = getActiveTasksForSupplementalHumanContext(controllerRunId, sessionKey, manifest, state);
  if (targetTasks.length === 0) {
    return [];
  }

  const createdAt = Date.now();
  const messages: TeamMessage[] = targetTasks.map((task) => ({
    id: generateId(),
    from: "human-intake",
    to: task.assignedWorkerId,
    toRole: task.assignedRole,
    type: "direct",
    content: request,
    contract: ensureTeamMessageContract(null, {
      type: "direct",
      content: request,
      toRole: task.assignedRole,
      taskId: task.id,
      intent: "update",
      needsResponse: false,
    }),
    taskId: task.id,
    createdAt,
  }));

  deps.updateTeamState((teamState) => {
    teamState.messages.push(...messages);
  });

  for (const message of messages) {
    recordTaskExecutionEvent(message.taskId!, {
      type: "progress",
      phase: "human_context_forwarded",
      source: "controller",
      status: "running",
      message: "Human provided supplemental context for this task. Review task messages for the new details.",
    }, deps);
    deps.wsServer.broadcastUpdate({ type: "message:new", data: message });
    if (message.to) {
      const worker = deps.getTeamState()?.workers?.[message.to];
      if (worker && worker.status !== "offline") {
        try {
          await deliverMessageToWorker(worker, message, deps);
        } catch (err) {
          deps.logger.warn(`Controller: failed to forward supplemental context to ${worker.id}: ${String(err)}`);
        }
      }
    }
  }

  manifest.notes = manifest.notes
    ? `${manifest.notes} TeamClaw forwarded this human intake as supplemental context to active task(s): ${targetTasks.map((task) => task.id).join(", ")}.`
    : `TeamClaw forwarded this human intake as supplemental context to active task(s): ${targetTasks.map((task) => task.id).join(", ")}.`;
  updateControllerRun(controllerRunId, deps, (run) => {
    run.manifest = manifest;
    appendControllerRunEvent(run, {
      type: "warning",
      phase: "context_forwarded",
      source: "controller",
      status: "running",
      sessionKey,
      message: `Forwarded supplemental human context to active task(s): ${targetTasks.map((task) => task.id).join(", ")}`,
    });
  });
  return targetTasks.map((task) => task.id);
}

async function createControllerManagedTask(
  input: {
    title: string;
    description: string;
    priority?: TaskPriority;
    assignedRole?: RoleId;
    createdBy: string;
    controllerRunId?: string;
    controllerSessionKey?: string;
    projectName?: string;
    recommendedSkills?: string[];
  },
  deps: ControllerHttpDeps,
): Promise<TaskInfo | undefined> {
  const taskId = generateId();
  const now = Date.now();
  const repoState = await refreshControllerRepoState(deps);
  const normalizedSessionKey = input.createdBy === "controller" && input.controllerSessionKey
    ? normalizeControllerIntakeSessionKey(input.controllerSessionKey)
    : undefined;

  const inheritedProject = normalizedSessionKey
    ? resolveProjectIdentityForSession(normalizedSessionKey, deps.getTeamState())
    : undefined;
  const explicitProjectId = deriveStableProjectKey(input.projectName ?? "");
  const projectId = inheritedProject?.projectId ?? (explicitProjectId || undefined);
  const projectDir = inheritedProject?.projectDir ?? projectId ?? deriveProjectSlug(input.title);

  const normalizedRecommendedSkills = normalizeRecommendedSkills(input.recommendedSkills ?? []);
  const task: TaskInfo = {
    id: taskId,
    title: input.title,
    description: input.description,
    status: "pending",
    priority: input.priority ?? "medium",
    assignedRole: input.assignedRole,
    createdBy: input.createdBy,
    recommendedSkills: normalizedRecommendedSkills.length > 0 ? normalizedRecommendedSkills : undefined,
    controllerRunId: input.createdBy === "controller" ? input.controllerRunId : undefined,
    controllerSessionKey: normalizedSessionKey,
    projectId,
    projectDir,
    createdAt: now,
    updatedAt: now,
  };

  deps.updateTeamState((state) => {
    const project = syncProjectRegistryEntry(state, {
      projectId: task.projectId,
      projectDir: task.projectDir,
      aliases: [input.projectName, task.projectId],
      summary: task.title,
      updatedAt: now,
    });
    task.projectId = project.projectId;
    task.projectDir = project.projectDir;
    state.tasks[taskId] = task;
  });
  recordTaskExecutionEvent(taskId, {
    type: "lifecycle",
    phase: "created",
    source: "controller",
    status: "pending",
    message: `Task created by ${input.createdBy}.`,
    role: input.assignedRole,
  }, deps);
  if (repoState?.enabled) {
    recordTaskExecutionEvent(taskId, {
      type: "lifecycle",
      phase: "repo_ready",
      source: "controller",
      status: "pending",
      message: repoState.remoteReady && repoState.remoteUrl
        ? `Git collaboration ready on ${repoState.defaultBranch} with remote ${repoState.remoteUrl}.`
        : `Git collaboration ready on ${repoState.defaultBranch} using controller-managed bundle sync.`,
      role: input.assignedRole,
    }, deps);
  }
  if (normalizedRecommendedSkills.length > 0) {
    recordTaskExecutionEvent(taskId, {
      type: "lifecycle",
      phase: "skills_recommended",
      source: "controller",
      status: "pending",
      message: `Recommended skills: ${normalizedRecommendedSkills.join(", ")}`,
      role: input.assignedRole,
    }, deps);
  }

  await autoAssignPendingTasks(deps);

  const updatedTask = deps.getTeamState()?.tasks[taskId];
  deps.wsServer.broadcastUpdate({ type: "task:created", data: serializeTask(updatedTask) });
  return updatedTask;
}

async function maybeBackfillExecutionReadyTask(
  controllerRunId: string,
  sessionKey: string,
  request: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerHttpDeps,
  options?: {
    source?: ControllerRunSource;
  },
): Promise<string[]> {
  if (manifest.createdTasks.length > 0 || manifest.clarificationsNeeded || manifest.requirementFullyComplete) {
    return [];
  }
  if (options?.source === "task_follow_up") {
    return [];
  }
  const likelyTechnicalRequest = looksLikeSoftwareRequirement(request)
    || manifest.requiredRoles.length > 0
    || /code|repo|repository|日志|输出|文件|配置|命令|修复|实现|修改/.test(request.toLowerCase());
  if (!likelyTechnicalRequest) {
    return [];
  }
  const forwardedTaskIds = await forwardSupplementalHumanContextToActiveTasks(
    controllerRunId,
    sessionKey,
    request,
    manifest,
    deps,
  );
  if (forwardedTaskIds.length > 0) {
    return [];
  }

  const assignedRole = chooseFallbackAssignedRole(manifest, request);
  const task = await createControllerManagedTask({
    title: buildFallbackControllerTaskTitle(request, assignedRole),
    description: request,
    assignedRole,
    createdBy: "controller",
    controllerRunId,
    controllerSessionKey: sessionKey,
    recommendedSkills: resolveActiveRoleSkills(assignedRole, []),
  }, deps);
  if (!task) {
    return [];
  }

  manifest.createdTasks = [{
    title: task.title,
    assignedRole: task.assignedRole,
    expectedOutcome: summarizeManifestExpectedOutcome(task),
  }];
  manifest.notes = manifest.notes
    ? `${manifest.notes} Controller synthesized a fallback execution-ready task because the model returned no created tasks.`
    : "Controller synthesized a fallback execution-ready task because the model returned no created tasks.";
  updateControllerRun(controllerRunId, deps, (run) => {
    run.manifest = manifest;
    appendControllerRunEvent(run, {
      type: "warning",
      phase: "task_backfilled",
      source: "controller",
      status: "running",
      sessionKey,
      message: `Controller synthesized fallback task ${task.id} (${task.assignedRole || "unassigned"}).`,
    });
  });
  return [task.id];
}

function ensureControllerManifest(
  controllerRunId: string,
  sessionKey: string,
  request: string,
  rawReply: string,
  createdTaskIds: string[],
  deps: ControllerHttpDeps,
): ControllerOrchestrationManifest {
  const currentState = deps.getTeamState();
  const existingManifest = currentState?.controllerRuns?.[controllerRunId]?.manifest;
  if (existingManifest) {
    return existingManifest;
  }

  const manifest = buildBackfilledControllerManifest(request, rawReply, createdTaskIds, currentState);
  updateControllerRun(controllerRunId, deps, (run) => {
    run.manifest = manifest;
    appendControllerRunEvent(run, {
      type: "warning",
      phase: "manifest_backfilled",
      source: "controller",
      status: "running",
      sessionKey,
      message: "Controller did not submit a structured manifest; TeamClaw backfilled a minimal manifest from the recorded run state.",
    });
  });
  return manifest;
}

function buildControllerFollowUpMessage(task: TaskInfo, state: TeamState | null): string {
  const parts = [
    `A controller-created TeamClaw task has ${task.status === "failed" ? "failed" : "completed"}.`,
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    task.assignedRole ? `Role: ${task.assignedRole}` : "",
    "",
    "## Original Task",
    task.description || "No task description was recorded.",
  ];

  if (task.result) {
    parts.push("", "## Task Result", task.result);
  }
  const resultContractSection = buildResultContractSection(task);
  if (resultContractSection) {
    parts.push("", resultContractSection);
  }
  if (task.error) {
    parts.push("", "## Task Error", task.error);
  }

  // Include preview URLs so the controller can present them to the human
  if (task.resultContract?.deliverables) {
    const liveDeliverables = task.resultContract.deliverables.filter((d) => d.liveUrl);
    if (liveDeliverables.length > 0) {
      parts.push("", "## Live Previews");
      for (const d of liveDeliverables) {
        parts.push(`- ${d.summary || d.value}: ${d.liveUrl}`);
      }
    }
  }

  // Inject prior manifest context (deferred tasks, clarification questions) so the
  // controller knows the original plan and can advance it
  if (state) {
    const sessionKey = task.controllerSessionKey;
    if (sessionKey) {
      const priorRuns = Object.values(state.controllerRuns)
        .filter((run) => normalizeControllerIntakeSessionKey(run.sessionKey) === normalizeControllerIntakeSessionKey(sessionKey) && run.manifest)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      // Collect deferred tasks from the latest manifest that had them
      const latestWithDeferred = priorRuns.find((run) => run.manifest!.deferredTasks && run.manifest!.deferredTasks.length > 0);
      if (latestWithDeferred?.manifest?.deferredTasks) {
        parts.push("", "## Prior Orchestration Plan (Deferred Tasks)");
        parts.push("These tasks were identified in the original plan but deferred until prerequisites were met:");
        for (const dt of latestWithDeferred.manifest.deferredTasks) {
          const blockedBy = dt.blockedBy ? ` [blocked by: ${dt.blockedBy}]` : "";
          parts.push(`- ${dt.title} (${dt.assignedRole || "any"})${blockedBy}`);
        }
      }

      // Collect only still-pending clarification questions for this session.
      const pendingClarifications = Object.values(state.clarifications)
        .filter((clarification) =>
          clarification.status === "pending"
          && normalizeControllerIntakeSessionKey(clarification.controllerSessionKey) === normalizeControllerIntakeSessionKey(sessionKey),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const priorQuestions = pendingClarifications
        .map((clarification) => clarification.question)
        .filter(Boolean);
      if (priorQuestions.length > 0) {
        parts.push("", "## Prior Clarification Questions (from earlier runs)");
        for (const q of priorQuestions.slice(0, 5)) {
          parts.push(`- ${q}`);
        }
      }
    }
  }

  parts.push(
    "",
    "## Controller Follow-up",
    "Continue orchestrating this same requirement.",
    "Review the current TeamClaw state before acting.",
    "Create only the next execution-ready task(s) whose prerequisites are now satisfied.",
    "For any large-scale requirement, prefer parallel fan-out over serial mega-phases: if multiple independent developer workstreams are ready, create all of them now instead of a single umbrella developer task.",
    "Decompose developer work by module or subsystem with clear file ownership and interfaces so multiple developer workers can collaborate safely in parallel.",
    "Use TeamClaw's available same-role capacity: create multiple developer tasks when the work can proceed concurrently rather than forcing one developer to carry the whole rewrite alone.",
    "Do not duplicate tasks that already exist, are active, or are already completed.",
    "If this task produced a web application with a live preview URL, include it in your reply so the human can verify the result.",
    "If all planned phases are complete and no follow-ups remain, set requirementFullyComplete=true in the manifest and provide a final delivery summary.",
    "If no additional task should be created yet, reply briefly and stop.",
  );

  return parts.filter(Boolean).join("\n");
}

function buildControllerParallelHelpMessage(
  task: TaskInfo,
  state: TeamState | null,
  input: {
    requestedBy: string;
    requestedByRole?: RoleId;
    targetRole?: RoleId;
    reason: string;
    requestedWorkerCount?: number;
    suggestedWorkstreams: string[];
  },
): string {
  const targetRole = input.targetRole || input.requestedByRole || task.assignedRole || "developer";
  return [
    buildControllerFollowUpMessage(task, state),
    "",
    "## Parallel Help Request",
    `Current worker ${input.requestedBy} has asked TeamClaw to expand parallel help for role ${targetRole}.`,
    input.requestedByRole ? `Requesting worker role: ${input.requestedByRole}` : "",
    typeof input.requestedWorkerCount === "number"
      ? `Desired same-role worker capacity for this requirement: ${input.requestedWorkerCount}`
      : "",
    `Why more parallel help is needed: ${input.reason}`,
    input.suggestedWorkstreams.length > 0
      ? `Suggested parallel workstreams:\n${input.suggestedWorkstreams.map((item) => `- ${item}`).join("\n")}`
      : "",
    "If the suggested workstreams are genuinely independent, create multiple execution-ready tasks for that role now instead of keeping one giant serial task.",
    "Reuse active tasks when possible, but if no matching tasks already exist, fan out the work into distinct module- or subsystem-scoped tasks that can run concurrently.",
  ].filter(Boolean).join("\n");
}

function buildControllerClarificationAnswerMessage(
  clarification: ClarificationRequest,
  answer: string,
  answeredBy: string,
): string {
  return [
    "The human has answered a pending controller clarification.",
    `Question: ${clarification.question}`,
    `Answer: ${answer}`,
    `Answered by: ${answeredBy}`,
    "Use this answer to continue the same requirement and update the plan/tasks accordingly.",
  ].join("\n");
}

function buildStructuredClarificationAnswer(
  clarification: ClarificationRequest,
  payload: {
    answer?: string;
    answerValue?: string;
    answerValues?: string[];
    answerNumber?: number;
    answerComment?: string;
  },
): string {
  if (typeof payload.answer === "string" && payload.answer.trim()) {
    return payload.answer.trim();
  }
  const schema = clarification.questionSchema;
  const optionLabel = (value: string): string => {
    const match = schema?.options?.find((entry) => entry.value === value);
    return match?.label || value;
  };
  const parts: string[] = [];
  if (schema?.kind === "single-select" && payload.answerValue) {
    parts.push(optionLabel(payload.answerValue));
  } else if (schema?.kind === "multi-select" && Array.isArray(payload.answerValues) && payload.answerValues.length > 0) {
    parts.push(payload.answerValues.map((entry) => optionLabel(entry)).join(", "));
  } else if (schema?.kind === "number" && typeof payload.answerNumber === "number" && Number.isFinite(payload.answerNumber)) {
    parts.push(`${payload.answerNumber}${schema.unit ? ` ${schema.unit}` : ""}`);
  } else if (payload.answerValue) {
    parts.push(payload.answerValue);
  }
  if (payload.answerComment && payload.answerComment.trim()) {
    parts.push(parts.length > 0 ? `Additional context: ${payload.answerComment.trim()}` : payload.answerComment.trim());
  }
  return parts.join("\n").trim();
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildManifestClarificationEntries(
  manifest: ControllerOrchestrationManifest,
): Array<{ question: string; questionSchema?: ClarificationRequest["questionSchema"] }> {
  const opportunities = Array.isArray(manifest.completionOpportunities)
    ? manifest.completionOpportunities.filter((entry) => entry.title && entry.value && entry.summary)
    : [];
  const completionEntries = manifest.requirementFullyComplete && opportunities.length > 0
    ? [{
      question: "Would you like TeamClaw to continue with one of these adjacent next steps?",
      questionSchema: {
        kind: "single-select" as const,
        title: "What should TeamClaw do next?",
        description: opportunities.map((entry) => `- ${entry.title}: ${entry.summary}`).join("\n"),
        required: false,
        options: opportunities.map((entry) => ({
          value: entry.value,
          label: entry.title,
          hint: entry.summary,
        })),
        allowOther: true,
      },
    }]
    : [];
  const normalizedQuestions = manifest.clarificationQuestions
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const schemas = Array.isArray(manifest.clarificationSchemas) ? manifest.clarificationSchemas : [];
  if (schemas.length > 0) {
    return [
      ...schemas.map((schema, index) => ({
        question: normalizedQuestions[index] || schema.title,
        questionSchema: schema,
      })),
      ...completionEntries,
    ];
  }
  return [
    ...normalizedQuestions.map((question) => ({ question })),
    ...completionEntries,
  ];
}

async function maybeConvertControllerClarificationToExecutionTask(
  controllerRunId: string,
  sessionKey: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerHttpDeps,
): Promise<string[]> {
  const candidateQuestion = (manifest.clarificationQuestions || []).find((entry) => looksLikeManualExecutionClarification(entry));
  const followUpDescription = candidateQuestion ? extractExecutableFollowUpFromClarification(candidateQuestion) : null;
  if (!candidateQuestion || !followUpDescription) {
    return [];
  }

  const assignedRole = chooseFallbackAssignedRole(manifest, followUpDescription);
  const task = await createControllerManagedTask({
    title: buildFallbackControllerTaskTitle(candidateQuestion, assignedRole),
    description: followUpDescription,
    assignedRole,
    createdBy: "controller",
    controllerRunId,
    controllerSessionKey: sessionKey,
    recommendedSkills: resolveActiveRoleSkills(assignedRole, []),
  }, deps);
  if (!task) {
    return [];
  }

  manifest.createdTasks = [{
    title: task.title,
    assignedRole: task.assignedRole,
    expectedOutcome: summarizeManifestExpectedOutcome(task),
  }];
  manifest.clarificationsNeeded = false;
  manifest.clarificationQuestions = manifest.clarificationQuestions.filter((entry) => entry !== candidateQuestion);
  if (Array.isArray(manifest.clarificationSchemas)) {
    manifest.clarificationSchemas = manifest.clarificationSchemas.filter((schema) => schema.title !== candidateQuestion);
  }
  manifest.notes = manifest.notes
    ? `${manifest.notes} TeamClaw converted a manual-action clarification into execution task ${task.id} so the team can perform the validation itself.`
    : `TeamClaw converted a manual-action clarification into execution task ${task.id} so the team can perform the validation itself.`;
  updateControllerRun(controllerRunId, deps, (run) => {
    run.manifest = manifest;
    appendControllerRunEvent(run, {
      type: "warning",
      phase: "clarification_converted_to_task",
      source: "controller",
      status: "running",
      sessionKey,
      message: `Controller converted a manual-action clarification into execution task ${task.id}.`,
    });
  });
  return [task.id];
}

function syncControllerRunClarifications(
  controllerRunId: string,
  sessionKey: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerHttpDeps,
): ClarificationRequest[] {
  const entries = buildManifestClarificationEntries(manifest);
  const created: ClarificationRequest[] = [];
  const superseded: ClarificationRequest[] = [];
  const now = Date.now();
  deps.updateTeamState((state) => {
    const desiredQuestionKeys = new Set(
      entries.map((entry) => normalizeComparableText(entry.question)),
    );
    const existingQuestions = new Map(
      Object.values(state.clarifications)
        .filter((item) => item.controllerRunId === controllerRunId)
        .map((item) => [normalizeComparableText(item.question), item]),
    );

    for (const [key, clarification] of existingQuestions.entries()) {
      if (
        clarification.status === "pending"
        && !desiredQuestionKeys.has(key)
      ) {
        clarification.status = "answered";
        clarification.answer = "Automatically superseded by the latest controller clarification set.";
        clarification.answeredBy = "system";
        clarification.answeredAt = now;
        clarification.updatedAt = now;
        superseded.push({ ...clarification });
      }
    }

    for (const entry of entries) {
      const key = normalizeComparableText(entry.question);
      if (existingQuestions.has(key)) {
        continue;
      }
      const clarification: ClarificationRequest = {
        id: generateId(),
        taskId: "",
        controllerRunId,
        controllerSessionKey: sessionKey,
        requestedBy: "controller",
        question: entry.question,
        questionSchema: entry.questionSchema,
        blockingReason: "The controller needs this information before it can confidently continue planning and downstream task creation.",
        context: manifest.requirementSummary,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      state.clarifications[clarification.id] = clarification;
      created.push(clarification);
    }
  });

  for (const clarification of created) {
    deps.wsServer.broadcastUpdate({ type: "clarification:requested", data: clarification });
  }
  for (const clarification of superseded) {
    deps.wsServer.broadcastUpdate({ type: "clarification:answered", data: clarification });
  }
  return created;
}

function reconcileControllerClarifications(deps: ControllerHttpDeps): TeamState | null {
  const state = deps.getTeamState();
  if (!state) {
    return null;
  }

  const superseded: ClarificationRequest[] = [];
  deps.updateTeamState((draft) => {
    const runsBySession = new Map<string, ControllerRunInfo[]>();
    for (const run of Object.values(draft.controllerRuns)) {
      const normalizedSessionKey = normalizeControllerIntakeSessionKey(run.sessionKey);
      const bucket = runsBySession.get(normalizedSessionKey) ?? [];
      bucket.push(run);
      runsBySession.set(normalizedSessionKey, bucket);
    }

    for (const clar of Object.values(draft.clarifications)) {
      if (clar.status !== "pending" || clar.requestedBy !== "controller" || clar.taskId) {
        continue;
      }
      const normalizedSessionKey = normalizeControllerIntakeSessionKey(clar.controllerSessionKey);
      const sessionRuns = runsBySession.get(normalizedSessionKey) ?? [];
      const supersedingRun = sessionRuns.find((run) =>
        run.updatedAt > clar.updatedAt
        && (
          run.manifest?.createdTasks.length
          || run.manifest?.requirementFullyComplete
        ),
      );
      if (!supersedingRun) {
        continue;
      }
      clar.status = "answered";
      clar.answer = "Automatically superseded by later controller progress.";
      clar.answeredBy = "system";
      clar.answeredAt = supersedingRun.updatedAt;
      clar.updatedAt = supersedingRun.updatedAt;
      superseded.push({ ...clar });
    }
  });

  for (const clarification of superseded) {
    deps.wsServer.broadcastUpdate({ type: "clarification:answered", data: clarification });
  }

  for (const run of Object.values(state.controllerRuns)) {
    if (!run.manifest?.clarificationsNeeded) {
      continue;
    }
    syncControllerRunClarifications(run.id, run.sessionKey, run.manifest, deps);
  }

  return deps.getTeamState();
}

function buildControllerRateLimitProbeMessage(
  sourceTaskId?: string,
  sourceTaskTitle?: string,
): string {
  const workflowLabel = sourceTaskTitle
    ? `${sourceTaskTitle}${sourceTaskId ? ` (${sourceTaskId})` : ""}`
    : (sourceTaskId ? `task ${sourceTaskId}` : "this controller workflow");
  return [
    `This is a follow-up check for ${workflowLabel}.`,
    "The earlier controller run appears to be delayed by upstream model rate limiting.",
    "Do not restart the workflow from scratch.",
    "Do not duplicate tasks that already exist, are active, or are completed.",
    "If the earlier controller follow-up is fully complete now, immediately submit the required structured manifest for that same workflow step and provide the final orchestration reply.",
    `If the earlier controller follow-up is not complete yet, reply with exactly ${CONTROLLER_RATE_LIMIT_WAITING_SENTINEL}.`,
  ].join("\n");
}

function buildControllerInactivityProbeMessage(
  inactivityMs: number,
  sourceTaskId?: string,
  sourceTaskTitle?: string,
): string {
  const workflowLabel = sourceTaskTitle
    ? `${sourceTaskTitle}${sourceTaskId ? ` (${sourceTaskId})` : ""}`
    : (sourceTaskId ? `task ${sourceTaskId}` : "this controller workflow");
  return [
    `This is a follow-up check for ${workflowLabel}.`,
    `There has been no new visible controller workflow progress for over ${formatDuration(inactivityMs)}.`,
    "Do not restart the workflow from scratch.",
    "Do not duplicate tasks that already exist, are active, or are completed.",
    "If the earlier controller follow-up is fully complete now, immediately submit the required structured manifest for that same workflow step and provide the final orchestration reply.",
    `If the earlier controller follow-up is not complete yet, reply with exactly ${CONTROLLER_RATE_LIMIT_WAITING_SENTINEL}.`,
  ].join("\n");
}

async function checkAndGenerateReport(task: TaskInfo, deps: ControllerHttpDeps): Promise<void> {
  const sessionKey = task.controllerSessionKey;
  if (!sessionKey) return;

  const state = deps.getTeamState();
  if (!state) return;

  if (!isSessionComplete(sessionKey, state, normalizeControllerIntakeSessionKey)) return;

  const report = generateDeliveryReport(sessionKey, state, normalizeControllerIntakeSessionKey);
  if (!report) return;

  // Check if we already generated a report for this session
  const existingReport = state.reports?.[report.id];
  if (existingReport) return;

  // Store a lightweight record in state (full report is generated on demand from live state)
  deps.updateTeamState((s) => {
    if (!s.reports) s.reports = {};
    s.reports[report.id] = {
      id: report.id,
      sessionKey: report.sessionKey,
      generatedAt: report.generatedAt,
      projectName: report.projectName,
      requirementSummary: report.requirementSummary,
      status: report.status,
      taskCount: report.taskCount,
      deliverableCount: report.deliverables.length,
      previewCount: report.deliverables.filter((d) => d.previewUrl).length,
    };
  });

  const reportUrl = `/api/v1/reports/${encodeURIComponent(sessionKey)}`;
  deps.wsServer.broadcastUpdate({
    type: "report:ready",
    data: { sessionKey, reportUrl, projectName: report.projectName, status: report.status },
  });
  deps.logger.info(`Controller: delivery report generated for session ${sessionKey}: ${reportUrl}`);
}

async function continueControllerWorkflow(task: TaskInfo, deps: ControllerHttpDeps): Promise<void> {
  if (task.createdBy !== "controller") {
    return;
  }
  const sessionKey = resolveControllerWorkflowSessionKey(task, deps.getTeamState());
  if (!sessionKey) {
    return;
  }
  if (task.controllerSessionKey !== sessionKey) {
    deps.updateTeamState((state) => {
      const currentTask = state.tasks[task.id];
      if (currentTask) {
        currentTask.controllerSessionKey = sessionKey;
      }
    });
  }
  await runControllerIntake(buildControllerFollowUpMessage(task, deps.getTeamState()), sessionKey, deps, {
    source: "task_follow_up",
    sourceTaskId: task.id,
    sourceTaskTitle: task.title,
  });
}

/**
 * Phase 2.1 review fix (design 2.3 concurrency matrix): intake runs create
 * tasks and burn a controller LLM pass, so they are refused while a profile
 * switch transition is in flight - at the runControllerIntake ENTRY, which is
 * the single funnel for URL submissions AND internal callers (task-completion
 * follow-ups, parallel-help, clarification resumes) that bypass the URL-level
 * 503 gate. The message deliberately avoids every token of
 * CONTROLLER_INTAKE_RETRYABLE_ERROR_PATTERN: a transition rejection must fail
 * fast, never retry its way into the switched team.
 */
export class ControllerIntakeSwitchInProgressError extends Error {
  readonly transition: TeamSwitchTransition;

  constructor(transition: TeamSwitchTransition) {
    super(
      `Controller intake rejected: a team profile switch to "${transition.targetProfileId}" is in progress (phase: ${transition.phase}) - retry after the switch completes`,
    );
    this.name = "ControllerIntakeSwitchInProgressError";
    this.transition = transition;
  }
}

export async function runControllerIntake(
  message: string,
  sessionKey: string,
  deps: ControllerHttpDeps,
  options?: {
    source?: ControllerRunSource;
    sourceTaskId?: string;
    sourceTaskTitle?: string;
  },
): Promise<{ sessionKey: string; runId: string; reply: string; controllerRunId: string }> {
  const activeTransition = deps.getTeamState()?.transition;
  if (activeTransition) {
    throw new ControllerIntakeSwitchInProgressError(activeTransition);
  }
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  return withSerializedControllerIntake(normalizedSessionKey, async () => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= CONTROLLER_INTAKE_MAX_RETRIES; attempt++) {
      try {
        return await runControllerIntakeUnlocked(message, normalizedSessionKey, deps, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errorText = lastError.message;
        // Only retry on transient server errors (500/502/503), not on client errors,
        // timeouts, or other failures that retrying won't fix.
        if (
          attempt === CONTROLLER_INTAKE_MAX_RETRIES
          || !CONTROLLER_INTAKE_RETRYABLE_ERROR_PATTERN.test(errorText)
          || errorText.includes("timed out")
        ) {
          throw lastError;
        }
        // Record a visible retry event so the human can see what happened.
        deps.logger.warn(
          `Controller: intake attempt ${attempt + 1} failed with transient error: ${errorText.slice(0, 200)}. Retrying in ${CONTROLLER_INTAKE_RETRY_DELAY_MS * (attempt + 1) / 1000}s...`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, CONTROLLER_INTAKE_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    throw lastError!;
  });
}

async function runControllerIntakeUnlocked(
  message: string,
  sessionKey: string,
  deps: ControllerHttpDeps,
  options?: {
    source?: ControllerRunSource;
    sourceTaskId?: string;
    sourceTaskTitle?: string;
  },
): Promise<{ sessionKey: string; runId: string; reply: string; controllerRunId: string }> {
  const taskIdsBeforeRun = collectTaskIds(deps.getTeamState());
  const controllerRun = createControllerRun(message, sessionKey, deps, options);
  recordControllerRunEvent(controllerRun.id, {
    type: "lifecycle",
    phase: "queued",
    source: "controller",
    status: "pending",
    sessionKey,
    message: "Controller intake queued.",
  }, deps);

  const runResult = await deps.runtime.subagent.run({
    sessionKey,
    message,
    extraSystemPrompt: buildControllerIntakeSystemPrompt(deps),
    idempotencyKey: `controller-intake-${generateId()}`,
  });
  recordControllerRunEvent(controllerRun.id, {
    type: "lifecycle",
    phase: "run_started",
    source: "controller",
    status: "running",
    sessionKey,
    runId: runResult.runId,
    message: `Controller intake started (${runResult.runId}).`,
  }, deps);

  const rateLimitState: {
    active: boolean;
    visibleAt?: number;
    nextProbeAt?: number;
    probeCount: number;
  } = {
    active: false,
    probeCount: 0,
  };
  const inactivityState: {
    active: boolean;
    visibleAt?: number;
    nextProbeAt?: number;
    probeCount: number;
  } = {
    active: false,
    nextProbeAt: Date.now() + deps.config.taskTimeoutMs,
    probeCount: 0,
  };
  const progressSnapshot: {
    fingerprints: string[];
    latestMessages: unknown[];
    lastActivityAt: number;
  } = {
    fingerprints: [],
    latestMessages: [],
    lastActivityAt: Date.now(),
  };

  const markRateLimitWaiting = async (): Promise<void> => {
    if (rateLimitState.active) {
      return;
    }
    const now = Date.now();
    rateLimitState.active = true;
    rateLimitState.visibleAt = now;
    rateLimitState.nextProbeAt = now + CONTROLLER_RATE_LIMIT_STALL_PROBE_MS;
    recordControllerRunEvent(controllerRun.id, {
      type: "progress",
      phase: "model_rate_limit_waiting",
      source: "controller",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: "Model rate limit reached. OpenClaw is retrying upstream; TeamClaw will keep waiting for the controller workflow to continue.",
    }, deps);
  };

  const clearRateLimitWaiting = (): void => {
    rateLimitState.active = false;
    rateLimitState.visibleAt = undefined;
    rateLimitState.nextProbeAt = undefined;
  };

  const noteObservedControllerActivity = (): void => {
    progressSnapshot.lastActivityAt = Date.now();
    inactivityState.active = false;
    inactivityState.visibleAt = undefined;
    inactivityState.nextProbeAt = Date.now() + deps.config.taskTimeoutMs;
  };

  const syncControllerSessionProgress = async (): Promise<void> => {
    const sessionMessages = await deps.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: CONTROLLER_SESSION_PROGRESS_MESSAGE_LIMIT,
    });
    progressSnapshot.latestMessages = Array.isArray(sessionMessages.messages) ? sessionMessages.messages : [];
    const entries = buildSessionProgressEntries(progressSnapshot.latestMessages, message);
    const newEntries = getNewSessionProgressEntries(entries, progressSnapshot.fingerprints);
    progressSnapshot.fingerprints = entries.map((entry) => entry.fingerprint);
    if (newEntries.length > 0) {
      noteObservedControllerActivity();
    }
    for (const entry of newEntries) {
      if (entry.isRateLimit) {
        await markRateLimitWaiting();
        continue;
      }
      if (rateLimitState.active && isStillWaitingResponse(entry.message)) {
        continue;
      }
      if (rateLimitState.active) {
        clearRateLimitWaiting();
      }
      recordControllerRunEvent(controllerRun.id, {
        type: "progress",
        phase: entry.phase,
        source: "subagent",
        stream: entry.stream,
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: entry.message,
      }, deps);
    }
  };

  const extractSessionAssistantReply = async (): Promise<string> => {
    const sessionMessages = await deps.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 100,
    });
    return extractLastAssistantText(sessionMessages.messages);
  };

  const probeRateLimitedControllerCompletion = async (): Promise<string | null> => {
    rateLimitState.probeCount += 1;
    const now = Date.now();
    rateLimitState.visibleAt = now;
    rateLimitState.nextProbeAt = now + CONTROLLER_RATE_LIMIT_STALL_PROBE_MS;
    recordControllerRunEvent(controllerRun.id, {
      type: "progress",
      phase: "model_rate_limit_probe",
      source: "controller",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: `Model rate limit has delayed controller orchestration for over ${formatDuration(CONTROLLER_RATE_LIMIT_STALL_PROBE_MS)}. Re-checking whether this workflow step has already completed.`,
    }, deps);

    const probeRun = await deps.runtime.subagent.run({
      sessionKey,
      message: buildControllerRateLimitProbeMessage(options?.sourceTaskId, options?.sourceTaskTitle),
      extraSystemPrompt: buildControllerIntakeSystemPrompt(deps),
      idempotencyKey: `${runResult.runId}:rate-limit-probe:${rateLimitState.probeCount}`,
    });
    const probeWait = await deps.runtime.subagent.waitForRun({
      runId: probeRun.runId,
      timeoutMs: CONTROLLER_RATE_LIMIT_PROBE_TIMEOUT_MS,
    });

    if (probeWait.status !== "ok") {
      return null;
    }

    const probeReply = await extractSessionAssistantReply();
    if (!probeReply || isRateLimitMessage(probeReply) || isStillWaitingResponse(probeReply)) {
      recordControllerRunEvent(controllerRun.id, {
        type: "progress",
        phase: "model_rate_limit_still_waiting",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: "The controller workflow is still waiting on model availability. TeamClaw will continue waiting.",
      }, deps);
      return null;
    }

    clearRateLimitWaiting();
    noteObservedControllerActivity();
    return probeReply;
  };

  const probeInactiveControllerCompletion = async (): Promise<string | null> => {
    inactivityState.probeCount += 1;
    const now = Date.now();
    inactivityState.active = true;
    inactivityState.visibleAt = now;
    inactivityState.nextProbeAt = now + deps.config.taskTimeoutMs;
    recordControllerRunEvent(controllerRun.id, {
      type: "progress",
      phase: "inactivity_probe",
      source: "controller",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: `No new controller workflow output has appeared for over ${formatDuration(deps.config.taskTimeoutMs)}. Re-checking whether this orchestration step is complete or still running.`,
    }, deps);

    const probeRun = await deps.runtime.subagent.run({
      sessionKey,
      message: buildControllerInactivityProbeMessage(
        deps.config.taskTimeoutMs,
        options?.sourceTaskId,
        options?.sourceTaskTitle,
      ),
      extraSystemPrompt: buildControllerIntakeSystemPrompt(deps),
      idempotencyKey: `${runResult.runId}:inactivity-probe:${inactivityState.probeCount}`,
    });
    const probeWait = await deps.runtime.subagent.waitForRun({
      runId: probeRun.runId,
      timeoutMs: CONTROLLER_INACTIVITY_PROBE_TIMEOUT_MS,
    });

    if (probeWait.status === "error" && isRateLimitMessage(probeWait.error || "")) {
      await markRateLimitWaiting();
      return null;
    }
    if (probeWait.status !== "ok") {
      return null;
    }

    const probeReply = await extractSessionAssistantReply();
    if (!probeReply || isRateLimitMessage(probeReply) || isStillWaitingResponse(probeReply)) {
      inactivityState.active = false;
      inactivityState.visibleAt = undefined;
      inactivityState.nextProbeAt = Date.now() + deps.config.taskTimeoutMs;
      recordControllerRunEvent(controllerRun.id, {
        type: "progress",
        phase: "inactivity_still_waiting",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: "The controller workflow is still running without a final result yet. TeamClaw will keep waiting instead of failing the run.",
      }, deps);
      return null;
    }

    if (rateLimitState.active) {
      clearRateLimitWaiting();
    }
    noteObservedControllerActivity();
    return probeReply;
  };

  let waitResult: Awaited<ReturnType<typeof deps.runtime.subagent.waitForRun>> = { status: "timeout" };
  let completionOverride: string | null = null;
  while (true) {
    if (rateLimitState.active && (rateLimitState.nextProbeAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
      completionOverride = await probeRateLimitedControllerCompletion();
      if (completionOverride) {
        waitResult = { status: "ok" };
        break;
      }
    }

    if (!rateLimitState.active && (inactivityState.nextProbeAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
      completionOverride = await probeInactiveControllerCompletion();
      if (completionOverride) {
        waitResult = { status: "ok" };
        break;
      }
    }

    waitResult = await deps.runtime.subagent.waitForRun({
      runId: runResult.runId,
      timeoutMs: CONTROLLER_RUN_WAIT_SLICE_MS,
    });

    try {
      await syncControllerSessionProgress();
    } catch (err) {
      deps.logger.debug?.(`Controller: failed to sync planning session progress for ${controllerRun.id}: ${String(err)}`);
    }

    if (waitResult.status === "ok") {
      clearRateLimitWaiting();
      noteObservedControllerActivity();
      break;
    }
    if (waitResult.status === "error") {
      if (isRateLimitMessage(waitResult.error || "")) {
        await markRateLimitWaiting();
        continue;
      }
      break;
    }
  }
  if (waitResult.status !== "ok") {
    const errorMessage = waitResult.error || "Controller intake failed";
    const createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, controllerRun.id, sessionKey, deps);
    updateControllerRun(controllerRun.id, deps, (run) => {
      run.createdTaskIds = createdTaskIds;
      run.error = errorMessage;
      appendControllerRunEvent(run, {
        type: "error",
        phase: "run_failed",
        source: "controller",
        status: "failed",
        sessionKey,
        runId: runResult.runId,
        message: errorMessage,
      });
    });
    throw new Error(errorMessage);
  }

  let createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, controllerRun.id, sessionKey, deps);

  try {
    await syncControllerSessionProgress();
  } catch (err) {
    deps.logger.debug?.(`Controller: failed final planning session sync for ${controllerRun.id}: ${String(err)}`);
  }

  const rawReply = completionOverride || await extractSessionAssistantReply()
    || "Controller completed the intake run but did not return any text.";
  const recordedManifest = ensureControllerManifest(
    controllerRun.id,
    sessionKey,
    message,
    rawReply,
    createdTaskIds,
    deps,
  );
  const fallbackTaskIds = await maybeBackfillExecutionReadyTask(
    controllerRun.id,
    sessionKey,
    message,
    recordedManifest,
    deps,
    { source: options?.source },
  );
  if (fallbackTaskIds.length > 0) {
    createdTaskIds = Array.from(new Set([...createdTaskIds, ...fallbackTaskIds]));
  }
  const convertedClarificationTaskIds = await maybeConvertControllerClarificationToExecutionTask(
    controllerRun.id,
    sessionKey,
    recordedManifest,
    deps,
  );
  if (convertedClarificationTaskIds.length > 0) {
    createdTaskIds = Array.from(new Set([...createdTaskIds, ...convertedClarificationTaskIds]));
  }
  syncControllerRunClarifications(controllerRun.id, sessionKey, recordedManifest, deps);
  const reconciledTasks = reconcileControllerManifestTaskBindings(sessionKey, createdTaskIds, recordedManifest, controllerRun.id, deps);

  // ── Automatic Team Kickoff ────────────────────────────────────────────
  // For complex projects (3+ roles), automatically run a kickoff meeting
  // so every candidate role can assess the requirement collaboratively.
  // This happens AFTER the initial LLM pass so we know which roles are
  // needed, but we store the assessments for visibility and future
  // refinement passes.
  const AUTO_KICKOFF_ROLE_THRESHOLD = 3;
  const isFollowUp = options?.source === "task_follow_up";
  const kickoffHandler = deps.getKickoffHandler?.();
  if (
    !isFollowUp
    && kickoffHandler
    && recordedManifest.requiredRoles.length >= AUTO_KICKOFF_ROLE_THRESHOLD
    && !recordedManifest.clarificationsNeeded
  ) {
    deps.logger.info(
      `Controller: auto-kickoff triggered for ${recordedManifest.requiredRoles.length} roles: ${recordedManifest.requiredRoles.join(", ")}`,
    );
    recordControllerRunEvent(controllerRun.id, {
      type: "lifecycle",
      phase: "kickoff_started",
      source: "controller",
      status: "running",
      sessionKey,
      message: `Auto-kickoff: provisioning ${recordedManifest.requiredRoles.length} candidate roles for team assessment.`,
    }, deps);
    try {
      const kickoffResult = await kickoffHandler(
        recordedManifest.requiredRoles,
        recordedManifest.requiredRoles.length >= 5 ? "complex" : "medium",
        message,
      );
      // Store kickoff assessments on the manifest for UI/API visibility
      recordedManifest.kickoffPlan = {
        complexity: recordedManifest.requiredRoles.length >= 5 ? "complex" : "medium",
        candidateRoles: recordedManifest.requiredRoles,
        completed: true,
        assessments: kickoffResult.assessments,
        summary: kickoffResult.summary,
        triggeredAt: Date.now(),
      };
      updateControllerRun(controllerRun.id, deps, (run) => {
        if (run.manifest) {
          run.manifest.kickoffPlan = recordedManifest.kickoffPlan;
        }
        appendControllerRunEvent(run, {
          type: "lifecycle",
          phase: "kickoff_completed",
          source: "controller",
          status: "running",
          sessionKey,
          message: `Team kickoff completed: ${kickoffResult.assessments.length} assessments collected. ${kickoffResult.summary.slice(0, 200)}`,
        });
      });
      deps.logger.info(
        `Controller: auto-kickoff completed with ${kickoffResult.assessments.length} assessments`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.logger.warn(`Controller: auto-kickoff failed: ${errMsg}`);
      recordControllerRunEvent(controllerRun.id, {
        type: "lifecycle",
        phase: "kickoff_failed",
        source: "controller",
        status: "running",
        sessionKey,
        message: `Auto-kickoff failed: ${errMsg}. Proceeding with controller-only planning.`,
      }, deps);
    }
  }

  const latestTeamState = deps.getTeamState();
  const reply = buildControllerManifestReply(recordedManifest, reconciledTasks.taskIds, latestTeamState, rawReply);

  updateControllerRun(controllerRun.id, deps, (run) => {
    run.reply = reply;
    run.error = undefined;
    run.createdTaskIds = reconciledTasks.taskIds;
    appendControllerRunEvent(run, {
      type: "output",
      phase: "final_reply",
      source: "subagent",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: reply,
    });
    if (reconciledTasks.linkedTaskIds.length > 0) {
      appendControllerRunEvent(run, {
        type: "lifecycle",
        phase: "tasks_linked",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: `Controller linked ${reconciledTasks.linkedTaskIds.length} existing task(s) into this workflow: ${reconciledTasks.linkedTaskIds.join(", ")}`,
      });
    }
    if (reconciledTasks.taskIds.length > 0) {
      appendControllerRunEvent(run, {
        type: "lifecycle",
        phase: "tasks_created",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: `Controller activated ${reconciledTasks.taskIds.length} execution-ready task(s): ${reconciledTasks.taskIds.join(", ")}`,
      });
    }
    appendControllerRunEvent(run, {
      type: "lifecycle",
      phase: "run_completed",
      source: "controller",
      status: "completed",
      sessionKey,
      runId: runResult.runId,
      message: "Controller intake completed.",
    });
  });

  await pruneStaleControllerRuns(deps, { excludeRunId: controllerRun.id });

  return {
    sessionKey,
    runId: runResult.runId,
    reply,
    controllerRunId: controllerRun.id,
  };
}

function summarizeTaskForAssignment(task: TaskInfo): string {
  const lastExecutionMessage = task.execution?.events[task.execution.events.length - 1]?.message;
  const contractSummary = task.resultContract
    ? [
        task.resultContract.summary,
        ...task.resultContract.deliverables.slice(0, 3).map((deliverable) => `${deliverable.kind}: ${deliverable.value}`),
      ].join(" | ")
    : "";
  const raw = contractSummary || task.result || task.progress || lastExecutionMessage || task.description || "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No upstream summary available.";
  }
  if (normalized.length <= MAX_TASK_CONTEXT_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TASK_CONTEXT_SUMMARY_CHARS).trimEnd()}…`;
}

function buildRecentCompletedTaskContext(task: TaskInfo, state: TeamState | null): string {
  if (!state) {
    return "";
  }

  // Only include tasks from the same session/project to avoid cross-project contamination.
  // Tasks sharing the same controllerSessionKey belong to the same user requirement.
  const sameSession = task.controllerSessionKey
    ? (candidate: TaskInfo) => candidate.controllerSessionKey === task.controllerSessionKey
    : () => true; // If no session key, fall back to all completed tasks (legacy behavior)

  const recentCompletedTasks = Object.values(state.tasks)
    .filter((candidate) => candidate.id !== task.id && candidate.status === "completed")
    .filter(sameSession)
    .filter((candidate) => (candidate.completedAt ?? candidate.updatedAt) <= task.createdAt)
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
    .slice(0, MAX_RECENT_TASK_CONTEXT)
    .reverse();

  if (recentCompletedTasks.length === 0) {
    return "";
  }

  return [
    "## Recent Completed Team Deliverables",
    "Use these upstream outputs before requesting clarification.",
    "If a summary references a filename or task ID, search the shared workspace for it first.",
    "Do not try to inspect another worker's OpenClaw session or session key directly; those sessions are isolated per worker.",
    ...recentCompletedTasks.map((candidate) => {
      const roleLabel = candidate.assignedRole
        ? (getActiveRoles().find((role) => role.id === candidate.assignedRole)?.label ?? candidate.assignedRole)
        : "Unassigned";
      return `- [${candidate.id}] ${candidate.title} (${roleLabel}): ${summarizeTaskForAssignment(candidate)}`;
    }),
  ].join("\n");
}

function buildRecommendedSkillsContext(task: TaskInfo): string {
  const recommendedSkills = resolveActiveRoleSkills(task.assignedRole, task.recommendedSkills ?? []);
  if (recommendedSkills.length === 0) {
    return "";
  }

  return [
    "## Recommended Skills",
    "- Prefer these skill slugs for this task when relevant:",
    ...recommendedSkills.map((skill) => `  - ${skill}`),
    "- Before starting, search/install missing recommended skills in the current workspace when the runtime supports it.",
    "- Prefer exact ClawHub/OpenClaw skill slugs over vague descriptions whenever possible.",
  ].join("\n");
}

function buildTaskContextSnapshot(task: TaskInfo, state: TeamState | null): TaskAssignmentPayload["teamContext"] | undefined {
  if (!state || !task.controllerSessionKey) {
    return undefined;
  }
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(task.controllerSessionKey);
  const summarize = (candidate: TaskInfo) => ({
    id: candidate.id,
    title: candidate.title,
    assignedRole: candidate.assignedRole,
    status: candidate.status,
    summary: summarizeTaskForAssignment(candidate),
  });
  const sameSessionTasks = Object.values(state.tasks)
    .filter((candidate) => candidate.id !== task.id)
    .filter((candidate) => normalizeControllerIntakeSessionKey(candidate.controllerSessionKey) === normalizedSessionKey);
  const latestRun = Object.values(state.controllerRuns)
    .filter((run) => normalizeControllerIntakeSessionKey(run.sessionKey) === normalizedSessionKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    requirementSummary: latestRun?.manifest?.requirementSummary || latestRun?.request,
    projectName: latestRun?.manifest?.projectName,
    requiredRoles: latestRun?.manifest?.requiredRoles,
    activeTasks: sameSessionTasks.filter((candidate) => candidate.status === "assigned" || candidate.status === "in_progress").slice(0, 8).map(summarize),
    blockedTasks: sameSessionTasks.filter((candidate) => candidate.status === "blocked").slice(0, 6).map(summarize),
    recentCompletedTasks: sameSessionTasks
      .filter((candidate) => candidate.status === "completed")
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
      .slice(0, 8)
      .map(summarize),
    pendingClarifications: Object.values(state.clarifications)
      .filter((clarification) => clarification.status === "pending")
      .filter((clarification) => normalizeControllerIntakeSessionKey(clarification.controllerSessionKey) === normalizedSessionKey)
      .slice(0, 5)
      .map((clarification) => ({
        question: clarification.question,
        blockingReason: clarification.blockingReason,
      })),
    answeredClarifications: Object.values(state.clarifications)
      .filter((clarification) => clarification.status === "answered" && clarification.answer)
      .filter((clarification) =>
        clarification.taskId === task.id
        || normalizeControllerIntakeSessionKey(clarification.controllerSessionKey) === normalizedSessionKey,
      )
      .sort((a, b) => (b.answeredAt ?? b.updatedAt ?? 0) - (a.answeredAt ?? a.updatedAt ?? 0))
      .slice(0, 5)
      .map((clarification) => ({
        question: clarification.question,
        answer: clarification.answer || "",
        answeredBy: clarification.answeredBy,
        blockingReason: clarification.blockingReason,
      })),
    handoffPlan: latestRun?.manifest?.handoffPlan,
    notes: latestRun?.manifest?.notes,
    kickoffSummary: latestRun?.manifest?.kickoffPlan?.summary,
  };
}

function buildTaskAssignmentDescription(task: TaskInfo, state: TeamState | null, repoInfo?: RepoSyncInfo): string {
  const parts = [task.description];
  const projectContext = buildProjectDirectoryContext(task.projectDir);
  if (projectContext) {
    parts.push("", projectContext);
  }
  const recommendedSkillsContext = buildRecommendedSkillsContext(task);
  if (recommendedSkillsContext) {
    parts.push("", recommendedSkillsContext);
  }
  const patternsContext = buildConsolidatedPatternsContext();
  if (patternsContext) {
    parts.push("", patternsContext);
  }
  const recentContext = buildRecentCompletedTaskContext(task, state);
  if (recentContext) {
    parts.push("", recentContext);
  }
  if (repoInfo?.enabled) {
    parts.push("", buildRepoTaskContext(repoInfo));
  }
  return parts.join("\n");
}

function buildProjectDirectoryContext(projectDir?: string): string | null {
  if (!projectDir) {
    return null;
  }
  const workspaceRelativePath = buildTeamClawProjectWorkspacePath(projectDir);
  const absoluteProjectPath = path.join(resolveTeamClawProjectsDir(), projectDir).replace(/\\/gu, "/");
  return [
    "## Authoritative Project Paths",
    `- Workspace-relative project path: \`${workspaceRelativePath}/\``,
    `- Absolute project path: \`${absoluteProjectPath}/\``,
    "- If the task description mentions any other workspace path, treat it as stale text from an older layout.",
    "- Resolve project-local files (for example `ARCHITECTURE.md`, `README.md`, `package.json`, `data/...`) inside the authoritative project path above.",
  ].join("\n");
}

function buildRepoTaskContext(repoInfo: RepoSyncInfo): string {
  const lines = [
    "## TeamClaw Git Collaboration",
    "- TeamClaw manages a git-backed project workspace for this task.",
    `- Sync mode: ${repoInfo.mode}.`,
    `- Default branch: ${repoInfo.defaultBranch}.`,
  ];

  if (repoInfo.headCommit) {
    const headSummary = repoInfo.headSummary ? ` "${repoInfo.headSummary}"` : "";
    lines.push(`- Current HEAD: ${repoInfo.headCommit}${headSummary}.`);
  }

  lines.push("- TeamClaw syncs the workspace checkout before task execution when needed.");
  lines.push("- Treat the current workspace as the canonical repo checkout; do not delete `.git` or replace the repo with ad-hoc archives.");
  return lines.join("\n");
}

async function refreshControllerRepoState(deps: ControllerHttpDeps): Promise<GitRepoState | null> {
  // Phase 2.3: the ACTIVE PROFILE's git switch outranks the legacy config
  // knob here - refreshing (or stamping) repo state for a profile that
  // declared git off would re-introduce exactly the repo field the switch
  // omitted for it (design 2.3: banking keeps no repo initialization). All
  // callers already treat null as "no repo" (same as config gitEnabled off).
  if (!deps.config.gitEnabled || !getActiveProfile().capabilities.git) {
    return null;
  }

  try {
    const repo = await ensureControllerGitRepo(deps.config, deps.logger);
    if (repo) {
      deps.updateTeamState((s) => {
        s.repo = repo;
      });
    }
    return repo;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn(`Controller: failed to refresh git repo state: ${message}`);
    deps.updateTeamState((s) => {
      if (s.repo?.enabled) {
        s.repo = {
          ...s.repo,
          error: message,
          lastPreparedAt: Date.now(),
        };
      }
    });
    return deps.getTeamState()?.repo ?? null;
  }
}

function scheduleProvisioningReconcile(deps: ControllerHttpDeps, reason: string): void {
  void deps.workerProvisioningManager?.requestReconcile(reason);
}

/** Collaboration contract helpers: at most ONE active write task per repo checkout. */
function taskWriteRoot(task: TaskInfo): string | null {
  if (task.writeMode === "read-only" || !task.projectDir) { return null; }
  return task.projectDir.split("__task-")[0] ?? task.projectDir;
}

function activeWriteRoots(state: TeamState): Set<string> {
  const roots = new Set<string>();
  for (const t of Object.values(state.tasks)) {
    if (t.status !== "assigned" && t.status !== "in_progress") { continue; }
    const root = taskWriteRoot(t);
    if (root) { roots.add(root); }
  }
  return roots;
}

function broadcastTaskExecutionEvent(
  taskId: string,
  task: TaskInfo,
  event: TaskExecutionEvent,
  deps: ControllerHttpDeps,
): void {
  deps.wsServer.broadcastUpdate({
    type: "task:execution",
    data: {
      taskId,
      event,
      execution: buildTaskExecutionSummary(task.execution),
    },
  });
}

function recordTaskExecutionEvent(
  taskId: string,
  input: TaskExecutionEventInput,
  deps: ControllerHttpDeps,
): { task?: TaskInfo; event?: TaskExecutionEvent; statusChanged: boolean } {
  const { updateTeamState, wsServer } = deps;
  let statusChanged = false;
  let event: TaskExecutionEvent | undefined;

  const state = updateTeamState((s) => {
    const task = s.tasks[taskId];
    if (!task) {
      return;
    }

    const previousStatus = task.status;
    event = appendTaskExecutionEvent(task, input);
    statusChanged = previousStatus !== task.status;
  });

  const updatedTask = state.tasks[taskId];
  if (updatedTask && event) {
    broadcastTaskExecutionEvent(taskId, updatedTask, event, deps);
    if (statusChanged) {
      wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    }
  }

  return { task: updatedTask, event, statusChanged };
}

function canAcceptWorkerUpdate(task: TaskInfo | undefined, workerId: string): boolean {
  if (!task || task.assignedWorkerId !== workerId || task.completedAt) {
    return false;
  }

  return task.status === "assigned" ||
    task.status === "in_progress" ||
    task.status === "review" ||
    task.status === "completed" ||
    task.status === "failed";
}

async function cancelTaskExecution(
  taskId: string,
  workerId: string | undefined,
  reason: string,
  deps: ControllerHttpDeps,
): Promise<void> {
  if (!workerId) {
    return;
  }

  const worker = deps.getTeamState()?.workers[workerId];
  if (!worker) {
    return;
  }

  let cancelled = false;
  try {
    const res = await fetch(`${worker.url}/api/v1/tasks/${taskId}/cancel`, {
      method: "POST",
    });
    cancelled = res.ok;
    if (!res.ok) {
      deps.logger.warn(`Controller: worker cancel failed for ${taskId} on ${workerId} (${res.status})`);
    }
  } catch (err) {
    deps.logger.warn(`Controller: failed to cancel task ${taskId} on ${workerId}: ${String(err)}`);
  }

  if (!cancelled) {
    return;
  }

  recordTaskExecutionEvent(taskId, {
    type: "lifecycle",
    phase: "execution_cancelled",
    source: "controller",
    message: `Cancelled active execution before ${reason}.`,
    workerId,
  }, deps);
}

// Tunnel/CDN caches rewrite the origin's Cache-Control: no-cache into a long
// browser freeze for cacheable extensions like .js (observed: Cloudflare
// Browser Cache TTL max-age=14400 on tunneled UI assets). A UI update then
// never reaches visitors through the tunnel. Serving content-versioned URLs
// (?v=<hash>) makes every UI deploy a URL no browser or edge has ever seen,
// so stale-cache behavior cannot recur.
const uiAssetVersionCache = new Map<string, { mtimeMs: number; version: string }>();

function uiAssetVersion(uiPath: string, file: string): string {
  const full = path.join(uiPath, file);
  try {
    const mtimeMs = fs.statSync(full).mtimeMs;
    const cached = uiAssetVersionCache.get(full);
    if (cached && cached.mtimeMs === mtimeMs) return cached.version;
    const version = createHash("sha1").update(fs.readFileSync(full)).digest("hex").slice(0, 10);
    uiAssetVersionCache.set(full, { mtimeMs, version });
    return version;
  } catch {
    return String(Date.now()); // unreadable asset: bust for this request
  }
}

const UI_HTML_ASSET_REFS = [
  "/ui/style.css",
  "/ui/app.js",
  "/ui/assets/teamclaw-app-icon.png",
];

function serveVersionedHtml(res: ServerResponse, htmlPath: string): void {
  try {
    const uiPath = path.dirname(htmlPath);
    let html = fs.readFileSync(htmlPath, "utf8");
    for (const ref of UI_HTML_ASSET_REFS) {
      html = html.split(`"${ref}"`).join(`"${ref}?v=${uiAssetVersion(uiPath, ref.slice("/ui/".length))}"`);
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(html);
  } catch {
    sendError(res, 404, "File not found");
  }
}

function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      // UI assets change with every plugin deploy on a localhost controller;
      // always revalidate so browsers never stick to a stale app.js.
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    sendError(res, 404, "File not found");
  }
}

function workspaceRequestErrorStatus(err: unknown): number {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
    return 404;
  }
  return 400;
}

function workspaceRequestErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Workspace request failed";
}

function getEffectiveStartupReadiness(
  deps: ControllerHttpDeps,
  state: TeamState | null,
): StartupProvisioningReadiness | null {
  if (!deps.workerProvisioningManager?.isEnabled()) {
    return null;
  }
  // Both branches are already-validated RoleId sources: config roles go
  // through parseRoleList (validateRoleIdList) and the fallback is the
  // active profile's defaultRole — no runtime validation needed here.
  const requiredRoles = deps.config.workerProvisioningRoles.length > 0
    ? [...new Set(deps.config.workerProvisioningRoles)]
    : [getActiveDefaultRole()];
  const readyWorkerIds = requiredRoles
    .map((role) => Object.values(state?.workers ?? {}).find((worker) =>
      worker.role === role && (worker.status === "idle" || worker.status === "busy")
    )?.id)
    .filter((workerId): workerId is string => Boolean(workerId));

  if (readyWorkerIds.length === requiredRoles.length) {
    const recorded = state?.provisioning?.startupReadiness;
    return {
      status: "ready",
      startedAt: recorded?.startedAt ?? state?.createdAt ?? Date.now(),
      checkedAt: Date.now(),
      attempts: recorded?.attempts ?? 0,
      requiredRoles,
      readyWorkerIds,
      message: recorded?.status === "ready"
        ? recorded.message
        : `Startup provisioning ready with ${readyWorkerIds.length} warm worker(s).`,
    };
  }

  return state?.provisioning?.startupReadiness ?? {
    status: "checking",
    startedAt: state?.createdAt ?? Date.now(),
    checkedAt: Date.now(),
    attempts: 0,
    requiredRoles,
    readyWorkerIds,
    message: `Startup provisioning warm-up is still initializing for ${requiredRoles.join(", ")}.`,
  };
}

function buildStartupReadinessMessage(readiness: StartupProvisioningReadiness): string {
  const requiredRoles = readiness.requiredRoles.length > 0 ? readiness.requiredRoles.join(", ") : "configured startup roles";
  if (readiness.status === "ready") {
    return readiness.message ?? "Startup provisioning is ready.";
  }
  if (readiness.status === "checking") {
    return readiness.message ?? `Startup provisioning is still warming workers for ${requiredRoles}.`;
  }
  return readiness.message ?? `Startup provisioning is degraded for ${requiredRoles}. Check provisioning logs and fix worker startup before retrying.`;
}

function shouldBlockControllerUntilProvisioningReady(
  deps: ControllerHttpDeps,
  state: TeamState | null,
): { blocked: boolean; readiness: StartupProvisioningReadiness | null } {
  const readiness = getEffectiveStartupReadiness(deps, state);
  if (!readiness) {
    return { blocked: false, readiness: null };
  }
  return {
    blocked: readiness.status !== "ready",
    readiness,
  };
}

/**
 * Filter deliverables that don't belong to the current task's project directory.
 * This prevents cross-project contamination when the model references stale files
 * from previous sessions visible in the shared workspace.
 */
function filterStaleDeliverables(
  contract: WorkerTaskResultContract,
  taskProjectDir: string | undefined,
): WorkerTaskResultContract {
  if (!taskProjectDir) return contract;
  // Normalize: "projects/foo-bar/" → "projects/foo-bar"
  const normalizedDir = taskProjectDir.replace(/\/$/u, "");
  const filtered = contract.deliverables.filter((d) => {
    const val = (d.value ?? "").replace(/\/$/u, "");
    if (!val) return true; // keep notes/commands without paths
    if (d.kind === "note" || d.kind === "command") return true;
    // Accept deliverables whose path contains the projectDir or is rooted in teamclaw/projects/{projectDir}
    if (val.includes(normalizedDir)) return true;
    // Accept relative paths that look like project-internal (no slashes or relative)
    if (!val.includes("/") || val.startsWith("./")) return true;
    // Reject paths from other project directories
    return false;
  });
  if (filtered.length === contract.deliverables.length) return contract;
  return { ...contract, deliverables: filtered };
}

/**
 * Strategy 4: When text-based enrichment found no HTML file references,
 * scan the workspace filesystem for HTML files and create a web-app deliverable.
 * This handles workers that return abstract summaries without mentioning specific paths.
 */
function enrichWithFilesystemHtmlScan(
  contract: WorkerTaskResultContract,
  taskProjectDir?: string,
): WorkerTaskResultContract | null {
  const existingWebApp = contract.deliverables.find((d) => d.artifactType === "web-app");
  if (existingWebApp) {
    const cwd = existingWebApp.previewCwd?.trim();
    if (cwd && cwd !== "." && cwd !== "./") {
      return null;
    }
    // Fall through — existing web-app has root previewCwd, try to improve it
  }

  let workspaceDir: string;
  let openclawWorkspaceDir: string;
  try {
    workspaceDir = resolveTeamClawWorkspaceDir();
    openclawWorkspaceDir = resolveTeamClawAgentWorkspaceRootDir();
  } catch {
    return null;
  }

  // Recursively scan the workspace for HTML files (up to 3 levels deep)
  const MAX_DEPTH = 3;
  const htmlCandidates: { dirPath: string; filename: string }[] = [];

  function scanDir(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, depth + 1);
      } else if (entry.isFile() && (entry.name.endsWith(".html") || entry.name.endsWith(".htm"))) {
        if (!entry.name.includes(".config.") && !entry.name.includes(".test.") && !entry.name.includes(".spec.")) {
          htmlCandidates.push({ dirPath: dir, filename: entry.name });
        }
      }
    }
  }

  // Scope scan to the task's project directory when available to avoid
  // picking up stale HTML from unrelated projects.
  const scanRoot = taskProjectDir
    ? path.join(workspaceDir, taskProjectDir)
    : workspaceDir;
  if (taskProjectDir && !fs.existsSync(scanRoot)) {
    return null;
  }
  scanDir(scanRoot, 0);

  if (htmlCandidates.length === 0) {
    return null;
  }

  // Use OpenClaw workspace root as base for relative paths (worker paths and
  // preview manager both resolve relative to the OpenClaw workspace, not the
  // TeamClaw subdirectory).
  const candidate = htmlCandidates[0];
  const relativeDir = path.relative(openclawWorkspaceDir, candidate.dirPath) || ".";
  const normalizedDir = relativeDir.replace(/\\/gu, "/");

  // Avoid adding a duplicate if a directory deliverable for this path already exists
  const existingDir = contract.deliverables.find(
    (d) => d.kind === "directory" && d.value.replace(/\\/gu, "/").replace(/\/$/u, "") === normalizedDir,
  );
  if (existingDir && existingDir.artifactType === "web-app" && existingWebApp?.previewCwd?.trim() !== ".") {
    // Existing web-app already has a specific, non-root directory — leave it alone.
    return null;
  }

  const newDeliverable: WorkerTaskResultDeliverable = {
    kind: "directory",
    value: normalizedDir,
    summary: `Web application at ${normalizedDir}`,
    artifactType: "web-app",
    previewCommand: "npx -y serve -l {PORT}",
    previewCwd: normalizedDir,
    previewReadyPath: "/",
  };

  const newDeliverables = [...contract.deliverables];
  if (existingDir) {
    // Update existing directory deliverable with web-app fields
    const idx = newDeliverables.indexOf(existingDir);
    // Always take the filesystem scan's directory path, which is more specific
    newDeliverables[idx] = { ...existingDir, ...newDeliverable };
  } else {
    newDeliverables.push(newDeliverable);
  }

  return { ...contract, deliverables: newDeliverables };
}

const MEANINGFUL_PROJECT_CHANGE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".html", ".css", ".scss", ".md", ".txt", ".yml", ".yaml",
  ".go", ".mod", ".sum", ".py", ".rb", ".rs", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".sh", ".bash", ".zsh", ".sql", ".toml", ".ini",
]);

const IGNORED_PROJECT_CHANGE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", "tmp", "temp",
]);

const IGNORED_PROJECT_CHANGE_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);

function taskRequiresMeaningfulProjectChangeGate(task: TaskInfo): boolean {
  if (task.assignedRole !== "developer" || !task.projectDir) {
    return false;
  }
  const text = `${task.title}\n${task.description}`.toLowerCase();
  if (/\b(qa|audit|review|verify|verification|validate|test|retest|confirm|check)\b/u.test(text)) {
    return false;
  }
  if (/(审计|审核|验证|复检|复查|确认|测试|检查)/u.test(text)) {
    return false;
  }
  return /\b(implement|build|fix|rework|update|add|enhanc|deliver|write|create)\b/u.test(text);
}

function projectHasMeaningfulDeliverableEvidence(
  task: TaskInfo,
  contract: WorkerTaskResultContract | undefined,
): boolean {
  if (!task.projectDir || !contract) {
    return false;
  }
  const projectRoot = path.join(resolveTeamClawProjectsDir(), task.projectDir);
  for (const deliverable of contract.deliverables) {
    if (deliverable.kind !== "file" && deliverable.kind !== "directory") {
      continue;
    }
    const rawValue = deliverable.value.trim().replace(/\\/g, "/");
    if (!rawValue) {
      continue;
    }
    const normalizedValue = rawValue.startsWith("projects/")
      ? rawValue.slice("projects/".length)
      : rawValue;
    if (
      normalizedValue !== task.projectDir
      && !normalizedValue.startsWith(`${task.projectDir}/`)
    ) {
      continue;
    }
    const relativePath = normalizedValue === task.projectDir
      ? ""
      : normalizedValue.slice(task.projectDir.length + 1);
    const fullPath = relativePath ? path.join(projectRoot, relativePath) : projectRoot;
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isFile()) {
        return true;
      }
      if (stats.isDirectory()) {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        if (entries.some((entry) => entry.isFile() || entry.isDirectory())) {
          return true;
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}

function projectHasMeaningfulFileChanges(
  task: TaskInfo,
  contract?: WorkerTaskResultContract,
): boolean {
  if (!task.projectDir) {
    return false;
  }
  const projectRoot = path.join(resolveTeamClawProjectsDir(), task.projectDir);
  if (!fs.existsSync(projectRoot)) {
    return false;
  }
  // Collaboration contract: write tasks deliver in a dedicated worktree.
  // An mtime scan is the wrong test there (committed files keep old mtimes
  // and the gate may run before the flush) - ask git instead: does HEAD carry
  // commits beyond the remote refs?
  if (task.projectDir.includes("__task-")) {
    try {
      const out = execFileSync("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: projectRoot }).toString();
      return Number(out.trim()) > 0;
    } catch {
      return false;
    }
  }
  const threshold = Math.max(task.startedAt ?? 0, task.createdAt ?? 0) - 1000;
  const stack = [projectRoot];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_CHANGE_DIRS.has(entry.name)) {
          stack.push(path.join(currentDir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (IGNORED_PROJECT_CHANGE_FILES.has(entry.name)) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!MEANINGFUL_PROJECT_CHANGE_EXTENSIONS.has(ext)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs >= threshold) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return projectHasMeaningfulDeliverableEvidence(task, contract);
}

function allowsNoChangeCompletion(
  task: TaskInfo,
  contract: WorkerTaskResultContract | undefined,
  resultText: string,
): boolean {
  const taskText = `${task.title}\n${task.description}`.toLowerCase();
  const evidenceText = [
    contract?.summary ?? "",
    contract?.notes ?? "",
    ...(contract?.keyPoints ?? []),
    resultText,
  ].join("\n").toLowerCase();
  const hasVerificationEvidence =
    (contract?.deliverables ?? []).some((deliverable) => deliverable.kind === "command" || deliverable.kind === "note")
    || /\b(go test|go vet|npm test|pnpm test|yarn test|pytest|cargo test|verified|verification|passes|all tests pass|no remaining)\b/u.test(evidenceText);
  const noChangeIsExpected =
    /\b(qa|audit|review|verify|verification|validate|test|retest|confirm|check)\b/u.test(taskText)
    || /(审计|审核|验证|复检|复查|确认|测试|检查)/u.test(taskText)
    || /\b(already fixed|already resolved|no further changes|no code changes|no file changes|no additional changes|verified existing fix)\b/u.test(evidenceText)
    || /(已修复|已解决|无需改动|无需修改|没有额外修改|无需额外变更|只需验证)/u.test(evidenceText);
  return hasVerificationEvidence && noChangeIsExpected;
}

function applyTaskResult(
  taskId: string,
  result: string,
  error: string | undefined,
  deps: ControllerHttpDeps,
): TaskInfo | undefined {
  const { logger, updateTeamState, wsServer } = deps;
  let completionEvent: TaskExecutionEvent | undefined;

  const state = updateTeamState((s) => {
    const task = s.tasks[taskId];
    if (!task) return;

    task.status = error ? "failed" : "completed";
    task.result = result;
    task.error = error;
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    // Re-enrich deliverables now that the full result text is available.
    if (!error && task.resultContract) {
      // Filter out stale deliverables from other projects first
      task.resultContract = filterStaleDeliverables(task.resultContract, task.projectDir);
      let enriched = enrichDeliverablesWithPreviewInference(task.resultContract, result);
      if (!enriched) {
        // Text-based enrichment failed — scan the workspace filesystem for HTML files.
        enriched = enrichWithFilesystemHtmlScan(task.resultContract, task.projectDir);
      }
      if (enriched) {
        task.resultContract = enriched;
      }
    }
    completionEvent = appendTaskExecutionEvent(task, {
      type: error ? "error" : "lifecycle",
      phase: error ? "result_failed" : "result_completed",
      source: "controller",
      status: error ? "failed" : "completed",
      message: error ? `Task failed: ${error}` : "Task completed successfully.",
      workerId: task.assignedWorkerId,
      role: task.assignedRole,
    });

    if (task.assignedWorkerId && s.workers[task.assignedWorkerId]) {
      const assignedWorker = s.workers[task.assignedWorkerId];
      if (assignedWorker.status !== "offline") {
        assignedWorker.status = "idle";
      }
      assignedWorker.currentTaskId = undefined;
    }
  });

  const updatedTask = state.tasks[taskId];
  if (updatedTask) {
    if (completionEvent) {
      broadcastTaskExecutionEvent(taskId, updatedTask, completionEvent, deps);
    }
    wsServer.broadcastUpdate({ type: "task:completed", data: serializeTask(updatedTask) });
    logger.info(`Controller: task ${taskId} ${error ? "failed" : "completed"}`);
    if (error && updatedTask.assignedWorkerId && deps.workerProvisioningManager?.hasManagedWorker(updatedTask.assignedWorkerId)) {
      void deps.workerProvisioningManager.onWorkerRemoved(
        updatedTask.assignedWorkerId,
        `task ${taskId} failed; retiring managed worker before retry`,
      ).catch((err) => {
        logger.warn(`Controller: failed to retire managed worker ${updatedTask.assignedWorkerId}: ${String(err)}`);
      });
    }
    if (updatedTask.assignedWorkerId) {
      void autoAssignPendingTasks(deps, updatedTask.assignedWorkerId).catch((err) => {
        logger.warn(
          `Controller: failed to auto-assign pending tasks after result for ${taskId}: ${String(err)}`,
        );
      });
    }
    scheduleProvisioningReconcile(deps, `task-result:${taskId}`);
    if (!error && updatedTask.createdBy === "controller") {
      void continueControllerWorkflow(updatedTask, deps).catch((err) => {
        logger.warn(
          `Controller: failed to continue intake workflow after ${taskId}: ${String(err)}`,
        );
      }).finally(() => {
        // After the follow-up run completes (or if there was none), check session completion.
        void checkAndGenerateReport(updatedTask, deps).catch(() => {});
      });
    } else if (updatedTask.controllerSessionKey) {
      // Non-controller tasks or failed tasks — still check session completion.
      void checkAndGenerateReport(updatedTask, deps).catch(() => {});
    }
  }

  return updatedTask;
}

async function requestTaskClarification(params: {
  taskId: string;
  requestedBy: string;
  requestedByWorkerId?: string;
  requestedByRole?: RoleId;
  question: string;
  blockingReason: string;
  context?: string;
  questionSchema?: ClarificationRequest["questionSchema"];
}, deps: ControllerHttpDeps): Promise<{
  status: "created" | "already-pending" | "conflict" | "missing-task";
  clarification?: ClarificationRequest;
  task?: TaskInfo;
}> {
  const { getTeamState, updateTeamState, wsServer } = deps;
  const currentState = getTeamState();
  const currentTask = currentState?.tasks[params.taskId];
  if (!currentTask) {
    return { status: "missing-task" };
  }

  if (currentTask.clarificationRequestId) {
    const existing = currentState?.clarifications[currentTask.clarificationRequestId];
    if (existing?.status === "pending") {
      return { status: "already-pending", clarification: existing, task: currentTask };
    }
  }

  if (currentTask.status === "completed" || currentTask.status === "failed") {
    return { status: "conflict", task: currentTask };
  }

  const previousWorkerId = currentTask.assignedWorkerId;
  const clarificationId = generateId();
  const now = Date.now();
  const clarification: ClarificationRequest = {
    id: clarificationId,
    taskId: params.taskId,
    requestedBy: params.requestedBy,
    requestedByWorkerId: params.requestedByWorkerId,
    requestedByRole: params.requestedByRole,
    question: params.question,
    questionSchema: params.questionSchema,
    blockingReason: params.blockingReason,
    context: params.context,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const state = updateTeamState((s) => {
    s.clarifications[clarificationId] = clarification;
    const task = s.tasks[params.taskId];
    if (!task) {
      return;
    }

    const assignedWorkerId = task.assignedWorkerId;
    task.status = "blocked";
    task.progress = `Awaiting clarification: ${params.question}`;
    task.clarificationRequestId = clarificationId;
    task.assignedWorkerId = undefined;
    task.updatedAt = now;

    if (assignedWorkerId && s.workers[assignedWorkerId]) {
      const assignedWorker = s.workers[assignedWorkerId];
      if (assignedWorker.status !== "offline") {
        assignedWorker.status = "idle";
      }
      assignedWorker.currentTaskId = undefined;
    }
  });

  await cancelTaskExecution(params.taskId, previousWorkerId, "clarification request", deps);

  const updatedTask = state.tasks[params.taskId];
  wsServer.broadcastUpdate({ type: "clarification:requested", data: clarification });
  if (updatedTask) {
    recordTaskExecutionEvent(params.taskId, {
      type: "lifecycle",
      phase: "clarification_requested",
      source: "controller",
      message: `Clarification requested: ${params.question}`,
      role: clarification.requestedByRole,
      workerId: clarification.requestedByWorkerId,
    }, deps);
    wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
  }

  return { status: "created", clarification, task: updatedTask };
}

function ensureTaskResultContract(
  taskId: string,
  result: string,
  error: string | undefined,
  deps: ControllerHttpDeps,
): WorkerTaskResultContract | undefined {
  const state = deps.getTeamState();
  const currentTask = state?.tasks[taskId];
  if (!currentTask) {
    return undefined;
  }
  if (currentTask.resultContract) {
    // Worker submitted a structured contract — but it may be missing preview
    // fields (artifactType, previewCommand, etc.). Enrich deliverables
    // so the PreviewManager can auto-launch previews.
    let enriched = enrichDeliverablesWithPreviewInference(currentTask.resultContract, result);
    if (!enriched) {
      // Text-based enrichment failed — scan the workspace filesystem for HTML files.
      enriched = enrichWithFilesystemHtmlScan(currentTask.resultContract, currentTask.projectDir);
    }
    if (enriched) {
      deps.updateTeamState((teamState) => {
        const task = teamState.tasks[taskId];
        if (task) {
          task.resultContract = enriched;
          task.updatedAt = Date.now();
        }
      });
      return enriched;
    }
    return currentTask.resultContract;
  }

  let contract = backfillWorkerTaskResultContract(currentTask, result, error);
  if (!error) {
    const enriched = enrichDeliverablesWithPreviewInference(contract, result)
      ?? enrichWithFilesystemHtmlScan(contract, currentTask.projectDir);
    if (enriched) {
      contract = enriched;
    }
  }
  deps.updateTeamState((teamState) => {
    const task = teamState.tasks[taskId];
    if (!task || task.resultContract) {
      return;
    }
    task.resultContract = contract;
  });
  recordTaskExecutionEvent(taskId, {
    type: "lifecycle",
    phase: "result_contract_backfilled",
    source: "controller",
    message: "Worker did not submit a structured result contract; TeamClaw backfilled one from the recorded task result.",
    workerId: currentTask.assignedWorkerId,
    role: currentTask.assignedRole,
  }, deps);
  return contract;
}

function buildEffectiveTaskResultContract(
  task: TaskInfo,
  result: string,
  error: string | undefined,
  submittedContract?: WorkerTaskResultContract,
): WorkerTaskResultContract {
  let contract = submittedContract
    ? filterStaleDeliverables(submittedContract, task.projectDir)
    : backfillWorkerTaskResultContract(task, result, error);
  if (!error) {
    const enriched = enrichDeliverablesWithPreviewInference(contract, result)
      ?? enrichWithFilesystemHtmlScan(contract, task.projectDir);
    if (enriched) {
      contract = enriched;
    }
  }
  return contract;
}

function buildResultContractSection(task: TaskInfo): string {
  const contract = task.resultContract;
  if (!contract) {
    return "";
  }

  const lines = [
    "## Structured Result Contract",
    `Outcome: ${contract.outcome}`,
    `Summary: ${contract.summary}`,
  ];
  if (contract.deliverables.length > 0) {
    lines.push("Deliverables:");
    for (const deliverable of contract.deliverables) {
      const summary = deliverable.summary ? ` — ${deliverable.summary}` : "";
      lines.push(`- ${deliverable.kind}: ${deliverable.value}${summary}`);
    }
  }
  if (contract.keyPoints.length > 0) {
    lines.push("Key points:");
    for (const keyPoint of contract.keyPoints) {
      lines.push(`- ${keyPoint}`);
    }
  }
  if (contract.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of contract.blockers) {
      lines.push(`- ${blocker}`);
    }
  }
  if (contract.followUps.length > 0) {
    lines.push("Suggested follow-ups:");
    for (const followUp of contract.followUps) {
      const roleLabel = followUp.targetRole ? ` (${followUp.targetRole})` : "";
      lines.push(`- ${followUp.type}${roleLabel}: ${followUp.reason}`);
    }
  }
  if (contract.questions.length > 0) {
    lines.push("Open questions:");
    for (const question of contract.questions) {
      lines.push(`- ${question}`);
    }
  }
  if (contract.notes) {
    lines.push(`Notes: ${contract.notes}`);
  }
  if (contract.discoveredPatterns && contract.discoveredPatterns.length > 0) {
    lines.push("Discovered patterns:");
    for (const pattern of contract.discoveredPatterns) {
      lines.push(`- ${pattern}`);
    }
  }
  return lines.join("\n");
}

const MAX_PATTERNS_FILE_BYTES = 64 * 1024;

function consolidateDiscoveredPatterns(
  contract: WorkerTaskResultContract,
  taskId: string,
  role: string | undefined,
  logger: PluginLogger,
): void {
  const patterns = contract.discoveredPatterns;
  if (!patterns || patterns.length === 0) {
    return;
  }
  try {
    const workspaceDir = resolveTeamClawWorkspaceDir();
    const patternsFile = path.join(workspaceDir, "memory", "patterns.md");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });

    let currentSize = 0;
    try {
      currentSize = fs.statSync(patternsFile).size;
    } catch {
      // File doesn't exist yet; will be created by append.
    }
    if (currentSize > MAX_PATTERNS_FILE_BYTES) {
      logger.info(`Controller: patterns.md already ${currentSize} bytes, skipping consolidation for ${taskId}`);
      return;
    }

    const roleLabel = role ?? "unknown";
    const timestamp = new Date().toISOString().slice(0, 10);
    const section = [
      "",
      `## ${timestamp} — ${taskId} (${roleLabel})`,
      ...patterns.map((p) => `- ${p}`),
    ].join("\n") + "\n";

    fs.appendFileSync(patternsFile, section, "utf8");
    logger.info(`Controller: consolidated ${patterns.length} pattern(s) from ${taskId} into patterns.md`);
  } catch (err) {
    logger.warn(`Controller: failed to consolidate patterns for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildConsolidatedPatternsContext(): string {
  try {
    const workspaceDir = resolveTeamClawWorkspaceDir();
    const patternsFile = path.join(workspaceDir, "memory", "patterns.md");
    const content = fs.readFileSync(patternsFile, "utf8").trim();
    // Only inject if there are actual patterns (more than just the header)
    const lines = content.split("\n").filter((l: string) => l.startsWith("- "));
    if (lines.length === 0) {
      return "";
    }
    return [
      "## Discovered Codebase Patterns",
      "Previous workers discovered these reusable patterns. Apply them where relevant:",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}

function revertTaskAssignment(taskId: string, workerId: string, deps: ControllerHttpDeps): TaskInfo | undefined {
  const { updateTeamState, wsServer } = deps;
  let revertEvent: TaskExecutionEvent | undefined;

  const state = updateTeamState((s) => {
    const task = s.tasks[taskId];
    if (!task) {
      return;
    }

    if (task.assignedWorkerId === workerId) {
      task.status = "pending";
      task.assignedWorkerId = undefined;
      task.updatedAt = Date.now();
      revertEvent = appendTaskExecutionEvent(task, {
        type: "error",
        phase: "assignment_reverted",
        source: "controller",
        message: `Assignment to ${workerId} was reverted; task returned to pending.`,
      });
    }

    const worker = s.workers[workerId];
    if (worker?.currentTaskId === taskId) {
      if (worker.status !== "offline") {
        worker.status = "idle";
      }
      worker.currentTaskId = undefined;
    }

  });

  const updatedTask = state.tasks[taskId];
  if (updatedTask) {
    if (revertEvent) {
      broadcastTaskExecutionEvent(taskId, updatedTask, revertEvent, deps);
    }
    wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    void autoAssignPendingTasks(deps).catch(() => {
      // Best-effort retry path; assignment failure is already surfaced via task state.
    });
    scheduleProvisioningReconcile(deps, `assignment-reverted:${taskId}`);
  }
  return updatedTask;
}

async function deliverMessageToWorker(
  worker: WorkerInfo,
  message: TeamMessage,
  deps: ControllerHttpDeps,
): Promise<void> {
  const res = await fetch(`${worker.url}/api/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    throw new Error(`worker ${worker.id} responded with ${res.status}`);
  }
}

async function routeDirectMessage(
  message: TeamMessage,
  deps: ControllerHttpDeps,
): Promise<boolean> {
  const { getTeamState, logger, messageRouter } = deps;
  const state = getTeamState();
  if (!state) {
    return false;
  }

  const routed = messageRouter.routeDirectMessage(message, state.workers);
  if (!routed) {
    return false;
  }

  try {
    await deliverMessageToWorker(routed.worker, routed.message, deps);
  } catch (err) {
    logger.warn(`Controller: failed to deliver message to ${routed.worker.id}: ${String(err)}`);
  }

  return true;
}

async function dispatchTaskToWorker(
  taskId: string,
  worker: WorkerInfo,
  deps: ControllerHttpDeps,
): Promise<void> {
  const { getTeamState, logger, updateTeamState } = deps;
  const state = getTeamState();
  const task = state?.tasks[taskId];
  if (!task) {
    throw new Error(`task ${taskId} not found`);
  }

  // Ensure project directory exists
  if (task.projectDir) {
    const projectPath = path.join(resolveTeamClawProjectsDir(), task.projectDir);
    try { fs.mkdirSync(projectPath, { recursive: true }); } catch { /* best-effort */ }
  }

  // Collaboration contract: WRITE tasks execute in a task-scoped git worktree
  // (branch teamclaw/task-<id>) so parallel roles never share a dirty checkout;
  // delivery happens via push + PR in the write-back reconciler.
  let assignmentProjectDir = task.projectDir;
  if (task.writeMode === "write" && task.projectDir?.startsWith("teamauto/") && !task.projectDir.includes("__task-")) {
    const scheduler = deps.getTeamAutoScheduler?.();
    if (scheduler) {
      const repoId = task.projectDir.slice("teamauto/".length).replace(/__/g, "/");
      try {
        assignmentProjectDir = await scheduler.ensureWriteWorktree(repoId, taskId);
        updateTeamState((s) => {
          const t = s.tasks[taskId];
          if (t) { t.projectDir = assignmentProjectDir; }
        });
        logger.info(`Controller: write task ${taskId} -> worktree projects/${assignmentProjectDir}`);
      } catch (err) {
        logger.warn(`Controller: worktree setup failed for ${taskId}, falling back to shared checkout: ${String(err)}`);
      }
    }
  }

  const sharedWorkspace = deps.workerProvisioningManager?.isSharedWorkspaceWorker(worker.id)
    || false;
  const repoState = await refreshControllerRepoState(deps);
  const repoInfo = buildRepoSyncInfo(repoState, sharedWorkspace);
  const description = buildTaskAssignmentDescription(task, state ?? null, repoInfo);
  const recommendedSkills = resolveActiveRoleSkills(task.assignedRole, task.recommendedSkills ?? []);
  // Resume support: reuse the interrupted execution's session so the worker
  // continues the same persisted OpenClaw conversation instead of starting over.
  const executionIdentity = (task.checkpoint?.sessionKey)
    ? { executionSessionKey: task.checkpoint.sessionKey, executionIdempotencyKey: buildTaskExecutionIdentity(task.id, worker.id).executionIdempotencyKey }
    : buildTaskExecutionIdentity(task.id, worker.id);
  const assignment: TaskAssignmentPayload = {
    taskId: task.id,
    title: task.title,
    description,
    priority: task.priority,
    recommendedSkills,
    projectDir: assignmentProjectDir,
    executionSessionKey: executionIdentity.executionSessionKey,
    executionIdempotencyKey: executionIdentity.executionIdempotencyKey,
    checkpoint: task.checkpoint,
    resumeAttempt: task.resumeAttempt,
    repo: repoInfo,
    teamContext: buildTaskContextSnapshot(task, state ?? null),
  };

  const res = await fetch(`${worker.url}/api/v1/tasks/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assignment),
  });

  if (!res.ok) {
    throw new Error(`worker ${worker.id} responded with ${res.status}`);
  }
}

async function assignTaskToWorker(
  taskId: string,
  worker: WorkerInfo,
  deps: ControllerHttpDeps,
  options?: {
    assignedRole?: RoleId;
  },
): Promise<TaskInfo | undefined> {
  const { logger, updateTeamState } = deps;
  let assignmentApplied = false;

  updateTeamState((s) => {
    const task = s.tasks[taskId];
    const targetWorker = s.workers[worker.id];
    if (!task || !targetWorker) {
      return;
    }
    if (targetWorker.status !== "idle") {
      return;
    }
    const canAssignCurrentTask =
      task.status === "pending" ||
      (task.status === "assigned" && task.assignedWorkerId === worker.id);
    if (!canAssignCurrentTask) {
      return;
    }

    task.status = "assigned";
    task.assignedWorkerId = worker.id;
    if (options?.assignedRole) {
      task.assignedRole = options.assignedRole;
    }
    resetTaskForFreshAttempt(task);
    task.updatedAt = Date.now();

    targetWorker.status = "busy";
    targetWorker.currentTaskId = taskId;
    assignmentApplied = true;
  });

  if (!assignmentApplied) {
    return deps.getTeamState()?.tasks[taskId];
  }

  try {
    await dispatchTaskToWorker(taskId, worker, deps);
  } catch (err) {
    logger.warn(`Controller: failed to dispatch task ${taskId} to ${worker.id}: ${String(err)}`);
    recordTaskExecutionEvent(taskId, {
      type: "error",
      phase: "dispatch_failed",
      source: "controller",
      message: `Failed to dispatch task to ${worker.id}: ${String(err)}`,
      workerId: worker.id,
      role: options?.assignedRole ?? worker.role,
    }, deps);
    return revertTaskAssignment(taskId, worker.id, deps);
  }

  recordTaskExecutionEvent(taskId, {
    type: "lifecycle",
    phase: "assigned",
    source: "controller",
    message: `Assigned to ${worker.label || worker.id}.`,
    workerId: worker.id,
    role: options?.assignedRole ?? worker.role,
  }, deps);

  return deps.getTeamState()?.tasks[taskId];
}

// ===========================================================================
// Team profile switch (Phase 2.1, vertical-team-profiles-design.md 2.3).
//
// Six-step semantics of POST /api/v1/team/profile:
//   0. validate profileId + reject concurrent switches (409)   [endpoint]
//   1. transition = { draining, target, startedAt }; persisted + WS event
//   2. graceful drain of in-flight tasks (timeout -> force-collect),
//      terminate workers                                        [drainTeam...]
//   3. archive the WHOLE TeamState + roles snapshot             [state.ts]
//   4. fresh capability-conditioned TeamState for the target
//   5. warm the target profile's warmupRoles                    [provisioner]
//   6. clear transition, persist, broadcast team.switch_completed
// ===========================================================================

const SWITCH_DRAIN_POLL_INTERVAL_MS = 500;
/** Advisory backoff hint carried in 409 bodies for worker register/heartbeat. */
const SWITCH_WORKER_BACKOFF_HINT_MS = 5000;
const SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS = 5;
/** New-work entry points gated with 503 + Retry-While during a transition. */
const TRANSITION_BLOCKED_TASK_POST_PATHS = new Set([
  "/api/v1/tasks",
  "/api/v1/controller/intake",
  "/api/v1/controller/manifest",
]);
// Review fix: manual assign and parallel-help both spawn work for the
// outgoing team (parallel-help funnels into runControllerIntake, which also
// carries its own entry-level backstop); task handoff stays open - it is part
// of in-flight completion the drain waits on.
const TRANSITION_BLOCKED_TASK_POST_PATH_RES = [
  /^\/api\/v1\/tasks\/[^/]+\/assign$/,
  /^\/api\/v1\/tasks\/[^/]+\/parallel-help$/,
];
const WORKER_REGISTER_PATH = "/api/v1/workers/register";
const WORKER_HEARTBEAT_PATH_RE = /^\/api\/v1\/workers\/[^/]+\/heartbeat$/;

// ===========================================================================
// Capability 404 gates (Phase 2.3, vertical-team-profiles-design.md 4).
//
// Routes whose EXISTENCE depends on the active profile's capability switches.
// A disabled capability hides its routes entirely: 404 (never 403 - the
// resource does not exist for this team), with the owning `capability` key in
// the error body so CI can assert the reason. software-rd ships all four
// switches on, so its routing is unchanged.
//
// Ordering contract with the transition matrix above: the transition checks
// run FIRST in handleRequest, so while a profile switch is in flight the
// 503/409 transition semantics win over the steady-state 404 (e.g. POST
// /repo/import during a switch to a git-less profile reports "retry later",
// not "does not exist").
// ===========================================================================

type CapabilityGateKey = keyof TeamProfileCapabilities;

/**
 * Route -> capability map. Prefix entries hide the whole route family;
 * exact entries are method-bound single routes. Routes NOT listed here stay
 * up for every profile: capability-agnostic reads, capability reads that
 * degrade gracefully instead of disappearing (GET /api/v1/repo answers
 * { enabled: false } so the UI can render an off state), and - deliberately
 * - POST /api/v1/controller/manifest: that endpoint records the controller
 * INTAKE orchestration manifest (controllerRuns/projects/task bindings,
 * requirement:complete), it is not a delivery-report surface, and the
 * controller prompt rules make teamclaw_submit_manifest mandatory on every
 * reply (controller-tools POSTs this endpoint) - gating it under
 * deliveryReview would 404 every intake manifest of a deliveryReview=false
 * team and break the intake loop (cross-review fix).
 */
const CAPABILITY_GATE_PREFIXES: ReadonlyArray<readonly [prefix: string, capability: CapabilityGateKey]> = [
  ["/api/v1/teamauto", "teamauto"],
  ["/api/v1/previews/", "runnablePreview"],
  ["/api/v1/reports", "deliveryReview"],
];
const CAPABILITY_GATE_EXACT_PATHS: ReadonlyArray<readonly [method: string, pathname: string, capability: CapabilityGateKey]> = [
  ["POST", "/api/v1/repo/import", "git"],
  ["GET", "/api/v1/repo/bundle", "git"],
];

/**
 * Returns the capability that owns `pathname` when the ACTIVE profile has it
 * disabled, else null (route proceeds unchanged). Reads the active profile
 * per request so the gates flip atomically with the switch's step-4 profile
 * activation.
 */
function disabledCapabilityForPath(method: string, pathname: string): CapabilityGateKey | null {
  const { capabilities } = getActiveProfile();
  for (const [prefix, capability] of CAPABILITY_GATE_PREFIXES) {
    if (pathname.startsWith(prefix) && !capabilities[capability]) {
      return capability;
    }
  }
  for (const [gatedMethod, gatedPath, capability] of CAPABILITY_GATE_EXACT_PATHS) {
    if (method === gatedMethod && pathname === gatedPath && !capabilities[capability]) {
      return capability;
    }
  }
  return null;
}

function sleepForSwitchDrain(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskInFlightForDrain(task: TaskInfo): boolean {
  return Boolean(task.assignedWorkerId) && (task.status === "assigned" || task.status === "in_progress");
}

/**
 * Design 2.3 step 2: graceful drain. Waits until no task is assigned /
 * in-progress any more (in-flight workers report results through their
 * normal endpoints, which stay open during the transition), then returns.
 * On timeout the remaining in-flight tasks are force-collected (failed with
 * an explicit error so the archive records the forced end) and all workers
 * are marked offline. Managed workers are terminated by the caller through
 * the provisioning manager's onWorkerRemoved (the terminateManagedWorker
 * single point); external workers observe 409 heartbeats and back off.
 */
async function drainTeamForProfileSwitch(
  deps: ControllerHttpDeps,
): Promise<{ timedOut: boolean; forceCollected: string[] }> {
  const { config, logger, getTeamState, updateTeamState } = deps;
  const deadline = Date.now() + config.teamSwitchDrainTimeoutMs;
  while (Date.now() < deadline) {
    const state = getTeamState();
    if (!state || !Object.values(state.tasks).some(taskInFlightForDrain)) {
      return { timedOut: false, forceCollected: [] };
    }
    await sleepForSwitchDrain(SWITCH_DRAIN_POLL_INTERVAL_MS);
  }

  const forceCollected: string[] = [];
  updateTeamState((state) => {
    for (const task of Object.values(state.tasks)) {
      if (taskInFlightForDrain(task)) {
        task.status = "failed";
        task.error = `team profile switch drain timeout (${config.teamSwitchDrainTimeoutMs}ms) - in-flight task force-collected into the team archive`;
        task.updatedAt = Date.now();
        forceCollected.push(task.id);
      }
    }
    for (const worker of Object.values(state.workers)) {
      worker.status = "offline";
      worker.currentTaskId = undefined;
    }
  });
  logger.warn(
    `Controller: profile switch drain timed out after ${config.teamSwitchDrainTimeoutMs}ms - force-collected ${forceCollected.length} in-flight task(s)`,
  );
  return { timedOut: true, forceCollected };
}

export type TeamProfileSwitchOptions = {
  /**
   * Crash resume (design 2.3): the archive file for this switch already
   * exists, so skip the drain+archive steps (2-3) and rebuild the new team
   * directly (steps 4-6).
   */
  skipArchive?: boolean;
};

/**
 * Run switch steps 2-6 (step 1 - setting and persisting the transition -
 * belongs to the POST endpoint / crash resume). Exported so the controller
 * startup chain can resume an interrupted switch with the same semantics.
 */
export async function executeTeamProfileSwitch(
  deps: ControllerHttpDeps,
  targetProfileId: string,
  options: TeamProfileSwitchOptions = {},
): Promise<void> {
  const { config, logger, getTeamState, updateTeamState, wsServer, workerProvisioningManager } = deps;
  const target = BUILTIN_PROFILES.get(targetProfileId);
  if (!target) {
    throw new Error(`TeamClaw team profile "${targetProfileId}" is not available in this installation`);
  }
  const setPhase = (phase: "draining" | "archiving" | "warming"): void => {
    updateTeamState((state) => {
      if (state.transition?.targetProfileId === targetProfileId) {
        state.transition.phase = phase;
      }
    });
  };

  if (!options.skipArchive) {
    // Step 2: drain in-flight work, then stop every worker.
    setPhase("draining");
    workerProvisioningManager?.setReconcileSuspended(true);
    const drain = await drainTeamForProfileSwitch(deps);
    for (const workerId of Object.keys(getTeamState()?.provisioning?.workers ?? {})) {
      if (workerProvisioningManager?.hasManagedWorker(workerId)) {
        await workerProvisioningManager
          .onWorkerRemoved(workerId, `team profile switch to "${targetProfileId}"`)
          .catch((err) => logger.warn(`Controller: failed to terminate managed worker ${workerId} during profile switch: ${String(err)}`));
      }
    }
    // Capability teardown for subsystems the target profile switches off
    // (minimal Phase 2.3 preview; the full 404 short-circuit lands in 2.3).
    // NOTE: teardown is one-directional at runtime. Switching a capability
    // back ON does not (re)start its subsystem here - TeamAuto scheduling
    // and preview restoration are wired at controller startup only, so an
    // off -> on switch (e.g. minimal-bank -> software-rd) takes effect for
    // those subsystems after the next gateway restart.
    if (!target.capabilities.teamauto) {
      const scheduler = deps.getTeamAutoScheduler?.() ?? null;
      if (scheduler) {
        try {
          await scheduler.stop();
        } catch { /* scheduler already stopped */ }
      }
    }
    if (!target.capabilities.runnablePreview && deps.previewManager) {
      try {
        await deps.previewManager.stopAll();
      } catch { /* previews already stopped */ }
    }

    // Step 3: archive the whole previous TeamState with a roles snapshot.
    // The phase flip is persisted BEFORE the archive write so a crash between
    // the two leaves an unambiguous "archive may exist" state for the resume
    // path (file existence check).
    setPhase("archiving");
    const sourceState = getTeamState();
    if (sourceState) {
      await saveTeamState(sourceState);
      const sourceProfile = getActiveProfile();
      await archiveTeamState(sourceState, {
        id: sourceProfile.id,
        name: sourceProfile.name,
        nameZh: sourceProfile.nameZh,
        version: sourceProfile.version,
        roles: sourceProfile.roles,
      });
      logger.info(
        `Controller: archived team "${sourceState.teamName}" (profile ${sourceProfile.id}, `
          + `${Object.keys(sourceState.tasks).length} task(s))${drain.timedOut ? " after drain timeout" : ""}`,
      );
    }
  }

  // Step 4: fresh TeamState for the target profile, conditioned on its
  // capability switches (design 2.3: banking omits repo/previews/reports).
  // setActiveProfileId and the state mutation below are both synchronous, so
  // no request can observe the new state against the old profile.
  const repoState = target.capabilities.git
    ? await ensureControllerGitRepo(config, logger).catch((err) => {
        logger.warn(`Controller: failed to prepare git collaboration repo for profile "${target.id}": ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : null;
  setActiveProfileId(target.id);
  const newCreatedAt = Date.now();
  updateTeamState((state) => {
    state.profileId = target.id;
    state.teamName = target.name;
    state.workers = {};
    state.tasks = {};
    state.controllerRuns = {};
    state.projects = {};
    state.messages = [];
    state.clarifications = {};
    state.provisioning = { workers: {} };
    if (target.capabilities.git && repoState) {
      state.repo = repoState;
    } else {
      delete state.repo;
    }
    if (target.capabilities.runnablePreview) {
      state.previews = {};
    } else {
      delete state.previews;
    }
    if (target.capabilities.deliveryReview) {
      state.reports = {};
    } else {
      delete state.reports;
    }
    state.createdAt = newCreatedAt;
  });
  await saveTeamState(getTeamState()!);

  // Step 5: warm the new profile's warmupRoles through the provisioning
  // pipeline (launch dispatch; registration/readiness tracking continues in
  // the background exactly like a cold start).
  setPhase("warming");
  await saveTeamState(getTeamState()!);
  workerProvisioningManager?.setReconcileSuspended(false);
  if (workerProvisioningManager?.isEnabled() && target.warmupRoles.length > 0) {
    await workerProvisioningManager
      .warmRolesForTeamSwitch(target.warmupRoles, `profile switch warmup (${target.id})`)
      .catch((err) => logger.warn(`Controller: profile switch warmup failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Step 6: settle - clear the transition, persist, announce.
  updateTeamState((state) => {
    delete state.transition;
  });
  await saveTeamState(getTeamState()!);
  wsServer.broadcastUpdate({ type: "team.switch_completed", data: { profileId: target.id } });
  logger.info(`Controller: team profile switch to "${target.id}" completed`);
}

/**
 * Design 2.3 crash semantics: on controller startup, an unfinished persisted
 * transition is resumed idempotently. If the archive file for this switch
 * already exists AND the phase is at/after "archiving", jump straight to
 * building the new team (skipArchive); otherwise re-run the drain from
 * scratch (drain is idempotent - a completed drain simply finds no in-flight
 * tasks). Returns true when a transition was resumed.
 */
export async function resumeTeamProfileSwitch(deps: ControllerHttpDeps): Promise<boolean> {
  const state = deps.getTeamState();
  const transition = state?.transition;
  if (!state || !transition) {
    return false;
  }
  if (!hasProfile(transition.targetProfileId)) {
    // Same red line as restoring an unknown profileId (design 2.2): a team
    // mid-switch to an unavailable profile must never silently land on a
    // different profile.
    throw new Error(
      `Controller: interrupted team profile switch references profile "${transition.targetProfileId}", which is not available in this installation. `,
    );
  }
  deps.logger.info(
    `Controller: resuming interrupted team profile switch to "${transition.targetProfileId}" (phase: ${transition.phase}, started at ${new Date(transition.startedAt).toISOString()})`,
  );
  // A persisted state whose profileId already equals the target means step 4
  // flipped the team identity onto the NEW team. Step 4 strictly follows the
  // completed archive write in the same execution (the archive file lands
  // atomically before step 4 runs), so that flip PROVES the archive exists.
  // This covers both phase "warming" and the ghost-archive window between
  // the step-4 flip reaching disk and the warming phase persisting - on disk
  // that window reads as (phase "archiving", profileId = target), where
  // looking up the SOURCE-named archive file with state.profileId would miss
  // it and a re-drain would seal the already-emptied NEW team as a ghost
  // archive entry. (Alternative considered: persisting a sourceProfileId on
  // the transition - rejected; this flip predicate is the identical proof
  // without transition-shape or migration churn, and it also degrades the
  // manually-corrupted (draining, target) combination the same safe way.)
  const step4Flipped = state.profileId === transition.targetProfileId;
  const archiveExists = step4Flipped
    || transition.phase === "warming"
    || Boolean(await findTeamSwitchArchive(state.profileId, transition.startedAt));
  const phaseAtOrAfterArchive = transition.phase === "archiving" || transition.phase === "warming";
  await executeTeamProfileSwitch(deps, transition.targetProfileId, {
    skipArchive: archiveExists && (phaseAtOrAfterArchive || step4Flipped),
  });
  return true;
}

export async function autoAssignPendingTasks(
  deps: ControllerHttpDeps,
  preferredWorkerId?: string,
): Promise<TaskInfo[]> {
  const { getTeamState, taskRouter, wsServer, logger, config } = deps;
  const attemptedPairs = new Set<string>();
  const assignedTasks: TaskInfo[] = [];
  const maxConcurrent = config.maxConcurrentTasks;

  // Phase 2.1 (design 2.3 concurrency matrix): while a profile switch
  // transition is active, never dispatch new work - pending tasks belong to
  // the outgoing team and are sealed into its archive.
  if (getTeamState()?.transition) {
    return assignedTasks;
  }

  while (true) {
    const state = getTeamState();
    if (!state) {
      break;
    }

    // Throttle: count currently in-progress tasks and respect maxConcurrentTasks
    const inProgressCount = Object.values(state.tasks).filter(
      (t) => t.status === "in_progress",
    ).length;
    if (inProgressCount >= maxConcurrent) {
      logger.debug?.(
        `Controller: skipping auto-assign — ${inProgressCount} tasks in_progress (max ${maxConcurrent})`,
      );
      break;
    }

    // Collaboration contract: serialize write tasks per repo checkout - a
    // second writer on the same root waits until the active one settles.
    const busyWriteRoots = activeWriteRoots(state);
    const candidateAssignments = taskRouter
      .autoAssignPendingTasks(state.tasks, state.workers)
      .filter(({ task, worker }) => !attemptedPairs.has(`${task.id}:${worker.id}`))
      .filter(({ task }) => {
        const root = taskWriteRoot(task);
        return !(root && busyWriteRoots.has(root));
      });

    const nextAssignment = (
      (preferredWorkerId
        ? candidateAssignments.find(({ worker }) => worker.id === preferredWorkerId)
        : undefined)
      ?? candidateAssignments[0]
    );

    if (!nextAssignment) {
      scheduleProvisioningReconcile(deps, preferredWorkerId
        ? `auto-assign-wait:${preferredWorkerId}`
        : "auto-assign-wait");
      break;
    }

    const pairKey = `${nextAssignment.task.id}:${nextAssignment.worker.id}`;
    attemptedPairs.add(pairKey);

    const updatedTask = await assignTaskToWorker(nextAssignment.task.id, nextAssignment.worker, deps, {
      assignedRole: nextAssignment.task.assignedRole,
    });

    if (updatedTask?.status === "assigned" && updatedTask.assignedWorkerId === nextAssignment.worker.id) {
      wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
      logger.info(
        `Controller: auto-assigned pending task ${updatedTask.id} to ${nextAssignment.worker.id}`,
      );
      assignedTasks.push(updatedTask);
    }
  }

  scheduleProvisioningReconcile(deps, preferredWorkerId
    ? `auto-assign:${preferredWorkerId}`
    : "auto-assign");

  return assignedTasks;
}

export function createControllerHttpServer(deps: ControllerHttpDeps): http.Server {
  const { logger, wsServer } = deps;
  let tunnelManagerSingleton: TunnelManager | null = null;

  const readFormBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  };

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Tunnel sharing: every request arriving via <user>.apps.teamclaw.dev is
    // gated behind the token the local web UI displays.
    let tunnelManager = tunnelManagerSingleton;
    if (!tunnelManager) {
      tunnelManager = tunnelManagerSingleton = createTunnelManager({ logger, localPort: deps.config.port });
    }
    const viaTunnel = tunnelManager.isTunnelRequest(typeof req.headers.host === "string" ? req.headers.host : undefined);
    if (viaTunnel) {
      if (req.method === "GET" && (pathname === "/__tunnel_gate" || pathname === "/")) {
        // Valid gate cookie on "/" goes straight to the dashboard; the gate
        // page only greets visitors who have not authenticated yet.
        if (pathname === "/" && tunnelManager.gateAllows(req)) {
          res.writeHead(302, { Location: "/ui/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
        return;
      }
      if (req.method === "POST" && pathname === "/__tunnel_gate/verify") {
        const form = await readFormBody(req);
        const submitted = String((form as { token?: unknown }).token ?? "").trim().toUpperCase();
        const st = tunnelManager.status();
        if (st.active && st.gateToken && submitted === st.gateToken) {
          const cookie = `${GATE_COOKIE_NAME}=${computeGateCookie(st.gateToken, st.tunnelId ?? "")}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax`;
          res.writeHead(302, { "Set-Cookie": cookie, Location: "/" });
          res.end();
          return;
        }
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), true));
        return;
      }
      if (!tunnelManager.gateAllows(req)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
        return;
      }
    } else {
      if (req.method === "GET" && pathname === "/api/v1/tunnel/status") {
        sendJson(res, 200, tunnelManager.status());
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/start") {
        const authStatus = await getGithubAuthManager(deps.config, logger).getStatus();
        const account = authStatus.account;
        if (!account?.login) { sendError(res, 401, "GitHub login required to share a tunnel"); return; }
        // Async launch: poll /tunnel/status for phase progress and the
        // resulting hostname/gateToken once startOp.phase === "done".
        const launched = tunnelManager.start(account.login);
        sendJson(res, 202, { launched, status: tunnelManager.status() });
        return;
      }
      // Self-hosted: user-owned Cloudflare tunnel via connector token (no
      // GitHub login, no platform tunnel server). Token from the request
      // body, or the TEAMCLAW_TUNNEL_TOKEN env injection when body is empty.
      if (req.method === "POST" && pathname === "/api/v1/tunnel/start-self-hosted") {
        let token = "";
        try {
          const body = await readFormBody(req) as { token?: unknown };
          token = String(body.token ?? "");
        } catch { /* fall through to env */ }
        if (!token.trim()) {
          const envToken = selfHostedTokenFromEnv();
          if (!envToken) { sendError(res, 400, "connector token required (or set TEAMCLAW_TUNNEL_TOKEN)"); return; }
          token = envToken;
        }
        const r = tunnelManager.startSelfHosted(token);
        if (!r.launched) { sendError(res, 400, r.error ?? "failed to start self-hosted tunnel"); return; }
        sendJson(res, 202, { launched: true, status: tunnelManager.status() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/start-quick") {
        const r = tunnelManager.startQuick();
        if (!r.launched) { sendError(res, 400, r.error ?? "failed to start quick tunnel"); return; }
        sendJson(res, 202, { launched: true, status: tunnelManager.status() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/stop") {
        await tunnelManager.stop();
        sendJson(res, 200, tunnelManager.status());
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/install-cloudflared") {
        try {
          const result = await tunnelManager.installCloudflared();
          sendJson(res, result.ok ? 200 : 500, { ...result, status: tunnelManager.status() });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : "install failed");
        }
        return;
      }
    }

    try {
      await handleRequest(req, res, pathname, deps);
    } catch (err) {
      logger.error(`Controller HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  });

  // Attach WebSocket
  wsServer.attach(server);

  // Plugin shutdown: kill the local connector and tear down the remote
  // tunnel so gateway exits never leak orphan cloudflared processes.
  server.on("close", () => {
    void tunnelManagerSingleton?.stop().catch(() => undefined);
  });

  // Boot reconciliation: reconnect a share persisted by a previous run
  // (gateway restart or kill -9) so the tunnel id and gate token survive.
  if (!tunnelManagerSingleton) {
    tunnelManagerSingleton = createTunnelManager({ logger, localPort: deps.config.port });
  }
  void tunnelManagerSingleton.recover().catch((err) => {
    logger.warn(`TeamClaw tunnel: boot recovery failed: ${String(err)}`);
  });

  setTimeout(() => {
    const state = deps.getTeamState();
    const pendingCount = state
      ? Object.values(state.tasks).filter((t) => t.status === "pending" && !t.assignedWorkerId).length
      : 0;
    if (pendingCount > 0) {
      logger.info(`Controller: startup reconciliation — ${pendingCount} pending tasks, triggering auto-assign`);
      void autoAssignPendingTasks(deps).catch((err) => {
        logger.warn(`Controller: startup auto-assign failed: ${String(err)}`);
      });
    }
  }, 2000);

  return server;
}

function resolveRequestOrigin(req: IncomingMessage, config: PluginConfig): string {
  const host = req.headers.host;
  if (typeof host === "string" && host.trim()) {
    return `http://${host.trim()}`;
  }
  return `http://127.0.0.1:${config.port}`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendGithubCallbackHtml(res: ServerResponse, statusCode: number, title: string, message: string): void {
  const html = [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtmlText(title)}</title>`,
    "<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0f1117;color:#e6e8ee}main{max-width:520px;padding:32px 40px;border:1px solid #2a2f3a;border-radius:14px;background:#161923;text-align:center}h1{font-size:20px;margin:0 0 10px}p{margin:6px 0;color:#a8b0c0;line-height:1.6}</style>",
    "</head><body><main>",
    `<h1>${escapeHtmlText(title)}</h1>`,
    `<p>${escapeHtmlText(message)}</p>`,
    "</main></body></html>",
  ].join("");
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ControllerHttpDeps,
): Promise<void> {
  void pathname;
  const { config, logger, getTeamState, updateTeamState, taskRouter, messageRouter, wsServer } = deps;
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const currentState = getTeamState();

  // ==================== Profile switch concurrency matrix ====================
  // Phase 2.1 (design 2.3): while a switch transition is in flight -
  //   - worker register/heartbeat -> 409 with an explicit backoff hint (the
  //     design contract for existing workers; they retry on their interval
  //     and re-register after team.switch_completed);
  //   - task submission POSTs -> 503 + Retry-After;
  //   - a second POST /api/v1/team/profile -> 409 (handled inside that
  //     endpoint, which owns the step-0 validation order);
  // Worker result/progress endpoints intentionally stay open: the drain step
  // waits for exactly those in-flight completions.
  const activeTransition = currentState?.transition;
  if (activeTransition) {
    if (req.method === "POST" && (pathname === WORKER_REGISTER_PATH || WORKER_HEARTBEAT_PATH_RE.test(pathname))) {
      sendJson(res, 409, {
        error: `Team profile switch to "${activeTransition.targetProfileId}" is in progress (phase: ${activeTransition.phase}); worker registration and heartbeat are temporarily rejected - back off and retry`,
        retryAfterMs: SWITCH_WORKER_BACKOFF_HINT_MS,
        transition: { phase: activeTransition.phase, targetProfileId: activeTransition.targetProfileId },
      });
      return;
    }
    if (
      req.method === "POST" &&
      (TRANSITION_BLOCKED_TASK_POST_PATHS.has(pathname) || TRANSITION_BLOCKED_TASK_POST_PATH_RES.some((re) => re.test(pathname)))
    ) {
      res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: `Team profile switch to "${activeTransition.targetProfileId}" is in progress (phase: ${activeTransition.phase}); task submission is temporarily unavailable - retry after the switch completes`,
        retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
        transition: { phase: activeTransition.phase, targetProfileId: activeTransition.targetProfileId },
      });
      return;
    }
    // Review fix: a bundle import during a transition would run after the
    // step-4 flip and stamp a repo field onto the new team even for profiles
    // with git disabled - the switch itself re-prepares repo state for
    // git-capable targets, so imports wait it out.
    if (req.method === "POST" && pathname === "/api/v1/repo/import") {
      res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: `Team profile switch to "${activeTransition.targetProfileId}" is in progress (phase: ${activeTransition.phase}); repo import is temporarily unavailable - retry after the switch completes`,
        retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
        transition: { phase: activeTransition.phase, targetProfileId: activeTransition.targetProfileId },
      });
      return;
    }
  }

  // ==================== Capability 404 gates (Phase 2.3) ====================
  // Steady-state existence gate, placed AFTER the transition matrix on
  // purpose: while a switch is in flight the 503/409 transition semantics
  // win over the steady-state 404 (e.g. repo import towards a git-less
  // target reports "retry later" during the switch, "does not exist" after
  // it). software-rd has all capabilities on, so this never fires there.
  const gatedCapability = disabledCapabilityForPath(req.method ?? "", pathname);
  if (gatedCapability) {
    const profile = getActiveProfile();
    sendJson(res, 404, {
      error: `Team profile "${profile.id}" has the "${gatedCapability}" capability disabled - this endpoint does not exist for this team`,
      capability: gatedCapability,
      profileId: profile.id,
    });
    return;
  }

  // ==================== Web UI ====================
  if (req.method === "GET" && pathname === "/") {
    res.statusCode = 302;
    res.setHeader("Location", "/ui");
    res.end();
    return;
  }

  if (req.method === "GET" && (pathname === "/ui" || pathname === "/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    serveVersionedHtml(res, path.join(uiPath, "index.html"));
    return;
  }

  // Standalone GitHub device-login page (big user code + prefilled link + polling).
  if (req.method === "GET" && (pathname === "/ui/auth/github" || pathname === "/ui/auth/github/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    serveStaticFile(res, path.join(uiPath, "github-login.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    const file = pathname.slice(4); // remove "/ui/"
    if (file.endsWith(".css")) {
      serveStaticFile(res, path.join(uiPath, file), "text/css; charset=utf-8");
    } else if (file.endsWith(".js")) {
      serveStaticFile(res, path.join(uiPath, file), "application/javascript; charset=utf-8");
    } else if (file.endsWith(".png")) {
      serveStaticFile(res, path.join(uiPath, file), "image/png");
    } else if (file.endsWith(".svg")) {
      serveStaticFile(res, path.join(uiPath, file), "image/svg+xml; charset=utf-8");
    } else if (file.endsWith(".ico")) {
      serveStaticFile(res, path.join(uiPath, file), "image/x-icon");
    } else {
      serveStaticFile(res, path.join(uiPath, file), "application/octet-stream");
    }
    return;
  }

  // ==================== TeamAuto ====================

  const teamAuto = deps.getTeamAutoScheduler?.() ?? null;

  if (req.method === "GET" && pathname === "/api/v1/teamauto/activity") {
    if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
    try {
      const activity = await teamAuto.getActivity();
      sendJson(res, 200, { activity });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to load activity");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/teamauto/repos") {
    if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
    try {
      sendJson(res, 200, await teamAuto.getStatus());
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to read TeamAuto status");
    }
    return;
  }

  // Selectable repos for the bind picker (the logged-in GitHub account's).
  if (req.method === "GET" && pathname === "/api/v1/teamauto/repo-candidates") {
    try {
      const auth = getGithubAuthManager(config, logger);
      const candidates = await createGithubClient(auth).listUserRepos();
      sendJson(res, 200, { candidates });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to list repositories");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/teamauto/repos") {
    if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
    let body: Record<string, unknown> = {};
    try { body = await parseJsonBody(req); } catch { /* empty body */ }
    const repo = typeof body.repo === "string" ? body.repo : "";
    if (!repo) { sendError(res, 400, "repo (owner/name) is required"); return; }
    try {
      const created = await teamAuto.addRepo(repo, {
        schedule: typeof body.schedule === "string" ? body.schedule : undefined,
        keywordInclude: Array.isArray(body.keywordInclude) ? body.keywordInclude.filter((k): k is string => typeof k === "string") : undefined,
        keywordExclude: Array.isArray(body.keywordExclude) ? body.keywordExclude.filter((k): k is string => typeof k === "string") : undefined,
      });
      sendJson(res, 201, created);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to bind repo");
    }
    return;
  }

  if (pathname.startsWith("/api/v1/teamauto/repos/")) {
    if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
    const repoId = decodeURIComponent(pathname.slice("/api/v1/teamauto/repos/".length).replace(/\/sweep$/, ""));
    const isSweep = pathname.endsWith("/sweep");
    if (req.method === "DELETE" && !isSweep) {
      try { await teamAuto.removeRepo(repoId); sendJson(res, 200, { ok: true }); }
      catch (err) { sendError(res, 400, err instanceof Error ? err.message : "failed to unbind"); }
      return;
    }
    if (req.method === "PATCH" && !isSweep) {
      let body: Record<string, unknown> = {};
      try { body = await parseJsonBody(req); } catch { /* empty */ }
      try {
        const updated = await teamAuto.updateRepo(repoId, {
          schedule: typeof body.schedule === "string" ? body.schedule : undefined,
          maxTasksPerSweep: typeof body.maxTasksPerSweep === "number" ? body.maxTasksPerSweep : undefined,
          fullReview: body.fullReview === "off" || body.fullReview === "weekly" || body.fullReview === "daily" ? body.fullReview : undefined,
          takeOwnership: typeof body.takeOwnership === "boolean" ? body.takeOwnership : undefined,
        });
        sendJson(res, 200, updated);
      } catch (err) { sendError(res, 400, err instanceof Error ? err.message : "failed to update"); }
      return;
    }
    if (req.method === "POST" && isSweep) {
      try { sendJson(res, 200, { summary: await teamAuto.runSweepNow(repoId, true) }); }
      catch (err) { sendError(res, 400, err instanceof Error ? err.message : "sweep failed"); }
      return;
    }
  }

  // ==================== GitHub Auth ====================

  if (req.method === "GET" && pathname === "/api/v1/auth/github/status") {
    try {
      const status = await getGithubAuthManager(config, logger).getStatus(resolveRequestOrigin(req, config));
      sendJson(res, 200, status);
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to read GitHub login status");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/github/login") {
    let flow: string | undefined;
    try {
      const body = await parseJsonBody(req) as { flow?: unknown };
      if (typeof body?.flow === "string") {
        flow = body.flow.trim();
      }
    } catch {
      // No body or invalid body: fall through to the default (device) flow.
    }
    const manager = getGithubAuthManager(config, logger);
    try {
      const loginPageUrl = resolveRequestOrigin(req, config).replace(/\/+$/, "") + "/ui/auth/github";
      if (flow === "web") {
        // Web flow needs a client secret for the code exchange; the device
        // flow (default) is fully secretless.
        const start = manager.beginLogin(resolveRequestOrigin(req, config));
        sendJson(res, 200, { mode: "web", loginPageUrl, ...start });
      } else {
        const start = await manager.beginDeviceLogin();
        // authorizeUrl intentionally points at our standalone login page so
        // older UI clients that just open response.authorizeUrl land on the
        // device-code page instead of a dead web-flow URL.
        sendJson(res, 200, { mode: "device", loginPageUrl, authorizeUrl: loginPageUrl, ...start });
      }
      logger.info(`Controller: GitHub login flow started (${flow === "web" ? "web" : "device"})`);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to start GitHub login");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/auth/github/callback") {
    const callbackError = requestUrl.searchParams.get("error");
    if (callbackError) {
      const description = requestUrl.searchParams.get("error_description") ?? "";
      logger.warn(`Controller: GitHub login was denied (${callbackError})`);
      sendGithubCallbackHtml(
        res,
        400,
        "GitHub login failed",
        `Authorization was denied: ${callbackError}${description ? ` (${description})` : ""}`,
      );
      return;
    }
    const code = requestUrl.searchParams.get("code") ?? "";
    const state = requestUrl.searchParams.get("state") ?? "";
    try {
      const account = await getGithubAuthManager(config, logger).completeLogin({
        code: code || undefined,
        state: state || undefined,
      });
      logger.info(`Controller: GitHub login completed for @${account.login}`);
      sendGithubCallbackHtml(
        res,
        200,
        "GitHub login successful",
        `Signed in as @${account.login}（GitHub 登录成功，可关闭本页返回 TeamClaw）。`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Controller: GitHub login callback failed: ${message}`);
      sendGithubCallbackHtml(res, 400, "GitHub login failed", `${message}`);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/github/logout") {
    try {
      await getGithubAuthManager(config, logger).logout();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to sign out of GitHub");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/github/refresh") {
    try {
      const store = await getGithubAuthManager(config, logger).forceRefresh();
      sendJson(res, 200, { ok: true, account: store.account, expiresAt: store.expiresAt });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to refresh the GitHub token");
    }
    return;
  }

  // ==================== Workspace Browser ====================

  if (req.method === "GET" && pathname === "/api/v1/workspace/status") {
    sendJson(res, 200, {
      workspaceDir: resolveTeamClawWorkspaceDir(),
      isDefault: teamClawWorkspaceIsDefault(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/workspace/change-dir") {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch {
      sendError(res, 400, "invalid JSON body");
      return;
    }
    const workspaceDir = typeof (body as { workspaceDir?: unknown })?.workspaceDir === "string"
      ? (body as { workspaceDir: string }).workspaceDir
      : "";
    if (!workspaceDir.trim()) {
      sendError(res, 400, "workspaceDir is required");
      return;
    }
    try {
      const result = await updateTeamClawWorkspaceDir(workspaceDir, {
        warn: (message: string) => deps.logger.info(message),
      });
      sendJson(res, 200, {
        ok: true,
        workspaceDir: result.agentEntryPath,
        configPath: result.configPath,
        restartRequired: true,
      });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to update workspace directory");
    }
    return;
  }

  // GET /api/v1/models/config - model catalog + current selection for the UI settings dialog
  if (req.method === "GET" && pathname === "/api/v1/models/config") {
    try {
      sendJson(res, 200, await getTeamClawModelCatalog());
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to read model configuration");
    }
    return;
  }

  // PUT /api/v1/models/config - persist default and per-role model selection
  if (req.method === "PUT" && pathname === "/api/v1/models/config") {
    let body: { defaultModel?: unknown; roleModelOverrides?: unknown } | null = null;
    try {
      body = await parseJsonBody(req) as { defaultModel?: unknown; roleModelOverrides?: unknown };
    } catch {
      sendError(res, 400, "invalid JSON body");
      return;
    }
    const update: { defaultModel?: string; roleModelOverrides?: Record<string, string> } = {};
    if (typeof body?.defaultModel === "string") {
      update.defaultModel = body.defaultModel.trim();
    }
    if (body?.roleModelOverrides && typeof body.roleModelOverrides === "object" && !Array.isArray(body.roleModelOverrides)) {
      const overrides: Record<string, string> = {};
      for (const [role, value] of Object.entries(body.roleModelOverrides as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) {
          overrides[role] = value.trim();
        }
      }
      update.roleModelOverrides = overrides;
    }
    if (update.defaultModel === undefined && update.roleModelOverrides === undefined) {
      sendError(res, 400, "defaultModel or roleModelOverrides is required");
      return;
    }
    try {
      await updateTeamClawModelConfig(update, {
        warn: (message: string) => deps.logger.info(message),
      });
      sendJson(res, 200, {
        ok: true,
        restartNote: "Config changes hot-reload; restart the gateway (openclaw gateway restart) if a change does not take effect.",
        catalog: await getTeamClawModelCatalog(),
      });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to update model configuration");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/tree") {
    try {
      // depth=N limits tree expansion (default 1 for lazy loading)
      const depthParam = requestUrl.searchParams.get("depth");
      const maxDepth = depthParam !== null ? Math.max(0, Math.min(parseInt(depthParam, 10) || 1, 8)) : 1;
      sendJson(res, 200, await listWorkspaceTree(maxDepth));
    } catch (err) {
      sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/subtree") {
    const dirPath = requestUrl.searchParams.get("path") ?? "";
    if (!dirPath) {
      sendError(res, 400, "path is required");
      return;
    }
    try {
      sendJson(res, 200, { entries: await listWorkspaceSubtree(dirPath) });
    } catch (err) {
      sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/file") {
    const relativePath = requestUrl.searchParams.get("path") ?? "";
    if (!relativePath) {
      sendError(res, 400, "path is required");
      return;
    }

    try {
      sendJson(res, 200, { file: await readWorkspaceFile(relativePath) });
    } catch (err) {
      sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/project-path") {
    const projectDir = requestUrl.searchParams.get("projectDir") ?? "";
    if (!projectDir) {
      sendError(res, 400, "projectDir is required");
      return;
    }
    const absolutePath = resolveSafeProjectDirectory(projectDir);
    if (!absolutePath) {
      sendError(res, 400, "Invalid projectDir");
      return;
    }
    if (!fs.existsSync(absolutePath)) {
      sendError(res, 404, "Project directory not found");
      return;
    }
    sendJson(res, 200, {
      projectDir,
      absolutePath,
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/v1/workspace/raw/")) {
    const rawPathname = pathname.slice("/api/v1/workspace/raw/".length);
    if (!rawPathname) {
      sendError(res, 400, "path is required");
      return;
    }

    try {
      const relativePath = decodeURIComponent(rawPathname);
      const file = await readWorkspaceRawFile(relativePath);
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(file.content);
    } catch (err) {
      sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
    }
    return;
  }

  // ==================== Worker Management ====================

  // POST /api/v1/workers/register
  if (req.method === "POST" && pathname === "/api/v1/workers/register") {
    const body = await parseJsonBody(req);
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const role = validateActiveRoleId(body.role) ?? "";
    const label = typeof body.label === "string" ? body.label : role;
    const workerUrl = typeof body.url === "string" ? body.url : "";
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities as string[] : [];
    const launchToken = typeof body.launchToken === "string" ? body.launchToken : undefined;

    if (!workerId || !role || !workerUrl) {
      sendError(res, 400, "workerId, role, and url are required");
      return;
    }

    const registrationValidation = deps.workerProvisioningManager?.validateRegistration(workerId, role, launchToken);
    if (registrationValidation && !registrationValidation.ok) {
      sendError(res, 403, registrationValidation.reason ?? "Worker registration rejected");
      return;
    }

    const state = updateTeamState((s) => {
      s.workers[workerId] = {
        id: workerId,
        role,
        label,
        status: "idle",
        transport: "http",
        url: workerUrl,
        lastHeartbeat: Date.now(),
        capabilities,
        registeredAt: Date.now(),
      };
    });
    deps.workerProvisioningManager?.onWorkerRegistered(workerId);

    wsServer.broadcastUpdate({ type: "worker:online", data: state.workers[workerId] });
    logger.info(`Controller: worker registered - ${label} (${workerId}) at ${workerUrl}`);
    sendJson(res, 201, { status: "registered", worker: state.workers[workerId] });
    void autoAssignPendingTasks(deps, workerId).catch((err) => {
      logger.warn(`Controller: failed to auto-assign after worker registration (${workerId}): ${String(err)}`);
    });
    return;
  }

  // DELETE /api/v1/workers/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/workers\/[^/]+$/)) {
    const workerId = pathname.split("/").pop()!;
    if (deps.workerProvisioningManager?.hasManagedWorker(workerId)) {
      await deps.workerProvisioningManager.onWorkerRemoved(workerId, "worker delete requested");
    }

    const affectedTaskIds: string[] = [];
    updateTeamState((s) => {
      const worker = s.workers[workerId];
      if (worker) {
        worker.status = "offline";
        worker.currentTaskId = undefined;
        delete s.workers[workerId];
      }

      for (const task of Object.values(s.tasks)) {
        if (
          task.assignedWorkerId === workerId &&
          task.status !== "completed" &&
          task.status !== "failed" &&
          task.status !== "blocked"
        ) {
          task.status = "pending";
          task.assignedWorkerId = undefined;
          resetTaskForFreshAttempt(task);
          task.updatedAt = Date.now();
          affectedTaskIds.push(task.id);
        }
      }
    });

    await autoAssignPendingTasks(deps);
    for (const taskId of affectedTaskIds) {
      const task = getTeamState()?.tasks[taskId];
      if (task) {
        wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(task) });
      }
    }
    wsServer.broadcastUpdate({ type: "worker:offline", data: { workerId } });
    logger.info(`Controller: worker removed - ${workerId}`);
    sendJson(res, 200, { status: "removed" });
    return;
  }

  // GET /api/v1/workers
  if (req.method === "GET" && pathname === "/api/v1/workers") {
    const state = getTeamState();
    const workers = state
      ? Object.values(state.workers).map((worker) => ({
          ...worker,
          // Ghost rows from previous gateway processes (provisioned workers
          // die with the process they ran in). The controller cleans these on
          // startup; the flag lets the UI mark leftovers as removable.
          staleRemovable: worker.id.startsWith("provisioned-") && worker.status === "offline",
        }))
      : [];
    sendJson(res, 200, { workers });
    return;
  }

  // POST /api/v1/workers/:id/heartbeat
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/workers\/[^/]+\/heartbeat$/)) {
    const workerId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const status = typeof body.status === "string" ? body.status as WorkerInfo["status"] : "idle";
    const currentTaskId = typeof body.currentTaskId === "string" ? body.currentTaskId : undefined;

    updateTeamState((s) => {
      if (s.workers[workerId]) {
        s.workers[workerId].lastHeartbeat = Date.now();
        s.workers[workerId].status = status;
        s.workers[workerId].currentTaskId = currentTaskId;
      }
    });
    deps.workerProvisioningManager?.onWorkerHeartbeat(workerId, status);

    if (status === "idle") {
      await autoAssignPendingTasks(deps, workerId);
    } else {
      scheduleProvisioningReconcile(deps, `heartbeat:${workerId}:${status}`);
    }
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // ==================== Task Management ====================

  // POST /api/v1/tasks
  if (req.method === "POST" && pathname === "/api/v1/tasks") {
    const body = await parseJsonBody(req);
    const title = typeof body.title === "string" ? body.title : "";
    const description = typeof body.description === "string" ? body.description : "";
    const priority = typeof body.priority === "string" ? body.priority as TaskPriority : "medium";
    const assignedRole = validateActiveRoleId(body.assignedRole);
    const createdBy = typeof body.createdBy === "string" ? body.createdBy : "boss";
    const controllerSessionKey = createdBy === "controller" && typeof body.controllerSessionKey === "string" && body.controllerSessionKey.trim()
      ? normalizeControllerIntakeSessionKey(body.controllerSessionKey)
      : undefined;
    const explicitProjectName = typeof body.projectName === "string" && body.projectName.trim()
      ? deriveStableProjectKey(body.projectName)
      : undefined;
    const recommendedSkills = normalizeRecommendedSkills(
      Array.isArray(body.recommendedSkills) ? body.recommendedSkills.map((entry) => String(entry ?? "")) : [],
    );

    if (!title) {
      sendError(res, 400, "title is required");
      return;
    }
    if (createdBy === "controller") {
      const readinessGate = shouldBlockControllerUntilProvisioningReady(deps, currentState);
      if (readinessGate.blocked && readinessGate.readiness) {
        sendError(res, 503, buildStartupReadinessMessage(readinessGate.readiness));
        return;
      }
    }
    if (createdBy === "controller" && shouldBlockControllerWithoutWorkers(deps.config, getTeamState())) {
      sendError(res, 409, buildControllerNoWorkersMessage());
      return;
    }

    const taskId = generateId();
    const now = Date.now();
    const repoState = await refreshControllerRepoState(deps);

    const inheritedProject = controllerSessionKey
      ? resolveProjectIdentityForSession(controllerSessionKey, getTeamState())
      : undefined;
    const projectId = inheritedProject?.projectId ?? (explicitProjectName || undefined);
    const projectDir = inheritedProject?.projectDir ?? projectId ?? deriveProjectSlug(title);

  const task: TaskInfo = {
    id: taskId,
    title,
    description,
      status: "pending",
      priority,
    assignedRole,
    createdBy,
    recommendedSkills: recommendedSkills.length > 0 ? recommendedSkills : undefined,
    controllerRunId: undefined,
    controllerSessionKey,
    projectId,
    projectDir,
      createdAt: now,
      updatedAt: now,
    };

    updateTeamState((s) => {
      const project = syncProjectRegistryEntry(s, {
        projectId: task.projectId,
        projectDir: task.projectDir,
        aliases: [explicitProjectName, task.projectId],
        summary: task.title,
        updatedAt: now,
      });
      task.projectId = project.projectId;
      task.projectDir = project.projectDir;
      s.tasks[taskId] = task;
    });
    recordTaskExecutionEvent(taskId, {
      type: "lifecycle",
      phase: "created",
      source: "controller",
      status: "pending",
      message: `Task created by ${createdBy}.`,
      role: assignedRole,
    }, deps);
    if (repoState?.enabled) {
      recordTaskExecutionEvent(taskId, {
        type: "lifecycle",
        phase: "repo_ready",
        source: "controller",
        status: "pending",
        message: repoState.remoteReady && repoState.remoteUrl
          ? `Git collaboration ready on ${repoState.defaultBranch} with remote ${repoState.remoteUrl}.`
          : `Git collaboration ready on ${repoState.defaultBranch} using controller-managed bundle sync.`,
        role: assignedRole,
      }, deps);
    }
    if (recommendedSkills.length > 0) {
      recordTaskExecutionEvent(taskId, {
        type: "lifecycle",
        phase: "skills_recommended",
        source: "controller",
        status: "pending",
        message: `Recommended skills: ${recommendedSkills.join(", ")}`,
        role: assignedRole,
      }, deps);
    }

    await autoAssignPendingTasks(deps);

    const updatedTask = getTeamState()?.tasks[taskId];
    wsServer.broadcastUpdate({ type: "task:created", data: serializeTask(updatedTask) });
    sendJson(res, 201, { task: serializeTask(updatedTask) });
    return;
  }

type TeamStatsResponse = {
  totalWorkers: number;
  workersByStatus: { idle: number; busy: number; offline: number };
  totalTasks: number;
  tasksByStatus: Record<string, number>;
  averageTaskDuration: number | null;
  uptime: number;
};

function computeTeamStats(state: TeamState): TeamStatsResponse {
  const workers = Object.values(state.workers);
  const tasks = Object.values(state.tasks);

  const workersByStatus = { idle: 0, busy: 0, offline: 0 };
  for (const worker of workers) {
    workersByStatus[worker.status] += 1;
  }

  const tasksByStatus: Record<string, number> = {};
  for (const task of tasks) {
    tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
  }

  const completedTasks = tasks.filter(
    (task) => task.status === "completed" && task.startedAt && task.completedAt,
  );
  const averageTaskDuration = completedTasks.length > 0
    ? completedTasks.reduce((sum, task) => sum + (task.completedAt! - task.startedAt!), 0) / completedTasks.length
    : null;

  return {
    totalWorkers: workers.length,
    workersByStatus,
    totalTasks: tasks.length,
    tasksByStatus,
    averageTaskDuration,
    uptime: process.uptime() * 1000,
  };
}

  // GET /api/v1/tasks
  if (req.method === "GET" && pathname === "/api/v1/tasks") {
    const state = getTeamState();
    const tasks = state ? Object.values(state.tasks).map((task) => serializeTask(task)) : [];
    sendJson(res, 200, { tasks });
    return;
  }

  // GET /api/v1/stats
  if (req.method === "GET" && pathname === "/api/v1/stats") {
    const state = getTeamState();
    if (!state) {
      sendError(res, 503, "Team state not available");
      return;
    }
    try {
      const stats = computeTeamStats(state);
      sendJson(res, 200, stats);
    } catch (err) {
      sendError(res, 500, `Failed to compute stats: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // GET /api/v1/tasks/:id
  if (req.method === "GET" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    const taskId = pathname.split("/").pop()!;
    const state = getTeamState();
    const task = state?.tasks[taskId];
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }
    sendJson(res, 200, { task: serializeTask(task) });
    return;
  }

  // DELETE /api/v1/tasks/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    const taskId = pathname.split("/").pop()!;
    const summary = buildEmptyTaskCleanupSummary();
    const deleted = await deleteTaskCascade(taskId, deps, summary);
    if (!deleted) {
      sendError(res, 404, "Task not found");
      return;
    }
    const stillExists = !!getTeamState()?.tasks[taskId];
    if (stillExists) {
      sendError(res, 409, "Task cleanup could not be confirmed");
      return;
    }
    sendJson(res, 200, {
      status: "deleted",
      confirmed: true,
      taskId,
      cleanup: summary,
    });
    return;
  }

  // GET /api/v1/tasks/:id/execution
  if (req.method === "GET" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/execution$/)) {
    const taskId = pathname.split("/")[4]!;
    const state = getTeamState();
    const task = state?.tasks[taskId];
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }

    const clarifications = state
      ? Object.values(state.clarifications)
        .filter((item) => item.taskId === taskId)
        .sort((left, right) => left.createdAt - right.createdAt)
      : [];
    const messages = state
      ? state.messages
        .filter((message) => message.taskId === taskId)
        .sort((left, right) => left.createdAt - right.createdAt)
      : [];

    sendJson(res, 200, {
      task: serializeTask(task, true),
      messages,
      clarifications,
    });
    return;
  }

  // PATCH /api/v1/tasks/:id
  if (req.method === "PATCH" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    const taskId = pathname.split("/").pop()!;
    const body = await parseJsonBody(req);
    let statusEvent: TaskExecutionEvent | undefined;
    let progressEvent: TaskExecutionEvent | undefined;
    let progressContract: WorkerProgressContract | undefined;

    const state = updateTeamState((s) => {
      const task = s.tasks[taskId];
      if (!task) return;
      const previousStatus = task.status;
      const previousProgress = task.progress;
      const previousProgressContract = task.progressContract;
      if (typeof body.status === "string") task.status = body.status as TaskStatus;
      if (typeof body.progress === "string") task.progress = body.progress as string;
      if (typeof body.priority === "string") task.priority = body.priority as TaskPriority;
      const nextAssignedRole = validateActiveRoleId(body.assignedRole);
      if (nextAssignedRole) task.assignedRole = nextAssignedRole;
      if (Array.isArray(body.recommendedSkills)) {
        const recommendedSkills = normalizeRecommendedSkills(
          body.recommendedSkills.map((entry: unknown) => String(entry ?? "")),
        );
        task.recommendedSkills = recommendedSkills.length > 0 ? recommendedSkills : undefined;
      }
      progressContract = normalizeWorkerProgressContract(body.progressContract)
        ?? (typeof body.progress === "string" ? backfillWorkerProgressContract(body.progress, typeof body.status === "string" ? body.status : undefined) : undefined);
      if (progressContract) {
        task.progressContract = progressContract;
        task.progress = task.progress || progressContract.summary;
      }
      task.updatedAt = Date.now();

      if (typeof body.status === "string" && body.status !== previousStatus) {
        statusEvent = appendTaskExecutionEvent(task, {
          type: "lifecycle",
          phase: `status_${task.status}`,
          source: "controller",
          status: mapTaskStatusToExecutionStatus(task.status, task.execution?.status),
          message: `Task status updated to ${task.status}.`,
        });
      }
      if (typeof body.progress === "string" && body.progress !== previousProgress) {
        progressEvent = appendTaskExecutionEvent(task, {
          type: "progress",
          phase: "progress_reported",
          source: "worker",
          status: task.status === "in_progress" || task.status === "review" ? "running" : undefined,
          message: body.progress as string,
        });
      } else if (progressContract && JSON.stringify(progressContract) !== JSON.stringify(previousProgressContract)) {
        progressEvent = appendTaskExecutionEvent(task, {
          type: "progress",
          phase: "progress_contract_reported",
          source: "worker",
          status: task.status === "in_progress" || task.status === "review" ? "running" : undefined,
          message: progressContract.summary,
        });
      }
    });

    const updatedTask = state.tasks[taskId];
    if (updatedTask) {
      if (statusEvent) {
        broadcastTaskExecutionEvent(taskId, updatedTask, statusEvent, deps);
      }
      if (progressEvent) {
        broadcastTaskExecutionEvent(taskId, updatedTask, progressEvent, deps);
      }
      wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    }
    sendJson(res, 200, { task: serializeTask(updatedTask) });
    return;
  }

  // POST /api/v1/tasks/:id/assign
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/assign$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const targetRole = validateActiveRoleId(body.targetRole);

    const state = getTeamState();
    if (!state?.tasks[taskId]) {
      sendError(res, 404, "Task not found");
      return;
    }

    let targetWorker: WorkerInfo | null = null;
    if (workerId && state.workers[workerId]) {
      targetWorker = state.workers[workerId]!;
    } else {
      const taskForRouting = targetRole
        ? { ...state.tasks[taskId], assignedRole: targetRole }
        : state.tasks[taskId];
      targetWorker = taskRouter.routeTask(taskForRouting, state.workers);
    }

    if (!targetWorker) {
      sendError(res, 404, "No available worker for this task");
      return;
    }

    const updatedTask = await assignTaskToWorker(taskId, targetWorker, deps, {
      assignedRole: targetRole,
    });
    wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    sendJson(res, 200, { task: serializeTask(updatedTask), worker: targetWorker });
    return;
  }

  // POST /api/v1/tasks/:id/handoff
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/handoff$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const targetRole = validateActiveRoleId(body.targetRole);
    const handoffContract = normalizeTaskHandoffContract(body.contract, {
      targetRole,
      reason: typeof body.reason === "string" ? body.reason : targetRole ? `The next step should move to ${targetRole}.` : "The task needs a new assignee.",
      summary: typeof body.summary === "string" ? body.summary : undefined,
      expectedNextStep: typeof body.expectedNextStep === "string" ? body.expectedNextStep : undefined,
      artifacts: [],
    });

    const state = getTeamState();
    if (!state?.tasks[taskId]) {
      sendError(res, 404, "Task not found");
      return;
    }

    const previousWorkerId = state.tasks[taskId].assignedWorkerId;
    const avoidPreviousManagedWorker = Boolean(
      previousWorkerId && deps.workerProvisioningManager?.hasManagedWorker(previousWorkerId),
    );

    updateTeamState((s) => {
      const task = s.tasks[taskId];
      task.status = "pending";
      task.assignedWorkerId = undefined;
      task.assignedRole = targetRole ?? task.assignedRole;
      task.lastHandoff = handoffContract;
      resetTaskForFreshAttempt(task);
      task.updatedAt = Date.now();

      // Free old worker
      if (previousWorkerId && s.workers[previousWorkerId]) {
        const previousWorker = s.workers[previousWorkerId];
        if (previousWorker.status !== "offline") {
          previousWorker.status = "idle";
        }
        previousWorker.currentTaskId = undefined;
      }
    });

    await cancelTaskExecution(taskId, previousWorkerId, "handoff", deps);
    if (avoidPreviousManagedWorker && previousWorkerId) {
      try {
        await deps.workerProvisioningManager?.onWorkerRemoved(
          previousWorkerId,
          `handoff for ${taskId} requested a fresh managed worker`,
        );
      } catch (err) {
        logger.warn(`Controller: failed to retire previous managed worker ${previousWorkerId}: ${String(err)}`);
      }
    }

    // Try auto-assign to new role
    const newState = getTeamState()!;
    const routingWorkers = avoidPreviousManagedWorker && previousWorkerId
      ? Object.fromEntries(Object.entries(newState.workers).filter(([workerId]) => workerId !== previousWorkerId))
      : newState.workers;
    const worker = taskRouter.routeTask(newState.tasks[taskId], routingWorkers);
    if (worker) {
      await assignTaskToWorker(taskId, worker, deps, { assignedRole: targetRole });
    } else {
      scheduleProvisioningReconcile(deps, `handoff:${taskId}`);
    }

    const updatedTask = getTeamState()?.tasks[taskId];
    recordTaskExecutionEvent(taskId, {
      type: "lifecycle",
      phase: "handoff",
      source: "controller",
      message: targetRole
        ? `Task handed off and re-routed to role ${targetRole}: ${handoffContract.summary}`
        : `Task handed off for re-routing: ${handoffContract.summary}`,
      role: targetRole,
    }, deps);
    wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    sendJson(res, 200, { task: serializeTask(updatedTask) });
    return;
  }

  // POST /api/v1/tasks/:id/checkpoint - worker persists an execution progress
  // snapshot so an interrupted task can resume instead of restarting.
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/checkpoint$/)) {
    const taskId = pathname.split("/")[4];
    let body: Record<string, unknown> = {};
    try { body = await parseJsonBody(req); } catch { sendError(res, 400, "invalid JSON body"); return; }
    const lastAssistantMessage = typeof body.lastAssistantMessage === "string" ? body.lastAssistantMessage.slice(0, 8000) : "";
    const progressNote = typeof body.progressNote === "string" ? body.progressNote.slice(0, 1000) : "";
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
    if (!lastAssistantMessage && !progressNote) {
      sendError(res, 400, "lastAssistantMessage or progressNote is required");
      return;
    }
    const updated = updateTeamState((s) => {
      const task = s.tasks[taskId];
      if (!task) { return; }
      const prev = task.checkpoint;
      const notes = [...(prev?.progressNotes ?? [])];
      if (progressNote && !notes.includes(progressNote)) { notes.push(progressNote); }
      task.checkpoint = {
        updatedAt: Date.now(),
        attempt: prev?.attempt ?? 0,
        sessionKey: sessionKey || prev?.sessionKey || "",
        lastAssistantMessage: lastAssistantMessage || prev?.lastAssistantMessage || "",
        progressNotes: notes.slice(-10),
      };
      task.updatedAt = Date.now();
    });
    const task = updated?.tasks[taskId];
    if (!task) { sendError(res, 404, "task not found"); return; }
    sendJson(res, 200, { ok: true, updatedAt: task.checkpoint?.updatedAt });
    return;
  }

  // POST /api/v1/tasks/:id/result-contract
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/result-contract$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const contract = normalizeWorkerTaskResultContract(body.contract ?? body.resultContract);
    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const currentTask = getTeamState()?.tasks[taskId];
    if (!currentTask) {
      sendError(res, 404, "Task not found");
      return;
    }
    if (!contract) {
      sendError(res, 400, "result contract is required");
      return;
    }
    if (workerId && !canAcceptWorkerUpdate(currentTask, workerId)) {
      logger.info(`Controller: ignoring stale result contract for ${taskId} from ${workerId}`);
      sendJson(res, 202, { status: "ignored", reason: "stale-worker-result-contract" });
      return;
    }

    const state = updateTeamState((teamState) => {
      const task = teamState.tasks[taskId];
      if (!task) {
        return;
      }
      task.resultContract = filterStaleDeliverables(contract, task.projectDir);
      task.updatedAt = Date.now();
      // Enrich deliverables with preview inference so PreviewManager can auto-launch.
      // Workers typically don't include artifactType/previewCommand in their contracts.
      const existingResult = task.result ?? "";
      let enriched = enrichDeliverablesWithPreviewInference(task.resultContract, existingResult);
      if (!enriched) {
        enriched = enrichWithFilesystemHtmlScan(contract, task.projectDir);
      }
      if (enriched) {
        task.resultContract = enriched;
      }
    });
    recordTaskExecutionEvent(taskId, {
      type: "output",
      phase: "result_contract_recorded",
      source: "worker",
      status: contract.outcome === "failed" ? "failed" : "running",
      message: contract.summary,
      workerId,
      role: currentTask.assignedRole,
    }, deps);
    consolidateDiscoveredPatterns(contract, taskId, currentTask.assignedRole, logger);
    sendJson(res, 201, { task: serializeTask(state.tasks[taskId]) });
    return;
  }

  // POST /api/v1/tasks/:id/result
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/result$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const result = typeof body.result === "string" ? body.result : "";
    let error = typeof body.error === "string" ? body.error : undefined;
    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const currentTask = getTeamState()?.tasks[taskId];
    if (!currentTask) {
      sendError(res, 404, "Task not found");
      return;
    }
    if (workerId && !canAcceptWorkerUpdate(currentTask, workerId)) {
      logger.info(`Controller: ignoring stale task result for ${taskId} from ${workerId}`);
      sendJson(res, 202, { status: "ignored", reason: "stale-worker-result" });
      return;
    }
    const previousWorkerId = getTeamState()?.tasks[taskId]?.assignedWorkerId;

    const submittedContract = normalizeWorkerTaskResultContract(body.contract ?? body.resultContract);
    if (submittedContract) {
      updateTeamState((teamState) => {
        const task = teamState.tasks[taskId];
        if (!task) {
          return;
        }
        task.resultContract = submittedContract;
      });
      recordTaskExecutionEvent(taskId, {
        type: "output",
        phase: "result_contract_recorded",
        source: "worker",
        status: error ? "failed" : "running",
          message: submittedContract.summary,
          workerId,
          role: currentTask.assignedRole,
        }, deps);
    }

    const effectiveContract = buildEffectiveTaskResultContract(currentTask, result, error, submittedContract ?? undefined);

    if (!error && effectiveContract.outcome === "blocked") {
      updateTeamState((teamState) => {
        const task = teamState.tasks[taskId];
        if (!task) {
          return;
        }
        task.resultContract = effectiveContract;
        task.updatedAt = Date.now();
      });
      if (!submittedContract) {
        recordTaskExecutionEvent(taskId, {
          type: "lifecycle",
          phase: "result_contract_backfilled",
          source: "controller",
          message: "Worker did not submit a structured result contract; TeamClaw backfilled one from the recorded task result.",
          workerId: currentTask.assignedWorkerId,
          role: currentTask.assignedRole,
        }, deps);
      }
      const requested = await requestTaskClarification({
        taskId,
        requestedBy: workerId ?? "worker",
        requestedByWorkerId: workerId,
        requestedByRole: currentTask.assignedRole,
        question: effectiveContract.questions[0]
          ?? "This task is blocked and needs a human decision before work can continue. What should TeamClaw do next?",
        blockingReason: effectiveContract.blockers[0] ?? effectiveContract.summary,
        context: [
          effectiveContract.notes,
          result.trim(),
          effectiveContract.keyPoints.length > 0
            ? `Worker-provided commands/details:\n${effectiveContract.keyPoints.join("\n")}`
            : "",
        ].filter(Boolean).join("\n\n"),
      }, deps);
      if (requested.status === "missing-task") {
        sendError(res, 404, "Task not found");
        return;
      }
      if (requested.status === "conflict") {
        sendError(res, 409, "Cannot request clarification for a completed task");
        return;
      }
      sendJson(res, requested.status === "already-pending" ? 200 : 201, {
        status: requested.status,
        clarification: requested.clarification,
        task: serializeTask(requested.task),
      });
      return;
    }

    const gatedTask = getTeamState()?.tasks[taskId];
    if (
      !error
      && gatedTask
      && taskRequiresMeaningfulProjectChangeGate(gatedTask)
      && !projectHasMeaningfulFileChanges(gatedTask, effectiveContract)
      && !allowsNoChangeCompletion(gatedTask, submittedContract ?? undefined, result)
    ) {
      error = "Task reported completion but no meaningful project file changes were detected in the assigned project directory.";
      recordTaskExecutionEvent(taskId, {
        type: "warning",
        phase: "completion_gate",
        source: "controller",
        status: "failed",
        message: error,
        workerId,
        role: gatedTask.assignedRole,
      }, deps);
    }

    const updatedTask = applyTaskResult(taskId, result, error, deps);
    ensureTaskResultContract(taskId, result, error, deps);
    if (!error) {
      deps.previewManager?.syncTaskPreviews(taskId).catch((err) => {
        logger.warn(`Controller: failed to sync previews for ${taskId}: ${String(err)}`);
      });
    }
    if (!workerId || workerId !== previousWorkerId) {
      await cancelTaskExecution(taskId, previousWorkerId, "manual result submission", deps);
    }
    sendJson(res, 200, { task: serializeTask(getTeamState()?.tasks[taskId] ?? updatedTask) });
    return;
  }

  // POST /api/v1/tasks/:id/execution
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/execution$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const type = typeof body.type === "string" ? body.type : "";
    const message = typeof body.message === "string" ? body.message : "";
    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const currentTask = getTeamState()?.tasks[taskId];

    if (!type || !message) {
      sendError(res, 400, "type and message are required");
      return;
    }

    if (!currentTask) {
      sendError(res, 404, "Task not found");
      return;
    }

    if (workerId && !canAcceptWorkerUpdate(currentTask, workerId)) {
      logger.info(`Controller: ignoring stale execution event for ${taskId} from ${workerId}`);
      sendJson(res, 202, { status: "ignored", reason: "stale-worker-event" });
      return;
    }

    const recorded = recordTaskExecutionEvent(taskId, {
      type: type as TaskExecutionEventInput["type"],
      message,
      createdAt: typeof body.createdAt === "number" ? body.createdAt : undefined,
      phase: typeof body.phase === "string" ? body.phase : undefined,
      source: typeof body.source === "string" ? body.source as TaskExecutionEventInput["source"] : undefined,
      stream: typeof body.stream === "string" ? body.stream : undefined,
      role: validateActiveRoleId(body.role),
      workerId,
      runId: typeof body.runId === "string" ? body.runId : undefined,
      sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
      status: typeof body.status === "string" ? body.status as TaskExecutionEventInput["status"] : undefined,
    }, deps);

    if (!recorded.task || !recorded.event) {
      sendError(res, 404, "Task not found");
      return;
    }

    // When a result contract is backfilled, the task is effectively complete —
    // trigger preview sync so that any web-app deliverables get previewed.
    if (recorded.event?.phase === "result_contract_backfilled") {
      deps.previewManager?.syncTaskPreviews(taskId).catch((err) => {
        logger.warn(`Controller: failed to sync previews for ${taskId}: ${String(err)}`);
      });
    }

    sendJson(res, 201, {
      task: serializeTask(recorded.task),
      execution: buildTaskExecutionSummary(recorded.task.execution),
      event: recorded.event,
    });
    return;
  }

  // POST /api/v1/tasks/:id/parallel-help
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/parallel-help$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const currentTask = getTeamState()?.tasks[taskId];
    if (!currentTask) {
      sendError(res, 404, "Task not found");
      return;
    }
    const requestedBy = typeof body.requestedBy === "string" ? body.requestedBy : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const requestedByRole = validateActiveRoleId(body.requestedByRole);
    const targetRole = validateActiveRoleId(body.targetRole);
    const requestedWorkerCount = typeof body.requestedWorkerCount === "number"
      ? Math.max(2, Math.min(10, Math.floor(body.requestedWorkerCount)))
      : undefined;
    const suggestedWorkstreams = Array.isArray(body.suggestedWorkstreams)
      ? body.suggestedWorkstreams.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    if (!requestedBy || !reason) {
      sendError(res, 400, "requestedBy and reason are required");
      return;
    }
    const sessionKey = resolveControllerWorkflowSessionKey(currentTask, getTeamState());
    if (!sessionKey) {
      sendError(res, 409, "Task is not linked to a controller session");
      return;
    }
    recordTaskExecutionEvent(taskId, {
      type: "progress",
      phase: "parallel_help_requested",
      source: "worker",
      message: `Worker requested more ${targetRole || requestedByRole || currentTask.assignedRole || "developer"} capacity for parallel work: ${reason}`,
      workerId: requestedBy,
      role: requestedByRole,
    }, deps);
    try {
      const result = await runControllerIntake(
        buildControllerParallelHelpMessage(currentTask, getTeamState(), {
          requestedBy,
          requestedByRole,
          targetRole,
          reason,
          requestedWorkerCount,
          suggestedWorkstreams,
        }),
        sessionKey,
        deps,
        {
          source: "task_follow_up",
          sourceTaskId: currentTask.id,
          sourceTaskTitle: currentTask.title,
        },
      );
      sendJson(res, 201, result);
    } catch (err) {
      if (err instanceof ControllerIntakeSwitchInProgressError) {
        // Backstop for the race between the URL-level gate and the intake
        // entry; same 503 + Retry-After shape as the gate.
        res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
        sendJson(res, 503, {
          error: err.message,
          retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
          transition: {
            phase: err.transition.phase,
            targetProfileId: err.transition.targetProfileId,
          },
        });
        return;
      }
      throw err;
    }
    return;
  }

  // ==================== Message Routing ====================

  // POST /api/v1/controller/manifest
  if (req.method === "POST" && pathname === "/api/v1/controller/manifest") {
    const body = await parseJsonBody(req);
    const sessionKey = normalizeControllerIntakeSessionKey(body.sessionKey);
    const manifest = normalizeControllerManifest(body.manifest);
    if (!manifest) {
      sendError(res, 400, "manifest is required and must include requirementSummary");
      return;
    }

    const runId = findLatestControllerRunIdForSession(sessionKey, deps.getTeamState(), {
      preferActive: true,
    });
    if (!runId) {
      sendError(res, 404, "Controller run not found for session");
      return;
    }

    const updatedRun = updateControllerRun(runId, deps, (run) => {
      run.manifest = manifest;
      const state = deps.getTeamState();
      if (state) {
        const project = syncProjectRegistryEntry(state, {
          projectId: manifest.projectName ?? run.projectId,
          projectDir: run.projectDir ?? manifest.projectName,
          aliases: [manifest.projectName, run.projectId],
          summary: manifest.requirementSummary,
          updatedAt: Date.now(),
        });
        run.projectId = project.projectId;
        run.projectDir = project.projectDir;
      }

      if (run.projectDir) {
        const state = deps.getTeamState();
        if (state) {
          for (const taskId of run.createdTaskIds) {
            const task = state.tasks[taskId];
            if (task) {
              if (!task.projectDir) {
                task.projectDir = run.projectDir;
              }
              if (!task.projectId) {
                task.projectId = run.projectId;
              }
            }
          }
        }
      }

      appendControllerRunEvent(run, {
        type: "output",
        phase: "manifest_recorded",
        source: "controller",
        status: "running",
        sessionKey,
        message: buildControllerManifestEventMessage(manifest),
      });
    });

    if (!updatedRun) {
      sendError(res, 404, "Controller run not found");
      return;
    }

    if (manifest.requirementFullyComplete) {
      logger.info(`Controller: requirement fully complete for session ${sessionKey} (run ${runId})`);
      wsServer.broadcastUpdate({
        type: "requirement:complete",
        data: {
          runId,
          sessionKey,
          requirementSummary: manifest.requirementSummary,
        },
      });
    }

    sendJson(res, 201, {
      controllerRun: serializeControllerRun(updatedRun),
      manifest,
    });
    return;
  }

  // GET /api/v1/controller/runs
  if (req.method === "GET" && pathname === "/api/v1/controller/runs") {
    const state = reconcileControllerClarifications(deps);
    const controllerRuns = state
      ? Object.values(state.controllerRuns)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((run) => serializeControllerRun(run))
      : [];
    sendJson(res, 200, { controllerRuns });
    return;
  }

  // DELETE /api/v1/projects/:projectDir
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/projects\/[^/]+$/)) {
    const projectDir = decodeURIComponent(pathname.split("/").pop()!);
    const result = await deleteProjectCascade(projectDir, deps);
    if (!result.deleted) {
      sendError(res, 404, "Project not found or project cleanup could not be confirmed");
      return;
    }
    const safeProjectPath = resolveSafeProjectDirectory(projectDir);
    const stillExists = safeProjectPath ? fs.existsSync(safeProjectPath) : true;
    if (stillExists) {
      sendError(res, 409, "Project cleanup could not be confirmed");
      return;
    }
    sendJson(res, 200, {
      status: "deleted",
      confirmed: true,
      projectDir,
      cleanup: result.summary,
    });
    return;
  }

  // DELETE /api/v1/controller/runs/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/controller\/runs\/[^/]+$/)) {
    const runId = pathname.split("/").pop()!;
    const result = await deleteControllerRunCascade(runId, deps);
    if (!result.deleted) {
      sendError(res, 404, "Controller run not found");
      return;
    }
    const stillExists = !!getTeamState()?.controllerRuns[runId];
    if (stillExists) {
      sendError(res, 409, "Planning run cleanup could not be confirmed");
      return;
    }
    sendJson(res, 200, {
      status: "deleted",
      confirmed: true,
      runId,
      cleanup: result.summary,
    });
    return;
  }

  // POST /api/v1/controller/intake
  if (req.method === "POST" && pathname === "/api/v1/controller/intake") {
    const readinessGate = shouldBlockControllerUntilProvisioningReady(deps, currentState);
    if (readinessGate.blocked && readinessGate.readiness) {
      sendError(res, 503, buildStartupReadinessMessage(readinessGate.readiness));
      return;
    }
    const body = await parseJsonBody(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      sendError(res, 400, "message is required");
      return;
    }

    const sessionKey = normalizeControllerIntakeSessionKey(body.sessionKey);

    try {
      const result = await runControllerIntake(message, sessionKey, deps);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof ControllerIntakeSwitchInProgressError) {
        // Same response shape as the URL-level transition gate (503 +
        // Retry-After); reachable here when a switch starts between the gate
        // and the intake entry (the gate reads the state once per request).
        res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
        sendJson(res, 503, {
          error: err.message,
          retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
          transition: {
            phase: err.transition.phase,
            targetProfileId: err.transition.targetProfileId,
          },
        });
        return;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`Controller: intake failed for ${sessionKey}: ${errorMessage}`);
      sendError(res, errorMessage.includes("timed out") ? 504 : 500, errorMessage);
    }
    return;
  }

  // POST /api/v1/messages/direct
  if (req.method === "POST" && pathname === "/api/v1/messages/direct") {
    const body = await parseJsonBody(req);
    const fromRole = validateActiveRoleId(body.fromRole);
    const toRole = validateActiveRoleId(body.toRole);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole,
      toRole,
      type: "direct",
      content: typeof body.content === "string" ? body.content : "",
      contract: ensureTeamMessageContract(body.contract, {
        type: "direct",
        content: typeof body.content === "string" ? body.content : "",
        toRole,
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      }),
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      createdAt: Date.now(),
    };

    updateTeamState((s) => { s.messages.push(message); });

    const routed = await routeDirectMessage(message, deps);

    wsServer.broadcastUpdate({ type: "message:new", data: message });
    sendJson(res, 201, { status: routed ? "delivered" : "no-target", message });
    return;
  }

  // POST /api/v1/messages/broadcast
  if (req.method === "POST" && pathname === "/api/v1/messages/broadcast") {
    const body = await parseJsonBody(req);
    const fromRole = validateActiveRoleId(body.fromRole);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole,
      type: "broadcast",
      content: typeof body.content === "string" ? body.content : "",
      contract: ensureTeamMessageContract(body.contract, {
        type: "broadcast",
        content: typeof body.content === "string" ? body.content : "",
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      }),
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      createdAt: Date.now(),
    };

    updateTeamState((s) => { s.messages.push(message); });

    const state = getTeamState()!;
    const routed = messageRouter.routeBroadcast(message, state.workers);
    for (const { worker, message: routedMsg } of routed) {
      try {
        await deliverMessageToWorker(worker, routedMsg, deps);
      } catch (err) {
        logger.warn(`Controller: failed to broadcast to ${worker.id}: ${String(err)}`);
      }
    }

    wsServer.broadcastUpdate({ type: "message:new", data: message });
    sendJson(res, 201, { status: "broadcast", recipients: routed.length });
    return;
  }

  // POST /api/v1/messages/review-request
  if (req.method === "POST" && pathname === "/api/v1/messages/review-request") {
    const body = await parseJsonBody(req);
    const fromRole = validateActiveRoleId(body.fromRole);
    const toRole = validateActiveRoleId(body.toRole);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole,
      toRole,
      type: "review-request",
      content: typeof body.content === "string" ? body.content : "",
      contract: ensureTeamMessageContract(body.contract, {
        type: "review-request",
        content: typeof body.content === "string" ? body.content : "",
        toRole,
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
        intent: "review-request",
        needsResponse: true,
      }),
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      createdAt: Date.now(),
    };

    updateTeamState((s) => { s.messages.push(message); });

    const state = getTeamState()!;
    const routed = messageRouter.routeReviewRequest(message, state.workers);
    if (routed) {
      try {
        await deliverMessageToWorker(routed.worker, routed.message, deps);
      } catch (err) {
        logger.warn(`Controller: failed to deliver review request: ${String(err)}`);
      }
    }

    wsServer.broadcastUpdate({ type: "message:new", data: message });
    sendJson(res, 201, { status: routed ? "delivered" : "no-target", message });
    return;
  }

  // GET /api/v1/messages
  if (req.method === "GET" && pathname === "/api/v1/messages") {
    const state = getTeamState();
    const messages = state?.messages ?? [];
    const limit = parseInt(requestUrl.searchParams.get("limit") ?? "50", 10);
    const offset = parseInt(requestUrl.searchParams.get("offset") ?? "0", 10);
    sendJson(res, 200, {
      messages: messages.slice(offset, offset + limit),
      total: messages.length,
    });
    return;
  }

  // ==================== Clarification Requests ====================

  // POST /api/v1/clarifications
  if (req.method === "POST" && pathname === "/api/v1/clarifications") {
    const body = await parseJsonBody(req);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const requestedBy = typeof body.requestedBy === "string" ? body.requestedBy : "";
    const requestedByWorkerId = typeof body.requestedByWorkerId === "string" ? body.requestedByWorkerId : undefined;
    const requestedByRole = validateActiveRoleId(body.requestedByRole);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const blockingReason = typeof body.blockingReason === "string" ? body.blockingReason.trim() : "";
    const context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;
    const questionSchema = normalizeClarificationQuestionSchema(body.questionSchema);

    if (!taskId || !question || !blockingReason) {
      sendError(res, 400, "taskId, question, and blockingReason are required");
      return;
    }

    const requested = await requestTaskClarification({
      taskId,
      requestedBy,
      requestedByWorkerId,
      requestedByRole,
      question,
      questionSchema,
      blockingReason,
      context,
    }, deps);
    if (requested.status === "missing-task") {
      sendError(res, 404, "Task not found");
      return;
    }
    if (requested.status === "conflict") {
      sendError(res, 409, "Cannot request clarification for a completed task");
      return;
    }
    if (requested.status === "already-pending") {
      sendJson(res, 200, {
        clarification: requested.clarification,
        task: serializeTask(requested.task),
        status: "already-pending",
      });
      return;
    }
    sendJson(res, 201, {
      clarification: requested.clarification,
      task: serializeTask(requested.task),
    });
    return;
  }

  // GET /api/v1/clarifications
  if (req.method === "GET" && pathname === "/api/v1/clarifications") {
    const state = reconcileControllerClarifications(deps);
    const clarifications = state
      ? Object.values(state.clarifications).sort((left, right) => right.createdAt - left.createdAt)
      : [];
    sendJson(res, 200, {
      clarifications,
      pendingCount: clarifications.filter((item) => item.status === "pending").length,
    });
    return;
  }

  // POST /api/v1/clarifications/:id/answer
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/clarifications\/[^/]+\/answer$/)) {
    const clarificationId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const answerValue = typeof body.answerValue === "string" ? body.answerValue.trim() : undefined;
    const answerValues = Array.isArray(body.answerValues)
      ? body.answerValues.map((entry) => String(entry || "").trim()).filter(Boolean)
      : undefined;
    const answerNumber = typeof body.answerNumber === "number" && Number.isFinite(body.answerNumber)
      ? body.answerNumber
      : undefined;
    const answerComment = typeof body.answerComment === "string" && body.answerComment.trim()
      ? body.answerComment.trim()
      : undefined;
    const answeredBy = typeof body.answeredBy === "string" && body.answeredBy.trim()
      ? body.answeredBy.trim()
      : "human";

    const currentState = getTeamState();
    const currentClarification = currentState?.clarifications[clarificationId];
    if (!currentClarification) {
      sendError(res, 404, "Clarification request not found");
      return;
    }

    const answer = buildStructuredClarificationAnswer(currentClarification, {
      answer: typeof body.answer === "string" ? body.answer.trim() : "",
      answerValue,
      answerValues,
      answerNumber,
      answerComment,
    });

    if (!answer) {
      sendError(res, 400, "answer is required");
      return;
    }

    if (currentClarification.status === "answered") {
      sendError(res, 409, "Clarification request already answered");
      return;
    }

    const now = Date.now();
    const state = updateTeamState((s) => {
      const clarification = s.clarifications[clarificationId];
      if (!clarification) {
        return;
      }

      clarification.status = "answered";
      clarification.answer = answer;
      clarification.answerValue = answerValue;
      clarification.answerValues = answerValues;
      clarification.answerNumber = answerNumber;
      clarification.answerComment = answerComment;
      clarification.answeredBy = answeredBy;
      clarification.answeredAt = now;
      clarification.updatedAt = now;

      const task = s.tasks[clarification.taskId];
      if (!task) {
        return;
      }

      task.status = "pending";
      task.progress = `Clarification answered by ${answeredBy}: ${answer}`;
      task.clarificationRequestId = undefined;
      resetTaskForFreshAttempt(task);
      task.updatedAt = now;
    });

    const clarification = state.clarifications[clarificationId];
    const task = clarification?.taskId ? state.tasks[clarification.taskId] : undefined;

    let responseMessage: TeamMessage | undefined;
    if (clarification?.requestedByRole && task) {
      responseMessage = {
        id: generateId(),
        from: answeredBy,
        toRole: clarification.requestedByRole,
        type: "direct",
        content: `Clarification answer for task ${task.id}: ${answer}`,
        contract: ensureTeamMessageContract(null, {
          type: "direct",
          content: `Clarification answer for task ${task.id}: ${answer}`,
          toRole: clarification.requestedByRole,
          taskId: task.id,
          summary: `Clarification answered for task ${task.id}`,
          details: answer,
          requestedAction: "Resume the task using this clarification.",
          needsResponse: false,
          intent: "update",
        }),
        taskId: task.id,
        createdAt: now,
      };

      updateTeamState((s) => {
        s.messages.push(responseMessage!);
      });
      await routeDirectMessage(responseMessage, deps);
      wsServer.broadcastUpdate({ type: "message:new", data: responseMessage });
    }

    let resumedTask = task;
    let resumedWorker: WorkerInfo | null = null;
    let continuedControllerRun: {
      sessionKey: string;
      controllerRunId?: string;
      runId?: string;
      reply?: string;
      queued?: boolean;
    } | null = null;
    if (task) {
      const latestState = getTeamState()!;
      if (clarification?.requestedByWorkerId && latestState.workers[clarification.requestedByWorkerId]?.status === "idle") {
        resumedWorker = latestState.workers[clarification.requestedByWorkerId]!;
      } else {
        resumedWorker = taskRouter.routeTask(task, latestState.workers);
      }

      if (resumedWorker) {
        resumedTask = await assignTaskToWorker(task.id, resumedWorker, deps, {
          assignedRole: task.assignedRole,
        });
      }
    } else if (clarification?.controllerRunId) {
      const targetSessionKey = clarification.controllerSessionKey
        || state.controllerRuns[clarification.controllerRunId]?.sessionKey;
      if (targetSessionKey) {
        continuedControllerRun = {
          sessionKey: targetSessionKey,
          controllerRunId: clarification.controllerRunId,
          queued: true,
        };
        void runControllerIntake(
          buildControllerClarificationAnswerMessage(clarification, answer, answeredBy),
          targetSessionKey,
          deps,
        ).catch((err) => {
          deps.logger.warn(
            `Controller: failed to continue intake after clarification ${clarification.id}: ${String(err)}`,
          );
        });
      }
    }

    wsServer.broadcastUpdate({ type: "clarification:answered", data: clarification });
    if (resumedTask) {
      recordTaskExecutionEvent(resumedTask.id, {
        type: "lifecycle",
        phase: "clarification_answered",
        source: "controller",
        message: `Clarification answered by ${answeredBy}: ${answer}`,
        role: clarification?.requestedByRole,
        workerId: clarification?.requestedByWorkerId,
      }, deps);
      wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(resumedTask) });
    }

    sendJson(res, 200, {
      clarification,
      task: serializeTask(resumedTask),
      resumedWorker,
      controllerRun: continuedControllerRun,
      message: responseMessage,
    });
    return;
  }

  // ==================== Git Collaboration ====================

  // GET /api/v1/repo
  if (req.method === "GET" && pathname === "/api/v1/repo") {
    const repo = await refreshControllerRepoState(deps);
    if (!repo?.enabled) {
      sendJson(res, 200, { enabled: false });
      return;
    }

    sendJson(res, 200, { repo });
    return;
  }

  // GET /api/v1/repo/bundle
  if (req.method === "GET" && pathname === "/api/v1/repo/bundle") {
    try {
      const exported = await exportControllerGitBundle(config, logger);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": exported.data.byteLength,
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(exported.data);
    } catch (err) {
      sendError(res, 503, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // POST /api/v1/repo/import
  if (req.method === "POST" && pathname === "/api/v1/repo/import") {
    const body = await readRequestBody(req);
    if (!body.length) {
      sendError(res, 400, "bundle body is required");
      return;
    }

    const taskId = typeof requestUrl.searchParams.get("taskId") === "string" && requestUrl.searchParams.get("taskId")
      ? requestUrl.searchParams.get("taskId")!
      : undefined;
    const workerId = typeof requestUrl.searchParams.get("workerId") === "string" && requestUrl.searchParams.get("workerId")
      ? requestUrl.searchParams.get("workerId")!
      : undefined;
    const role = validateActiveRoleId(requestUrl.searchParams.get("role"));

    try {
      const imported = await importControllerGitBundle(config, logger, body, { taskId, workerId });
      updateTeamState((s) => {
        s.repo = imported.repo;
      });

      if (taskId) {
        recordTaskExecutionEvent(taskId, {
          type: imported.merged || imported.alreadyUpToDate ? "lifecycle" : "error",
          phase: imported.merged
            ? "repo_imported"
            : imported.alreadyUpToDate
              ? "repo_import_skipped"
              : "repo_import_failed",
          source: "controller",
          message: imported.message,
          workerId,
          role,
        }, deps);
      }

      sendJson(res, imported.merged || imported.alreadyUpToDate ? 200 : 409, {
        repo: imported.repo,
        merged: imported.merged,
        fastForwarded: imported.fastForwarded,
        alreadyUpToDate: imported.alreadyUpToDate,
        message: imported.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (taskId) {
        recordTaskExecutionEvent(taskId, {
          type: "error",
          phase: "repo_import_failed",
          source: "controller",
          message,
          workerId,
          role,
        }, deps);
      }
      sendError(res, 500, message);
    }
    return;
  }

  // ==================== Team Info ====================

  // GET /api/v1/team/status
  if (req.method === "GET" && pathname === "/api/v1/team/status") {
    const state = reconcileControllerClarifications(deps);
    const startupReadiness = getEffectiveStartupReadiness(deps, state);
    const modelReadiness = getTeamClawModelReadiness();
    const externalWorkerInstall = buildExternalWorkerInstallInfo(req, config);
    if (!state) {
      sendJson(res, 200, {
        teamName: config.teamName,
        workers: [],
        tasks: [],
        controllerRuns: [],
        messages: [],
        clarifications: [],
        previews: [],
        repo: null,
        pendingClarificationCount: 0,
        modelReadiness,
        externalWorkerInstall,
        provisioning: startupReadiness ? { startupReadiness } : undefined,
      });
      return;
    }

    const clarifications = Object.values(state.clarifications).sort((left, right) => right.createdAt - left.createdAt);
    sendJson(res, 200, {
      teamName: state.teamName,
      workers: Object.values(state.workers),
      tasks: Object.values(state.tasks).map((task) => serializeTask(task)),
      controllerRuns: Object.values(state.controllerRuns)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((run) => serializeControllerRun(run)),
      messages: state.messages,
      clarifications,
      previews: Object.values(state.previews ?? {}),
      repo: state.repo ?? null,
      modelReadiness,
      externalWorkerInstall,
      provisioning: {
        ...(state.provisioning ?? { workers: {} }),
        startupReadiness,
      },
      taskCount: Object.keys(state.tasks).length,
      workerCount: Object.keys(state.workers).length,
      pendingClarificationCount: clarifications.filter((item) => item.status === "pending").length,
    });
    return;
  }

  // GET /api/v1/roles
  if (req.method === "GET" && pathname === "/api/v1/roles") {
    sendJson(res, 200, { roles: getActiveRoles(), defaultRole: getActiveDefaultRole() });
    return;
  }

  // GET /api/v1/profiles — list the available team profile packages
  // (Phase 2.1, design section 4: the switcher UI reads this list).
  if (req.method === "GET" && pathname === "/api/v1/profiles") {
    const profiles = [...BUILTIN_PROFILES.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        nameZh: profile.nameZh,
        icon: profile.icon,
        industry: profile.industry,
        description: profile.description,
        roleCount: profile.roles.length,
        version: profile.version,
        ...(profile.reviewedBy ? { reviewedBy: profile.reviewedBy } : {}),
      }));
    sendJson(res, 200, { profiles });
    return;
  }

  // GET /api/v1/team/profile — active profile detail incl. capabilities
  // (design section 4: UI hides capability-gated entries based on this).
  if (req.method === "GET" && pathname === "/api/v1/team/profile") {
    const state = getTeamState();
    const profile = getActiveProfile();
    sendJson(res, 200, {
      profileId: state?.profileId ?? profile.id,
      profile,
      teamName: state?.teamName ?? config.teamName,
      transition: state?.transition ?? null,
    });
    return;
  }

  // POST /api/v1/team/profile { profileId } — six-step switch semantics
  // (Phase 2.1, design section 2.3). Returns 202; progress arrives via the
  // team.switch_started / team.switch_completed WS events.
  if (req.method === "POST" && pathname === "/api/v1/team/profile") {
    const body = await parseJsonBody(req);
    const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
    if (!profileId || !hasProfile(profileId)) {
      sendError(
        res,
        404,
        `unknown team profile "${profileId || "<empty>"}" (available: ${[...BUILTIN_PROFILES.keys()].sort().join(", ")})`,
      );
      return;
    }
    const state = getTeamState();
    if (!state) {
      sendError(res, 503, "Team state not loaded");
      return;
    }
    if (state.transition) {
      sendJson(res, 409, {
        error: `a team profile switch to "${state.transition.targetProfileId}" is already in progress (phase: ${state.transition.phase})`,
        transition: state.transition,
      });
      return;
    }

    // Step 1: persist the transition (the crash-resume truth) and announce.
    // The check-and-set above plus this mutation run without an await in
    // between, so a concurrent second POST observes the transition (409).
    const previousProfileId = state.profileId;
    updateTeamState((s) => {
      s.transition = { phase: "draining", targetProfileId: profileId, startedAt: Date.now() };
    });
    try {
      await saveTeamState(state);
    } catch (err) {
      // Durability failed: roll the in-memory transition back so the team is
      // never wedged behind a transition the crash-resume path cannot see.
      // Nothing has been broadcast yet, so no external observer was told a
      // switch had started.
      updateTeamState((s) => {
        delete s.transition;
      });
      sendError(res, 500, `failed to persist the team profile switch transition: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    wsServer.broadcastUpdate({ type: "team.switch_started", data: { profileId, previousProfileId } });
    logger.info(`Controller: team profile switch started - "${previousProfileId}" -> "${profileId}"`);

    void executeTeamProfileSwitch(deps, profileId).catch((err) => {
      logger.error(`Controller: team profile switch to "${profileId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      // Never leave the team wedged in a transition: clear it so whichever
      // team the state now holds keeps serving and the switch can be
      // re-issued. The archive (if step 3 ran) keeps the previous team. Also
      // lift the provisioning reconcile suspension so the manager keeps
      // operating for whichever team survived.
      deps.workerProvisioningManager?.setReconcileSuspended(false);
      updateTeamState((s) => {
        if (s.transition?.targetProfileId === profileId) {
          delete s.transition;
        }
      });
      void saveTeamState(getTeamState()!).catch(() => undefined);
    });

    sendJson(res, 202, { status: "switching", profileId, transition: state.transition });
    return;
  }

  // GET /api/v1/archived-teams — archived team metadata list
  // (Phase 2.1, design section 4: profileId/teamName/time/taskCount; detail
  // queries and the archive UI stay v1.1).
  if (req.method === "GET" && pathname === "/api/v1/archived-teams") {
    const archives = await listArchivedTeams();
    sendJson(res, 200, { archives });
    return;
  }

  // /api/v1/previews/:id/* — proxy to preview subprocess
  if (req.method === "GET" || req.method === "HEAD" || req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
    const previewPrefix = "/api/v1/previews/";
    if (pathname.startsWith(previewPrefix)) {
      const remaining = pathname.slice(previewPrefix.length);
      const slashIdx = remaining.indexOf("/");
      const previewId = slashIdx >= 0 ? remaining.slice(0, slashIdx) : remaining;
      const subPath = slashIdx >= 0 ? remaining.slice(slashIdx) : "/";

      const state = deps.getTeamState();
      const preview = state?.previews?.[previewId];
      if (!preview || preview.status !== "healthy") {
        const status = preview?.status ?? "unknown";
        const errMsg = preview?.lastError;
        sendJson(res, 503, { error: "Preview not available", previewId, status, lastError: errMsg ?? undefined });
        return;
      }

      const proxyPathPrefix = `/api/v1/previews/${encodeURIComponent(previewId)}`;
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: preview.targetPort,
          path: subPath + (requestUrl.search || ""),
          method: req.method,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${preview.targetPort}`,
            "accept-encoding": "identity",
            "x-forwarded-for": req.socket.remoteAddress ?? "",
            "x-forwarded-host": req.headers.host ?? "",
            "x-forwarded-proto": "http",
          },
        },
        (proxyRes: http.IncomingMessage) => {
          const contentType = (proxyRes.headers["content-type"] ?? "").toLowerCase();
          if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 201 && proxyRes.statusCode !== 301 && proxyRes.statusCode !== 302 && proxyRes.statusCode !== 304) {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
            return;
          }

          if (contentType.includes("text/html")) {
            const chunks: Buffer[] = [];
            proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
            proxyRes.on("end", () => {
              let raw = Buffer.concat(chunks);
              // Decompress if the upstream response is compressed (brotli/gzip/deflate).
              const encoding = (proxyRes.headers["content-encoding"] ?? "").toLowerCase();
              try {
                if (encoding === "br") {
                  raw = zlib.brotliDecompressSync(raw);
                } else if (encoding === "gzip") {
                  raw = zlib.gunzipSync(raw);
                } else if (encoding === "deflate") {
                  raw = zlib.inflateSync(raw);
                }
              } catch {
                // If decompression fails, use raw bytes as-is.
              }
              const body = raw.toString("utf-8");
              // Rewrite absolute-path references (href="/...", src="/...", action="/...")
              // to include the proxy prefix so all navigation stays within the proxy.
              const rewritten = body.replace(
                /\b(href|src|action)\s*=\s*"\/([^"]*)"/g,
                `$1="${proxyPathPrefix}/$2"`,
              ).replace(
                /\b(href|src|action)\s*=\s*'\/([^']*)'/g,
                `$1='${proxyPathPrefix}/$2'`,
              );
              const resHeaders = { ...proxyRes.headers };
              // We've decoded and rewritten the body — remove upstream encoding headers.
              delete resHeaders["content-encoding"];
              delete resHeaders["transfer-encoding"];
              resHeaders["content-length"] = String(Buffer.byteLength(rewritten, "utf-8"));
              res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
              res.end(rewritten);
            });
          } else {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          }
        },
      );
      proxyReq.on("error", (err: Error) => {
        deps.logger.warn(`Controller: preview proxy error for ${previewId}: ${String(err)}`);
        if (!res.headersSent) {
          sendJson(res, 502, { error: "Preview proxy error", previewId, message: String(err) });
        }
      });
      req.pipe(proxyReq);
      return;
    }
  }

  // GET /api/v1/reports — list all delivery reports
  if (req.method === "GET" && pathname === "/api/v1/reports") {
    const state = deps.getTeamState();
    const reports = Object.values(state?.reports ?? {}).sort((a, b) => b.generatedAt - a.generatedAt);
    sendJson(res, 200, { reports });
    return;
  }

  // GET /api/v1/reports/:sessionKey — serve delivery report page
  if (req.method === "GET" && pathname.startsWith("/api/v1/reports/")) {
    const sessionKey = decodeURIComponent(pathname.slice("/api/v1/reports/".length));
    const state = deps.getTeamState();
    if (!state) {
      sendError(res, 503, "Team state not loaded");
      return;
    }
    const report = generateDeliveryReport(sessionKey, state, normalizeControllerIntakeSessionKey);
    if (!report) {
      sendError(res, 404, "No report found for this session");
      return;
    }
    const accept = (req.headers["accept"] ?? "").toLowerCase();
    if (accept.includes("application/json")) {
      sendJson(res, 200, { report });
    } else {
      const html = renderReportHtml(report);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html, "utf-8") });
      res.end(html);
    }
    return;
  }

  // GET /api/v1/health
  if (req.method === "GET" && pathname === "/api/v1/health") {
    const readiness = getEffectiveStartupReadiness(deps, currentState);
    const modelReadiness = getTeamClawModelReadiness();
    const statusCode = readiness && readiness.status !== "ready" ? 503 : 200;
    sendJson(res, statusCode, {
      status: readiness?.status === "degraded" ? "degraded" : readiness?.status === "checking" ? "starting" : "ok",
      mode: "controller",
      timestamp: Date.now(),
      provisioningReadiness: readiness,
      modelReadiness,
    });
    return;
  }

  sendError(res, 404, "Not found");
}
