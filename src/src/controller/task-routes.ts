// PR-C of issue #204 (http-server monolith split): the task CRUD/lifecycle
// route handlers lifted verbatim from the inline dispatch blocks in
// controller/http-server.ts (task create/list/get/patch/delete, execution
// detail, manual assign, handoff, checkpoint, result contract, result,
// execution events, parallel help). Zero behavior change - the route shells
// in http-server keep the method+pathname matches and call these handlers
// with the same deps object as before. This module must NEVER import
// http-server (the reverse edge exists: http-server -> task-routes); the
// domain helpers arrive from the sibling PR-C modules below.
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  TaskExecutionEvent,
  TaskExecutionEventInput,
  TaskInfo,
  TaskPriority,
  TaskStatus,
  WorkerInfo,
  WorkerProgressContract,
} from "../types.js";
import { generateId, parseJsonBody, sendError, sendJson } from "../protocol.js";
import { normalizeRecommendedSkills, validateActiveRoleId } from "../profile-loader.js";
import { deriveProjectSlug, deriveStableProjectKey } from "../openclaw-workspace.js";
import {
  backfillWorkerProgressContract,
  enrichDeliverablesWithPreviewInference,
  normalizeTaskHandoffContract,
  normalizeWorkerProgressContract,
  normalizeWorkerTaskResultContract,
} from "../interaction-contracts.js";
import { refreshControllerRepoState } from "./repo-routes.js";
import {
  appendTaskExecutionEvent,
  broadcastTaskExecutionEvent,
  buildTaskExecutionSummary,
  canAcceptWorkerUpdate,
  cancelTaskExecution,
  mapTaskStatusToExecutionStatus,
  normalizeControllerIntakeSessionKey,
  recordTaskExecutionEvent,
  resetTaskForFreshAttempt,
  serializeTask,
  type ControllerTaskDomainDeps,
} from "./task-execution.js";
import {
  assignTaskToWorker,
  autoAssignPendingTasks,
  scheduleProvisioningReconcile,
} from "./task-assignment.js";
import {
  resolveProjectIdentityForSession,
  syncProjectRegistryEntry,
} from "./project-registry.js";
import { buildEmptyTaskCleanupSummary, deleteTaskCascade } from "./task-cleanup.js";
import {
  allowsNoChangeCompletion,
  applyTaskResult,
  buildEffectiveTaskResultContract,
  consolidateDiscoveredPatterns,
  ensureTaskResultContract,
  enrichWithFilesystemHtmlScan,
  filterStaleDeliverables,
  projectHasMeaningfulFileChanges,
  taskRequiresMeaningfulProjectChangeGate,
} from "./task-results.js";
import { requestTaskClarification } from "./clarification-routes.js";
import {
  buildControllerParallelHelpMessage,
  resolveControllerWorkflowSessionKey,
} from "./controller-planning.js";
import {
  ControllerIntakeSwitchInProgressError,
  runControllerIntake,
} from "./controller-intake.js";
import {
  buildStartupReadinessMessage,
  shouldBlockControllerUntilProvisioningReady,
} from "./worker-routes.js";
import {
  buildControllerNoWorkersMessage,
  shouldBlockControllerWithoutWorkers,
} from "./controller-capacity.js";

// Same value as the SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS constant the
// dispatch layer keeps in http-server.ts (PR-B precedent: the lifted preview
// proxy keeps its own copy of the prefix const; the shells keep an identical
// copy for the startsWith match).
const SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS = 5;

// POST /api/v1/tasks
export async function handleTaskCreateRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getTeamState, updateTeamState, wsServer } = deps;
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
    const readinessGate = shouldBlockControllerUntilProvisioningReady(deps, getTeamState());
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
}

// GET /api/v1/tasks
export async function handleTaskListRequest(deps: ControllerTaskDomainDeps, res: ServerResponse): Promise<void> {
  const { getTeamState } = deps;
  const state = getTeamState();
  const tasks = state ? Object.values(state.tasks).map((task) => serializeTask(task)) : [];
  sendJson(res, 200, { tasks });
}

// GET /api/v1/tasks/:id
export async function handleTaskGetRequest(deps: ControllerTaskDomainDeps, res: ServerResponse, pathname: string): Promise<void> {
  const { getTeamState } = deps;
  const taskId = pathname.split("/").pop()!;
  const state = getTeamState();
  const task = state?.tasks[taskId];
  if (!task) {
    sendError(res, 404, "Task not found");
    return;
  }
  sendJson(res, 200, { task: serializeTask(task) });
}

// DELETE /api/v1/tasks/:id
export async function handleTaskDeleteRequest(deps: ControllerTaskDomainDeps, res: ServerResponse, pathname: string): Promise<void> {
  const { getTeamState } = deps;
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
}

// GET /api/v1/tasks/:id/execution
export async function handleTaskExecutionGetRequest(deps: ControllerTaskDomainDeps, res: ServerResponse, pathname: string): Promise<void> {
  const { getTeamState } = deps;
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
}

// PATCH /api/v1/tasks/:id
export async function handleTaskPatchRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { updateTeamState, wsServer } = deps;
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
}

// POST /api/v1/tasks/:id/assign
export async function handleTaskAssignRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { getTeamState, taskRouter, wsServer } = deps;
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
}

// POST /api/v1/tasks/:id/handoff
export async function handleTaskHandoffRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { logger, getTeamState, taskRouter, updateTeamState, wsServer } = deps;
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
}

// POST /api/v1/tasks/:id/checkpoint
export async function handleTaskCheckpointRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { updateTeamState } = deps;
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
}

// POST /api/v1/tasks/:id/result-contract
export async function handleTaskResultContractRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { logger, getTeamState, updateTeamState } = deps;
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
}

// POST /api/v1/tasks/:id/result
export async function handleTaskResultRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { logger, getTeamState, updateTeamState } = deps;
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
}

// POST /api/v1/tasks/:id/execution
export async function handleTaskExecutionEventRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { logger, getTeamState } = deps;
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
}

// POST /api/v1/tasks/:id/parallel-help
export async function handleTaskParallelHelpRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { getTeamState } = deps;
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
}
