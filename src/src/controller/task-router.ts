import type { PluginLogger } from "../../api.js";
import type { RoleId, TaskInfo, WorkerInfo } from "../types.js";
// Phase 1.3: role labels come from the active TeamProfile.
import { getActiveRole } from "../profile-loader.js";
// Phase 2.5: bilingual tiered token inference (design 2.3) is the fast path
// for unassigned tasks; it returns null when it refuses to decide (tie or
// all-zero), which falls through to the legacy keyword matcher below.
import { inferTaskRole } from "./role-inference.js";
// Phase 2.5 wiring (design 2.3 "LLM 兜底", P2.5 follow-up): tasks the token
// fast path refuses to decide escalate to resolveTaskRoleWithLlmFallback
// (kickoff-orchestrator seam). The llmRoleJudge callback is injected by the
// controller assembly (controller-service wires it to the real controller
// LLM session; tests inject fakes) so this module stays free of LLM/runtime
// knowledge. Without a judge the escalation is skipped and unconfident tasks
// keep the legacy capability-matcher path - byte-for-byte the pre-wiring
// behavior (e.g. runtimes without an LLM subagent).
import { resolveTaskRoleWithLlmFallback, type TaskRoleResolutionDeps } from "./kickoff-orchestrator.js";

export type TaskRouterOptions = {
  /**
   * Phase 2.5 wiring: LLM judge for tasks the token fast path refuses to
   * decide. The resolver validates the judge's answer against the ACTIVE
   * profile and degrades to the profile defaultRole on failure/invalid
   * answers; this router treats the outcome as a routing HINT exactly like a
   * confident inference (degrade to the legacy matcher when the role has no
   * idle worker - never strand the task).
   */
  llmRoleJudge?: TaskRoleResolutionDeps["llmRoleJudge"];
};

export class TaskRouter {
  private logger: PluginLogger;
  private readonly llmRoleJudge?: TaskRoleResolutionDeps["llmRoleJudge"];
  /**
   * LLM-judged role per task id, written at most once per task per process
   * so a pending unconfident task never triggers repeat LLM calls across
   * dispatch rounds. Pruned when the task disappears from state.
   */
  private readonly judgedRoles = new Map<string, RoleId>();

  constructor(logger: PluginLogger, options?: TaskRouterOptions) {
    this.logger = logger;
    this.llmRoleJudge = options?.llmRoleJudge;
  }

  routeTask(
    task: TaskInfo,
    workers: Record<string, WorkerInfo>,
  ): WorkerInfo | null {
    // First try exact role match with idle workers
    if (task.assignedRole) {
      const candidates = Object.values(workers).filter(
        (w) => w.role === task.assignedRole && w.status === "idle",
      );
      if (candidates.length > 0) {
        return candidates[0]!;
      }

      this.logger.info(
        `TaskRouter: no idle worker for explicitly assigned role ${task.assignedRole} on task ${task.id}; keeping task pending`,
      );
      return null;
    }

    // Phase 2.5 fast path: tiered bilingual token inference over the active
    // profile's roles. A confident pick routes to that role's idle workers;
    // when the inferred role has no idle worker we degrade to the legacy
    // matcher instead of stranding the task (inference is a hint, the
    // explicit assignedRole branch above is the decision that must wait).
    // Phase 2.5 wiring: an LLM-judged role (cached from a previous dispatch
    // round) fills in when the token fast path refuses to decide, with the
    // same hint semantics as a confident inference.
    const inferredRole = inferTaskRole(task) ?? this.judgedRoles.get(task.id);
    if (inferredRole) {
      const inferredCandidates = Object.values(workers).filter(
        (w) => w.role === inferredRole && w.status === "idle",
      );
      if (inferredCandidates.length > 0) {
        return inferredCandidates[0]!;
      }
      this.logger.info(
        `TaskRouter: inferred role ${inferredRole} has no idle worker on task ${task.id}; trying capability matching`,
      );
    }

    // Try keyword matching on capabilities
    const keywords = this.extractKeywords(task.description + " " + task.title);
    const scored = Object.values(workers)
      .filter((w) => w.status === "idle")
      .map((w) => {
        const roleDef = getActiveRole(w.role);
        const capabilities = roleDef?.capabilities ?? [];
        const matchCount = keywords.filter((k) =>
          capabilities.some((c) => c.includes(k) || k.includes(c)),
        ).length;
        return { worker: w, score: matchCount };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      return scored[0]!.worker;
    }

    // Fallback: any idle worker
    const anyIdle = Object.values(workers).find((w) => w.status === "idle");
    if (anyIdle) {
      return anyIdle;
    }

    return null;
  }

  async autoAssignPendingTasks(
    tasks: Record<string, TaskInfo>,
    workers: Record<string, WorkerInfo>,
  ): Promise<Array<{ task: TaskInfo; worker: WorkerInfo }>> {
    const pendingTasks = Object.values(tasks).filter(
      (t) => t.status === "pending" || t.status === "assigned",
    );

    this.pruneJudgedRoles(tasks);

    // Phase 2.5 wiring: escalate unassigned tasks the token fast path refuses
    // to decide to the LLM judge, once per task (results cached above the
    // routing call). The resolver degrades to the profile defaultRole when
    // the judge fails, times out, or answers with a role outside the active
    // profile. Skipped entirely when no judge is wired - pre-wiring behavior.
    if (this.llmRoleJudge) {
      await Promise.all(pendingTasks
        .filter((task) =>
          !task.assignedRole
          && !this.judgedRoles.has(task.id)
          && inferTaskRole(task) === null)
        .map(async (task) => {
          try {
            const resolved = await resolveTaskRoleWithLlmFallback(task, {
              llmRoleJudge: this.llmRoleJudge,
              logger: this.logger,
            });
            this.judgedRoles.set(task.id, resolved);
          } catch (err) {
            this.logger.warn(
              `TaskRouter: LLM role judge threw for task ${task.id} (${err instanceof Error ? err.message : String(err)}); keeping legacy routing for it`,
            );
          }
        }));
    }

    const assignments: Array<{ task: TaskInfo; worker: WorkerInfo }> = [];

    for (const task of pendingTasks) {
      if (task.assignedWorkerId && workers[task.assignedWorkerId]) {
        continue; // Already assigned to a valid worker
      }

      const worker = this.routeTask(task, workers);
      if (worker) {
        assignments.push({ task, worker });
      }
    }

    return assignments;
  }

  /** Drop judged-role cache entries for tasks that no longer exist in state. */
  private pruneJudgedRoles(tasks: Record<string, TaskInfo>): void {
    for (const taskId of this.judgedRoles.keys()) {
      if (!tasks[taskId]) {
        this.judgedRoles.delete(taskId);
      }
    }
  }

  private extractKeywords(text: string): string[] {
    const common = new Set([
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
      "of", "with", "by", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "shall", "can", "this", "that",
      "these", "those", "it", "its", "we", "our", "you", "your", "they",
      "their", "create", "implement", "build", "make", "add", "update", "fix",
    ]);
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !common.has(w));
  }
}
