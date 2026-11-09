import type {
  ControllerManifestCompletionOpportunity,
  ControllerManifestCreatedTask,
  ControllerManifestDeferredTask,
  ControllerOrchestrationManifest,
  RoleId,
} from "../types.js";
import { validateRoleIdList } from "../roles.js";
import { deriveStableProjectKey } from "../openclaw-workspace.js";
// Issue #226 W3: the clarification-schema normalization family moved to the
// shared layer (worker/tools.ts consumes it; the worker must not import the
// controller tree). This module keeps the manifest-specific normalizers and
// imports the shared contract — controller -> shared direction only.
import {
  normalizeClarificationQuestionSchemas,
  normalizeOptionalManifestText,
} from "../shared/clarification-schema.js";

export function normalizeManifestRoleList(raw: unknown): RoleId[] {
  // Phase 0.3: delegates to the shared validateRoleIdList guard in roles.ts.
  // The hand-written TEAMCLAW_ROLE_IDS copy this function used to keep was
  // removed by Phase 1.2 (single-source-of-truth convergence); the role set
  // now lives only in role-ids.ts / roles.ts.
  return validateRoleIdList(raw);
}

export function normalizeManifestStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
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

export function normalizeManifestCompletionOpportunities(raw: unknown): ControllerManifestCompletionOpportunity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      value: typeof entry.value === "string" ? entry.value.trim() : "",
      summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
    }))
    .filter((entry) => entry.title && entry.value && entry.summary);
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
  const clarificationSchemas = normalizeClarificationQuestionSchemas(input.clarificationSchemas);
  const clarificationQuestions = normalizeManifestStringList(input.clarificationQuestions);
  return {
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : "1.0",
    projectName: typeof input.projectName === "string" && input.projectName.trim()
      ? (deriveStableProjectKey(input.projectName.trim()) || input.projectName.trim())
      : undefined,
    requirementSummary,
    requiredRoles: normalizeManifestRoleList(input.requiredRoles),
    clarificationsNeeded: Boolean(input.clarificationsNeeded),
    clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : clarificationSchemas.map((entry) => entry.title),
    clarificationSchemas,
    createdTasks: normalizeManifestCreatedTasks(input.createdTasks),
    deferredTasks: normalizeManifestDeferredTasks(input.deferredTasks),
    handoffPlan: normalizeOptionalManifestText(input.handoffPlan),
    notes: normalizeOptionalManifestText(input.notes),
    completionOpportunities: normalizeManifestCompletionOpportunities(input.completionOpportunities),
    requirementFullyComplete: Boolean(input.requirementFullyComplete),
  };
}
