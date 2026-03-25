import fs from "node:fs";
import path from "node:path";
import http from "node:http";
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
  WorkerProgressContract,
  WorkerInfo,
  WorkerTaskResultContract,
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
import { createControllerPromptInjector } from "./prompt-injector.js";
import { buildControllerNoWorkersMessage, shouldBlockControllerWithoutWorkers } from "./controller-capacity.js";
import {
  backfillWorkerProgressContract,
  backfillWorkerTaskResultContract,
  ensureTeamMessageContract,
  normalizeTaskHandoffContract,
  normalizeWorkerProgressContract,
  normalizeWorkerTaskResultContract,
} from "../interaction-contracts.js";
import { normalizeControllerManifest } from "./orchestration-manifest.js";

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
const CONTROLLER_INTAKE_SESSION_PREFIX = "teamclaw-controller-web:";
const CONTROLLER_INTAKE_AGENT_SESSION_RE = /^agent:[^:]+:(teamclaw-controller-web:[a-zA-Z0-9:_-]{1,120})$/;
const CONTROLLER_RUN_WAIT_SLICE_MS = 30_000;
const CONTROLLER_RATE_LIMIT_STALL_PROBE_MS = 5 * 60 * 1000;
const CONTROLLER_RATE_LIMIT_PROBE_TIMEOUT_MS = 60_000;
const CONTROLLER_RATE_LIMIT_WAITING_SENTINEL = "TEAMCLAW_STILL_WAITING";
const controllerIntakeQueue = new Map<string, Promise<void>>();

export function buildControllerIntakeSystemPrompt(
  deps: Pick<ControllerHttpDeps, "config" | "getTeamState">,
): string {
  const injector = createControllerPromptInjector({
    config: deps.config,
    getTeamState: deps.getTeamState,
  });
  return injector()?.prependSystemContext ?? "";
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
    executionSessionKey: `teamclaw-task-${taskId}-${attemptId}`,
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

  return logicalKey.startsWith(CONTROLLER_INTAKE_SESSION_PREFIX)
    ? logicalKey
    : `${CONTROLLER_INTAKE_SESSION_PREFIX}${logicalKey}`;
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
  for (const role of ROLES) {
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
  const clarificationQuestions = inferClarificationQuestionsFromReply(rawReply);
  return {
    version: "1.0",
    requirementSummary: request.replace(/\s+/g, " ").trim() || "Controller requirement summary unavailable.",
    requiredRoles: Array.from(inferredRoles),
    clarificationsNeeded: clarificationQuestions.length > 0 && actualCreatedTasks.length === 0,
    clarificationQuestions,
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
  const resultContractSection = buildResultContractSection(task);
  if (resultContractSection) {
    parts.push("", resultContractSection);
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
  await runControllerIntake(buildControllerFollowUpMessage(task), sessionKey, deps, {
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
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  return withSerializedControllerIntake(normalizedSessionKey, () =>
    runControllerIntakeUnlocked(message, normalizedSessionKey, deps, options),
  );
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
    return probeReply;
  };

  let waitResult: Awaited<ReturnType<typeof deps.runtime.subagent.waitForRun>> = { status: "timeout" };
  let completionOverride: string | null = null;
  const deadline = Date.now() + deps.config.taskTimeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      waitResult = { status: "timeout" };
      break;
    }

    if (rateLimitState.active && (rateLimitState.nextProbeAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
      completionOverride = await probeRateLimitedControllerCompletion();
      if (completionOverride) {
        waitResult = { status: "ok" };
        break;
      }
    }

    const sliceTimeoutMs = Math.max(1_000, Math.min(CONTROLLER_RUN_WAIT_SLICE_MS, remainingMs));
    waitResult = await deps.runtime.subagent.waitForRun({
      runId: runResult.runId,
      timeoutMs: sliceTimeoutMs,
    });

    if (waitResult.status === "ok") {
      clearRateLimitWaiting();
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
  const reconciledTasks = reconcileControllerManifestTaskBindings(sessionKey, createdTaskIds, recordedManifest, deps);
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
      });
    }
  }

  return updatedTask;
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
    return currentTask.resultContract;
  }

  const contract = backfillWorkerTaskResultContract(currentTask, result, error);
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
  return lines.join("\n");
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
  const executionIdentity = buildTaskExecutionIdentity(task.id, worker.id);
  const assignment: TaskAssignmentPayload = {
    taskId: task.id,
    title: task.title,
    description,
    priority: task.priority,
    recommendedSkills,
    executionSessionKey: executionIdentity.executionSessionKey,
    executionIdempotencyKey: executionIdentity.executionIdempotencyKey,
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
  if (req.method === "GET" && pathname === "/") {
    res.statusCode = 302;
    res.setHeader("Location", "/ui");
    res.end();
    return;
  }

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
    const controllerSessionKey = createdBy === "controller" && typeof body.controllerSessionKey === "string" && body.controllerSessionKey.trim()
      ? normalizeControllerIntakeSessionKey(body.controllerSessionKey)
      : undefined;
    const recommendedSkills = normalizeRecommendedSkills(
      Array.isArray(body.recommendedSkills) ? body.recommendedSkills.map((entry) => String(entry ?? "")) : [],
    );

    if (!title) {
      sendError(res, 400, "title is required");
      return;
    }
    if (createdBy === "controller" && shouldBlockControllerWithoutWorkers(deps.config, getTeamState())) {
      sendError(res, 409, buildControllerNoWorkersMessage());
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
      controllerSessionKey,
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
      if (typeof body.assignedRole === "string") task.assignedRole = body.assignedRole as RoleId;
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
      task.resultContract = contract;
      task.updatedAt = Date.now();
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
    sendJson(res, 201, { task: serializeTask(state.tasks[taskId]) });
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

    const updatedTask = applyTaskResult(taskId, result, error, deps);
    ensureTaskResultContract(taskId, result, error, deps);
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

    sendJson(res, 201, {
      controllerRun: serializeControllerRun(updatedRun),
      manifest,
    });
    return;
  }

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
      contract: ensureTeamMessageContract(body.contract, {
        type: "direct",
        content: typeof body.content === "string" ? body.content : "",
        toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
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
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
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
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
      type: "review-request",
      content: typeof body.content === "string" ? body.content : "",
      contract: ensureTeamMessageContract(body.contract, {
        type: "review-request",
        content: typeof body.content === "string" ? body.content : "",
        toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
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
        const assignedWorker = s.workers[assignedWorkerId];
        if (assignedWorker.status !== "offline") {
          assignedWorker.status = "idle";
        }
        assignedWorker.currentTaskId = undefined;
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
      resetTaskForFreshAttempt(task);
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
