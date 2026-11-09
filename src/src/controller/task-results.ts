// PR-C of issue #204 (http-server monolith split): the task result domain -
// result application (worker release, managed-worker retirement, workflow
// continuation), stale-deliverable filtering, filesystem HTML enrichment,
// the meaningful-project-change completion gate, result-contract
// backfill/effective-contract synthesis, and discovered-patterns
// consolidation - extracted verbatim from controller/http-server.ts. Zero
// behavior change. This module must NEVER import http-server (the reverse
// edge exists: http-server -> task-results).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PluginLogger } from "../../api.js";
import type {
  TaskExecutionEvent,
  TaskInfo,
  TeamState,
  WorkerTaskResultContract,
  WorkerTaskResultDeliverable,
} from "../types.js";
import {
  backfillWorkerTaskResultContract,
  enrichDeliverablesWithPreviewInference,
} from "../interaction-contracts.js";
import {
  resolveTeamClawAgentWorkspaceRootDir,
  resolveTeamClawProjectsDir,
  resolveTeamClawWorkspaceDir,
} from "../openclaw-workspace.js";
import {
  appendTaskExecutionEvent,
  broadcastTaskExecutionEvent,
  recordTaskExecutionEvent,
  serializeTask,
} from "./task-execution.js";
import { autoAssignPendingTasks, scheduleProvisioningReconcile } from "./task-assignment.js";
import { checkAndGenerateReport } from "./controller-planning.js";
import { continueControllerWorkflow } from "./controller-intake.js";
// Design 2.4 workflow-chain routing: tasks carrying TaskInfo.workflow route
// their follow-up step deterministically from the template's conclusion
// branches (they are createdBy "workflow", so the generic controller LLM
// follow-up below never fires for them - the two continuations are disjoint).
import { continueWorkflowAfterTaskCompletion } from "./workflow-routes.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

/**
 * Filter deliverables that don't belong to the current task's project directory.
 * This prevents cross-project contamination when the model references stale files
 * from previous sessions visible in the shared workspace.
 */
export function filterStaleDeliverables(
  contract: WorkerTaskResultContract,
  taskProjectDir: string | undefined,
): WorkerTaskResultContract {
  if (!taskProjectDir) return contract;
  // Normalize: "projects/foo-bar/" → "projects/foo-bar"
  const normalizedDir = taskProjectDir.replace(/\/$/u, "");
  const filtered = contract.deliverables.filter((d) => {
    const val = (d.value ?? "").replace(/\/$/u, "");
    if (!val) return true; // keep notes/commands without paths
    if (d.kind === "note" || d.kind === "command") return true;
    // Accept deliverables whose path contains the projectDir or is rooted in teamclaw/projects/{projectDir}
    if (val.includes(normalizedDir)) return true;
    // Accept relative paths that look like project-internal (no slashes or relative)
    if (!val.includes("/") || val.startsWith("./")) return true;
    // Reject paths from other project directories
    return false;
  });
  if (filtered.length === contract.deliverables.length) return contract;
  return { ...contract, deliverables: filtered };
}

/**
 * Strategy 4: When text-based enrichment found no HTML file references,
 * scan the workspace filesystem for HTML files and create a web-app deliverable.
 * This handles workers that return abstract summaries without mentioning specific paths.
 */
export function enrichWithFilesystemHtmlScan(
  contract: WorkerTaskResultContract,
  taskProjectDir?: string,
): WorkerTaskResultContract | null {
  const existingWebApp = contract.deliverables.find((d) => d.artifactType === "web-app");
  if (existingWebApp) {
    const cwd = existingWebApp.previewCwd?.trim();
    if (cwd && cwd !== "." && cwd !== "./") {
      return null;
    }
    // Fall through — existing web-app has root previewCwd, try to improve it
  }

  let workspaceDir: string;
  let openclawWorkspaceDir: string;
  try {
    workspaceDir = resolveTeamClawWorkspaceDir();
    openclawWorkspaceDir = resolveTeamClawAgentWorkspaceRootDir();
  } catch {
    return null;
  }

  // Recursively scan the workspace for HTML files (up to 3 levels deep)
  const MAX_DEPTH = 3;
  const htmlCandidates: { dirPath: string; filename: string }[] = [];

  function scanDir(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, depth + 1);
      } else if (entry.isFile() && (entry.name.endsWith(".html") || entry.name.endsWith(".htm"))) {
        if (!entry.name.includes(".config.") && !entry.name.includes(".test.") && !entry.name.includes(".spec.")) {
          htmlCandidates.push({ dirPath: dir, filename: entry.name });
        }
      }
    }
  }

  // Scope scan to the task's project directory when available to avoid
  // picking up stale HTML from unrelated projects.
  const scanRoot = taskProjectDir
    ? path.join(workspaceDir, taskProjectDir)
    : workspaceDir;
  if (taskProjectDir && !fs.existsSync(scanRoot)) {
    return null;
  }
  scanDir(scanRoot, 0);

  if (htmlCandidates.length === 0) {
    return null;
  }

  // Use OpenClaw workspace root as base for relative paths (worker paths and
  // preview manager both resolve relative to the OpenClaw workspace, not the
  // TeamClaw subdirectory).
  const candidate = htmlCandidates[0];
  const relativeDir = path.relative(openclawWorkspaceDir, candidate.dirPath) || ".";
  const normalizedDir = relativeDir.replace(/\\/gu, "/");

  // Avoid adding a duplicate if a directory deliverable for this path already exists
  const existingDir = contract.deliverables.find(
    (d) => d.kind === "directory" && d.value.replace(/\\/gu, "/").replace(/\/$/u, "") === normalizedDir,
  );
  if (existingDir && existingDir.artifactType === "web-app" && existingWebApp?.previewCwd?.trim() !== ".") {
    // Existing web-app already has a specific, non-root directory — leave it alone.
    return null;
  }

  const newDeliverable: WorkerTaskResultDeliverable = {
    kind: "directory",
    value: normalizedDir,
    summary: `Web application at ${normalizedDir}`,
    artifactType: "web-app",
    previewCommand: "npx -y serve -l {PORT}",
    previewCwd: normalizedDir,
    previewReadyPath: "/",
  };

  const newDeliverables = [...contract.deliverables];
  if (existingDir) {
    // Update existing directory deliverable with web-app fields
    const idx = newDeliverables.indexOf(existingDir);
    // Always take the filesystem scan's directory path, which is more specific
    newDeliverables[idx] = { ...existingDir, ...newDeliverable };
  } else {
    newDeliverables.push(newDeliverable);
  }

  return { ...contract, deliverables: newDeliverables };
}

const MEANINGFUL_PROJECT_CHANGE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".html", ".css", ".scss", ".md", ".txt", ".yml", ".yaml",
  ".go", ".mod", ".sum", ".py", ".rb", ".rs", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".sh", ".bash", ".zsh", ".sql", ".toml", ".ini",
]);

const IGNORED_PROJECT_CHANGE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", "tmp", "temp",
]);

const IGNORED_PROJECT_CHANGE_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);

export function taskRequiresMeaningfulProjectChangeGate(task: TaskInfo): boolean {
  if (task.assignedRole !== "developer" || !task.projectDir) {
    return false;
  }
  const text = `${task.title}\n${task.description}`.toLowerCase();
  if (/\b(qa|audit|review|verify|verification|validate|test|retest|confirm|check)\b/u.test(text)) {
    return false;
  }
  if (/(审计|审核|验证|复检|复查|确认|测试|检查)/u.test(text)) {
    return false;
  }
  return /\b(implement|build|fix|rework|update|add|enhanc|deliver|write|create)\b/u.test(text);
}

export function projectHasMeaningfulDeliverableEvidence(
  task: TaskInfo,
  contract: WorkerTaskResultContract | undefined,
): boolean {
  if (!task.projectDir || !contract) {
    return false;
  }
  const projectRoot = path.join(resolveTeamClawProjectsDir(), task.projectDir);
  for (const deliverable of contract.deliverables) {
    if (deliverable.kind !== "file" && deliverable.kind !== "directory") {
      continue;
    }
    const rawValue = deliverable.value.trim().replace(/\\/g, "/");
    if (!rawValue) {
      continue;
    }
    const normalizedValue = rawValue.startsWith("projects/")
      ? rawValue.slice("projects/".length)
      : rawValue;
    if (
      normalizedValue !== task.projectDir
      && !normalizedValue.startsWith(`${task.projectDir}/`)
    ) {
      continue;
    }
    const relativePath = normalizedValue === task.projectDir
      ? ""
      : normalizedValue.slice(task.projectDir.length + 1);
    const fullPath = relativePath ? path.join(projectRoot, relativePath) : projectRoot;
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isFile()) {
        return true;
      }
      if (stats.isDirectory()) {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        if (entries.some((entry) => entry.isFile() || entry.isDirectory())) {
          return true;
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function projectHasMeaningfulFileChanges(
  task: TaskInfo,
  contract?: WorkerTaskResultContract,
): boolean {
  if (!task.projectDir) {
    return false;
  }
  const projectRoot = path.join(resolveTeamClawProjectsDir(), task.projectDir);
  if (!fs.existsSync(projectRoot)) {
    return false;
  }
  // Collaboration contract: write tasks deliver in a dedicated worktree.
  // An mtime scan is the wrong test there (committed files keep old mtimes
  // and the gate may run before the flush) - ask git instead: does HEAD carry
  // commits beyond the remote refs?
  if (task.projectDir.includes("__task-")) {
    try {
      const out = execFileSync("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: projectRoot }).toString();
      return Number(out.trim()) > 0;
    } catch {
      return false;
    }
  }
  const threshold = Math.max(task.startedAt ?? 0, task.createdAt ?? 0) - 1000;
  const stack = [projectRoot];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_CHANGE_DIRS.has(entry.name)) {
          stack.push(path.join(currentDir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (IGNORED_PROJECT_CHANGE_FILES.has(entry.name)) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!MEANINGFUL_PROJECT_CHANGE_EXTENSIONS.has(ext)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs >= threshold) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return projectHasMeaningfulDeliverableEvidence(task, contract);
}

export function allowsNoChangeCompletion(
  task: TaskInfo,
  contract: WorkerTaskResultContract | undefined,
  resultText: string,
): boolean {
  const taskText = `${task.title}\n${task.description}`.toLowerCase();
  const evidenceText = [
    contract?.summary ?? "",
    contract?.notes ?? "",
    ...(contract?.keyPoints ?? []),
    resultText,
  ].join("\n").toLowerCase();
  const hasVerificationEvidence =
    (contract?.deliverables ?? []).some((deliverable) => deliverable.kind === "command" || deliverable.kind === "note")
    || /\b(go test|go vet|npm test|pnpm test|yarn test|pytest|cargo test|verified|verification|passes|all tests pass|no remaining)\b/u.test(evidenceText);
  const noChangeIsExpected =
    /\b(qa|audit|review|verify|verification|validate|test|retest|confirm|check)\b/u.test(taskText)
    || /(审计|审核|验证|复检|复查|确认|测试|检查)/u.test(taskText)
    || /\b(already fixed|already resolved|no further changes|no code changes|no file changes|no additional changes|verified existing fix)\b/u.test(evidenceText)
    || /(已修复|已解决|无需改动|无需修改|没有额外修改|无需额外变更|只需验证)/u.test(evidenceText);
  return hasVerificationEvidence && noChangeIsExpected;
}

export function applyTaskResult(
  taskId: string,
  result: string,
  error: string | undefined,
  deps: ControllerTaskDomainDeps,
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
    // Re-enrich deliverables now that the full result text is available.
    if (!error && task.resultContract) {
      // Filter out stale deliverables from other projects first
      task.resultContract = filterStaleDeliverables(task.resultContract, task.projectDir);
      let enriched = enrichDeliverablesWithPreviewInference(task.resultContract, result);
      if (!enriched) {
        // Text-based enrichment failed — scan the workspace filesystem for HTML files.
        enriched = enrichWithFilesystemHtmlScan(task.resultContract, task.projectDir);
      }
      if (enriched) {
        task.resultContract = enriched;
      }
    }
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
    if (!error && updatedTask.workflow) {
      void continueWorkflowAfterTaskCompletion(updatedTask, deps).catch((err) => {
        logger.warn(
          `Controller: failed to continue workflow chain after ${taskId}: ${String(err)}`,
        );
      });
    }
    if (!error && updatedTask.createdBy === "controller") {
      void continueControllerWorkflow(updatedTask, deps).catch((err) => {
        logger.warn(
          `Controller: failed to continue intake workflow after ${taskId}: ${String(err)}`,
        );
      }).finally(() => {
        // After the follow-up run completes (or if there was none), check session completion.
        void checkAndGenerateReport(updatedTask, deps).catch(() => {});
      });
    } else if (updatedTask.controllerSessionKey) {
      // Non-controller tasks or failed tasks — still check session completion.
      void checkAndGenerateReport(updatedTask, deps).catch(() => {});
    }
  }

  return updatedTask;
}

export function ensureTaskResultContract(
  taskId: string,
  result: string,
  error: string | undefined,
  deps: ControllerTaskDomainDeps,
): WorkerTaskResultContract | undefined {
  const state = deps.getTeamState();
  const currentTask = state?.tasks[taskId];
  if (!currentTask) {
    return undefined;
  }
  if (currentTask.resultContract) {
    // Worker submitted a structured contract — but it may be missing preview
    // fields (artifactType, previewCommand, etc.). Enrich deliverables
    // so the PreviewManager can auto-launch previews.
    let enriched = enrichDeliverablesWithPreviewInference(currentTask.resultContract, result);
    if (!enriched) {
      // Text-based enrichment failed — scan the workspace filesystem for HTML files.
      enriched = enrichWithFilesystemHtmlScan(currentTask.resultContract, currentTask.projectDir);
    }
    if (enriched) {
      deps.updateTeamState((teamState) => {
        const task = teamState.tasks[taskId];
        if (task) {
          task.resultContract = enriched;
          task.updatedAt = Date.now();
        }
      });
      return enriched;
    }
    return currentTask.resultContract;
  }

  let contract = backfillWorkerTaskResultContract(currentTask, result, error);
  if (!error) {
    const enriched = enrichDeliverablesWithPreviewInference(contract, result)
      ?? enrichWithFilesystemHtmlScan(contract, currentTask.projectDir);
    if (enriched) {
      contract = enriched;
    }
  }
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

export function buildEffectiveTaskResultContract(
  task: TaskInfo,
  result: string,
  error: string | undefined,
  submittedContract?: WorkerTaskResultContract,
): WorkerTaskResultContract {
  let contract = submittedContract
    ? filterStaleDeliverables(submittedContract, task.projectDir)
    : backfillWorkerTaskResultContract(task, result, error);
  if (!error) {
    const enriched = enrichDeliverablesWithPreviewInference(contract, result)
      ?? enrichWithFilesystemHtmlScan(contract, task.projectDir);
    if (enriched) {
      contract = enriched;
    }
  }
  return contract;
}

const MAX_PATTERNS_FILE_BYTES = 64 * 1024;

export function consolidateDiscoveredPatterns(
  contract: WorkerTaskResultContract,
  taskId: string,
  role: string | undefined,
  logger: PluginLogger,
): void {
  const patterns = contract.discoveredPatterns;
  if (!patterns || patterns.length === 0) {
    return;
  }
  try {
    const workspaceDir = resolveTeamClawWorkspaceDir();
    const patternsFile = path.join(workspaceDir, "memory", "patterns.md");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });

    let currentSize = 0;
    try {
      currentSize = fs.statSync(patternsFile).size;
    } catch {
      // File doesn't exist yet; will be created by append.
    }
    if (currentSize > MAX_PATTERNS_FILE_BYTES) {
      logger.info(`Controller: patterns.md already ${currentSize} bytes, skipping consolidation for ${taskId}`);
      return;
    }

    const roleLabel = role ?? "unknown";
    const timestamp = new Date().toISOString().slice(0, 10);
    const section = [
      "",
      `## ${timestamp} — ${taskId} (${roleLabel})`,
      ...patterns.map((p) => `- ${p}`),
    ].join("\n") + "\n";

    fs.appendFileSync(patternsFile, section, "utf8");
    logger.info(`Controller: consolidated ${patterns.length} pattern(s) from ${taskId} into patterns.md`);
  } catch (err) {
    logger.warn(`Controller: failed to consolidate patterns for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
