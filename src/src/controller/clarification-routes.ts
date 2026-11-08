// PR-C of issue #204 (http-server monolith split): the clarification request
// domain - requestTaskClarification (task blocking + worker release), the
// structured answer builders, and the create/list/answer route handlers -
// lifted verbatim from controller/http-server.ts. Zero behavior change - the
// route shells in http-server keep the method+pathname matches and call these
// handlers with the same deps object as before. This module must NEVER import
// http-server (the reverse edge exists: http-server -> clarification-routes).
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ClarificationRequest,
  RoleId,
  TaskInfo,
  TeamMessage,
  WorkerInfo,
} from "../types.js";
import { generateId, parseJsonBody, sendError, sendJson } from "../protocol.js";
import { ensureTeamMessageContract } from "../interaction-contracts.js";
import { validateActiveRoleId } from "../profile-loader.js";
import { normalizeClarificationQuestionSchema } from "./orchestration-manifest.js";
import {
  cancelTaskExecution,
  recordTaskExecutionEvent,
  resetTaskForFreshAttempt,
  serializeTask,
  type ControllerTaskDomainDeps,
} from "./task-execution.js";
import { assignTaskToWorker } from "./task-assignment.js";
import { routeDirectMessage } from "./message-delivery.js";
import {
  reconcileControllerClarifications,
  runControllerIntake,
} from "./controller-intake.js";

// POST /api/v1/clarifications
export async function handleClarificationCreateRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
}

// GET /api/v1/clarifications
export async function handleClarificationListRequest(deps: ControllerTaskDomainDeps, res: ServerResponse): Promise<void> {
  const state = reconcileControllerClarifications(deps);
  const clarifications = state
    ? Object.values(state.clarifications).sort((left, right) => right.createdAt - left.createdAt)
    : [];
  sendJson(res, 200, {
    clarifications,
    pendingCount: clarifications.filter((item) => item.status === "pending").length,
  });
}

// POST /api/v1/clarifications/:id/answer
export async function handleClarificationAnswerRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { getTeamState, taskRouter, updateTeamState, wsServer } = deps;
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
}

export function buildControllerClarificationAnswerMessage(
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

export function buildStructuredClarificationAnswer(
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

export async function requestTaskClarification(params: {
  taskId: string;
  requestedBy: string;
  requestedByWorkerId?: string;
  requestedByRole?: RoleId;
  question: string;
  blockingReason: string;
  context?: string;
  questionSchema?: ClarificationRequest["questionSchema"];
}, deps: ControllerTaskDomainDeps): Promise<{
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
