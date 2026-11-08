// PR-C of issue #204 (http-server monolith split): the task execution event
// ring and task serialization extracted verbatim from controller/http-server.ts.
// Zero behavior change - http-server and the sibling PR-C modules import these
// with the same deps object as before. This module must NEVER import
// http-server (the reverse edge exists: http-server -> task-execution); the
// websocket broadcast and the team-state mutator arrive through the deps
// slice below, and everything else is pure over TaskInfo.
import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import type {
  KickoffAssessment,
  PluginConfig,
  RoleId,
  TaskExecution,
  TaskExecutionEvent,
  TaskExecutionEventInput,
  TaskExecutionSummary,
  TaskInfo,
  TaskStatus,
  TeamState,
} from "../types.js";
import { generateId } from "../protocol.js";
import { buildTeamClawAgentSessionKey } from "../openclaw-workspace.js";
import type { TaskRouter } from "./task-router.js";
import type { MessageRouter } from "./message-router.js";
import type { TeamAutoScheduler } from "../teamauto/scheduler.js";
import type { TeamWebSocketServer } from "./websocket.js";
import type { WorkerProvisioningManager } from "./worker-provisioning.js";
import type { PreviewManager } from "./preview-manager.js";

/**
 * Structural mirror of ControllerHttpDeps (http-server.ts). The task/team
 * lifecycle domain extracted by PR-C is one tightly coupled family whose
 * helpers hand the SAME deps object to each other (intake -> planning ->
 * assignment -> execution events), so the PR-C modules share this single
 * slice instead of per-module subsets that would each have to union their
 * transitive callees. http-server keeps passing its full ControllerHttpDeps
 * object; TypeScript structural typing accepts it, so no call site changes
 * beyond the import path. This module must never import http-server; the
 * kickoff callback is declared structurally so controller-service.ts stays
 * the only definition site of KickoffHandler (no new module edge).
 */
type ControllerKickoffHandler = (
  candidateRoles: RoleId[],
  complexity: "simple" | "medium" | "complex",
  requirement: string,
) => Promise<{ assessments: KickoffAssessment[]; summary: string }>;

export type ControllerTaskDomainDeps = {
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
  getKickoffHandler?: () => ControllerKickoffHandler | undefined;
  /** Late-bound TeamAuto scheduler (autonomous repo collaboration). */
  getTeamAutoScheduler?: () => TeamAutoScheduler | null;
};

export const MAX_TASK_EXECUTION_EVENTS = 250;

const CONTROLLER_INTAKE_SESSION_PREFIX = "teamclaw-controller-web:";
const CONTROLLER_INTAKE_AGENT_SESSION_RE = /^agent:[^:]+:(teamclaw-controller-web:[a-zA-Z0-9:_-]{1,120})$/;

export function mapTaskStatusToExecutionStatus(taskStatus: TaskStatus, current?: TaskExecution["status"]): TaskExecution["status"] {
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

export function ensureTaskExecution(task: TaskInfo): TaskExecution {
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

export function resetTaskForFreshAttempt(task: TaskInfo): void {
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

export function buildTaskExecutionIdentity(taskId: string, workerId: string): {
  executionSessionKey: string;
  executionIdempotencyKey: string;
} {
  const attemptId = generateId();
  return {
    executionSessionKey: buildTeamClawAgentSessionKey(`teamclaw-task-${taskId}-${attemptId}`),
    executionIdempotencyKey: `teamclaw-${taskId}-${workerId}-${attemptId}`,
  };
}

export function appendTaskExecutionEvent(task: TaskInfo, input: TaskExecutionEventInput): TaskExecutionEvent {
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

export function buildTaskExecutionSummary(execution?: TaskExecution): TaskExecutionSummary | undefined {
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

export function serializeTask(task?: TaskInfo, includeExecutionEvents = false): Record<string, unknown> | undefined {
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

export function normalizeControllerIntakeSessionKey(input: unknown): string {
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

export function broadcastTaskExecutionEvent(
  taskId: string,
  task: TaskInfo,
  event: TaskExecutionEvent,
  deps: ControllerTaskDomainDeps,
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

export function recordTaskExecutionEvent(
  taskId: string,
  input: TaskExecutionEventInput,
  deps: ControllerTaskDomainDeps,
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

export function canAcceptWorkerUpdate(task: TaskInfo | undefined, workerId: string): boolean {
  if (!task || task.assignedWorkerId !== workerId || task.completedAt) {
    return false;
  }

  return task.status === "assigned" ||
    task.status === "in_progress" ||
    task.status === "review" ||
    task.status === "completed" ||
    task.status === "failed";
}

export async function cancelTaskExecution(
  taskId: string,
  workerId: string | undefined,
  reason: string,
  deps: ControllerTaskDomainDeps,
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
