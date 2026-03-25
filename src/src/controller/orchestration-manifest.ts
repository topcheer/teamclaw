import type {
  ControllerManifestCreatedTask,
  ControllerManifestDeferredTask,
  ControllerOrchestrationManifest,
  RoleId,
} from "../types.js";

const TEAMCLAW_ROLE_IDS = new Set<RoleId>([
  "pm",
  "architect",
  "developer",
  "qa",
  "release-engineer",
  "infra-engineer",
  "devops",
  "security-engineer",
  "designer",
  "marketing",
]);

export function normalizeManifestRoleList(raw: unknown): RoleId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const roleIds: RoleId[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim() as RoleId;
    if (!normalized || !TEAMCLAW_ROLE_IDS.has(normalized) || roleIds.includes(normalized)) {
      continue;
    }
    roleIds.push(normalized);
  }
  return roleIds;
}

export function normalizeManifestStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

export function normalizeOptionalManifestText(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim();
  return normalized || undefined;
}

export function normalizeManifestCreatedTasks(raw: unknown): ControllerManifestCreatedTask[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      assignedRole: normalizeManifestRoleList([entry.assignedRole])[0],
      expectedOutcome: typeof entry.expectedOutcome === "string" ? entry.expectedOutcome.trim() : "",
    }))
    .filter((entry) => entry.title && entry.expectedOutcome);
}

export function normalizeManifestDeferredTasks(raw: unknown): ControllerManifestDeferredTask[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      assignedRole: normalizeManifestRoleList([entry.assignedRole])[0],
      blockedBy: typeof entry.blockedBy === "string" ? entry.blockedBy.trim() : "",
      whenReady: typeof entry.whenReady === "string" ? entry.whenReady.trim() : "",
    }))
    .filter((entry) => entry.title && entry.blockedBy && entry.whenReady);
}

export function normalizeControllerManifest(raw: unknown): ControllerOrchestrationManifest | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const requirementSummary = typeof input.requirementSummary === "string" ? input.requirementSummary.trim() : "";
  if (!requirementSummary) {
    return null;
  }
  return {
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : "1.0",
    requirementSummary,
    requiredRoles: normalizeManifestRoleList(input.requiredRoles),
    clarificationsNeeded: Boolean(input.clarificationsNeeded),
    clarificationQuestions: normalizeManifestStringList(input.clarificationQuestions),
    createdTasks: normalizeManifestCreatedTasks(input.createdTasks),
    deferredTasks: normalizeManifestDeferredTasks(input.deferredTasks),
    handoffPlan: normalizeOptionalManifestText(input.handoffPlan),
    notes: normalizeOptionalManifestText(input.notes),
  };
}
