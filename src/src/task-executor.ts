import type { OpenClawPluginApi, PluginLogger } from "../api.js";
import { getRole } from "./roles.js";
import type { RoleId, TaskAssignmentPayload, TaskExecutionEventInput } from "./types.js";

const TEAMCLAW_ROLE_IDS_TEXT = [
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
].join(", ");

const SESSION_PROGRESS_POLL_INTERVAL_MS = 1000;
const SESSION_PROGRESS_MESSAGE_LIMIT = 200;
const MAX_SESSION_PROGRESS_MESSAGE_CHARS = 4000;
const RUN_WAIT_SLICE_MS = 30_000;
const RATE_LIMIT_STALL_PROBE_MS = 5 * 60 * 1000;
const RATE_LIMIT_PROBE_TIMEOUT_MS = 60_000;
const BACKGROUND_WORK_PROBE_MS = 60_000;
const BACKGROUND_WORK_PROBE_TIMEOUT_MS = 60_000;
const CHILD_SESSION_PROGRESS_POLL_INTERVAL_MS = 5_000;
const RATE_LIMIT_WAITING_SENTINEL = "TEAMCLAW_STILL_WAITING";
const TOOL_CALL_BLOCK_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["tool_result", "tool_result_error"]);

type SessionProgressEntry = {
  fingerprint: string;
  message: string;
  phase: string;
  stream: string;
  isRateLimit: boolean;
};

type SessionProgressSnapshot = {
  fingerprints: string[];
  childSessionKeys: string[];
  childFingerprints: Map<string, string[]>;
  lastChildPollAt: number;
  lastAssistantMessage: string;
  latestMessages: unknown[];
};

type AssistantTurnSnapshot = {
  text: string;
  toolCalls: string[];
  yielded: boolean;
  backgroundPending: boolean;
};

export type TaskExecutorResult = {
  text: string;
  contract?: Record<string, unknown>;
};

export type RoleTaskExecutorDeps = {
  runtime: OpenClawPluginApi["runtime"];
  logger: PluginLogger;
  role: RoleId;
  taskTimeoutMs: number;
  getSessionKey: (assignment: TaskAssignmentPayload) => string;
  getIdempotencyKey?: (assignment: TaskAssignmentPayload) => string;
  reportExecutionEvent?: (taskId: string, event: TaskExecutionEventInput) => Promise<void> | void;
};

export function createRoleTaskExecutor(deps: RoleTaskExecutorDeps) {
  const { runtime, logger, role, taskTimeoutMs, getSessionKey, getIdempotencyKey, reportExecutionEvent } = deps;
  const roleDef = getRole(role);
  const roleSystemPrompt = roleDef
    ? roleDef.systemPrompt
    : `You are a ${role} in a virtual software team. Complete the assigned task.`;

  return async (taskDescription: string, assignment: TaskAssignmentPayload): Promise<TaskExecutorResult> => {
    const taskId = assignment.taskId;
    const sessionKey = getSessionKey(assignment);
    const idempotencyKey = getIdempotencyKey?.(assignment);
    const taskMessage = buildTaskMessage(taskDescription, taskId, roleDef?.label ?? role, {
      inlineContract: true,
      projectDir: assignment.projectDir,
    });
    logger.info(`TeamClaw: executing task ${taskId} as ${role} via subagent`);

    async function emitExecutionEvent(event: TaskExecutionEventInput): Promise<void> {
      if (!reportExecutionEvent) {
        return;
      }
      try {
        await Promise.resolve(reportExecutionEvent(taskId, {
          role,
          source: event.source ?? "worker",
          ...event,
        }));
      } catch (err) {
        logger.warn(`TeamClaw: failed to report execution event for task ${taskId}: ${String(err)}`);
      }
    }

    try {
      const runResult = await runtime.subagent.run({
        sessionKey,
        message: taskMessage,
        extraSystemPrompt: roleSystemPrompt,
        idempotencyKey,
      });

      logger.info(`TeamClaw: subagent run started for task ${taskId}, runId=${runResult.runId}`);
      await emitExecutionEvent({
        type: "lifecycle",
        phase: "run_started",
        source: "subagent",
        status: "running",
        runId: runResult.runId,
        sessionKey,
        message: `Subagent run started (${runResult.runId})`,
      });

      const progressSnapshot: SessionProgressSnapshot = {
        fingerprints: [],
        childSessionKeys: [],
        childFingerprints: new Map(),
        lastChildPollAt: 0,
        lastAssistantMessage: "",
        latestMessages: [],
      };
      const deadline = Date.now() + taskTimeoutMs;
      const rateLimitState: {
        active: boolean;
        visibleAt?: number;
        nextProbeAt?: number;
        probeCount: number;
      } = {
        active: false,
        probeCount: 0,
      };
      const backgroundWaitState: {
        active: boolean;
        visibleAt?: number;
        nextProbeAt?: number;
        probeCount: number;
      } = {
        active: false,
        probeCount: 0,
      };

      const markRateLimitWaiting = async (): Promise<void> => {
        if (rateLimitState.active) {
          return;
        }
        const now = Date.now();
        rateLimitState.active = true;
        rateLimitState.visibleAt = now;
        rateLimitState.nextProbeAt = now + RATE_LIMIT_STALL_PROBE_MS;
        await emitExecutionEvent({
          type: "progress",
          phase: "model_rate_limit_waiting",
          source: "worker",
          status: "running",
          runId: runResult.runId,
          sessionKey,
          message: "Model rate limit reached. OpenClaw is retrying upstream; TeamClaw will keep waiting for the task to continue.",
        });
      };

      const clearRateLimitWaiting = (): void => {
        rateLimitState.active = false;
        rateLimitState.visibleAt = undefined;
        rateLimitState.nextProbeAt = undefined;
      };

      const markBackgroundWorkWaiting = async (): Promise<void> => {
        if (backgroundWaitState.active) {
          return;
        }
        const now = Date.now();
        backgroundWaitState.active = true;
        backgroundWaitState.visibleAt = now;
        backgroundWaitState.nextProbeAt = now + BACKGROUND_WORK_PROBE_MS;
        await emitExecutionEvent({
          type: "progress",
          phase: "background_work_waiting",
          source: "worker",
          status: "running",
          runId: runResult.runId,
          sessionKey,
          message: "The worker ended its last turn while background work was still running. TeamClaw will keep checking until the real final deliverable is ready.",
        });
      };

      const clearBackgroundWorkWaiting = (): void => {
        backgroundWaitState.active = false;
        backgroundWaitState.visibleAt = undefined;
        backgroundWaitState.nextProbeAt = undefined;
      };

      const syncSessionProgress = async (): Promise<void> => {
        const sessionMessages = await runtime.subagent.getSessionMessages({
          sessionKey,
          limit: SESSION_PROGRESS_MESSAGE_LIMIT,
        });
        progressSnapshot.latestMessages = Array.isArray(sessionMessages.messages) ? sessionMessages.messages : [];

        const entries = buildSessionProgressEntries(progressSnapshot.latestMessages, taskMessage);
        const newEntries = getNewSessionProgressEntries(entries, progressSnapshot.fingerprints);
        progressSnapshot.fingerprints = entries.map((entry) => entry.fingerprint);
        progressSnapshot.childSessionKeys = mergeChildSessionKeys(
          progressSnapshot.childSessionKeys,
          collectChildSessionKeys(progressSnapshot.latestMessages),
        );

        for (const entry of newEntries) {
          if (entry.isRateLimit) {
            await markRateLimitWaiting();
            continue;
          }
          if (rateLimitState.active && isStillWaitingResponse(entry.message)) {
            continue;
          }
          if (rateLimitState.active && isInternalRetryPrompt(entry.message, entry.stream)) {
            continue;
          }
          if (rateLimitState.active) {
            clearRateLimitWaiting();
          }
          if (entry.stream === "assistant") {
            progressSnapshot.lastAssistantMessage = entry.message;
          }
          await emitExecutionEvent({
            type: "progress",
            phase: entry.phase,
            source: "subagent",
            stream: entry.stream,
            runId: runResult.runId,
            sessionKey,
            message: entry.message,
          });
        }

        if (Date.now() - progressSnapshot.lastChildPollAt >= CHILD_SESSION_PROGRESS_POLL_INTERVAL_MS) {
          progressSnapshot.lastChildPollAt = Date.now();
          const childRateLimitDetected = await syncChildSessionRateLimits(runtime, progressSnapshot);
          if (childRateLimitDetected) {
            await markRateLimitWaiting();
          }
        }
      };

      const extractSessionAssistantTurn = async (): Promise<AssistantTurnSnapshot> => {
        let turn = extractLastAssistantTurn(progressSnapshot.latestMessages);
        if (!turn.text && !turn.backgroundPending) {
          const sessionMessages = await runtime.subagent.getSessionMessages({
            sessionKey,
            limit: 100,
          });
          progressSnapshot.latestMessages = Array.isArray(sessionMessages.messages) ? sessionMessages.messages : [];
          turn = extractLastAssistantTurn(sessionMessages.messages);
        }
        return turn;
      };

      const probeRateLimitedTaskCompletion = async (): Promise<string | null> => {
        rateLimitState.probeCount += 1;
        const now = Date.now();
        rateLimitState.visibleAt = now;
        rateLimitState.nextProbeAt = now + RATE_LIMIT_STALL_PROBE_MS;
        await emitExecutionEvent({
          type: "progress",
          phase: "model_rate_limit_probe",
          source: "worker",
          status: "running",
          runId: runResult.runId,
          sessionKey,
          message: `Model rate limit has delayed task progress for over ${formatDuration(RATE_LIMIT_STALL_PROBE_MS)}. Re-checking whether the current task has already completed.`,
        });

        const probeRun = await runtime.subagent.run({
          sessionKey,
          message: buildRateLimitProbeMessage(taskId, roleDef?.label ?? role),
          extraSystemPrompt: roleSystemPrompt,
          idempotencyKey: `${idempotencyKey ?? `teamclaw-${taskId}`}:rate-limit-probe:${rateLimitState.probeCount}`,
        });
        const probeWait = await runtime.subagent.waitForRun({
          runId: probeRun.runId,
          timeoutMs: RATE_LIMIT_PROBE_TIMEOUT_MS,
        });

        try {
          await syncSessionProgress();
        } catch (err) {
          logger.debug?.(`TeamClaw: failed probe session sync for ${taskId}: ${String(err)}`);
        }

        if (probeWait.status !== "ok") {
          return null;
        }

        const probeTurn = await extractSessionAssistantTurn();
        if (!probeTurn.text || probeTurn.backgroundPending || isRateLimitMessage(probeTurn.text) || isStillWaitingResponse(probeTurn.text)) {
          await emitExecutionEvent({
            type: "progress",
            phase: "model_rate_limit_still_waiting",
            source: "worker",
            status: "running",
            runId: runResult.runId,
            sessionKey,
            message: "The task is still waiting on model availability. TeamClaw will continue waiting.",
          });
          return null;
        }

        clearRateLimitWaiting();
        return probeTurn.text;
      };

      const probeBackgroundTaskCompletion = async (): Promise<AssistantTurnSnapshot | null> => {
        backgroundWaitState.probeCount += 1;
        const now = Date.now();
        backgroundWaitState.visibleAt = now;
        backgroundWaitState.nextProbeAt = now + BACKGROUND_WORK_PROBE_MS;
        await emitExecutionEvent({
          type: "progress",
          phase: "background_work_probe",
          source: "worker",
          status: "running",
          runId: runResult.runId,
          sessionKey,
          message: `Background work has been running for over ${formatDuration(BACKGROUND_WORK_PROBE_MS)}. Re-checking whether the original task is now complete.`,
        });

        const probeRun = await runtime.subagent.run({
          sessionKey,
          message: buildBackgroundWorkProbeMessage(taskId, roleDef?.label ?? role),
          extraSystemPrompt: roleSystemPrompt,
          idempotencyKey: `${idempotencyKey ?? `teamclaw-${taskId}`}:background-work-probe:${backgroundWaitState.probeCount}`,
        });
        const probeWait = await runtime.subagent.waitForRun({
          runId: probeRun.runId,
          timeoutMs: Math.min(
            BACKGROUND_WORK_PROBE_TIMEOUT_MS,
            Math.max(1_000, deadline - Date.now()),
          ),
        });

        try {
          await syncSessionProgress();
        } catch (err) {
          logger.debug?.(`TeamClaw: failed background probe session sync for ${taskId}: ${String(err)}`);
        }

        if (probeWait.status !== "ok") {
          if (probeWait.status === "error" && isRateLimitMessage(probeWait.error || "")) {
            await markRateLimitWaiting();
          }
          return null;
        }

        const probeTurn = await extractSessionAssistantTurn();
        if (
          !probeTurn.text ||
          probeTurn.backgroundPending ||
          isRateLimitMessage(probeTurn.text) ||
          isStillWaitingResponse(probeTurn.text)
        ) {
          await emitExecutionEvent({
            type: "progress",
            phase: "background_work_still_waiting",
            source: "worker",
            status: "running",
            runId: runResult.runId,
            sessionKey,
            message: "The task is still waiting on background work. TeamClaw will continue waiting.",
          });
          return null;
        }

        clearBackgroundWorkWaiting();
        return probeTurn;
      };

      let keepPolling = true;
      const pollSessionProgress = (async () => {
        while (keepPolling) {
          try {
            await syncSessionProgress();
          } catch (err) {
            logger.debug?.(`TeamClaw: failed to sync session progress for ${taskId}: ${String(err)}`);
          }

          if (!keepPolling) {
            break;
          }
          await delay(SESSION_PROGRESS_POLL_INTERVAL_MS);
        }
      })();

      let waitResult;
      let completionOverride: string | null = null;
      try {
        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            waitResult = { status: "timeout" as const };
            break;
          }

          if (rateLimitState.active && (rateLimitState.nextProbeAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
            completionOverride = await probeRateLimitedTaskCompletion();
            if (completionOverride) {
              waitResult = { status: "ok" as const };
              break;
            }
          }

          const sliceTimeoutMs = Math.max(1_000, Math.min(RUN_WAIT_SLICE_MS, remainingMs));
          waitResult = await runtime.subagent.waitForRun({
            runId: runResult.runId,
            timeoutMs: sliceTimeoutMs,
          });

          if (waitResult.status === "ok") {
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
      } finally {
        keepPolling = false;
        await pollSessionProgress;
      }

      try {
        await syncSessionProgress();
      } catch (err) {
        logger.debug?.(`TeamClaw: failed final session progress sync for ${taskId}: ${String(err)}`);
      }

      if (waitResult.status === "ok") {
        let assistantTurn = completionOverride
          ? buildAssistantTurnSnapshot(completionOverride)
          : await extractSessionAssistantTurn();
        while (isBackgroundWorkPendingTurn(assistantTurn)) {
          await markBackgroundWorkWaiting();
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            waitResult = { status: "timeout" as const };
            break;
          }
          const nextProbeAt = backgroundWaitState.nextProbeAt ?? (Date.now() + BACKGROUND_WORK_PROBE_MS);
          const delayMs = Math.max(1_000, Math.min(nextProbeAt - Date.now(), remainingMs));
          await delay(delayMs);
          const probeTurn = await probeBackgroundTaskCompletion();
          if (probeTurn) {
            assistantTurn = probeTurn;
            break;
          }
          assistantTurn = await extractSessionAssistantTurn();
        }
        if (waitResult.status === "ok") {
          if (rateLimitState.active) {
            clearRateLimitWaiting();
          }
          const rawResult = assistantTurn.text;
          if (rawResult && normalizeComparableText(rawResult) !== normalizeComparableText(progressSnapshot.lastAssistantMessage)) {
            await emitExecutionEvent({
              type: "output",
              phase: "final_output",
              source: "subagent",
              message: rawResult,
            });
          }

          clearBackgroundWorkWaiting();

          // Extract inline result contract if present
          const extracted = extractInlineResultContract(rawResult);
          if (extracted) {
            logger.info(`TeamClaw: task ${taskId} — extracted inline result contract from ${role}`);
            return { text: extracted.cleanedText || rawResult, contract: extracted.contract };
          }
          logger.info(`TeamClaw: task ${taskId} completed successfully as ${role}`);
          return { text: rawResult };
        }
        clearBackgroundWorkWaiting();
      }

      if (waitResult.status === "timeout") {
        await emitExecutionEvent({
          type: "error",
          phase: "timeout",
          source: "subagent",
          status: "failed",
          message: `Task execution timed out after ${formatDuration(taskTimeoutMs)}`,
        });
        throw new Error(`Task execution timed out after ${formatDuration(taskTimeoutMs)}`);
      }

      await emitExecutionEvent({
        type: "error",
        phase: "run_failed",
        source: "subagent",
        status: "failed",
        message: waitResult.error || "Task execution failed",
      });
      throw new Error(waitResult.error || "Task execution failed");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await emitExecutionEvent({
        type: "error",
        phase: "execution_error",
        source: "worker",
        status: "failed",
        message: errorMsg,
      });
      logger.error(`TeamClaw: task ${taskId} execution failed for ${role}: ${errorMsg}`);
      throw err;
    }
  };
}

function formatDuration(timeoutMs: number): string {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildSessionProgressEntries(messages: unknown[], taskMessage: string): SessionProgressEntry[] {
  const entries: SessionProgressEntry[] = [];
  const normalizedTaskMessage = normalizeComparableText(taskMessage);

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

    const comparableMessage = normalizeComparableText(rendered.message);
    if (role === "user" && normalizedTaskMessage && comparableMessage.includes(normalizedTaskMessage)) {
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

function collectChildSessionKeys(messages: unknown[]): string[] {
  const keys = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .map((entry) => (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
            ? (entry as { text: string }).text
            : "")
          .filter(Boolean)
          .join("\n")
        : "";
    for (const match of text.matchAll(/"childSessionKey"\s*:\s*"([^"]+)"/g)) {
      const childSessionKey = match[1]?.trim();
      if (childSessionKey) {
        keys.add(childSessionKey);
      }
    }
  }
  return Array.from(keys);
}

function mergeChildSessionKeys(existing: string[], discovered: string[]): string[] {
  const keys = new Set(existing);
  for (const childSessionKey of discovered) {
    keys.add(childSessionKey);
  }
  return Array.from(keys);
}

async function syncChildSessionRateLimits(
  runtime: OpenClawPluginApi["runtime"],
  snapshot: SessionProgressSnapshot,
): Promise<boolean> {
  let detected = false;
  for (const childSessionKey of snapshot.childSessionKeys) {
    try {
      const sessionMessages = await runtime.subagent.getSessionMessages({
        sessionKey: childSessionKey,
        limit: SESSION_PROGRESS_MESSAGE_LIMIT,
      });
      const entries = buildSessionProgressEntries(sessionMessages.messages, "");
      const previousFingerprints = snapshot.childFingerprints.get(childSessionKey) ?? [];
      const newEntries = getNewSessionProgressEntries(entries, previousFingerprints);
      snapshot.childFingerprints.set(childSessionKey, entries.map((entry) => entry.fingerprint));
      if (newEntries.some((entry) => entry.isRateLimit)) {
        detected = true;
      }
    } catch (_err) {
      // Child session updates are best-effort only.
    }
  }
  return detected;
}

function getNewSessionProgressEntries(
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

function normalizeSessionRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "toolresult") {
    return "tool_result";
  }
  return normalized;
}

function renderSessionMessage(message: Record<string, unknown>, role: string): { message: string; stream: string } {
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

function normalizeBlockType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function truncateProgressMessage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= MAX_SESSION_PROGRESS_MESSAGE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SESSION_PROGRESS_MESSAGE_CHARS)}\n… (truncated)`;
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function buildTaskMessage(
  taskDescription: string,
  taskId: string,
  roleLabel: string,
  options?: { inlineContract?: boolean; projectDir?: string },
): string {
  const rules = [
    "- Deliver exactly the artifact requested by this task.",
    "- Follow the task verb literally: if the task asks for a brief, plan, matrix, review, package, positioning, or design artifact, produce that artifact and stop there.",
    "- Do NOT scaffold code, project structure, configs, or files unless the task explicitly asks for implementation work.",
    "- Do NOT create additional tasks, task trees, or duplicate follow-up work.",
    "- Do NOT re-scope this into a multi-role coordination workflow.",
    "- Do NOT delegate the core work of this task away to another role.",
    "- If Task Context includes recent completed deliverables, treat them as upstream inputs and search the shared workspace for any referenced task IDs or filenames before requesting clarification.",
    "- Do NOT attempt to inspect or resolve another worker's OpenClaw session or session key; those sessions are isolated per worker.",
    "- If the task includes a Recommended Skills section, use those skills first and prefer the exact listed slugs when searching for additional help.",
    "- Do NOT mark the task completed or failed via progress tools. Return the final deliverable (or raise an error) and let TeamClaw close the task.",
    "- If critical information is missing and you cannot proceed safely, request clarification and wait instead of guessing.",
    "- If more work is needed, mention it briefly in your result or use a handoff/review tool on this same task.",
    `- Do NOT use sessions_yield or end your turn while background work, coding agents, or process sessions are still running; if the task is not complete yet, reply with exactly ${RATE_LIMIT_WAITING_SENTINEL}.`,
    "- Never return 'running in background' as the final result for a TeamClaw task. If you spawn a helper session, keep monitoring it and only return after you have the actual deliverable.",
    "- Use structured fields on progress, review, handoff, and messaging tools whenever coordination is needed.",
    `- When naming a role, use exact TeamClaw role IDs: ${TEAMCLAW_ROLE_IDS_TEXT}.`,
  ];

  // Verification checklist — workers must verify before submitting results
  const verificationRules = [
    "",
    "## Verification Before Completion",
    "You MUST verify your work actually functions before submitting the result contract. A human team lead will review your deliverables — incomplete or broken work reflects poorly on the team.",
    "",
    "**For web applications (HTML/CSS/JS, React, Vue, etc.):**",
    "1. Start a local HTTP server in the project directory (e.g., `npx -y serve -l 3333` or `python3 -m http.server 3333`).",
    "2. Use `curl -s http://localhost:3333/` to confirm it returns valid HTML (not a 404 or error page).",
    "3. Check the HTML for basic correctness: no unclosed tags, JS `<script>` blocks parse without syntax errors.",
    "4. If the page uses JavaScript, run a quick syntax check: `node -e \"require('fs').readFileSync('index.html','utf8')\"` or similar.",
    "5. After verification, STOP the server process so the preview system can start its own.",
    "6. Report what you verified and the results in your completion summary.",
    "",
    "**For CLI tools / scripts:**",
    "- Run the tool with example arguments and include the actual terminal output in your result.",
    "- Test at least one success case and one error case (e.g., missing arguments, invalid input).",
    "",
    "**For Node.js / Python projects:**",
    "- Run `npm test` or `pytest` or the project's test command.",
    "- If no test suite exists, write a quick smoke test and run it.",
    "- For servers: start the server, hit a health endpoint with `curl`, confirm a 200 response, then stop it.",
    "",
    "**For REST API projects:**",
    "- Start the server and verify ALL API endpoints with `curl` (include POST with request body).",
    "- Confirm the OpenAPI/Swagger UI page is accessible: `curl -s http://localhost:<port>/swagger-ui/index.html` (or the framework-specific path) — it MUST return HTML, not 404.",
    "- If Swagger UI returns 404, fix the dependency/configuration before submitting.",
    "- After verification, STOP the server so the preview system can launch it on its own port.",
    "",
    "**For documents / designs:**",
    "- Re-read the document end-to-end and fix any incomplete sections or placeholders.",
    "- Ensure the document directly answers the original requirement — don't leave TODOs.",
    "- If the document references diagrams or external resources, verify the references are correct.",
    "",
    "**For all deliverables:**",
    "- List every file you created or modified in the result contract deliverables array.",
    "- CRITICAL: Only include deliverables from YOUR current task's project directory. NEVER reference files from other projects in the workspace.",
    "- If you see files from other projects in the workspace, ignore them completely — they belong to different tasks.",
    "- If something didn't work as expected, report it honestly in blockers rather than hiding it.",
    "- The human will see your verification output, so be thorough — this is your quality gate.",
  ];
  rules.push(...verificationRules);

  // Deliverable metadata guidance — enables preview system and user presentation
  const deliverableMetadataRules = [
    "",
    "## Deliverable Metadata (Critical for Preview System)",
    "TeamClaw can auto-launch web applications and expose preview URLs. For this to work, you MUST provide accurate metadata in your result contract deliverables:",
    "",
    "**Web applications (frontend, full-stack, APIs with UI):**",
    "```json",
    '{',
    '  "kind": "directory",',
    '  "value": "teamclaw/projects/<project>/",',
    '  "summary": "Express REST API with React frontend",',
    '  "artifactType": "web-app",',
    '  "previewCommand": "npm run dev -- --port {PORT}",',
    '  "previewCwd": "teamclaw/projects/<project>/",',
    '  "previewReadyPath": "/"',
    '}',
    "```",
    "- `previewCommand` MUST use `{PORT}` placeholder — the preview system injects the actual port.",
    "- `previewCwd` is relative to the workspace root. The system sets cwd automatically — do NOT include `cd` in the command.",
    "- Do NOT include venv setup, `source activate`, or `pip install` in previewCommand — the system auto-detects venvs and installs deps.",
    "- Keep previewCommand simple — just the server start command. Examples: `python -m uvicorn main:app --host 0.0.0.0 --port {PORT}`, `npm start -- --port {PORT}`",
    "",
    "**Static HTML sites (no build step):**",
    "- Set `artifactType: \"web-app\"` and leave `previewCommand` empty — the system auto-serves static files.",
    "",
    "**REST API projects (no frontend HTML):**",
    "You MUST include an interactive API documentation UI so the preview system can display it. This is critical — without it, the preview iframe shows a 404.",
    "⚠️ CRITICAL: `previewCommand` is REQUIRED for REST API deliverables. The system cannot start Python/Java/Go servers without it. Only Node.js projects with package.json scripts are auto-detected.",
    "```json",
    '{',
    '  "kind": "directory",',
    '  "value": "teamclaw/projects/<project>/",',
    '  "summary": "Spring Boot REST API with Swagger UI",',
    '  "artifactType": "rest-api",',
    '  "previewCommand": "mvn spring-boot:run -Dspring-boot.run.jvmArguments=\\"-Dserver.port={PORT}\\"",',
    '  "previewCwd": "teamclaw/projects/<project>/",',
    '  "previewReadyPath": "/swagger-ui/index.html"',
    '}',
    "```",
    "Technology-specific OpenAPI setup AND previewCommand (MANDATORY for all REST API projects):",
    "- **Java Spring Boot**: dep `springdoc-openapi-starter-webmvc-ui:2.8.6`; `previewCommand`: `mvn spring-boot:run -Dspring-boot.run.jvmArguments=\"-Dserver.port={PORT}\"`, `previewReadyPath`: `/swagger-ui/index.html`",
    "- **Node.js Express**: `swagger-ui-express` + `swagger-jsdoc` → `/api-docs`; `previewCommand`: `npm start -- --port {PORT}`, `previewReadyPath`: `/api-docs`",
    "- **Python FastAPI**: Built-in; `previewCommand`: `python -m uvicorn main:app --host 0.0.0.0 --port {PORT}`, `previewReadyPath`: `/docs`",
    "- **Python Flask**: `flask-restx` or `flasgger` → `/apidocs`; `previewCommand`: `python -m flask --app app run --host 0.0.0.0 --port {PORT}`, `previewReadyPath`: `/apidocs`",
    "- **Go (Gin/Echo)**: `swaggo/swag` + `gin-swagger`; `previewCommand`: `go run . --port {PORT}`, `previewReadyPath`: `/swagger/index.html`",
    "- `previewReadyPath` MUST point to the Swagger/OpenAPI UI page, NOT `/` (which returns 404 for pure APIs).",
    "",
    "**CLI tools / scripts:**",
    "- Use `kind: \"file\"`, include sample invocation and output in `summary`.",
    '- Example summary: "Run with: python3 rename_images.py --directory ./photos --execute"',
    "",
    "**Design documents / reports:**",
    "- Use `kind: \"file\"` with `artifactType: \"document\"`.",
    "- Include the key decisions or structure overview in `summary`.",
  ];
  rules.push(...deliverableMetadataRules);

  if (options?.inlineContract) {
    rules.push(
      "- IMPORTANT: At the very end of your reply, you MUST include a structured result contract as a fenced JSON block. This is how TeamClaw understands your result — without it, your work cannot be routed to the next step. Use this exact format:",
      "",
      "```teamclaw-result-contract",
      JSON.stringify({
        outcome: "completed|failed|blocked",
        summary: "One-sentence summary of what was accomplished",
        deliverables: [{ kind: "file|directory|command|artifact|note", value: "path or description", summary: "optional note" }],
        keyPoints: ["Important decisions or findings"],
        blockers: ["Any unresolved blockers (empty array if none)"],
        followUps: [{ type: "review|handoff|clarification|downstream-task", targetRole: "role-id", reason: "why" }],
        questions: ["Open questions (empty array if none)"],
        discoveredPatterns: ["Reusable codebase patterns found during this task"],
        notes: "Optional extra delivery notes",
      }, null, 2),
      "```",
      "",
      "  Replace the placeholder values with real data from your work. The `outcome`, `summary`, and `deliverables` fields are required. Use `[]` for empty arrays. The fenced block MUST use the `teamclaw-result-contract` language tag.",
    );
  } else {
    rules.push(
      "- Before your final reply, submit a structured worker result contract with teamclaw_submit_result_contract so TeamClaw can route the next step without parsing prose.",
    );
  }

  const sections = [
    taskDescription,
    "",
    "## Task Context",
    `Reference: ${taskId}`,
    `Assigned Role: ${roleLabel}`,
  ];

  if (options?.projectDir) {
    sections.push(
      "",
      "## Working Directory",
      `This task's project directory is: \`teamclaw/projects/${options.projectDir}/\``,
      "All files you create, read, or modify for this task MUST be inside this directory.",
      "If the directory is empty, create the necessary structure. If it already has files from prior tasks in the same project, build on them.",
      "Do NOT place files in the workspace root or any other project's directory.",
    );
  }

  sections.push("", "## Execution Rules", ...rules);
  return sections.join("\n");
}

/**
 * Extract an inline result contract from a fenced ```teamclaw-result-contract block.
 * Returns the parsed contract and the text with the block removed, or null if
 * no valid contract is found.
 */
export function extractInlineResultContract(text: string): {
  contract: Record<string, unknown>;
  cleanedText: string;
} | null {
  // Match ```teamclaw-result-contract ... ``` blocks (greedy last match)
  const pattern = /```teamclaw-result-contract\s*\n([\s\S]*?)```/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return null;
  }
  const jsonStr = lastMatch[1]!.trim();
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    // Remove the contract block from the text for a clean result
    const cleanedText = text.slice(0, lastMatch.index).trimEnd()
      + text.slice(lastMatch.index + lastMatch[0].length).trimStart();
    return { contract: parsed, cleanedText: cleanedText.trim() };
  } catch {
    return null;
  }
}

function buildRateLimitProbeMessage(taskId: string, roleLabel: string): string {
  return [
    `This is a follow-up check for task ${taskId} (${roleLabel}).`,
    "The earlier run appears to be delayed by upstream model rate limiting.",
    "Do not restart the task from scratch.",
    "If the original task is fully complete now, immediately submit the structured result contract and provide the final result for that original task.",
    `If the original task is not complete yet, reply with exactly ${RATE_LIMIT_WAITING_SENTINEL}.`,
  ].join("\n");
}

function buildBackgroundWorkProbeMessage(taskId: string, roleLabel: string): string {
  return [
    `This is a follow-up check for task ${taskId} (${roleLabel}).`,
    "Your previous turn ended while background work was still running.",
    "Do not restart the task from scratch.",
    "Inspect the background coding or process session you previously started, continue from the existing workspace/session state, and only finalize once the original task deliverable is genuinely complete.",
    "Do not call sessions_yield again unless you are still explicitly waiting on unfinished background work.",
    "If the original task is fully complete now, immediately submit the structured result contract and provide the final result for that original task.",
    `If the original task is not complete yet, reply with exactly ${RATE_LIMIT_WAITING_SENTINEL}.`,
  ].join("\n");
}

function buildAssistantTurnSnapshot(text: string, toolCalls: string[] = []): AssistantTurnSnapshot {
  const normalizedText = String(text || "").trim();
  const normalizedToolCalls = toolCalls
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
  const yielded = normalizedToolCalls.includes("sessions_yield");
  return {
    text: normalizedText,
    toolCalls: normalizedToolCalls,
    yielded,
    backgroundPending: yielded || isBackgroundWorkPendingMessage(normalizedText),
  };
}

function extractLastAssistantTurn(messages: unknown[]): AssistantTurnSnapshot {
  const assistantMessages = messages.filter((message): message is { role?: unknown; content?: unknown } => {
    if (!message || typeof message !== "object") {
      return false;
    }
    return (message as { role?: unknown }).role === "assistant";
  });

  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  if (!lastAssistant) {
    return buildAssistantTurnSnapshot("");
  }

  if (typeof lastAssistant.content === "string") {
    return buildAssistantTurnSnapshot(lastAssistant.content);
  }

  if (Array.isArray(lastAssistant.content)) {
    const textBlocks = lastAssistant.content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
      })
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean);
    const toolCalls = lastAssistant.content
      .filter((block): block is { type?: unknown; name?: unknown } => {
        return !!block
          && typeof block === "object"
          && TOOL_CALL_BLOCK_TYPES.has(normalizeBlockType((block as { type?: unknown }).type));
      })
      .map((block) => (typeof block.name === "string" ? block.name : ""))
      .filter(Boolean);
    if (textBlocks.length > 0 || toolCalls.length > 0) {
      return buildAssistantTurnSnapshot(textBlocks.join("\n"), toolCalls);
    }
  }

  return buildAssistantTurnSnapshot(JSON.stringify(lastAssistant));
}

function isRateLimitMessage(value: string): boolean {
  return /(rate[_ ]limit|too many requests|429\b|resource has been exhausted|tokens per day|quota|throttl)/i.test(
    String(value || ""),
  );
}

function isStillWaitingResponse(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return true;
  }
  if (normalized === RATE_LIMIT_WAITING_SENTINEL) {
    return true;
  }
  return /(still waiting|continue waiting|not complete yet|尚未完成|继续等待|仍在等待)/i.test(normalized);
}

function isInternalRetryPrompt(value: string, stream?: string): boolean {
  if (stream !== "user") {
    return false;
  }
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  return /continue where you left off\. the previous model attempt failed or timed out\./i.test(normalized);
}

function isBackgroundWorkPendingMessage(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  return /(running in background|background session|command still running \(session|monitor progress and report back when complete|后台.*运行中|后台.*会在完成后汇报|后台.*完成后再汇报)/i.test(
    normalized,
  );
}

function isBackgroundWorkPendingTurn(turn: AssistantTurnSnapshot): boolean {
  return turn.backgroundPending || isStillWaitingResponse(turn.text);
}
