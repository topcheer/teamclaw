import type { OpenClawPluginApi, PluginLogger } from "../api.js";
import { getRole } from "./roles.js";
import type { RoleId, TaskExecutionEventInput } from "./types.js";

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
const TOOL_CALL_BLOCK_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["tool_result", "tool_result_error"]);

type SessionProgressEntry = {
  fingerprint: string;
  message: string;
  phase: string;
  stream: string;
};

type SessionProgressSnapshot = {
  fingerprints: string[];
  lastAssistantMessage: string;
  latestMessages: unknown[];
};

export type RoleTaskExecutorDeps = {
  runtime: OpenClawPluginApi["runtime"];
  logger: PluginLogger;
  role: RoleId;
  taskTimeoutMs: number;
  getSessionKey: (taskId: string) => string;
  getIdempotencyKey?: (taskId: string) => string;
  reportExecutionEvent?: (taskId: string, event: TaskExecutionEventInput) => Promise<void> | void;
};

export function createRoleTaskExecutor(deps: RoleTaskExecutorDeps) {
  const { runtime, logger, role, taskTimeoutMs, getSessionKey, getIdempotencyKey, reportExecutionEvent } = deps;
  const roleDef = getRole(role);
  const roleSystemPrompt = roleDef
    ? roleDef.systemPrompt
    : `You are a ${role} in a virtual software team. Complete the assigned task.`;

  return async (taskDescription: string, taskId: string): Promise<string> => {
    const sessionKey = getSessionKey(taskId);
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
        idempotencyKey: getIdempotencyKey?.(taskId),
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
        lastAssistantMessage: "",
        latestMessages: [],
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

        for (const entry of newEntries) {
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
      try {
        waitResult = await runtime.subagent.waitForRun({
          runId: runResult.runId,
          timeoutMs: taskTimeoutMs,
        });
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
        let result = extractLastAssistantText(progressSnapshot.latestMessages);
        if (!result) {
          const sessionMessages = await runtime.subagent.getSessionMessages({
            sessionKey,
            limit: 100,
          });
          result = extractLastAssistantText(sessionMessages.messages);
        }
        if (result && normalizeComparableText(result) !== normalizeComparableText(progressSnapshot.lastAssistantMessage)) {
          await emitExecutionEvent({
            type: "output",
            phase: "final_output",
            source: "subagent",
            message: result,
          });
        }

        logger.info(`TeamClaw: task ${taskId} completed successfully as ${role}`);
        return result;
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
    });
  }

  return entries;
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
    "- Use structured fields on progress, review, handoff, and messaging tools whenever coordination is needed.",
    `- When naming a role, use exact TeamClaw role IDs: ${TEAMCLAW_ROLE_IDS_TEXT}.`,
  ].join("\n");
}

function extractLastAssistantText(messages: unknown[]): string {
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
