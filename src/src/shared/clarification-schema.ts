// Shared contracts layer (issue #226, W3): the structured clarification
// question schema normalization family, lifted verbatim from
// controller/orchestration-manifest.ts. The worker imports this contract
// (worker/tools.ts asks the question schema through it), so it must live in
// the shared layer — worker must never import the controller tree. The
// manifest-specific normalizers (role lists, created/deferred tasks,
// completion opportunities) stay in orchestration-manifest.ts and now import
// this module (controller -> shared direction only).
import type {
  ClarificationQuestionOption,
  ClarificationQuestionSchema,
} from "../types.js";

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
