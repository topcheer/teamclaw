// PR-C of issue #204 (http-server monolith split): the controller planning
// domain - manifest binding/backfill, fallback role+title heuristics,
// controller-managed task creation, supplemental human-context forwarding,
// follow-up/parallel-help message building, and delivery-report completion
// checks - extracted verbatim from controller/http-server.ts. Zero behavior
// change. This module must NEVER import http-server (the reverse edge
// exists: http-server -> controller-planning); the intake orchestration
// (controller-intake.ts) calls into these, never the other way round.
import type { PluginLogger } from "../../api.js";
import type {
  ControllerOrchestrationManifest,
  ControllerRunInfo,
  ControllerRunSource,
  PluginConfig,
  RoleId,
  TaskInfo,
  TaskPriority,
  TaskWorkflowContext,
  TeamMessage,
  TeamState,
  WorkerTaskResultContract,
} from "../types.js";
import { generateId } from "../protocol.js";
import { ensureTeamMessageContract } from "../interaction-contracts.js";
import {
  getActiveDefaultRole,
  getActiveRoles,
  normalizeRecommendedSkills,
  resolveActiveRoleSkills,
} from "../profile-loader.js";
import {
  deriveProjectSlug,
  deriveStableProjectKey,
} from "../openclaw-workspace.js";
import { generateDeliveryReport, isSessionComplete } from "./delivery-report.js";
import { refreshControllerRepoState } from "./repo-routes.js";
import {
  normalizeControllerIntakeSessionKey,
  recordTaskExecutionEvent,
  serializeTask,
} from "./task-execution.js";
import {
  appendControllerRunEvent,
  updateControllerRun,
} from "./controller-runs.js";
import { autoAssignPendingTasks } from "./task-assignment.js";
import {
  resolveProjectIdentityForSession,
  syncProjectRegistryEntry,
} from "./project-registry.js";
import { deliverMessageToWorker } from "./message-delivery.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

export function collectTaskIds(state: TeamState | null): Set<string> {
  return new Set(Object.keys(state?.tasks ?? {}));
}

export function normalizeControllerTaskMatchText(input: unknown): string {
  return typeof input === "string" ? input.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

export function taskMatchesManifestCreatedTask(
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

export function scoreControllerTaskBindingCandidate(task: TaskInfo): number {
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

export function reconcileControllerManifestTaskBindings(
  sessionKey: string,
  createdTaskIds: string[],
  manifest: ControllerOrchestrationManifest | undefined,
  controllerRunId: string,
  deps: ControllerTaskDomainDeps,
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

export function tagControllerCreatedTasks(
  taskIdsBeforeRun: Set<string>,
  controllerRunId: string,
  sessionKey: string,
  deps: ControllerTaskDomainDeps,
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

export function resolveControllerWorkflowSessionKey(task: TaskInfo, state: TeamState | null): string | undefined {
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

export function buildControllerManifestEventMessage(manifest: ControllerOrchestrationManifest): string {
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

export function buildControllerManifestReply(
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

export function summarizeManifestExpectedOutcome(task: TaskInfo): string {
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

export function inferManifestRolesFromText(text: string): RoleId[] {
  const normalized = text.toLowerCase();
  const roleIds: RoleId[] = [];
  for (const role of getActiveRoles()) {
    if (normalized.includes(role.id) || normalized.includes(role.label.toLowerCase())) {
      roleIds.push(role.id);
    }
  }
  return roleIds;
}

export function inferClarificationQuestionsFromReply(text: string): string[] {
  const candidates = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.includes("?"))
    .map((line) => line.replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  return Array.from(new Set(candidates)).slice(0, 5);
}

export function buildBackfilledControllerManifest(
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

export function looksLikeSoftwareRequirement(request: string): boolean {
  const normalized = request.toLowerCase();
  return /(api|backend|frontend|fastapi|react|vue|node|python|typescript|javascript|sql|database|service|app|web|mobile|docker|kubernetes|deploy|stderr|stdout|logging|logger|log file|config|yaml|json|cli|command|build|test|compile|bug|fix|output|file|repo|repository|code|测试|系统|平台|接口|服务|数据库|应用|前端|后端|日志|输出|文件|配置|命令|编译|构建|修复|代码|仓库)/.test(normalized);
}

export function looksLikeManualExecutionClarification(question: string): boolean {
  const normalized = question.toLowerCase();
  return /(请先|请运行|请执行|请重试|请重新编译|请复现|run\b|rerun\b|retry\b|rebuild\b|recompile\b|git pull\b|go build\b|npm test\b|pnpm test\b|yarn test\b|pytest\b|cargo test\b|是否仍然|does it still|still crash|still fail)/i.test(normalized);
}

export function extractExecutableFollowUpFromClarification(question: string): string | null {
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

export function isArchitectureFirstRequirement(request: string): boolean {
  const normalized = request.toLowerCase();
  return /(analy[sz]e|analysis|assess|feasibility|architecture|architect|design|plan|decompose|migration|port|rewrite|refactor|audit|review|repo|repository|codebase|golang|go\b|typescript|可行性|评估|架构|设计|分析|拆分|迁移|移植|重写|审计|仓库|代码库)/.test(normalized);
}

export function chooseFallbackAssignedRole(manifest: ControllerOrchestrationManifest, request: string): RoleId {
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

export function buildFallbackControllerTaskTitle(request: string, assignedRole?: RoleId): string {
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

export function looksLikeSupplementalHumanContextUpdate(request: string): boolean {
  const normalized = request.toLowerCase();
  const hasEndpointOrCredentialHint = /(apikey|api key|token|credential|endpoint|base url|provider|model list|models接口|连接信息|兼容接口|供应商|可用模型)/i.test(request);
  const urlCount = (request.match(/https?:\/\//gi) || []).length;
  const looksLikeFreshImplementationAsk = /(implement|build|create|write|develop|fix|refactor|design|架构|设计|实现|开发|修复|重构|创建)/i.test(normalized);
  return !looksLikeFreshImplementationAsk && (hasEndpointOrCredentialHint || urlCount >= 2);
}

export function getActiveTasksForSupplementalHumanContext(
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

export async function forwardSupplementalHumanContextToActiveTasks(
  controllerRunId: string,
  sessionKey: string,
  request: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerTaskDomainDeps,
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

export async function createControllerManagedTask(
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
    /**
     * Design 2.4 workflow-chain context: when present the task is a workflow
     * step task (createdBy "workflow") and the completion hook routes the
     * chain from it. Untouched for controller/other creators.
     */
    workflow?: TaskWorkflowContext;
  },
  deps: ControllerTaskDomainDeps,
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
    workflow: input.workflow,
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

export async function maybeBackfillExecutionReadyTask(
  controllerRunId: string,
  sessionKey: string,
  request: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerTaskDomainDeps,
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

export function ensureControllerManifest(
  controllerRunId: string,
  sessionKey: string,
  request: string,
  rawReply: string,
  createdTaskIds: string[],
  deps: ControllerTaskDomainDeps,
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

export function buildControllerFollowUpMessage(task: TaskInfo, state: TeamState | null): string {
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

export function buildControllerParallelHelpMessage(
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

export async function maybeConvertControllerClarificationToExecutionTask(
  controllerRunId: string,
  sessionKey: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerTaskDomainDeps,
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

export async function checkAndGenerateReport(task: TaskInfo, deps: ControllerTaskDomainDeps): Promise<void> {
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

export function buildResultContractSection(task: TaskInfo): string {
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
