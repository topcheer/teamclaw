// PR-C of issue #204 (http-server monolith split): the controller-run
// lifecycle (execution event ring, create/update/serialize) extracted
// verbatim from controller/http-server.ts. Zero behavior change - callers
// pass the same deps object as before. This module must NEVER import
// http-server (the reverse edge exists: http-server -> controller-runs).
import type { PluginLogger } from "../../api.js";
import type {
  ControllerRunInfo,
  ControllerRunSource,
  TaskExecution,
  TaskExecutionEvent,
  TaskExecutionEventInput,
  TeamState,
} from "../types.js";
import { generateId } from "../protocol.js";
import { deriveProjectSlug } from "../openclaw-workspace.js";
import { buildTaskExecutionSummary, MAX_TASK_EXECUTION_EVENTS } from "./task-execution.js";
import {
  extractExplicitProjectNameHint,
  resolveExistingProjectIdentityFromMessage,
  resolveProjectIdentityForSession,
  resolveProjectIdentityForTaskId,
  syncProjectRegistryEntry,
} from "./project-registry.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

const MAX_CONTROLLER_RUNS = 40;

export function ensureControllerRunExecution(run: ControllerRunInfo): TaskExecution {
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

export function appendControllerRunEvent(run: ControllerRunInfo, input: TaskExecutionEventInput): TaskExecutionEvent {
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

export function trimControllerRuns(state: TeamState): void {
  const runs = Object.values(state.controllerRuns)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  if (runs.length <= MAX_CONTROLLER_RUNS) {
    return;
  }
  for (const run of runs.slice(0, runs.length - MAX_CONTROLLER_RUNS)) {
    delete state.controllerRuns[run.id];
  }
}

export function serializeControllerRun(run?: ControllerRunInfo, includeExecutionEvents = true): Record<string, unknown> | undefined {
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

export function buildControllerRunTitle(
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

export function createControllerRun(
  message: string,
  sessionKey: string,
  deps: ControllerTaskDomainDeps,
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

export function updateControllerRun(
  runId: string,
  deps: ControllerTaskDomainDeps,
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

export function recordControllerRunEvent(
  runId: string,
  input: TaskExecutionEventInput,
  deps: ControllerTaskDomainDeps,
): ControllerRunInfo | undefined {
  return updateControllerRun(runId, deps, (run) => {
    appendControllerRunEvent(run, input);
  });
}
