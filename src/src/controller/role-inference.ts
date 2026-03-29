import { ROLES } from "../roles.js";
import type { RoleId, TaskInfo } from "../types.js";

/**
 * Infer the most appropriate role for a task based on text analysis.
 *
 * If `task.assignedRole` is already set, returns it directly.
 * Otherwise, tokenizes the task title + description and scores each known
 * role by overlap with its id, label, and capabilities.
 */
export function inferTaskRole(task: Pick<TaskInfo, "assignedRole" | "title" | "description">): RoleId | null {
  if (task.assignedRole) {
    return task.assignedRole;
  }

  const text = `${task.title} ${task.description}`.toLowerCase();
  let bestRole: RoleId | null = null;
  let bestScore = 0;

  for (const role of ROLES) {
    const roleTokens = [
      role.id,
      role.label,
      ...role.capabilities,
    ].flatMap((entry) => entry.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
    const uniqueTokens = [...new Set(roleTokens)];
    const score = uniqueTokens.reduce((count, token) => count + (text.includes(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestRole = role.id;
    }
  }

  return bestScore > 0 ? bestRole : null;
}

/**
 * Fallback role when inference produces no match.
 * The developer role is the most versatile generalist.
 */
export const FALLBACK_ROLE: RoleId = "developer";
