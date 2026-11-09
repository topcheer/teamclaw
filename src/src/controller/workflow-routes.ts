// Design 2.4 workflows backend (vertical-team-profiles-design.md section
// 2.4): declarative workflow templates with conclusion branches, consumed
// end to end from this module.
//
//   - POST /api/v1/workflows/{id}/start (registered in route-table.ts):
//     creates the FIRST step task of the named template (the UI wave renders
//     the profile's workflows as a quick-action button group and posts here
//     with optional initial context).
//   - continueWorkflowAfterTaskCompletion: the task-completion hook that
//     task-results.ts applyTaskResult invokes for tasks carrying
//     TaskInfo.workflow. It parses the completed step's conclusion phrase
//     from the result text (includes match, longest phrase wins) and routes
//     per the step's `on` map - RUNTIME-DYNAMIC routing, the design's
//     "controller 按 conclusion 路由" realized WITHOUT a controller LLM pass:
//     the conclusion enum values are concrete phrases (e.g. 「通过」/
//     「退回补充材料」) the step's task description instructs the worker to
//     end its deliverable with, so deterministic keyword matching suffices.
//
// The task chain IS the run state (per design: no separate registry): every
// step task carries TaskWorkflowContext {workflowId, runId, stepKey,
// visitCounts, routed* latch}, persists with TeamState, serializes through
// serializeTask, and the routed* latch makes routing exactly-once per step
// task. Workflow tasks are createdBy "workflow", so the generic controller
// LLM follow-up (continueControllerWorkflow) never fires for them - the
// declarative template replaces the LLM's free-form follow-up planning.
//
// Module-home rule mirrors the other route modules: TYPE-ONLY import of
// route-table.js (RouteContext); no runtime import of http-server.

import type { RoleId, TaskInfo, TaskWorkflowContext } from "../types.js";
import { generateId, parseJsonBody, sendError, sendJson } from "../protocol.js";
import { getActiveWorkflows, type TeamProfileWorkflow, type TeamProfileWorkflowStep } from "../profile-loader.js";
import { recordTaskExecutionEvent, serializeTask } from "./task-execution.js";
import { createControllerManagedTask } from "./controller-planning.js";
import { SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS } from "./controller-routes.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";
import type { RouteContext } from "./route-table.js";

/** createdBy stamp for workflow-engine tasks (skips the controller LLM follow-up path). */
const WORKFLOW_TASK_CREATED_BY = "workflow";

/** Return-edge loop guard: a step may be (re)entered at most this many times per run. */
export const MAX_WORKFLOW_STEP_VISITS = 3;

/** Upstream result excerpt cap when embedding outputs into a step description. */
const UPSTREAM_RESULT_EXCERPT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Template helpers.
// ---------------------------------------------------------------------------

function stepKeyOf(stepId: number | string): string {
  return String(stepId);
}

function isBranchStep(step: TeamProfileWorkflowStep): boolean {
  return typeof step.id === "string";
}

function findStep(workflow: TeamProfileWorkflow, stepKey: string): TeamProfileWorkflowStep | undefined {
  return workflow.steps.find((step) => stepKeyOf(step.id) === stepKey);
}

/**
 * Default "next" resolution (design 2.4: on-values may be "next" or a step
 * id; conclusions without an explicit on-mapping fall through to next):
 * advance along the NUMERIC spine to the smallest numeric step id greater
 * than the current one. Branch steps (string ids like "committee") are never
 * a default next - they are reachable only through an explicit on jump, so
 * e.g. the within-mandate approval (step 2) ends the run instead of leaking
 * into the committee step declared after it.
 */
function defaultNextStep(workflow: TeamProfileWorkflow, current: TeamProfileWorkflowStep): TeamProfileWorkflowStep | undefined {
  if (isBranchStep(current)) {
    return undefined;
  }
  return workflow.steps
    .filter((step) => !isBranchStep(step) && (step.id as number) > (current.id as number))
    .sort((a, b) => (a.id as number) - (b.id as number))[0];
}

/**
 * Longest-phrase-wins includes match of the step's conclusion enum against
 * the completed task's evidence text (result + result contract summary /
 * key points / notes). Longest-first prevents a prefix phrase (「通过」 inside
 * 「未通过」-style collisions, 「补充材料」 inside 「退回补充材料」) from
 * shadowing the specific phrase.
 */
export function matchStepConclusion(step: TeamProfileWorkflowStep, evidenceText: string): string | undefined {
  const conclusions = step.conclusion ?? [];
  if (conclusions.length === 0 || !evidenceText) {
    return undefined;
  }
  return [...conclusions].sort((a, b) => b.length - a.length).find((phrase) => evidenceText.includes(phrase));
}

function collectResultEvidence(task: TaskInfo): string {
  const contract = task.resultContract;
  return [
    task.result ?? "",
    contract?.summary ?? "",
    contract?.notes ?? "",
    ...(contract?.keyPoints ?? []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Task description assembly.
// ---------------------------------------------------------------------------

function conclusionInstruction(step: TeamProfileWorkflowStep): string {
  const conclusions = step.conclusion ?? [];
  if (conclusions.length === 0) {
    return "";
  }
  return `结论要求：请在交付物结尾单独一行明确给出以下结论短语之一（工作流引擎按该短语路由下一步）：${conclusions.map((phrase) => `「${phrase}」`).join(" / ")}`;
}

function truncateExcerpt(text: string, limit = UPSTREAM_RESULT_EXCERPT_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}\n…（上游结果过长，已截断，完整内容见原任务）`;
}

/**
 * Design 2.4 outputKey passing: for every inputs[] key of the target step,
 * embed the latest completed result of the step that declares that output.
 */
function buildUpstreamInputsSection(
  targetStep: TeamProfileWorkflowStep,
  workflow: TeamProfileWorkflow,
  completedTasks: TaskInfo[],
): string {
  const inputKeys = targetStep.inputs ?? [];
  if (inputKeys.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const inputKey of inputKeys) {
    const declaringStep = workflow.steps.find((step) => (step.outputs ?? []).some((output) => output.key === inputKey));
    if (!declaringStep) {
      continue; // impossible after load validation (dangling input is fatal); belt-and-braces
    }
    const output = (declaringStep.outputs ?? []).find((entry) => entry.key === inputKey)!;
    const sourceTask = completedTasks
      .filter((task) => task.workflow?.stepKey === stepKeyOf(declaringStep.id))
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))[0];
    if (sourceTask) {
      lines.push(
        `【上游产出 ${output.key}（${output.name}，来自任务 ${sourceTask.id}：${declaringStep.title}）】`,
        truncateExcerpt(sourceTask.result ?? sourceTask.resultContract?.summary ?? "（上游任务未记录文本结果）"),
        "",
      );
    } else {
      lines.push(`【上游产出 ${output.key}（${output.name}）】尚未生成：请先向 controller 申请 ${declaringStep.title} 的产出。`, "");
    }
  }
  return lines.join("\n").trim();
}

function buildReturnReasonSection(returningTask: TaskInfo): string {
  return [
    `【退回意见（来自 ${returningTask.title}，任务 ${returningTask.id} 的结论与要点）】`,
    truncateExcerpt(collectResultEvidence(returningTask)),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run helpers.
// ---------------------------------------------------------------------------

function tasksOfWorkflowRun(state: { tasks: Record<string, TaskInfo> }, runId: string): TaskInfo[] {
  return Object.values(state.tasks).filter((task) => task.workflow?.runId === runId);
}

function visitCountsIncluding(context: TaskWorkflowContext, stepKey: string): Record<string, number> {
  const counts = { ...(context.visitCounts ?? {}) };
  counts[stepKey] = (counts[stepKey] ?? 0) + 1;
  return counts;
}

async function createWorkflowStepTask(
  input: {
    workflow: TeamProfileWorkflow;
    step: TeamProfileWorkflowStep;
    runId: string;
    description: string;
    visitCounts: Record<string, number>;
  },
  deps: ControllerTaskDomainDeps,
): Promise<TaskInfo | undefined> {
  const { workflow, step } = input;
  const workflowContext: TaskWorkflowContext = {
    workflowId: workflow.id,
    runId: input.runId,
    stepKey: stepKeyOf(step.id),
    visitCounts: input.visitCounts,
  };
  return createControllerManagedTask({
    title: step.title,
    description: input.description,
    assignedRole: step.role as RoleId,
    createdBy: WORKFLOW_TASK_CREATED_BY,
    projectName: `workflow-${workflow.id}`,
    recommendedSkills: [],
    workflow: workflowContext,
  }, deps);
}

function buildStepDescription(
  input: {
    workflow: TeamProfileWorkflow;
    step: TeamProfileWorkflowStep;
    initialContext?: string;
    upstreamSection?: string;
    returnSection?: string;
  },
): string {
  const { workflow, step } = input;
  const parts: string[] = [
    `【工作流】${workflow.name}（workflow id: ${workflow.id}）— 当前步骤：${step.title}`,
    step.description ?? "",
  ];
  if (input.initialContext?.trim()) {
    parts.push(`【业务背景 / 初始材料】\n${input.initialContext.trim()}`);
  }
  if (input.returnSection) {
    parts.push(input.returnSection);
  }
  if (input.upstreamSection) {
    parts.push(`【上游交付（本步骤的输入）】\n${input.upstreamSection}`);
  }
  const instruction = conclusionInstruction(step);
  if (instruction) {
    parts.push(instruction);
  }
  return parts.filter((entry) => entry.trim().length > 0).join("\n\n");
}

// ---------------------------------------------------------------------------
// Completion routing (the design's "controller 按 conclusion 路由", minimal
// viable: deterministic phrase matching on the result evidence, no LLM pass).
// ---------------------------------------------------------------------------

export async function continueWorkflowAfterTaskCompletion(
  completedTask: TaskInfo,
  deps: ControllerTaskDomainDeps,
): Promise<TaskInfo | undefined> {
  const context = completedTask.workflow;
  if (!context) {
    return undefined;
  }
  const { logger } = deps;
  const state = deps.getTeamState();
  if (!state || !state.tasks[completedTask.id]) {
    return undefined;
  }

  const workflow = getActiveWorkflows().find((entry) => entry.id === context.workflowId);
  if (!workflow) {
    logger.warn(
      `Workflow: task ${completedTask.id} references workflow "${context.workflowId}" which the active profile does not carry - chain stops`,
    );
    return undefined;
  }
  const currentStep = findStep(workflow, context.stepKey);
  if (!currentStep) {
    logger.warn(
      `Workflow: task ${completedTask.id} references step "${context.stepKey}" of "${workflow.id}" which no longer exists - chain stops`,
    );
    return undefined;
  }

  // 1. Decide the next step from the conclusion evidence (pure, no state).
  const evidence = collectResultEvidence(state.tasks[completedTask.id] ?? completedTask);
  const conclusion = matchStepConclusion(currentStep, evidence);
  const explicitTarget = conclusion !== undefined ? currentStep.on?.[conclusion] : undefined;
  let nextStep: TeamProfileWorkflowStep | undefined;
  if (explicitTarget !== undefined && explicitTarget !== "next") {
    nextStep = findStep(workflow, stepKeyOf(explicitTarget));
  } else {
    // No conclusion enum, no matching phrase (documented fallback), or an
    // explicit "next": advance along the numeric spine.
    nextStep = defaultNextStep(workflow, currentStep);
  }
  const nextStepKey = nextStep ? stepKeyOf(nextStep.id) : "";
  const isReturnEdge = typeof nextStep?.id === "number"
    && typeof currentStep.id === "number"
    && (nextStep.id as number) <= currentStep.id;

  // 2. Once-only routing latch + loop guard, set atomically in one state
  // mutation (no await between latch and task creation, so concurrent
  // completions cannot double-spawn the follow-up task). routedToStepKey
  // records where the chain ACTUALLY went: the follow-up step key, or ""
  // when the run ends (leaf completion or the guard refusing a return edge).
  let alreadyRouted = false;
  let loopGuardTripped = false;
  let visitCounts = context.visitCounts ?? {};
  deps.updateTeamState((s) => {
    const task = s.tasks[completedTask.id];
    if (!task?.workflow) {
      alreadyRouted = true;
      return;
    }
    if (task.workflow.routedToStepKey !== undefined) {
      alreadyRouted = true;
      return;
    }
    if (nextStep && (context.visitCounts?.[nextStepKey] ?? 0) + 1 > MAX_WORKFLOW_STEP_VISITS) {
      loopGuardTripped = true;
    }
    task.workflow.routedToStepKey = loopGuardTripped ? "" : nextStepKey;
    task.workflow.routedAt = Date.now();
    task.workflow.routedConclusion = conclusion;
    if (!loopGuardTripped) {
      task.workflow.visitCounts = visitCountsIncluding(context, nextStepKey);
      visitCounts = task.workflow.visitCounts;
    }
  });
  if (alreadyRouted) {
    return undefined;
  }

  if (loopGuardTripped) {
    recordWorkflowRoutingEvent(completedTask.id, deps, currentStep,
      `workflow "${workflow.id}" stopped: step "${nextStepKey}" would exceed ${MAX_WORKFLOW_STEP_VISITS} visits (return-edge loop guard)`);
    logger.warn(
      `Workflow: run ${context.runId} of "${workflow.id}" stopped at step ${context.stepKey} - step "${nextStepKey}" exceeded the ${MAX_WORKFLOW_STEP_VISITS}-visit loop guard`,
    );
    return undefined;
  }

  if (conclusion === undefined && (currentStep.conclusion ?? []).length > 0) {
    logger.warn(
      `Workflow: task ${completedTask.id} (step ${context.stepKey} of "${workflow.id}") stated none of the step's conclusion phrases; falling back to default next-step routing`,
    );
  }

  recordWorkflowRoutingEvent(completedTask.id, deps, currentStep,
    `workflow "${workflow.id}" step ${context.stepKey} completed${conclusion ? ` with conclusion 「${conclusion}」` : ""} -> ${
      nextStep ? `step ${nextStepKey} (${nextStep.title}, role ${nextStep.role})` : "chain end"}`);

  if (!nextStep) {
    logger.info(`Workflow: run ${context.runId} of "${workflow.id}" completed (no next step after ${context.stepKey})`);
    return undefined;
  }

  // 3. Create the follow-up step task with upstream outputs + return reason.
  const runTasks = tasksOfWorkflowRun(deps.getTeamState() ?? state, context.runId);
  const completedRunTasks = runTasks.filter((task) => task.status === "completed" || task.id === completedTask.id);
  const description = buildStepDescription({
    workflow,
    step: nextStep,
    upstreamSection: buildUpstreamInputsSection(nextStep, workflow, completedRunTasks),
    returnSection: isReturnEdge ? buildReturnReasonSection(state.tasks[completedTask.id] ?? completedTask) : undefined,
  });
  const nextTask = await createWorkflowStepTask({
    workflow,
    step: nextStep,
    runId: context.runId,
    description,
    visitCounts,
  }, deps);
  if (!nextTask) {
    logger.error(`Workflow: failed to create follow-up task for run ${context.runId} of "${workflow.id}" (step ${nextStepKey})`);
    return undefined;
  }
  logger.info(
    `Workflow: run ${context.runId} of "${workflow.id}" routed step ${context.stepKey} -> ${nextStepKey} as task ${nextTask.id}`,
  );
  return nextTask;
}

function recordWorkflowRoutingEvent(
  taskId: string,
  deps: ControllerTaskDomainDeps,
  step: TeamProfileWorkflowStep,
  message: string,
): void {
  recordTaskExecutionEvent(taskId, {
    type: "lifecycle",
    phase: "workflow_step_routed",
    source: "controller",
    status: "running",
    message,
    role: step.role,
  }, deps);
}

// ---------------------------------------------------------------------------
// POST /api/v1/workflows/{id}/start - kick off a workflow run.
// ---------------------------------------------------------------------------

/**
 * Extracts the workflow id from /api/v1/workflows/{id}/start. Returns ""
 * for a malformed id (the route regex already guarantees the segment shape;
 * percent-decode failures degrade to "" -> the 404 path, never a 500).
 */
function workflowIdFromPathname(pathname: string): string {
  const match = pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/start$/);
  const raw = match?.[1];
  if (!raw) {
    return "";
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

export async function workflowStartRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps, pathname, currentState } = ctx;
  const { logger } = deps;

  // Transition matrix (design 2.3): starting a workflow spawns new work for
  // the outgoing team, same as POST /api/v1/tasks. The dispatch-layer gate
  // in http-server.ts enumerates the historical task-submission paths, so
  // this handler enforces the same 503 + Retry-After contract for its own
  // route (handler-level enforcement keeps the gate list untouched).
  if (currentState?.transition) {
    res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
    sendJson(res, 503, {
      error: `Team profile switch to "${currentState.transition.targetProfileId}" is in progress (phase: ${currentState.transition.phase}); workflow start is temporarily unavailable - retry after the switch completes`,
      retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
      transition: { phase: currentState.transition.phase, targetProfileId: currentState.transition.targetProfileId },
    });
    return;
  }

  const workflowId = workflowIdFromPathname(pathname);
  const workflows = getActiveWorkflows();
  const workflow = workflows.find((entry) => entry.id === workflowId);
  if (!workflow) {
    sendError(
      res,
      404,
      `unknown workflow "${workflowId || "<empty>"}" for the active profile (available: ${
        workflows.map((entry) => entry.id).sort().join(", ") || "none"
      })`,
    );
    return;
  }

  if (!deps.getTeamState()) {
    sendError(res, 503, "Team state not loaded");
    return;
  }

  const body = await parseJsonBody(req);
  if (body.context !== undefined && typeof body.context !== "string") {
    sendError(res, 400, "body field \"context\" must be a string when provided (initial business context for the first step)");
    return;
  }
  const initialContext = typeof body.context === "string" ? body.context.trim() : "";

  // Design 2.4 "按 steps 建任务链": the run starts at the FIRST declared
  // step (the numeric spine root), not at the lowest id - template order is
  // authoritative and load validation guarantees a non-empty steps array.
  const firstStep = workflow.steps[0]!;
  const runId = generateId();
  const description = buildStepDescription({
    workflow,
    step: firstStep,
    initialContext: initialContext || undefined,
    upstreamSection: buildUpstreamInputsSection(firstStep, workflow, []),
  });
  const task = await createWorkflowStepTask({
    workflow,
    step: firstStep,
    runId,
    description,
    visitCounts: { [stepKeyOf(firstStep.id)]: 1 },
  }, deps);
  if (!task) {
    sendError(res, 500, `failed to create the first task of workflow "${workflowId}"`);
    return;
  }
  logger.info(`Workflow: started run ${runId} of "${workflow.id}" at step ${stepKeyOf(firstStep.id)} (task ${task.id})`);
  sendJson(res, 201, {
    workflowId: workflow.id,
    workflowName: workflow.name,
    runId,
    stepCount: workflow.steps.length,
    step: { id: firstStep.id, role: firstStep.role, title: firstStep.title },
    task: serializeTask(task),
  });
}
