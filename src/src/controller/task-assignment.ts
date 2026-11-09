// PR-C of issue #204 (http-server monolith split): the task assignment
// pipeline (assignment context builders, worker dispatch, revert, and the
// issue-#191 gated auto-assign loop) extracted verbatim from
// controller/http-server.ts. Zero behavior change - callers pass the same
// deps object as before. This module must NEVER import http-server (the
// reverse edge exists: http-server -> task-assignment); autoAssignPendingTasks
// stays exported because controller-service.ts triggers it after startup
// reconciliation.
import fs from "node:fs";
import path from "node:path";
import type { PluginLogger } from "../../api.js";
import type {
  PluginConfig,
  RepoSyncInfo,
  RoleId,
  TaskAssignmentPayload,
  TaskExecutionEvent,
  TaskInfo,
  TeamState,
  WorkerInfo,
} from "../types.js";
import { getActiveRoles, resolveActiveRoleSkills } from "../profile-loader.js";
import { buildRepoSyncInfo } from "../git-collaboration.js";
import {
  buildTeamClawProjectWorkspacePath,
  resolveTeamClawProjectsDir,
  resolveTeamClawWorkspaceDir,
} from "../openclaw-workspace.js";
import { refreshControllerRepoState } from "./repo-routes.js";
import {
  appendTaskExecutionEvent,
  broadcastTaskExecutionEvent,
  buildTaskExecutionIdentity,
  normalizeControllerIntakeSessionKey,
  recordTaskExecutionEvent,
  resetTaskForFreshAttempt,
  serializeTask,
  withWorkerDispatchToken,
} from "./task-execution.js";
import type { TaskRouter } from "./task-router.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

const MAX_RECENT_TASK_CONTEXT = 3;
const MAX_TASK_CONTEXT_SUMMARY_CHARS = 500;

export function summarizeTaskForAssignment(task: TaskInfo): string {
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

export function buildRecentCompletedTaskContext(task: TaskInfo, state: TeamState | null): string {
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

export function buildRecommendedSkillsContext(task: TaskInfo): string {
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

export function buildTaskContextSnapshot(task: TaskInfo, state: TeamState | null): TaskAssignmentPayload["teamContext"] | undefined {
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

export function buildTaskAssignmentDescription(task: TaskInfo, state: TeamState | null, repoInfo?: RepoSyncInfo): string {
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

export function buildProjectDirectoryContext(projectDir?: string): string | null {
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

export function buildRepoTaskContext(repoInfo: RepoSyncInfo): string {
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

export function scheduleProvisioningReconcile(deps: ControllerTaskDomainDeps, reason: string): void {
  void deps.workerProvisioningManager?.requestReconcile(reason);
}

/** Collaboration contract helpers: at most ONE active write task per repo checkout. */
export function taskWriteRoot(task: TaskInfo): string | null {
  if (task.writeMode === "read-only" || !task.projectDir) { return null; }
  return task.projectDir.split("__task-")[0] ?? task.projectDir;
}

export function activeWriteRoots(state: TeamState): Set<string> {
  const roots = new Set<string>();
  for (const t of Object.values(state.tasks)) {
    if (t.status !== "assigned" && t.status !== "in_progress") { continue; }
    const root = taskWriteRoot(t);
    if (root) { roots.add(root); }
  }
  return roots;
}

export function buildConsolidatedPatternsContext(): string {
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

export function revertTaskAssignment(taskId: string, workerId: string, deps: ControllerTaskDomainDeps): TaskInfo | undefined {
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

export async function dispatchTaskToWorker(
  taskId: string,
  worker: WorkerInfo,
  deps: ControllerTaskDomainDeps,
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

  // Issue #222: carry the worker's dispatch token (provisioning-record
  // launchToken, else the synced securityToken) so a token-paired worker
  // accepts the assignment; L0 sends the historical header set unchanged.
  const res = await fetch(`${worker.url}/api/v1/tasks/assign`, {
    method: "POST",
    headers: withWorkerDispatchToken({ "Content-Type": "application/json" }, worker.id, deps.config, state ?? null),
    body: JSON.stringify(assignment),
  });

  if (!res.ok) {
    throw new Error(`worker ${worker.id} responded with ${res.status}`);
  }
}

export async function assignTaskToWorker(
  taskId: string,
  worker: WorkerInfo,
  deps: ControllerTaskDomainDeps,
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

// ── Issue #191: auto-assign re-entrancy gate ─────────────────────────────────
//
// revertTaskAssignment (dispatch failure path) fires a nested
// `void autoAssignPendingTasks(deps)`. Before the gate, each nested call ran
// concurrently with its OWN attemptedPairs set: it re-attempted the pair that
// had just failed, reverted again, and spawned another nested round - with
// unreachable workers the retry tree grew 2^n dispatch attempts (observed as
// a 4GB OOM). The gate keeps ONE round in flight per controller deps and
// defers nested triggers to a single follow-up round that SHARES the failed
// pairs, collapsing the storm to linear work. Keyed weakly on the deps object
// so separate controller instances (and separate test scenarios) never share
// gate state.
type AutoAssignGate = {
  inFlight: boolean;
  /** Follow-up round queued by a nested trigger; carries that trigger's preferredWorkerId hint. */
  rerunQueued: { preferredWorkerId: string | undefined } | null;
  attemptedPairs: Set<string>;
};

const autoAssignGates = new WeakMap<ControllerTaskDomainDeps, AutoAssignGate>();

export function getAutoAssignGate(deps: ControllerTaskDomainDeps): AutoAssignGate {
  let gate = autoAssignGates.get(deps);
  if (!gate) {
    gate = { inFlight: false, rerunQueued: null, attemptedPairs: new Set() };
    autoAssignGates.set(deps, gate);
  }
  return gate;
}

export async function autoAssignPendingTasks(
  deps: ControllerTaskDomainDeps,
  preferredWorkerId?: string,
): Promise<TaskInfo[]> {
  const gate = getAutoAssignGate(deps);
  if (gate.inFlight) {
    // Nested trigger (revert path, concurrent register/heartbeat, ...):
    // never start a parallel round. Queue exactly one follow-up; it re-reads
    // the live state, so nothing observable is lost - only the storm is.
    // The follow-up carries the nested trigger's preferredWorkerId hint
    // (worker register/heartbeat triggers pass theirs; it only biases which
    // candidate is attempted first). A later id-less trigger (revert path)
    // must not erase a hint that is already queued; a later trigger WITH an
    // id wins as the most recent signal about where capacity appeared.
    if (gate.rerunQueued) {
      if (preferredWorkerId !== undefined) {
        gate.rerunQueued.preferredWorkerId = preferredWorkerId;
      }
    } else {
      gate.rerunQueued = { preferredWorkerId };
    }
    return [];
  }
  gate.inFlight = true;
  try {
    return await runAutoAssignRound(deps, preferredWorkerId, gate.attemptedPairs);
  } finally {
    gate.inFlight = false;
    if (gate.rerunQueued) {
      const rerun = gate.rerunQueued;
      gate.rerunQueued = null;
      void autoAssignPendingTasks(deps, rerun.preferredWorkerId).catch(() => {
        // Best-effort follow-up round; assignment failures already surface
        // via task state (same policy as the fire-and-forget call sites).
      });
    } else {
      // The round settled with no deferred work: forget the attempted (and
      // possibly failed) pairs so future rounds may try them again - e.g.
      // after an unreachable worker recovers or a new task is submitted.
      gate.attemptedPairs.clear();
    }
  }
}

export async function runAutoAssignRound(
  deps: ControllerTaskDomainDeps,
  preferredWorkerId: string | undefined,
  attemptedPairs: Set<string>,
): Promise<TaskInfo[]> {
  const { getTeamState, taskRouter, wsServer, logger, config } = deps;
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
    // Phase 2.5 wiring: the router is async because unconfident tasks may
    // first escalate to the injected LLM role judge (cached per task).
    const candidateAssignments = (await taskRouter
      .autoAssignPendingTasks(state.tasks, state.workers))
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
