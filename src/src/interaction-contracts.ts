import { ROLES } from "./roles.js";
import type {
  RoleId,
  TaskHandoffContract,
  TaskInfo,
  TeamMessage,
  TeamMessageContract,
  TeamMessageIntent,
  WorkerProgressContract,
  WorkerTaskResultContract,
  WorkerTaskResultDeliverable,
  WorkerTaskResultFollowUp,
  WorkerTaskResultOutcome,
} from "./types.js";

const CONTRACT_VERSION = "1.0";
const ROLE_IDS = new Set<RoleId>(ROLES.map((role) => role.id));
const RESULT_DELIVERABLE_KINDS = new Set<WorkerTaskResultDeliverable["kind"]>([
  "file",
  "directory",
  "command",
  "artifact",
  "note",
]);
const RESULT_FOLLOW_UP_TYPES = new Set<WorkerTaskResultFollowUp["type"]>([
  "review",
  "handoff",
  "clarification",
  "downstream-task",
]);
const MESSAGE_INTENTS = new Set<TeamMessageIntent>([
  "question",
  "announcement",
  "handoff",
  "review-request",
  "review-response",
  "update",
  "coordination",
]);

export function normalizeContractStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

export function normalizeOptionalContractText(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim();
  return normalized || undefined;
}

export function normalizeContractRole(raw: unknown): RoleId | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim() as RoleId;
  return normalized && ROLE_IDS.has(normalized) ? normalized : undefined;
}

export function summarizeContractText(text: string, maxChars = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

export function ensureTeamMessageContract(
  raw: unknown,
  fallback: {
    type: TeamMessage["type"];
    content: string;
    toRole?: RoleId;
    taskId?: string;
    summary?: string;
    details?: string;
    requestedAction?: string;
    needsResponse?: boolean;
    references?: string[];
    intent?: TeamMessageIntent;
  },
): TeamMessageContract {
  return normalizeTeamMessageContract(raw) ?? buildBackfilledTeamMessageContract(fallback);
}

export function normalizeTeamMessageContract(raw: unknown): TeamMessageContract | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary) {
    return null;
  }
  const intent = normalizeMessageIntent(input.intent) ?? "update";
  return {
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : CONTRACT_VERSION,
    intent,
    summary,
    details: normalizeOptionalContractText(input.details),
    requestedAction: normalizeOptionalContractText(input.requestedAction),
    requestedRole: normalizeContractRole(input.requestedRole),
    needsResponse: Boolean(input.needsResponse),
    references: normalizeContractStringList(input.references),
  };
}

export function normalizeWorkerProgressContract(raw: unknown): WorkerProgressContract | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary) {
    return null;
  }
  const status = normalizeProgressStatus(input.status) ?? "in_progress";
  return {
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : CONTRACT_VERSION,
    summary,
    status,
    currentStep: normalizeOptionalContractText(input.currentStep),
    nextStep: normalizeOptionalContractText(input.nextStep),
    blockers: normalizeContractStringList(input.blockers),
  };
}

export function backfillWorkerProgressContract(progress: string, status?: string): WorkerProgressContract | undefined {
  const normalized = progress.trim();
  if (!normalized) {
    return undefined;
  }
  return {
    version: CONTRACT_VERSION,
    summary: summarizeContractText(normalized),
    status: normalizeProgressStatus(status) ?? "in_progress",
    currentStep: normalized,
    blockers: extractQuestionOrBulletLines(normalized, 3, /blocked|waiting|stuck|need/i),
  };
}

export function renderWorkerProgressText(
  contract: WorkerProgressContract | undefined,
  fallbackProgress?: string,
): string {
  if (!contract) {
    return fallbackProgress?.trim() ?? "";
  }
  const lines = [contract.summary];
  if (contract.currentStep) {
    lines.push(`Current step: ${contract.currentStep}`);
  }
  if (contract.nextStep) {
    lines.push(`Next step: ${contract.nextStep}`);
  }
  if (contract.blockers.length > 0) {
    lines.push(`Blockers: ${contract.blockers.join("; ")}`);
  }
  return lines.filter(Boolean).join("\n");
}

export function normalizeTaskHandoffContract(
  raw: unknown,
  fallback: {
    targetRole?: RoleId;
    reason: string;
    summary?: string;
    expectedNextStep?: string;
    artifacts?: string[];
  },
): TaskHandoffContract {
  if (raw && typeof raw === "object") {
    const input = raw as Record<string, unknown>;
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (summary && reason) {
      return {
        version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : CONTRACT_VERSION,
        summary,
        reason,
        targetRole: normalizeContractRole(input.targetRole) ?? fallback.targetRole,
        expectedNextStep: normalizeOptionalContractText(input.expectedNextStep),
        artifacts: normalizeContractStringList(input.artifacts),
      };
    }
  }

  return {
    version: CONTRACT_VERSION,
    summary: fallback.summary?.trim() || buildDefaultHandoffSummary(fallback.targetRole, fallback.reason),
    reason: fallback.reason.trim(),
    targetRole: fallback.targetRole,
    expectedNextStep: fallback.expectedNextStep?.trim() || undefined,
    artifacts: (fallback.artifacts ?? []).map((entry) => entry.trim()).filter(Boolean),
  };
}

export function normalizeWorkerTaskResultContract(raw: unknown): WorkerTaskResultContract | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary) {
    return null;
  }
  return {
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : CONTRACT_VERSION,
    outcome: normalizeResultOutcome(input.outcome),
    summary,
    deliverables: normalizeResultDeliverables(input.deliverables),
    keyPoints: normalizeContractStringList(input.keyPoints),
    blockers: normalizeContractStringList(input.blockers),
    followUps: normalizeResultFollowUps(input.followUps),
    questions: normalizeContractStringList(input.questions),
    notes: normalizeOptionalContractText(input.notes),
    discoveredPatterns: normalizeContractStringList(input.discoveredPatterns),
  };
}

export function backfillWorkerTaskResultContract(
  task: Pick<TaskInfo, "title" | "description" | "assignedRole" | "lastHandoff"> | undefined,
  result: string,
  error?: string,
): WorkerTaskResultContract {
  const normalizedResult = result.trim();
  const normalizedError = error?.trim();
  const summarySource = normalizedError
    || firstMeaningfulLine(normalizedResult)
    || task?.lastHandoff?.summary
    || task?.description
    || task?.title
    || "Worker result summary unavailable.";
  const outcome: WorkerTaskResultOutcome = normalizedError
    ? "failed"
    : task?.lastHandoff
      ? "blocked"
      : "completed";
  const keyPoints = extractQuestionOrBulletLines(normalizedResult, 5);
  const questions = extractQuestionOrBulletLines(normalizedResult, 5, /\?$/);
  const blockers = normalizedError
    ? [normalizedError]
    : task?.lastHandoff
      ? [task.lastHandoff.reason]
      : [];
  const followUps: WorkerTaskResultFollowUp[] = task?.lastHandoff
    ? [{
        type: "handoff",
        targetRole: task.lastHandoff.targetRole,
        reason: task.lastHandoff.reason,
      }]
    : [];

  return {
    version: CONTRACT_VERSION,
    outcome,
    summary: summarizeContractText(summarySource),
    deliverables: inferResultDeliverables(normalizedResult, normalizedError),
    keyPoints,
    blockers,
    followUps,
    questions,
    notes: "Backfilled by TeamClaw because the worker did not submit a structured result contract.",
  };
}

function buildBackfilledTeamMessageContract(fallback: {
  type: TeamMessage["type"];
  content: string;
  toRole?: RoleId;
  taskId?: string;
  summary?: string;
  details?: string;
  requestedAction?: string;
  needsResponse?: boolean;
  references?: string[];
  intent?: TeamMessageIntent;
}): TeamMessageContract {
  const summary = fallback.summary?.trim() || summarizeContractText(fallback.content);
  const intent = fallback.intent ?? inferMessageIntent(fallback.type, fallback.content);
  const requestedAction = fallback.requestedAction?.trim() || buildDefaultRequestedAction(intent, fallback.toRole);
  const references = [...(fallback.references ?? []), ...(fallback.taskId ? [fallback.taskId] : [])]
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    version: CONTRACT_VERSION,
    intent,
    summary: summary || "TeamClaw message",
    details: fallback.details?.trim() || deriveMessageDetails(summary, fallback.content),
    requestedAction: requestedAction || undefined,
    requestedRole: fallback.toRole,
    needsResponse: typeof fallback.needsResponse === "boolean" ? fallback.needsResponse : intent === "question" || intent === "review-request" || intent === "handoff",
    references: Array.from(new Set(references)),
  };
}

function normalizeResultDeliverables(raw: unknown): WorkerTaskResultDeliverable[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const kind = typeof entry.kind === "string" && RESULT_DELIVERABLE_KINDS.has(entry.kind as WorkerTaskResultDeliverable["kind"])
        ? entry.kind as WorkerTaskResultDeliverable["kind"]
        : "note";
      const value = typeof entry.value === "string" ? entry.value.trim() : "";
      const summary = normalizeOptionalContractText(entry.summary);
      const artifactType = typeof entry.artifactType === "string" ? entry.artifactType as WorkerTaskResultDeliverable["artifactType"] : undefined;
      const previewCommand = normalizeOptionalContractText(entry.previewCommand);
      const previewCwd = normalizeOptionalContractText(entry.previewCwd);
      const previewReadyPath = normalizeOptionalContractText(entry.previewReadyPath);
      const liveUrl = normalizeOptionalContractText(entry.liveUrl);
      return value ? { kind, value, summary, artifactType, previewCommand, previewCwd, previewReadyPath, liveUrl } : null;
    })
    .filter((entry): entry is WorkerTaskResultDeliverable => !!entry);
}

function normalizeResultFollowUps(raw: unknown): WorkerTaskResultFollowUp[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const type = typeof entry.type === "string" && RESULT_FOLLOW_UP_TYPES.has(entry.type as WorkerTaskResultFollowUp["type"])
        ? entry.type as WorkerTaskResultFollowUp["type"]
        : null;
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
      if (!type || !reason) {
        return null;
      }
      return {
        type,
        targetRole: normalizeContractRole(entry.targetRole),
        reason,
      };
    })
    .filter((entry): entry is WorkerTaskResultFollowUp => !!entry);
}

function normalizeResultOutcome(raw: unknown): WorkerTaskResultOutcome {
  if (raw === "blocked" || raw === "failed") {
    return raw;
  }
  return "completed";
}

function normalizeProgressStatus(raw: unknown): WorkerProgressContract["status"] | null {
  if (raw === "in_progress" || raw === "review") {
    return raw;
  }
  return null;
}

function normalizeMessageIntent(raw: unknown): TeamMessageIntent | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim() as TeamMessageIntent;
  return MESSAGE_INTENTS.has(normalized) ? normalized : null;
}

function inferMessageIntent(type: TeamMessage["type"], content: string): TeamMessageIntent {
  if (type === "review-request") {
    return "review-request";
  }
  if (content.includes("?")) {
    return "question";
  }
  return type === "broadcast" ? "announcement" : "update";
}

function buildDefaultRequestedAction(intent: TeamMessageIntent, toRole?: RoleId): string {
  switch (intent) {
    case "question":
      return "Answer the question so the sender can continue safely.";
    case "review-request":
      return toRole
        ? `Review the referenced work as ${toRole} and reply with findings.`
        : "Review the referenced work and reply with findings.";
    case "handoff":
      return "Take over the next step described in the handoff summary.";
    case "announcement":
      return "Read the update and align your work if needed.";
    default:
      return "";
  }
}

function buildDefaultHandoffSummary(targetRole: RoleId | undefined, reason: string): string {
  if (targetRole) {
    return `Hand off the current task to ${targetRole}: ${summarizeContractText(reason)}`;
  }
  return `Hand off the current task: ${summarizeContractText(reason)}`;
}

function deriveMessageDetails(summary: string, content: string): string | undefined {
  const normalized = content.trim();
  if (!normalized || normalized === summary) {
    return undefined;
  }
  return normalized;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\n+/)) {
    const normalized = line.replace(/^[-*]\s*/, "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function extractQuestionOrBulletLines(text: string, maxItems: number, matcher?: RegExp): string[] {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !matcher || matcher.test(line));
  return Array.from(new Set(lines.map((line) => summarizeContractText(line, 220)))).slice(0, maxItems);
}

const WEB_HTML_FILENAMES = new Set(["index.html", "app.html", "main.html", "home.html"]);

/**
 * Default preview command used when the worker does not provide one.
 * This is a minimal static file server — the worker (LLM) is responsible
 * for providing the real, framework-appropriate command via previewCommand
 * in its result contract.
 */
function inferPreviewCommand(_cwd: string, _resultText: string, _filePaths: string[]): string {
  return "npx -y serve -l {PORT}";
}

function isWebHtmlPath(filePath: string): boolean {
  const segments = filePath.replace(/\\/gu, "/").split("/");
  const filename = segments[segments.length - 1] ?? "";
  if (!filename.toLowerCase().endsWith(".html") && !filename.toLowerCase().endsWith(".htm")) {
    return false;
  }
  if (filename.startsWith(".") || filename.includes(".config.") || filename.includes(".test.") || filename.includes(".spec.")) {
    return false;
  }
  return true;
}

function inferResultDeliverables(result: string, error?: string): WorkerTaskResultDeliverable[] {
  if (error) {
    return [{
      kind: "note",
      value: error,
      summary: "Execution error surfaced by the worker.",
    }];
  }

  const deliverables: WorkerTaskResultDeliverable[] = [];
  let webAppInferred = false;
  const pathMatches = Array.from(result.matchAll(/(?:^|[\s:(`])([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)/g))
    .map((match) => match[1])
    .filter(Boolean);
  const uniquePaths = Array.from(new Set(pathMatches)).slice(0, 5);
  for (const filePath of uniquePaths) {
    if (!webAppInferred && isWebHtmlPath(filePath)) {
      const segments = filePath.replace(/\\/gu, "/").split("/");
      const filename = segments[segments.length - 1] ?? "";
      const dirname = segments.length > 1 ? segments.slice(0, -1).join("/") : ".";
      const isTopLevelHtml = WEB_HTML_FILENAMES.has(filename);
      if (isTopLevelHtml || filename.toLowerCase().endsWith(".html")) {
        webAppInferred = true;
        deliverables.push({
          kind: "directory",
          value: dirname,
          summary: `Web application at ${dirname}`,
          artifactType: "web-app",
          previewCommand: inferPreviewCommand(dirname, result, uniquePaths),
          previewCwd: dirname,
          previewReadyPath: "/",
        });
        continue;
      }
    }
    deliverables.push({
      kind: "file",
      value: filePath,
    });
  }
  if (deliverables.length > 0) {
    return deliverables;
  }
  if (!result.trim()) {
    return [];
  }
  return [{
    kind: "note",
    value: summarizeContractText(result, 300),
    summary: "Backfilled from the worker's final reply.",
  }];
}

/**
 * Enrich existing deliverables with preview fields (artifactType, previewCommand, etc.)
 * by inferring from the raw result text.
 *
 * This function only enriches when the worker did NOT already provide these fields.
 * When the worker (LLM) submits a proper result contract with previewCommand and
 * artifactType, we trust it completely — it knows its own code better than we do.
 *
 * Returns the contract with enriched deliverables if any enrichment happened, or null
 * if no enrichment was needed.
 */
export function enrichDeliverablesWithPreviewInference(
  contract: WorkerTaskResultContract,
  resultText: string,
): WorkerTaskResultContract | null {
  const { deliverables } = contract;
  const existingWebApp = deliverables.find((d) => d.artifactType === "web-app");
  if (existingWebApp) {
    // Worker already provided a web-app with a real previewCommand — trust it.
    if (existingWebApp.previewCommand?.trim()) {
      return null;
    }
    // Worker declared web-app but no command — try to provide a fallback command.
    const cwd = existingWebApp.previewCwd?.trim();
    if (cwd && cwd !== "." && cwd !== "./") {
      // Has a real cwd but no command — provide generic static serve fallback
      existingWebApp.previewCommand = inferPreviewCommand(cwd, resultText, deliverables.map((d) => d.value ?? ""));
      return { ...contract, deliverables };
    }
  }

  // Strategy 1: Extract file paths from result text to detect HTML files
  const allSources = [resultText, ...deliverables.map((d) => d.summary ?? "")];
  const pathMatches = Array.from(
    allSources.join("\n").matchAll(/(?:^|[\s:(,`])([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)/g),
  )
    .map((match) => match[1])
    .filter(Boolean);

  for (const filePath of Array.from(new Set(pathMatches)).slice(0, 5)) {
    if (isWebHtmlPath(filePath)) {
      const segments = filePath.replace(/\\/gu, "/").split("/");
      const filename = segments[segments.length - 1] ?? "";
      const dirname = segments.length > 1 ? segments.slice(0, -1).join("/") : ".";
      if (!filename.toLowerCase().endsWith(".html") && !filename.toLowerCase().endsWith(".htm")) {
        continue;
      }
      const allDeliverablePaths = deliverables.map((d) => d.value ?? "");
      const matchingIndex = deliverables.findIndex((d) =>
        d.kind === "directory"
          && filePath.replace(/\\/gu, "/").startsWith(
            d.value?.replace(/\\/gu, "/").replace(/\/$/u, ""),
          ),
      );
      if (matchingIndex >= 0) {
        deliverables[matchingIndex] = {
          ...deliverables[matchingIndex],
          artifactType: "web-app",
          previewCommand: inferPreviewCommand(dirname, resultText, allDeliverablePaths),
          previewCwd: dirname,
          previewReadyPath: "/",
          summary: deliverables[matchingIndex].summary || `Web application at ${dirname}`,
        };
      } else {
        deliverables.push({
          kind: "directory",
          value: dirname,
          summary: `Web application at ${dirname}`,
          artifactType: "web-app",
          previewCommand: inferPreviewCommand(dirname, resultText, allDeliverablePaths),
          previewCwd: dirname,
          previewReadyPath: "/",
        });
      }
      return { ...contract, deliverables };
    }
  }

  // Strategy 2: If result text mentions HTML/web/blog/site keywords and there's a
  // directory deliverable without artifactType, infer web-app from the directory itself.
  const webKeywords = /\b(html|web\s*app|web\s*site|blog|index\.html|app\.html|homepage)\b/i;
  const hasWebKeywords = webKeywords.test(resultText) || deliverables.some((d) => webKeywords.test(d.summary ?? ""));

  if (hasWebKeywords) {
    const dirDeliverable = deliverables.find(
      (d) => d.kind === "directory" && !d.artifactType && d.value,
    );
    if (dirDeliverable) {
      const cwd = dirDeliverable.value.replace(/\/$/u, "");
      const allDeliverablePaths = deliverables.map((d) => d.value ?? "");
      deliverables[deliverables.indexOf(dirDeliverable)] = {
        ...dirDeliverable,
        artifactType: "web-app",
        previewCommand: inferPreviewCommand(cwd, resultText, allDeliverablePaths),
        previewCwd: cwd,
        previewReadyPath: "/",
        summary: dirDeliverable.summary || `Web application at ${cwd}`,
      };
      return { ...contract, deliverables };
    }
  }

  // Strategy 3: Extract directory paths that contain HTML files from result text
  // (e.g. "blog/index.html" → directory "blog"). This handles cases where deliverables
  // are all "note" type but result text references HTML files in directories.
  const dirHtmlPattern = /([A-Za-z0-9_.-]+\/)[A-Za-z0-9_.-]+\.html\b/g;
  const dirMatches = Array.from(resultText.matchAll(dirHtmlPattern)).map((m) => m[1].replace(/\/$/u, ""));
  const uniqueDirs = Array.from(new Set(dirMatches));
  if (uniqueDirs.length > 0 && hasWebKeywords) {
    const dirname = uniqueDirs[0];
    deliverables.push({
      kind: "directory",
      value: dirname,
      summary: `Web application at ${dirname}`,
      artifactType: "web-app",
      previewCommand: inferPreviewCommand(dirname, resultText, [dirname]),
      previewCwd: dirname,
      previewReadyPath: "/",
    });
    return { ...contract, deliverables };
  }

  return null;
}
