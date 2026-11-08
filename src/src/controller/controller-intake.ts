// PR-C of issue #204 (http-server monolith split): the controller intake
// orchestration - the serialized, retrying runControllerIntake funnel with
// its session-progress streaming, rate-limit/inactivity probes, the
// ControllerIntakeSwitchInProgressError entry gate, workflow continuation,
// and the controller-run clarification sync/reconcile - extracted verbatim
// from controller/http-server.ts. Zero behavior change. This module must
// NEVER import http-server (the reverse edge exists:
// http-server -> controller-intake); the planning helpers arrive from
// ./controller-planning.js and the kickoff handler stays late-bound through
// the deps slice.
import { normalizeSessionRole } from "../session-roles.js";
import type {
  ClarificationRequest,
  ControllerOrchestrationManifest,
  ControllerRunInfo,
  ControllerRunSource,
  TaskInfo,
  TeamState,
  TeamSwitchTransition,
} from "../types.js";
import { generateId } from "../protocol.js";
import { createControllerPromptInjector } from "./prompt-injector.js";
import { normalizeControllerIntakeSessionKey } from "./task-execution.js";
import {
  appendControllerRunEvent,
  createControllerRun,
  recordControllerRunEvent,
  updateControllerRun,
} from "./controller-runs.js";
import {
  buildControllerFollowUpMessage,
  buildControllerManifestReply,
  collectTaskIds,
  ensureControllerManifest,
  maybeBackfillExecutionReadyTask,
  maybeConvertControllerClarificationToExecutionTask,
  reconcileControllerManifestTaskBindings,
  resolveControllerWorkflowSessionKey,
  tagControllerCreatedTasks,
} from "./controller-planning.js";
import { pruneStaleControllerRuns } from "./task-cleanup.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

const CONTROLLER_RUN_WAIT_SLICE_MS = 30_000;
const CONTROLLER_SESSION_PROGRESS_MESSAGE_LIMIT = 200;
const MAX_SESSION_PROGRESS_MESSAGE_CHARS = 4000;
const TOOL_CALL_BLOCK_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["tool_result", "tool_result_error"]);

const CONTROLLER_RATE_LIMIT_STALL_PROBE_MS = 5 * 60 * 1000;
const CONTROLLER_RATE_LIMIT_PROBE_TIMEOUT_MS = 60_000;
const CONTROLLER_INACTIVITY_PROBE_TIMEOUT_MS = 60_000;
const CONTROLLER_RATE_LIMIT_WAITING_SENTINEL = "TEAMCLAW_STILL_WAITING";
const CONTROLLER_INTAKE_MAX_RETRIES = 2;
const CONTROLLER_INTAKE_RETRY_DELAY_MS = 3_000;
const CONTROLLER_INTAKE_RETRYABLE_ERROR_PATTERN = /(500|502|503|server error|internal error|overloaded|unavailable)/i;
const controllerIntakeQueue = new Map<string, Promise<void>>();

export function buildControllerIntakeSystemPrompt(
  deps: Pick<ControllerTaskDomainDeps, "config" | "getTeamState">,
): string {
  const injector = createControllerPromptInjector({
    config: deps.config,
    getTeamState: deps.getTeamState,
  });
  return injector()?.prependSystemContext ?? "";
}

export function extractLastAssistantText(messages: unknown[]): string {
  const assistantMessages = messages.filter((message): message is { role?: unknown; content?: unknown } => {
    if (!message || typeof message !== "object") {
      return false;
    }
    return (message as { role?: unknown }).role === "assistant";
  });

  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  if (!lastAssistant) {
    return "";
  }

  if (typeof lastAssistant.content === "string") {
    return lastAssistant.content;
  }

  if (Array.isArray(lastAssistant.content)) {
    const textBlocks = lastAssistant.content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
      })
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean);
    if (textBlocks.length > 0) {
      return textBlocks.join("\n");
    }
  }

  return JSON.stringify(lastAssistant);
}

type SessionProgressEntry = {
  fingerprint: string;
  message: string;
  phase: string;
  stream: string;
  isRateLimit: boolean;
};

export function normalizeBlockType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

export function truncateProgressMessage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= MAX_SESSION_PROGRESS_MESSAGE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SESSION_PROGRESS_MESSAGE_CHARS)}\n… (truncated)`;
}

export function normalizeProgressComparableText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

export function safeJsonStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

export function renderSessionMessage(message: Record<string, unknown>, role: string): { message: string; stream: string } {
  const content = message.content;
  if (typeof content === "string") {
    return {
      message: truncateProgressMessage(content),
      stream: role,
    };
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const toolCalls: string[] = [];
    let toolResultCount = 0;
    let toolResultErrors = 0;

    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const block = entry as Record<string, unknown>;
      const type = normalizeBlockType(block.type);
      if (type === "text") {
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (text) {
          textParts.push(text);
        }
        continue;
      }

      if (TOOL_CALL_BLOCK_TYPES.has(type)) {
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (name) {
          toolCalls.push(name);
        }
        continue;
      }

      if (TOOL_RESULT_BLOCK_TYPES.has(type)) {
        toolResultCount += 1;
        if (block.is_error === true) {
          toolResultErrors += 1;
        }
      }
    }

    const parts: string[] = [];
    if (textParts.length > 0) {
      parts.push(textParts.join("\n"));
    }
    if (toolCalls.length > 0) {
      parts.push(`[tool call] ${toolCalls.join(", ")}`);
    }
    if (toolResultCount > 0) {
      parts.push(`[tool result] ${toolResultCount}${toolResultErrors > 0 ? ` (${toolResultErrors} error)` : ""}`);
    }

    if (parts.length > 0) {
      return {
        message: truncateProgressMessage(parts.join("\n")),
        stream: textParts.length > 0 ? role : "tool",
      };
    }
  }

  const fallbackToolName = typeof message.toolName === "string"
    ? message.toolName.trim()
    : (typeof message.tool_name === "string" ? message.tool_name.trim() : "");
  if (fallbackToolName) {
    return {
      message: `[tool call] ${fallbackToolName}`,
      stream: "tool",
    };
  }

  return {
    message: truncateProgressMessage(safeJsonStringify(message)),
    stream: role || "session",
  };
}

export function buildSessionProgressEntries(messages: unknown[], controllerMessage: string): SessionProgressEntry[] {
  const entries: SessionProgressEntry[] = [];
  const normalizedControllerMessage = normalizeProgressComparableText(controllerMessage);

  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object") {
      continue;
    }

    const message = rawMessage as Record<string, unknown>;
    const role = normalizeSessionRole(message.role);
    if (!role) {
      continue;
    }

    const rendered = renderSessionMessage(message, role);
    if (!rendered.message) {
      continue;
    }

    const comparableMessage = normalizeProgressComparableText(rendered.message);
    if (role === "user" && normalizedControllerMessage && comparableMessage.includes(normalizedControllerMessage)) {
      continue;
    }

    entries.push({
      fingerprint: `${rendered.stream}:${comparableMessage}`,
      message: rendered.message,
      phase: rendered.stream,
      stream: rendered.stream,
      isRateLimit: isRateLimitMessage(rendered.message),
    });
  }

  return entries;
}

export function getNewSessionProgressEntries(
  entries: SessionProgressEntry[],
  previousFingerprints: string[],
): SessionProgressEntry[] {
  if (entries.length === 0) {
    return [];
  }
  if (previousFingerprints.length === 0) {
    return entries;
  }

  const currentFingerprints = entries.map((entry) => entry.fingerprint);
  const maxOverlap = Math.min(previousFingerprints.length, currentFingerprints.length);
  let overlap = 0;

  for (let size = maxOverlap; size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (previousFingerprints[previousFingerprints.length - size + index] !== currentFingerprints[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = size;
      break;
    }
  }

  return entries.slice(overlap);
}

export function formatDuration(timeoutMs: number): string {
  const totalSeconds = Math.ceil(timeoutMs / 1000);
  if (totalSeconds % 3600 === 0) {
    const hours = totalSeconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
}

export function isRateLimitMessage(value: string): boolean {
  return /(rate[_ ]limit|too many requests|429\b|resource has been exhausted|tokens per day|quota|throttl)/i.test(
    String(value || ""),
  );
}

export function isStillWaitingResponse(value: string): boolean {
  return value.replace(/\s+/g, " ").trim() === CONTROLLER_RATE_LIMIT_WAITING_SENTINEL;
}

export async function withSerializedControllerIntake<T>(
  sessionKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const previous = controllerIntakeQueue.get(normalizedSessionKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  controllerIntakeQueue.set(normalizedSessionKey, current);
  try {
    await previous;
    return await fn();
  } finally {
    releaseCurrent();
    if (controllerIntakeQueue.get(normalizedSessionKey) === current) {
      controllerIntakeQueue.delete(normalizedSessionKey);
    }
  }
}

export function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function buildManifestClarificationEntries(
  manifest: ControllerOrchestrationManifest,
): Array<{ question: string; questionSchema?: ClarificationRequest["questionSchema"] }> {
  const opportunities = Array.isArray(manifest.completionOpportunities)
    ? manifest.completionOpportunities.filter((entry) => entry.title && entry.value && entry.summary)
    : [];
  const completionEntries = manifest.requirementFullyComplete && opportunities.length > 0
    ? [{
      question: "Would you like TeamClaw to continue with one of these adjacent next steps?",
      questionSchema: {
        kind: "single-select" as const,
        title: "What should TeamClaw do next?",
        description: opportunities.map((entry) => `- ${entry.title}: ${entry.summary}`).join("\n"),
        required: false,
        options: opportunities.map((entry) => ({
          value: entry.value,
          label: entry.title,
          hint: entry.summary,
        })),
        allowOther: true,
      },
    }]
    : [];
  const normalizedQuestions = manifest.clarificationQuestions
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const schemas = Array.isArray(manifest.clarificationSchemas) ? manifest.clarificationSchemas : [];
  if (schemas.length > 0) {
    return [
      ...schemas.map((schema, index) => ({
        question: normalizedQuestions[index] || schema.title,
        questionSchema: schema,
      })),
      ...completionEntries,
    ];
  }
  return [
    ...normalizedQuestions.map((question) => ({ question })),
    ...completionEntries,
  ];
}

export function syncControllerRunClarifications(
  controllerRunId: string,
  sessionKey: string,
  manifest: ControllerOrchestrationManifest,
  deps: ControllerTaskDomainDeps,
): ClarificationRequest[] {
  const entries = buildManifestClarificationEntries(manifest);
  const created: ClarificationRequest[] = [];
  const superseded: ClarificationRequest[] = [];
  const now = Date.now();
  deps.updateTeamState((state) => {
    const desiredQuestionKeys = new Set(
      entries.map((entry) => normalizeComparableText(entry.question)),
    );
    const existingQuestions = new Map(
      Object.values(state.clarifications)
        .filter((item) => item.controllerRunId === controllerRunId)
        .map((item) => [normalizeComparableText(item.question), item]),
    );

    for (const [key, clarification] of existingQuestions.entries()) {
      if (
        clarification.status === "pending"
        && !desiredQuestionKeys.has(key)
      ) {
        clarification.status = "answered";
        clarification.answer = "Automatically superseded by the latest controller clarification set.";
        clarification.answeredBy = "system";
        clarification.answeredAt = now;
        clarification.updatedAt = now;
        superseded.push({ ...clarification });
      }
    }

    for (const entry of entries) {
      const key = normalizeComparableText(entry.question);
      if (existingQuestions.has(key)) {
        continue;
      }
      const clarification: ClarificationRequest = {
        id: generateId(),
        taskId: "",
        controllerRunId,
        controllerSessionKey: sessionKey,
        requestedBy: "controller",
        question: entry.question,
        questionSchema: entry.questionSchema,
        blockingReason: "The controller needs this information before it can confidently continue planning and downstream task creation.",
        context: manifest.requirementSummary,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      state.clarifications[clarification.id] = clarification;
      created.push(clarification);
    }
  });

  for (const clarification of created) {
    deps.wsServer.broadcastUpdate({ type: "clarification:requested", data: clarification });
  }
  for (const clarification of superseded) {
    deps.wsServer.broadcastUpdate({ type: "clarification:answered", data: clarification });
  }
  return created;
}

export function reconcileControllerClarifications(deps: ControllerTaskDomainDeps): TeamState | null {
  const state = deps.getTeamState();
  if (!state) {
    return null;
  }

  const superseded: ClarificationRequest[] = [];
  deps.updateTeamState((draft) => {
    const runsBySession = new Map<string, ControllerRunInfo[]>();
    for (const run of Object.values(draft.controllerRuns)) {
      const normalizedSessionKey = normalizeControllerIntakeSessionKey(run.sessionKey);
      const bucket = runsBySession.get(normalizedSessionKey) ?? [];
      bucket.push(run);
      runsBySession.set(normalizedSessionKey, bucket);
    }

    for (const clar of Object.values(draft.clarifications)) {
      if (clar.status !== "pending" || clar.requestedBy !== "controller" || clar.taskId) {
        continue;
      }
      const normalizedSessionKey = normalizeControllerIntakeSessionKey(clar.controllerSessionKey);
      const sessionRuns = runsBySession.get(normalizedSessionKey) ?? [];
      const supersedingRun = sessionRuns.find((run) =>
        run.updatedAt > clar.updatedAt
        && (
          run.manifest?.createdTasks.length
          || run.manifest?.requirementFullyComplete
        ),
      );
      if (!supersedingRun) {
        continue;
      }
      clar.status = "answered";
      clar.answer = "Automatically superseded by later controller progress.";
      clar.answeredBy = "system";
      clar.answeredAt = supersedingRun.updatedAt;
      clar.updatedAt = supersedingRun.updatedAt;
      superseded.push({ ...clar });
    }
  });

  for (const clarification of superseded) {
    deps.wsServer.broadcastUpdate({ type: "clarification:answered", data: clarification });
  }

  for (const run of Object.values(state.controllerRuns)) {
    if (!run.manifest?.clarificationsNeeded) {
      continue;
    }
    syncControllerRunClarifications(run.id, run.sessionKey, run.manifest, deps);
  }

  return deps.getTeamState();
}

export function buildControllerRateLimitProbeMessage(
  sourceTaskId?: string,
  sourceTaskTitle?: string,
): string {
  const workflowLabel = sourceTaskTitle
    ? `${sourceTaskTitle}${sourceTaskId ? ` (${sourceTaskId})` : ""}`
    : (sourceTaskId ? `task ${sourceTaskId}` : "this controller workflow");
  return [
    `This is a follow-up check for ${workflowLabel}.`,
    "The earlier controller run appears to be delayed by upstream model rate limiting.",
    "Do not restart the workflow from scratch.",
    "Do not duplicate tasks that already exist, are active, or are completed.",
    "If the earlier controller follow-up is fully complete now, immediately submit the required structured manifest for that same workflow step and provide the final orchestration reply.",
    `If the earlier controller follow-up is not complete yet, reply with exactly ${CONTROLLER_RATE_LIMIT_WAITING_SENTINEL}.`,
  ].join("\n");
}

export function buildControllerInactivityProbeMessage(
  inactivityMs: number,
  sourceTaskId?: string,
  sourceTaskTitle?: string,
): string {
  const workflowLabel = sourceTaskTitle
    ? `${sourceTaskTitle}${sourceTaskId ? ` (${sourceTaskId})` : ""}`
    : (sourceTaskId ? `task ${sourceTaskId}` : "this controller workflow");
  return [
    `This is a follow-up check for ${workflowLabel}.`,
    `There has been no new visible controller workflow progress for over ${formatDuration(inactivityMs)}.`,
    "Do not restart the workflow from scratch.",
    "Do not duplicate tasks that already exist, are active, or are completed.",
    "If the earlier controller follow-up is fully complete now, immediately submit the required structured manifest for that same workflow step and provide the final orchestration reply.",
    `If the earlier controller follow-up is not complete yet, reply with exactly ${CONTROLLER_RATE_LIMIT_WAITING_SENTINEL}.`,
  ].join("\n");
}

export async function continueControllerWorkflow(task: TaskInfo, deps: ControllerTaskDomainDeps): Promise<void> {
  if (task.createdBy !== "controller") {
    return;
  }
  const sessionKey = resolveControllerWorkflowSessionKey(task, deps.getTeamState());
  if (!sessionKey) {
    return;
  }
  if (task.controllerSessionKey !== sessionKey) {
    deps.updateTeamState((state) => {
      const currentTask = state.tasks[task.id];
      if (currentTask) {
        currentTask.controllerSessionKey = sessionKey;
      }
    });
  }
  await runControllerIntake(buildControllerFollowUpMessage(task, deps.getTeamState()), sessionKey, deps, {
    source: "task_follow_up",
    sourceTaskId: task.id,
    sourceTaskTitle: task.title,
  });
}

/**
 * Phase 2.1 review fix (design 2.3 concurrency matrix): intake runs create
 * tasks and burn a controller LLM pass, so they are refused while a profile
 * switch transition is in flight - at the runControllerIntake ENTRY, which is
 * the single funnel for URL submissions AND internal callers (task-completion
 * follow-ups, parallel-help, clarification resumes) that bypass the URL-level
 * 503 gate. The message deliberately avoids every token of
 * CONTROLLER_INTAKE_RETRYABLE_ERROR_PATTERN: a transition rejection must fail
 * fast, never retry its way into the switched team.
 */
export class ControllerIntakeSwitchInProgressError extends Error {
  readonly transition: TeamSwitchTransition;

  constructor(transition: TeamSwitchTransition) {
    super(
      `Controller intake rejected: a team profile switch to "${transition.targetProfileId}" is in progress (phase: ${transition.phase}) - retry after the switch completes`,
    );
    this.name = "ControllerIntakeSwitchInProgressError";
    this.transition = transition;
  }
}

export async function runControllerIntake(
  message: string,
  sessionKey: string,
  deps: ControllerTaskDomainDeps,
  options?: {
    source?: ControllerRunSource;
    sourceTaskId?: string;
    sourceTaskTitle?: string;
  },
): Promise<{ sessionKey: string; runId: string; reply: string; controllerRunId: string }> {
  const activeTransition = deps.getTeamState()?.transition;
  if (activeTransition) {
    throw new ControllerIntakeSwitchInProgressError(activeTransition);
  }
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  return withSerializedControllerIntake(normalizedSessionKey, async () => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= CONTROLLER_INTAKE_MAX_RETRIES; attempt++) {
      try {
        return await runControllerIntakeUnlocked(message, normalizedSessionKey, deps, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errorText = lastError.message;
        // Only retry on transient server errors (500/502/503), not on client errors,
        // timeouts, or other failures that retrying won't fix.
        if (
          attempt === CONTROLLER_INTAKE_MAX_RETRIES
          || !CONTROLLER_INTAKE_RETRYABLE_ERROR_PATTERN.test(errorText)
          || errorText.includes("timed out")
        ) {
          throw lastError;
        }
        // Record a visible retry event so the human can see what happened.
        deps.logger.warn(
          `Controller: intake attempt ${attempt + 1} failed with transient error: ${errorText.slice(0, 200)}. Retrying in ${CONTROLLER_INTAKE_RETRY_DELAY_MS * (attempt + 1) / 1000}s...`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, CONTROLLER_INTAKE_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    throw lastError!;
  });
}

export async function runControllerIntakeUnlocked(
  message: string,
  sessionKey: string,
  deps: ControllerTaskDomainDeps,
  options?: {
    source?: ControllerRunSource;
    sourceTaskId?: string;
    sourceTaskTitle?: string;
  },
): Promise<{ sessionKey: string; runId: string; reply: string; controllerRunId: string }> {
  const taskIdsBeforeRun = collectTaskIds(deps.getTeamState());
  const controllerRun = createControllerRun(message, sessionKey, deps, options);
  recordControllerRunEvent(controllerRun.id, {
    type: "lifecycle",
    phase: "queued",
    source: "controller",
    status: "pending",
    sessionKey,
    message: "Controller intake queued.",
  }, deps);

  const runResult = await deps.runtime.subagent.run({
    sessionKey,
    message,
    extraSystemPrompt: buildControllerIntakeSystemPrompt(deps),
    idempotencyKey: `controller-intake-${generateId()}`,
  });
  recordControllerRunEvent(controllerRun.id, {
    type: "lifecycle",
    phase: "run_started",
    source: "controller",
    status: "running",
    sessionKey,
    runId: runResult.runId,
    message: `Controller intake started (${runResult.runId}).`,
  }, deps);

  const rateLimitState: {
    active: boolean;
    visibleAt?: number;
    nextProbeAt?: number;
    probeCount: number;
  } = {
    active: false,
    probeCount: 0,
  };
  const inactivityState: {
    active: boolean;
    visibleAt?: number;
    nextProbeAt?: number;
    probeCount: number;
  } = {
    active: false,
    nextProbeAt: Date.now() + deps.config.taskTimeoutMs,
    probeCount: 0,
  };
  const progressSnapshot: {
    fingerprints: string[];
    latestMessages: unknown[];
    lastActivityAt: number;
  } = {
    fingerprints: [],
    latestMessages: [],
    lastActivityAt: Date.now(),
  };

  const markRateLimitWaiting = async (): Promise<void> => {
    if (rateLimitState.active) {
      return;
    }
    const now = Date.now();
    rateLimitState.active = true;
    rateLimitState.visibleAt = now;
    rateLimitState.nextProbeAt = now + CONTROLLER_RATE_LIMIT_STALL_PROBE_MS;
    recordControllerRunEvent(controllerRun.id, {
      type: "progress",
      phase: "model_rate_limit_waiting",
      source: "controller",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: "Model rate limit reached. OpenClaw is retrying upstream; TeamClaw will keep waiting for the controller workflow to continue.",
    }, deps);
  };

  const clearRateLimitWaiting = (): void => {
    rateLimitState.active = false;
    rateLimitState.visibleAt = undefined;
    rateLimitState.nextProbeAt = undefined;
  };

  const noteObservedControllerActivity = (): void => {
    progressSnapshot.lastActivityAt = Date.now();
    inactivityState.active = false;
    inactivityState.visibleAt = undefined;
    inactivityState.nextProbeAt = Date.now() + deps.config.taskTimeoutMs;
  };

  const syncControllerSessionProgress = async (): Promise<void> => {
    const sessionMessages = await deps.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: CONTROLLER_SESSION_PROGRESS_MESSAGE_LIMIT,
    });
    progressSnapshot.latestMessages = Array.isArray(sessionMessages.messages) ? sessionMessages.messages : [];
    const entries = buildSessionProgressEntries(progressSnapshot.latestMessages, message);
    const newEntries = getNewSessionProgressEntries(entries, progressSnapshot.fingerprints);
    progressSnapshot.fingerprints = entries.map((entry) => entry.fingerprint);
    if (newEntries.length > 0) {
      noteObservedControllerActivity();
    }
    for (const entry of newEntries) {
      if (entry.isRateLimit) {
        await markRateLimitWaiting();
        continue;
      }
      if (rateLimitState.active && isStillWaitingResponse(entry.message)) {
        continue;
      }
      if (rateLimitState.active) {
        clearRateLimitWaiting();
      }
      recordControllerRunEvent(controllerRun.id, {
        type: "progress",
        phase: entry.phase,
        source: "subagent",
        stream: entry.stream,
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: entry.message,
      }, deps);
    }
  };

  const extractSessionAssistantReply = async (): Promise<string> => {
    const sessionMessages = await deps.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 100,
    });
    return extractLastAssistantText(sessionMessages.messages);
  };

  const probeRateLimitedControllerCompletion = async (): Promise<string | null> => {
    rateLimitState.probeCount += 1;
    const now = Date.now();
    rateLimitState.visibleAt = now;
    rateLimitState.nextProbeAt = now + CONTROLLER_RATE_LIMIT_STALL_PROBE_MS;
    recordControllerRunEvent(controllerRun.id, {
      type: "progress",
      phase: "model_rate_limit_probe",
      source: "controller",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: `Model rate limit has delayed controller orchestration for over ${formatDuration(CONTROLLER_RATE_LIMIT_STALL_PROBE_MS)}. Re-checking whether this workflow step has already completed.`,
    }, deps);

    const probeRun = await deps.runtime.subagent.run({
      sessionKey,
      message: buildControllerRateLimitProbeMessage(options?.sourceTaskId, options?.sourceTaskTitle),
      extraSystemPrompt: buildControllerIntakeSystemPrompt(deps),
      idempotencyKey: `${runResult.runId}:rate-limit-probe:${rateLimitState.probeCount}`,
    });
    const probeWait = await deps.runtime.subagent.waitForRun({
      runId: probeRun.runId,
      timeoutMs: CONTROLLER_RATE_LIMIT_PROBE_TIMEOUT_MS,
    });

    if (probeWait.status !== "ok") {
      return null;
    }

    const probeReply = await extractSessionAssistantReply();
    if (!probeReply || isRateLimitMessage(probeReply) || isStillWaitingResponse(probeReply)) {
      recordControllerRunEvent(controllerRun.id, {
        type: "progress",
        phase: "model_rate_limit_still_waiting",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: "The controller workflow is still waiting on model availability. TeamClaw will continue waiting.",
      }, deps);
      return null;
    }

    clearRateLimitWaiting();
    noteObservedControllerActivity();
    return probeReply;
  };

  const probeInactiveControllerCompletion = async (): Promise<string | null> => {
    inactivityState.probeCount += 1;
    const now = Date.now();
    inactivityState.active = true;
    inactivityState.visibleAt = now;
    inactivityState.nextProbeAt = now + deps.config.taskTimeoutMs;
    recordControllerRunEvent(controllerRun.id, {
      type: "progress",
      phase: "inactivity_probe",
      source: "controller",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: `No new controller workflow output has appeared for over ${formatDuration(deps.config.taskTimeoutMs)}. Re-checking whether this orchestration step is complete or still running.`,
    }, deps);

    const probeRun = await deps.runtime.subagent.run({
      sessionKey,
      message: buildControllerInactivityProbeMessage(
        deps.config.taskTimeoutMs,
        options?.sourceTaskId,
        options?.sourceTaskTitle,
      ),
      extraSystemPrompt: buildControllerIntakeSystemPrompt(deps),
      idempotencyKey: `${runResult.runId}:inactivity-probe:${inactivityState.probeCount}`,
    });
    const probeWait = await deps.runtime.subagent.waitForRun({
      runId: probeRun.runId,
      timeoutMs: CONTROLLER_INACTIVITY_PROBE_TIMEOUT_MS,
    });

    if (probeWait.status === "error" && isRateLimitMessage(probeWait.error || "")) {
      await markRateLimitWaiting();
      return null;
    }
    if (probeWait.status !== "ok") {
      return null;
    }

    const probeReply = await extractSessionAssistantReply();
    if (!probeReply || isRateLimitMessage(probeReply) || isStillWaitingResponse(probeReply)) {
      inactivityState.active = false;
      inactivityState.visibleAt = undefined;
      inactivityState.nextProbeAt = Date.now() + deps.config.taskTimeoutMs;
      recordControllerRunEvent(controllerRun.id, {
        type: "progress",
        phase: "inactivity_still_waiting",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: "The controller workflow is still running without a final result yet. TeamClaw will keep waiting instead of failing the run.",
      }, deps);
      return null;
    }

    if (rateLimitState.active) {
      clearRateLimitWaiting();
    }
    noteObservedControllerActivity();
    return probeReply;
  };

  let waitResult: Awaited<ReturnType<typeof deps.runtime.subagent.waitForRun>> = { status: "timeout" };
  let completionOverride: string | null = null;
  while (true) {
    if (rateLimitState.active && (rateLimitState.nextProbeAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
      completionOverride = await probeRateLimitedControllerCompletion();
      if (completionOverride) {
        waitResult = { status: "ok" };
        break;
      }
    }

    if (!rateLimitState.active && (inactivityState.nextProbeAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
      completionOverride = await probeInactiveControllerCompletion();
      if (completionOverride) {
        waitResult = { status: "ok" };
        break;
      }
    }

    waitResult = await deps.runtime.subagent.waitForRun({
      runId: runResult.runId,
      timeoutMs: CONTROLLER_RUN_WAIT_SLICE_MS,
    });

    try {
      await syncControllerSessionProgress();
    } catch (err) {
      deps.logger.debug?.(`Controller: failed to sync planning session progress for ${controllerRun.id}: ${String(err)}`);
    }

    if (waitResult.status === "ok") {
      clearRateLimitWaiting();
      noteObservedControllerActivity();
      break;
    }
    if (waitResult.status === "error") {
      if (isRateLimitMessage(waitResult.error || "")) {
        await markRateLimitWaiting();
        continue;
      }
      break;
    }
  }
  if (waitResult.status !== "ok") {
    const errorMessage = waitResult.error || "Controller intake failed";
    const createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, controllerRun.id, sessionKey, deps);
    updateControllerRun(controllerRun.id, deps, (run) => {
      run.createdTaskIds = createdTaskIds;
      run.error = errorMessage;
      appendControllerRunEvent(run, {
        type: "error",
        phase: "run_failed",
        source: "controller",
        status: "failed",
        sessionKey,
        runId: runResult.runId,
        message: errorMessage,
      });
    });
    throw new Error(errorMessage);
  }

  let createdTaskIds = tagControllerCreatedTasks(taskIdsBeforeRun, controllerRun.id, sessionKey, deps);

  try {
    await syncControllerSessionProgress();
  } catch (err) {
    deps.logger.debug?.(`Controller: failed final planning session sync for ${controllerRun.id}: ${String(err)}`);
  }

  const rawReply = completionOverride || await extractSessionAssistantReply()
    || "Controller completed the intake run but did not return any text.";
  const recordedManifest = ensureControllerManifest(
    controllerRun.id,
    sessionKey,
    message,
    rawReply,
    createdTaskIds,
    deps,
  );
  const fallbackTaskIds = await maybeBackfillExecutionReadyTask(
    controllerRun.id,
    sessionKey,
    message,
    recordedManifest,
    deps,
    { source: options?.source },
  );
  if (fallbackTaskIds.length > 0) {
    createdTaskIds = Array.from(new Set([...createdTaskIds, ...fallbackTaskIds]));
  }
  const convertedClarificationTaskIds = await maybeConvertControllerClarificationToExecutionTask(
    controllerRun.id,
    sessionKey,
    recordedManifest,
    deps,
  );
  if (convertedClarificationTaskIds.length > 0) {
    createdTaskIds = Array.from(new Set([...createdTaskIds, ...convertedClarificationTaskIds]));
  }
  syncControllerRunClarifications(controllerRun.id, sessionKey, recordedManifest, deps);
  const reconciledTasks = reconcileControllerManifestTaskBindings(sessionKey, createdTaskIds, recordedManifest, controllerRun.id, deps);

  // ── Automatic Team Kickoff ────────────────────────────────────────────
  // For complex projects (3+ roles), automatically run a kickoff meeting
  // so every candidate role can assess the requirement collaboratively.
  // This happens AFTER the initial LLM pass so we know which roles are
  // needed, but we store the assessments for visibility and future
  // refinement passes.
  const AUTO_KICKOFF_ROLE_THRESHOLD = 3;
  const isFollowUp = options?.source === "task_follow_up";
  const kickoffHandler = deps.getKickoffHandler?.();
  if (
    !isFollowUp
    && kickoffHandler
    && recordedManifest.requiredRoles.length >= AUTO_KICKOFF_ROLE_THRESHOLD
    && !recordedManifest.clarificationsNeeded
  ) {
    deps.logger.info(
      `Controller: auto-kickoff triggered for ${recordedManifest.requiredRoles.length} roles: ${recordedManifest.requiredRoles.join(", ")}`,
    );
    recordControllerRunEvent(controllerRun.id, {
      type: "lifecycle",
      phase: "kickoff_started",
      source: "controller",
      status: "running",
      sessionKey,
      message: `Auto-kickoff: provisioning ${recordedManifest.requiredRoles.length} candidate roles for team assessment.`,
    }, deps);
    try {
      const kickoffResult = await kickoffHandler(
        recordedManifest.requiredRoles,
        recordedManifest.requiredRoles.length >= 5 ? "complex" : "medium",
        message,
      );
      // Store kickoff assessments on the manifest for UI/API visibility
      recordedManifest.kickoffPlan = {
        complexity: recordedManifest.requiredRoles.length >= 5 ? "complex" : "medium",
        candidateRoles: recordedManifest.requiredRoles,
        completed: true,
        assessments: kickoffResult.assessments,
        summary: kickoffResult.summary,
        triggeredAt: Date.now(),
      };
      updateControllerRun(controllerRun.id, deps, (run) => {
        if (run.manifest) {
          run.manifest.kickoffPlan = recordedManifest.kickoffPlan;
        }
        appendControllerRunEvent(run, {
          type: "lifecycle",
          phase: "kickoff_completed",
          source: "controller",
          status: "running",
          sessionKey,
          message: `Team kickoff completed: ${kickoffResult.assessments.length} assessments collected. ${kickoffResult.summary.slice(0, 200)}`,
        });
      });
      deps.logger.info(
        `Controller: auto-kickoff completed with ${kickoffResult.assessments.length} assessments`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.logger.warn(`Controller: auto-kickoff failed: ${errMsg}`);
      recordControllerRunEvent(controllerRun.id, {
        type: "lifecycle",
        phase: "kickoff_failed",
        source: "controller",
        status: "running",
        sessionKey,
        message: `Auto-kickoff failed: ${errMsg}. Proceeding with controller-only planning.`,
      }, deps);
    }
  }

  const latestTeamState = deps.getTeamState();
  const reply = buildControllerManifestReply(recordedManifest, reconciledTasks.taskIds, latestTeamState, rawReply);

  updateControllerRun(controllerRun.id, deps, (run) => {
    run.reply = reply;
    run.error = undefined;
    run.createdTaskIds = reconciledTasks.taskIds;
    appendControllerRunEvent(run, {
      type: "output",
      phase: "final_reply",
      source: "subagent",
      status: "running",
      sessionKey,
      runId: runResult.runId,
      message: reply,
    });
    if (reconciledTasks.linkedTaskIds.length > 0) {
      appendControllerRunEvent(run, {
        type: "lifecycle",
        phase: "tasks_linked",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: `Controller linked ${reconciledTasks.linkedTaskIds.length} existing task(s) into this workflow: ${reconciledTasks.linkedTaskIds.join(", ")}`,
      });
    }
    if (reconciledTasks.taskIds.length > 0) {
      appendControllerRunEvent(run, {
        type: "lifecycle",
        phase: "tasks_created",
        source: "controller",
        status: "running",
        sessionKey,
        runId: runResult.runId,
        message: `Controller activated ${reconciledTasks.taskIds.length} execution-ready task(s): ${reconciledTasks.taskIds.join(", ")}`,
      });
    }
    appendControllerRunEvent(run, {
      type: "lifecycle",
      phase: "run_completed",
      source: "controller",
      status: "completed",
      sessionKey,
      runId: runResult.runId,
      message: "Controller intake completed.",
    });
  });

  await pruneStaleControllerRuns(deps, { excludeRunId: controllerRun.id });

  return {
    sessionKey,
    runId: runResult.runId,
    reply,
    controllerRunId: controllerRun.id,
  };
}
