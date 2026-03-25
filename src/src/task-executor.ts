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

  return async (taskDescription: string, assignment: TaskAssignmentPayload): Promise<string> => {
    const taskId = assignment.taskId;
    const sessionKey = getSessionKey(assignment);
    const idempotencyKey = getIdempotencyKey?.(assignment);
    const taskMessage = buildTaskMessage(taskDescription, taskId, roleDef?.label ?? role);
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
          const result = assistantTurn.text;
          if (result && normalizeComparableText(result) !== normalizeComparableText(progressSnapshot.lastAssistantMessage)) {
            await emitExecutionEvent({
              type: "output",
              phase: "final_output",
              source: "subagent",
              message: result,
            });
          }

          clearBackgroundWorkWaiting();
          logger.info(`TeamClaw: task ${taskId} completed successfully as ${role}`);
          return result;
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

function buildTaskMessage(taskDescription: string, taskId: string, roleLabel: string): string {
  return [
    taskDescription,
    "",
    "## Task Context",
    `Reference: ${taskId}`,
    `Assigned Role: ${roleLabel}`,
    "",
    "## Execution Rules",
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
    "- Before your final reply, submit a structured worker result contract with teamclaw_submit_result_contract so TeamClaw can route the next step without parsing prose.",
    `- Do NOT use sessions_yield or end your turn while background work, coding agents, or process sessions are still running; if the task is not complete yet, reply with exactly ${RATE_LIMIT_WAITING_SENTINEL}.`,
    "- Never return 'running in background' as the final result for a TeamClaw task. If you spawn a helper session, keep monitoring it and only return after you have the actual deliverable.",
    "- Use structured fields on progress, review, handoff, and messaging tools whenever coordination is needed.",
    `- When naming a role, use exact TeamClaw role IDs: ${TEAMCLAW_ROLE_IDS_TEXT}.`,
  ].join("\n");
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
