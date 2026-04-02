import type {
  ClarificationQuestionOption,
  ClarificationQuestionSchema,
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

export function normalizeClarificationOptions(raw: unknown): ClarificationQuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      value: typeof entry.value === "string" ? entry.value.trim() : "",
      label: typeof entry.label === "string" ? entry.label.trim() : "",
      hint: typeof entry.hint === "string" && entry.hint.trim() ? entry.hint.trim() : undefined,
    }))
    .filter((entry) => entry.value && entry.label);
}

export function normalizeClarificationQuestionSchema(raw: unknown): ClarificationQuestionSchema | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = raw as Record<string, unknown>;
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || !["single-select", "multi-select", "number", "text"].includes(kind)) {
    return undefined;
  }
  const options = normalizeClarificationOptions(input.options);
  const schema: ClarificationQuestionSchema = {
    kind: kind as ClarificationQuestionSchema["kind"],
    title,
    description: normalizeOptionalManifestText(input.description),
    required: input.required == null ? true : Boolean(input.required),
    allowOther: Boolean(input.allowOther),
    placeholder: normalizeOptionalManifestText(input.placeholder),
    unit: normalizeOptionalManifestText(input.unit),
  };
  if (options.length > 0) {
    schema.options = options;
  }
  if (typeof input.min === "number" && Number.isFinite(input.min)) {
    schema.min = input.min;
  }
  if (typeof input.max === "number" && Number.isFinite(input.max)) {
    schema.max = input.max;
  }
  if (typeof input.step === "number" && Number.isFinite(input.step)) {
    schema.step = input.step;
  }
  if ((schema.kind === "single-select" || schema.kind === "multi-select") && (!schema.options || schema.options.length === 0)) {
    return undefined;
  }
  return schema;
}

export function normalizeClarificationQuestionSchemas(raw: unknown): ClarificationQuestionSchema[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => normalizeClarificationQuestionSchema(entry))
    .filter((entry): entry is ClarificationQuestionSchema => Boolean(entry));
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
  const clarificationSchemas = normalizeClarificationQuestionSchemas(input.clarificationSchemas);
  const clarificationQuestions = normalizeManifestStringList(input.clarificationQuestions);
  return {
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : "1.0",
    projectName: typeof input.projectName === "string" && input.projectName.trim() ? input.projectName.trim() : undefined,
    requirementSummary,
    requiredRoles: normalizeManifestRoleList(input.requiredRoles),
    clarificationsNeeded: Boolean(input.clarificationsNeeded),
    clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : clarificationSchemas.map((entry) => entry.title),
    clarificationSchemas,
    createdTasks: normalizeManifestCreatedTasks(input.createdTasks),
    deferredTasks: normalizeManifestDeferredTasks(input.deferredTasks),
    handoffPlan: normalizeOptionalManifestText(input.handoffPlan),
    notes: normalizeOptionalManifestText(input.notes),
    requirementFullyComplete: Boolean(input.requirementFullyComplete),
  };
}
