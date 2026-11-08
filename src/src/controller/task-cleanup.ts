// PR-C of issue #204 (http-server monolith split): the task/run/project
// cascade cleanup family extracted verbatim from controller/http-server.ts.
// Zero behavior change - callers pass the same deps object as before. This
// module must NEVER import http-server (the reverse edge exists:
// http-server -> task-cleanup); workspace git tracking and preview teardown
// arrive through direct peer imports and the deps slice below.
import fs from "node:fs";
import path from "node:path";
import type { PluginLogger } from "../../api.js";
import type {
  ControllerRunInfo,
  PluginConfig,
  TaskInfo,
  TeamMessage,
  TeamState,
} from "../types.js";
import { removeTrackedWorkspaceSubtree } from "../git-collaboration.js";
import { resolveTeamClawProjectsDir } from "../openclaw-workspace.js";
import { cancelTaskExecution, normalizeControllerIntakeSessionKey } from "./task-execution.js";
import { findProjectRecordByDir } from "./project-registry.js";
import type { PreviewManager } from "./preview-manager.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

type TaskCleanupSummary = {
  deletedTaskIds: string[];
  deletedClarificationIds: string[];
  deletedMessageIds: string[];
  stoppedPreviewIds: string[];
  deletedReportIds: string[];
  deletedProjectDirs: string[];
};

export function buildEmptyTaskCleanupSummary(): TaskCleanupSummary {
  return {
    deletedTaskIds: [],
    deletedClarificationIds: [],
    deletedMessageIds: [],
    stoppedPreviewIds: [],
    deletedReportIds: [],
    deletedProjectDirs: [],
  };
}

export function resolveSafeProjectDirectory(projectDir: string | undefined): string | null {
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

export async function deleteProjectDirectoryIfUnused(
  projectDir: string | undefined,
  deps: ControllerTaskDomainDeps,
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

export function isTaskTerminalForCleanup(task: TaskInfo | undefined): boolean {
  if (!task) {
    return true;
  }
  return task.status === "completed" || task.status === "failed";
}

export function canAutoDeleteStaleControllerRun(
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

export async function pruneStaleControllerRuns(
  deps: ControllerTaskDomainDeps,
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

export async function deleteProjectCascade(
  projectDir: string,
  deps: ControllerTaskDomainDeps,
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

export async function deleteTaskCascade(
  taskId: string,
  deps: ControllerTaskDomainDeps,
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

export async function deleteControllerRunCascade(
  runId: string,
  deps: ControllerTaskDomainDeps,
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
