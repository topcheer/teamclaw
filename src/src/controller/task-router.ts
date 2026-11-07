import type { PluginLogger } from "../../api.js";
import type { TaskInfo, WorkerInfo } from "../types.js";
// Phase 1.3: role labels come from the active TeamProfile.
import { getActiveRole } from "../profile-loader.js";
// Phase 2.5: bilingual tiered token inference (design 2.3) is the fast path
// for unassigned tasks; it returns null when it refuses to decide (tie or
// all-zero), which falls through to the legacy keyword matcher below.
import { inferTaskRole } from "./role-inference.js";

export class TaskRouter {
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
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
    const inferredRole = inferTaskRole(task);
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

  autoAssignPendingTasks(
    tasks: Record<string, TaskInfo>,
    workers: Record<string, WorkerInfo>,
  ): Array<{ task: TaskInfo; worker: WorkerInfo }> {
    const pendingTasks = Object.values(tasks).filter(
      (t) => t.status === "pending" || t.status === "assigned",
    );

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
