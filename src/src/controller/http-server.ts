import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import type {
  ClarificationRequest,
  ControllerRunInfo,
  ControllerRunSource,
  GitRepoState,
  PluginConfig,
  RepoSyncInfo,
  RoleId,
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
  WorkerInfo,
} from "../types.js";
import {
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendError,
  generateId,
} from "../protocol.js";
import { listWorkspaceTree, readWorkspaceFile, readWorkspaceRawFile } from "../workspace-browser.js";
import { ROLES, normalizeRecommendedSkills, resolveRecommendedSkillsForRole } from "../roles.js";
import { buildRepoSyncInfo, ensureControllerGitRepo, exportControllerGitBundle, importControllerGitBundle } from "../git-collaboration.js";
import type { LocalWorkerManager } from "./local-worker-manager.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import type { WorkerProvisioningManager } from "./worker-provisioning.js";

export type ControllerHttpDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
  taskRouter: TaskRouter;
  messageRouter: MessageRouter;
  wsServer: TeamWebSocketServer;
  localWorkerManager?: LocalWorkerManager;
  workerProvisioningManager?: WorkerProvisioningManager | null;
};

const MAX_TASK_EXECUTION_EVENTS = 250;
const MAX_CONTROLLER_RUNS = 40;
const MAX_RECENT_TASK_CONTEXT = 3;
const MAX_TASK_CONTEXT_SUMMARY_CHARS = 500;
const CONTROLLER_INTAKE_TIMEOUT_CAP_MS = 180_000;
const CONTROLLER_INTAKE_SESSION_PREFIX = "teamclaw-controller-web:";

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
    return sourceTaskTitle
      ? `Controller follow-up after ${sourceTaskTitle}`
      : "Controller workflow follow-up";
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
  const run: ControllerRunInfo = {
    id: generateId(),
    title: buildControllerRunTitle(message, options?.source ?? "human", options?.sourceTaskTitle),
    sessionKey,
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
    teamState.controllerRuns[run.id] = run;
    trimControllerRuns(teamState);
  });
  const createdRun = state.controllerRuns[run.id] ?? run;
  deps.wsServer.broadcastUpdate({ type: "controller:run", data: serializeControllerRun(createdRun) });
  return createdRun;
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
  delete payload.controllerSessionKey;
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

function normalizeControllerIntakeSessionKey(input: unknown): string {
  const fallback = `${CONTROLLER_INTAKE_SESSION_PREFIX}default`;
  if (typeof input !== "string") {
    return fallback;
  }

  const trimmed = input.trim();
  if (!trimmed || !/^[a-zA-Z0-9:_-]{1,120}$/.test(trimmed)) {
    return fallback;
  }

  return trimmed.startsWith(CONTROLLER_INTAKE_SESSION_PREFIX)
    ? trimmed
    : `${CONTROLLER_INTAKE_SESSION_PREFIX}${trimmed}`;
}

function collectTaskIds(state: TeamState | null): Set<string> {
  return new Set(Object.keys(state?.tasks ?? {}));
}

function tagControllerCreatedTasks(
  taskIdsBeforeRun: Set<string>,
  sessionKey: string,
  deps: ControllerHttpDeps,
): string[] {
  const taggedTaskIds: string[] = [];
  deps.updateTeamState((state) => {
    for (const task of Object.values(state.tasks)) {
      if (taskIdsBeforeRun.has(task.id)) {
        continue;
      }
      if (task.createdBy !== "controller" || task.controllerSessionKey) {
        continue;
      }
      task.controllerSessionKey = sessionKey;
      taggedTaskIds.push(task.id);
    }
  });
  return taggedTaskIds;
}

function buildControllerFollowUpMessage(task: TaskInfo): string {
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
  if (task.error) {
    parts.push("", "## Task Error", task.error);
  }

  parts.push(
    "",
    "## Controller Follow-up",
    "Continue orchestrating this same requirement.",
    "Review the current TeamClaw state before acting.",
    "Create only the next execution-ready task(s) whose prerequisites are now satisfied.",
    "Do not duplicate tasks that already exist, are active, or are already completed.",
    "If no additional task should be created yet, reply briefly and stop.",
  );

  return parts.filter(Boolean).join("\n");
}

async function continueControllerWorkflow(task: TaskInfo, deps: ControllerHttpDeps): Promise<void> {
  if (task.createdBy !== "controller" || !task.controllerSessionKey) {
    return;
  }
  await runControllerIntake(buildControllerFollowUpMessage(task), task.controllerSessionKey, deps, {
    source: "task_follow_up",
    sourceTaskId: task.id,
    sourceTaskTitle: task.title,
  });
}

async function runControllerIntake(
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

  const waitResult = await deps.runtime.subagent.waitForRun({
    runId: runResult.runId,
    timeoutMs: Math.min(deps.config.taskTimeoutMs, CONTROLLER_INTAKE_TIMEOUT_CAP_MS),
  });

  if (waitResult.status === "timeout") {
    const createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, sessionKey, deps);
    updateControllerRun(controllerRun.id, deps, (run) => {
      run.createdTaskIds = createdTaskIds;
      run.error = "Controller intake timed out";
      appendControllerRunEvent(run, {
        type: "error",
        phase: "timeout",
        source: "controller",
        status: "failed",
        sessionKey,
        runId: runResult.runId,
        message: "Controller intake timed out.",
      });
    });
    throw new Error("Controller intake timed out");
  }
  if (waitResult.status !== "ok") {
    const errorMessage = waitResult.error || "Controller intake failed";
    const createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, sessionKey, deps);
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

  const createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, sessionKey, deps);

  const sessionMessages = await deps.runtime.subagent.getSessionMessages({
    sessionKey,
    limit: 100,
  });
  const reply = extractLastAssistantText(sessionMessages.messages)
    || "Controller completed the intake run but did not return any text.";

  updateControllerRun(controllerRun.id, deps, (run) => {
    run.reply = reply;
    run.error = undefined;
    run.createdTaskIds = createdTaskIds;
    appendControllerRunEvent(run, {
      type: "output",
      phase: "final_reply",
      source: "subagent",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: reply,
    });
    if (createdTaskIds.length > 0) {
      appendControllerRunEvent(run, {
        type: "lifecycle",
        phase: "tasks_created",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: `Controller created ${createdTaskIds.length} task(s): ${createdTaskIds.join(", ")}`,
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

  return {
    sessionKey,
    runId: runResult.runId,
    reply,
    controllerRunId: controllerRun.id,
  };
}

function summarizeTaskForAssignment(task: TaskInfo): string {
  const lastExecutionMessage = task.execution?.events[task.execution.events.length - 1]?.message;
  const raw = task.result || task.progress || lastExecutionMessage || task.description || "";
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

  const recentCompletedTasks = Object.values(state.tasks)
    .filter((candidate) => candidate.id !== task.id && candidate.status === "completed")
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
        ? (ROLES.find((role) => role.id === candidate.assignedRole)?.label ?? candidate.assignedRole)
        : "Unassigned";
      return `- [${candidate.id}] ${candidate.title} (${roleLabel}): ${summarizeTaskForAssignment(candidate)}`;
    }),
  ].join("\n");
}

function buildRecommendedSkillsContext(task: TaskInfo): string {
  const recommendedSkills = resolveRecommendedSkillsForRole(task.assignedRole, task.recommendedSkills ?? []);
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

function buildTaskAssignmentDescription(task: TaskInfo, state: TeamState | null, repoInfo?: RepoSyncInfo): string {
  const parts = [task.description];
  const recommendedSkillsContext = buildRecommendedSkillsContext(task);
  if (recommendedSkillsContext) {
    parts.push("", recommendedSkillsContext);
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
  if (!deps.config.gitEnabled) {
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
  if (deps.localWorkerManager?.isLocalWorkerId(workerId)) {
    cancelled = await deps.localWorkerManager.cancelTaskExecution(workerId, taskId);
  } else {
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

function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
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
      s.workers[task.assignedWorkerId].status = "idle";
      s.workers[task.assignedWorkerId].currentTaskId = undefined;
    }
  });

  const updatedTask = state.tasks[taskId];
  if (updatedTask) {
    if (completionEvent) {
      broadcastTaskExecutionEvent(taskId, updatedTask, completionEvent, deps);
    }
    wsServer.broadcastUpdate({ type: "task:completed", data: serializeTask(updatedTask) });
    logger.info(`Controller: task ${taskId} ${error ? "failed" : "completed"}`);
    if (updatedTask.assignedWorkerId) {
      void autoAssignPendingTasks(deps, updatedTask.assignedWorkerId).catch((err) => {
        logger.warn(
          `Controller: failed to auto-assign pending tasks after result for ${taskId}: ${String(err)}`,
        );
      });
    }
    scheduleProvisioningReconcile(deps, `task-result:${taskId}`);
    if (!error && updatedTask.createdBy === "controller" && updatedTask.controllerSessionKey) {
      void continueControllerWorkflow(updatedTask, deps).catch((err) => {
        logger.warn(
          `Controller: failed to continue intake workflow after ${taskId}: ${String(err)}`,
        );
      });
    }
  }

  return updatedTask;
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
      worker.status = "idle";
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
  const { localWorkerManager } = deps;

  if (localWorkerManager?.isLocalWorkerId(worker.id)) {
    const queued = await localWorkerManager.queueMessage(worker.id, message);
    if (queued) {
      return;
    }

    deps.logger.warn(`Controller: local message path unavailable for ${worker.id}, falling back to worker URL`);
  }

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
  const { getTeamState, localWorkerManager } = deps;
  const state = getTeamState();
  const task = state?.tasks[taskId];
  if (!task) {
    throw new Error(`task ${taskId} not found`);
  }

  const sharedWorkspace = localWorkerManager?.isLocalWorkerId(worker.id) ?? false;
  const repoState = await refreshControllerRepoState(deps);
  const repoInfo = buildRepoSyncInfo(repoState, sharedWorkspace);
  const description = buildTaskAssignmentDescription(task, state ?? null, repoInfo);
  const recommendedSkills = resolveRecommendedSkillsForRole(task.assignedRole, task.recommendedSkills ?? []);
  const assignment: TaskAssignmentPayload = {
    taskId: task.id,
    title: task.title,
    description,
    priority: task.priority,
    recommendedSkills,
    repo: repoInfo,
  };

  if (localWorkerManager?.isLocalWorkerId(worker.id)) {
    const accepted = await localWorkerManager.dispatchTask(worker.id, assignment);
    if (accepted) {
      return;
    }

    deps.logger.warn(`Controller: local dispatch path unavailable for ${worker.id}, falling back to worker URL`);
  }

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

async function autoAssignPendingTasks(
  deps: ControllerHttpDeps,
  preferredWorkerId?: string,
): Promise<TaskInfo[]> {
  const { getTeamState, taskRouter, wsServer, logger } = deps;
  const attemptedPairs = new Set<string>();
  const assignedTasks: TaskInfo[] = [];

  while (true) {
    const state = getTeamState();
    if (!state) {
      break;
    }

    const nextAssignment = taskRouter
      .autoAssignPendingTasks(state.tasks, state.workers)
      .filter(({ worker }) => !preferredWorkerId || worker.id === preferredWorkerId)
      .find(({ task, worker }) => !attemptedPairs.has(`${task.id}:${worker.id}`));

    if (!nextAssignment) {
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

    try {
      await handleRequest(req, res, pathname, deps);
    } catch (err) {
      logger.error(`Controller HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  });

  // Attach WebSocket
  wsServer.attach(server);

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ControllerHttpDeps,
): Promise<void> {
  const { config, logger, getTeamState, updateTeamState, taskRouter, messageRouter, wsServer } = deps;
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // ==================== Web UI ====================
  if (req.method === "GET" && (pathname === "/ui" || pathname === "/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    serveStaticFile(res, path.join(uiPath, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    const file = pathname.slice(4); // remove "/ui/"
    if (file.endsWith(".css")) {
      serveStaticFile(res, path.join(uiPath, file), "text/css; charset=utf-8");
    } else if (file.endsWith(".js")) {
      serveStaticFile(res, path.join(uiPath, file), "application/javascript; charset=utf-8");
    } else {
      serveStaticFile(res, path.join(uiPath, file), "application/octet-stream");
    }
    return;
  }

  // ==================== Workspace Browser ====================

  if (req.method === "GET" && pathname === "/api/v1/workspace/tree") {
    try {
      sendJson(res, 200, await listWorkspaceTree());
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
    const role = typeof body.role === "string" ? body.role as RoleId : "";
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
    if (deps.localWorkerManager?.isLocalWorkerId(workerId)) {
      sendError(res, 400, "Local workers are managed by controller config");
      return;
    }

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
    const workers = state ? Object.values(state.workers) : [];
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
    const assignedRole = typeof body.assignedRole === "string" ? body.assignedRole as RoleId : undefined;
    const createdBy = typeof body.createdBy === "string" ? body.createdBy : "boss";
    const recommendedSkills = normalizeRecommendedSkills(
      Array.isArray(body.recommendedSkills) ? body.recommendedSkills.map((entry) => String(entry ?? "")) : [],
    );

    if (!title) {
      sendError(res, 400, "title is required");
      return;
    }

    const taskId = generateId();
    const now = Date.now();
    const repoState = await refreshControllerRepoState(deps);

    const task: TaskInfo = {
      id: taskId,
      title,
      description,
      status: "pending",
      priority,
      assignedRole,
      createdBy,
      recommendedSkills: recommendedSkills.length > 0 ? recommendedSkills : undefined,
      createdAt: now,
      updatedAt: now,
    };

    updateTeamState((s) => {
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

  // GET /api/v1/tasks
  if (req.method === "GET" && pathname === "/api/v1/tasks") {
    const state = getTeamState();
    const tasks = state ? Object.values(state.tasks).map((task) => serializeTask(task)) : [];
    sendJson(res, 200, { tasks });
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

    const state = updateTeamState((s) => {
      const task = s.tasks[taskId];
      if (!task) return;
      const previousStatus = task.status;
      const previousProgress = task.progress;
      if (typeof body.status === "string") task.status = body.status as TaskStatus;
      if (typeof body.progress === "string") task.progress = body.progress as string;
      if (typeof body.priority === "string") task.priority = body.priority as TaskPriority;
      if (typeof body.assignedRole === "string") task.assignedRole = body.assignedRole as RoleId;
      if (Array.isArray(body.recommendedSkills)) {
        const recommendedSkills = normalizeRecommendedSkills(
          body.recommendedSkills.map((entry: unknown) => String(entry ?? "")),
        );
        task.recommendedSkills = recommendedSkills.length > 0 ? recommendedSkills : undefined;
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
    const targetRole = typeof body.targetRole === "string" ? body.targetRole as RoleId : undefined;

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
    const targetRole = typeof body.targetRole === "string" ? body.targetRole as RoleId : undefined;

    const state = getTeamState();
    if (!state?.tasks[taskId]) {
      sendError(res, 404, "Task not found");
      return;
    }

    const previousWorkerId = state.tasks[taskId].assignedWorkerId;

    updateTeamState((s) => {
      s.tasks[taskId].status = "pending";
      s.tasks[taskId].assignedWorkerId = undefined;
      s.tasks[taskId].assignedRole = targetRole ?? s.tasks[taskId].assignedRole;
      s.tasks[taskId].updatedAt = Date.now();

      // Free old worker
      if (previousWorkerId && s.workers[previousWorkerId]) {
        s.workers[previousWorkerId].status = "idle";
        s.workers[previousWorkerId].currentTaskId = undefined;
      }
    });

    await cancelTaskExecution(taskId, previousWorkerId, "handoff", deps);

    // Try auto-assign to new role
    const newState = getTeamState()!;
    const worker = taskRouter.routeTask(newState.tasks[taskId], newState.workers);
    if (worker) {
      await assignTaskToWorker(taskId, worker, deps, { assignedRole: targetRole });
    }

    const updatedTask = getTeamState()?.tasks[taskId];
    recordTaskExecutionEvent(taskId, {
      type: "lifecycle",
      phase: "handoff",
      source: "controller",
      message: targetRole
        ? `Task handed off and re-routed to role ${targetRole}.`
        : "Task handed off for re-routing.",
      role: targetRole,
    }, deps);
    wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    sendJson(res, 200, { task: serializeTask(updatedTask) });
    return;
  }

  // POST /api/v1/tasks/:id/result
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/result$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const result = typeof body.result === "string" ? body.result : "";
    const error = typeof body.error === "string" ? body.error : undefined;
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

    const updatedTask = applyTaskResult(taskId, result, error, deps);
    if (!workerId || workerId !== previousWorkerId) {
      await cancelTaskExecution(taskId, previousWorkerId, "manual result submission", deps);
    }
    sendJson(res, 200, { task: serializeTask(updatedTask) });
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
      role: typeof body.role === "string" ? body.role as RoleId : undefined,
      workerId,
      runId: typeof body.runId === "string" ? body.runId : undefined,
      sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
      status: typeof body.status === "string" ? body.status as TaskExecutionEventInput["status"] : undefined,
    }, deps);

    if (!recorded.task || !recorded.event) {
      sendError(res, 404, "Task not found");
      return;
    }

    sendJson(res, 201, {
      task: serializeTask(recorded.task),
      execution: buildTaskExecutionSummary(recorded.task.execution),
      event: recorded.event,
    });
    return;
  }

  // ==================== Message Routing ====================

  // GET /api/v1/controller/runs
  if (req.method === "GET" && pathname === "/api/v1/controller/runs") {
    const state = getTeamState();
    const controllerRuns = state
      ? Object.values(state.controllerRuns)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((run) => serializeControllerRun(run))
      : [];
    sendJson(res, 200, { controllerRuns });
    return;
  }

  // POST /api/v1/controller/intake
  if (req.method === "POST" && pathname === "/api/v1/controller/intake") {
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`Controller: intake failed for ${sessionKey}: ${errorMessage}`);
      sendError(res, errorMessage.includes("timed out") ? 504 : 500, errorMessage);
    }
    return;
  }

  // POST /api/v1/messages/direct
  if (req.method === "POST" && pathname === "/api/v1/messages/direct") {
    const body = await parseJsonBody(req);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
      type: "direct",
      content: typeof body.content === "string" ? body.content : "",
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
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      type: "broadcast",
      content: typeof body.content === "string" ? body.content : "",
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
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
      type: "review-request",
      content: typeof body.content === "string" ? body.content : "",
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
    const requestedByRole = typeof body.requestedByRole === "string" ? body.requestedByRole as RoleId : undefined;
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const blockingReason = typeof body.blockingReason === "string" ? body.blockingReason.trim() : "";
    const context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;

    if (!taskId || !question || !blockingReason) {
      sendError(res, 400, "taskId, question, and blockingReason are required");
      return;
    }

    const currentState = getTeamState();
    const currentTask = currentState?.tasks[taskId];
    if (!currentTask) {
      sendError(res, 404, "Task not found");
      return;
    }

    if (currentTask.clarificationRequestId) {
      const existing = currentState?.clarifications[currentTask.clarificationRequestId];
      if (existing?.status === "pending") {
        sendJson(res, 200, { clarification: existing, task: currentTask, status: "already-pending" });
        return;
      }
    }

    if (currentTask.status === "completed" || currentTask.status === "failed") {
      sendError(res, 409, "Cannot request clarification for a completed task");
      return;
    }

    const previousWorkerId = currentTask.assignedWorkerId;

    const clarificationId = generateId();
    const now = Date.now();
    const clarification: ClarificationRequest = {
      id: clarificationId,
      taskId,
      requestedBy,
      requestedByWorkerId,
      requestedByRole,
      question,
      blockingReason,
      context,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const state = updateTeamState((s) => {
      s.clarifications[clarificationId] = clarification;
      const task = s.tasks[taskId];
      if (!task) {
        return;
      }

      const assignedWorkerId = task.assignedWorkerId;
      task.status = "blocked";
      task.progress = `Awaiting clarification: ${question}`;
      task.clarificationRequestId = clarificationId;
      task.assignedWorkerId = undefined;
      task.updatedAt = now;

      if (assignedWorkerId && s.workers[assignedWorkerId]) {
        s.workers[assignedWorkerId].status = "idle";
        s.workers[assignedWorkerId].currentTaskId = undefined;
      }
    });

    await cancelTaskExecution(taskId, previousWorkerId, "clarification request", deps);

    const updatedTask = state.tasks[taskId];
    wsServer.broadcastUpdate({ type: "clarification:requested", data: clarification });
    if (updatedTask) {
      recordTaskExecutionEvent(taskId, {
        type: "lifecycle",
        phase: "clarification_requested",
        source: "controller",
        message: `Clarification requested: ${question}`,
        role: clarification.requestedByRole,
        workerId: clarification.requestedByWorkerId,
      }, deps);
      wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(updatedTask) });
    }
    sendJson(res, 201, { clarification, task: serializeTask(updatedTask) });
    return;
  }

  // GET /api/v1/clarifications
  if (req.method === "GET" && pathname === "/api/v1/clarifications") {
    const state = getTeamState();
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
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    const answeredBy = typeof body.answeredBy === "string" && body.answeredBy.trim()
      ? body.answeredBy.trim()
      : "human";

    if (!answer) {
      sendError(res, 400, "answer is required");
      return;
    }

    const currentState = getTeamState();
    const currentClarification = currentState?.clarifications[clarificationId];
    if (!currentClarification) {
      sendError(res, 404, "Clarification request not found");
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
      task.updatedAt = now;
    });

    const clarification = state.clarifications[clarificationId];
    const task = clarification ? state.tasks[clarification.taskId] : undefined;

    let responseMessage: TeamMessage | undefined;
    if (clarification?.requestedByRole && task) {
      responseMessage = {
        id: generateId(),
        from: answeredBy,
        toRole: clarification.requestedByRole,
        type: "direct",
        content: `Clarification answer for task ${task.id}: ${answer}`,
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
    const role = typeof requestUrl.searchParams.get("role") === "string" && requestUrl.searchParams.get("role")
      ? requestUrl.searchParams.get("role") as RoleId
      : undefined;

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
    const state = getTeamState();
    if (!state) {
      sendJson(res, 200, {
        teamName: config.teamName,
        workers: [],
        tasks: [],
        controllerRuns: [],
        messages: [],
        clarifications: [],
        repo: null,
        pendingClarificationCount: 0,
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
      repo: state.repo ?? null,
      taskCount: Object.keys(state.tasks).length,
      workerCount: Object.keys(state.workers).length,
      pendingClarificationCount: clarifications.filter((item) => item.status === "pending").length,
    });
    return;
  }

  // GET /api/v1/roles
  if (req.method === "GET" && pathname === "/api/v1/roles") {
    sendJson(res, 200, { roles: ROLES });
    return;
  }

  // GET /api/v1/health
  if (req.method === "GET" && pathname === "/api/v1/health") {
    sendJson(res, 200, { status: "ok", mode: "controller", timestamp: Date.now() });
    return;
  }

  sendError(res, 404, "Not found");
}
