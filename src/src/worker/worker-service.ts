import http from "node:http";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import type { PluginConfig, TaskAssignmentPayload, WorkerIdentity } from "../types.js";
import { createHeartbeatPayload } from "../protocol.js";
import { IdentityManager } from "../identity.js";
import { MessageQueue } from "./message-queue.js";
import { createWorkerHttpHandler } from "./http-handler.js";
import { buildTeamClawAgentSessionKey, ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";

export type TaskExecutorResultLike = string | { text: string; contract?: Record<string, unknown> };

export type WorkerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  onIdentityEstablished: (identity: WorkerIdentity) => void;
  taskExecutor?: (taskDescription: string, assignment: TaskAssignmentPayload) => Promise<TaskExecutorResultLike>;
  prepareTaskAssignment?: (assignment: TaskAssignmentPayload) => Promise<void> | void;
  publishTaskAssignment?: (assignment: TaskAssignmentPayload, result: string) => Promise<void> | void;
  cancelTaskExecution?: (taskId: string, sessionKey?: string) => Promise<boolean> | boolean;
  messageQueue?: MessageQueue;
};

export function createWorkerService(deps: WorkerServiceDeps): OpenClawPluginService {
  const { config, logger, onIdentityEstablished, taskExecutor: externalTaskExecutor } = deps;
  let identityManager: IdentityManager;
  let messageQueue: MessageQueue;
  let server: http.Server | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let controllerUrl: string | null = null;
  let workerId: string | null = null;
  let activeTaskId: string | undefined;
  const activeTaskSessionKeys = new Map<string, string>();
  const cancelledTaskIds = new Set<string>();

  const taskExecutor = externalTaskExecutor
    ? async (assignment: TaskAssignmentPayload): Promise<{ text: string; contract?: Record<string, unknown> }> => {
        const taskId = assignment.taskId;
        cancelledTaskIds.delete(taskId);
        activeTaskId = taskId;
        activeTaskSessionKeys.set(taskId, assignment.executionSessionKey || buildTeamClawAgentSessionKey(`teamclaw-task-${taskId}`));
        try {
          await deps.prepareTaskAssignment?.(assignment);
          const taskPrompt = [assignment.title.trim(), assignment.description.trim()].filter(Boolean).join("\n\n");
          const raw = await externalTaskExecutor(taskPrompt, assignment);
          if (cancelledTaskIds.has(taskId)) {
            throw new Error("Task execution cancelled by controller");
          }
          const result = typeof raw === "string" ? { text: raw } : raw;
          await deps.publishTaskAssignment?.(assignment, result.text);
          return result;
        } finally {
          activeTaskId = undefined;
          activeTaskSessionKeys.delete(taskId);
          if (!cancelledTaskIds.has(taskId)) {
            cancelledTaskIds.delete(taskId);
          }
        }
      }
    : undefined;

  function reportTaskResult(taskId: string, result: string, error: string | null, contract?: Record<string, unknown>): void {
    if (cancelledTaskIds.has(taskId)) {
      logger.info(`Worker: suppressing result report for cancelled task ${taskId}`);
      return;
    }
    if (!controllerUrl) return;
    const body: Record<string, unknown> = { result, error, workerId };
    if (contract) {
      body.resultContract = contract;
    }
    fetch(`${controllerUrl}/api/v1/tasks/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((err) => {
      logger.error(`Worker: failed to report task result: ${String(err)}`);
    });
  }

  async function cancelAssignedTask(taskId: string): Promise<boolean> {
    if (activeTaskId !== taskId) {
      return false;
    }

    cancelledTaskIds.add(taskId);
    try {
      const cancelled = await deps.cancelTaskExecution?.(taskId, activeTaskSessionKeys.get(taskId));
      return cancelled ?? true;
    } catch (err) {
      logger.warn(`Worker: failed to cancel task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  function isTaskCancelled(taskId: string): boolean {
    return cancelledTaskIds.has(taskId);
  }

  async function startServer(): Promise<void> {
    // Kickoff assessor — uses the worker's subagent runtime for lightweight assessment
    const kickoffAssessor = externalTaskExecutor
      ? async (requirement: string, role: string): Promise<Record<string, unknown>> => {
          const { buildKickoffAssessmentPrompt } = await import("../controller/kickoff-orchestrator.js");
          const prompt = buildKickoffAssessmentPrompt(role as import("../types.js").RoleId, requirement);
          const sessionKey = buildTeamClawAgentSessionKey(`teamclaw-kickoff-${role}-${Date.now()}`);
          const raw = await externalTaskExecutor(prompt, {
            taskId: `kickoff-${role}`,
            title: `Kickoff Assessment (${role})`,
            description: prompt,
            executionSessionKey: sessionKey,
          });
          const text = typeof raw === "string" ? raw : raw.text;
          // Parse the JSON response
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
          const jsonStr = jsonMatch?.[1]?.trim() ?? text.trim();
          try {
            const parsed = JSON.parse(jsonStr);
            return {
              role,
              needed: Boolean(parsed.needed),
              scope: String(parsed.scope ?? ""),
              suggestedTasks: Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks : [],
              dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
              risks: Array.isArray(parsed.risks) ? parsed.risks : [],
              questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            };
          } catch {
            return { role, needed: false, scope: `Could not parse: ${text.slice(0, 200)}`, suggestedTasks: [], dependencies: [], risks: [], questions: [] };
          }
        }
      : undefined;

    const handler = createWorkerHttpHandler(
        { role: config.role, port: config.port },
        logger,
        messageQueue,
        workerId ?? "",
        taskExecutor,
        reportTaskResult,
        cancelAssignedTask,
        isTaskCancelled,
        kickoffAssessor,
      );

    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }

    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server!.listen(config.port, () => {
        logger.info(`Worker: HTTP server listening on port ${config.port}`);
        resolve();
      });
      server!.on("error", reject);
    });
  }

  return {
    id: "teamclaw-worker",
    async start(_ctx: OpenClawPluginServiceContext) {
      await ensureOpenClawWorkspaceMemoryDir(logger);

      messageQueue = deps.messageQueue ?? new MessageQueue();
      identityManager = new IdentityManager(config, logger);

      // Start HTTP server initially (without identity)
      await startServer();

      // Register with controller
      const identity = await identityManager.register();
      if (!identity) {
        logger.warn("Worker: could not register with controller, will retry on next heartbeat");
      } else {
        controllerUrl = identity.controllerUrl;
        workerId = identity.workerId;
        onIdentityEstablished(identity);
        // Restart server with worker ID and task executor
        await startServer();
      }

      // Start heartbeat
      heartbeatTimer = setInterval(async () => {
        if (!identityManager.hasIdentity()) {
          const newIdentity = await identityManager.register();
          if (newIdentity && !controllerUrl) {
            controllerUrl = newIdentity.controllerUrl;
            workerId = newIdentity.workerId;
            onIdentityEstablished(newIdentity);
            await startServer();
          }
          return;
        }

        const id = identityManager.getIdentity();
        if (!id || !controllerUrl) return;

        try {
          const heartbeat = createHeartbeatPayload(
            id.workerId,
            activeTaskId ? "busy" : "idle",
            activeTaskId,
          );
          const res = await fetch(`${controllerUrl}/api/v1/workers/${id.workerId}/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(heartbeat),
          });

          if (!res.ok) {
            logger.warn(`Worker: heartbeat failed (${res.status})`);
          }
        } catch (err) {
          logger.warn(`Worker: heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, config.heartbeatIntervalMs);

      if (heartbeatTimer) {
        const timer = heartbeatTimer as unknown as { unref?: () => void };
        timer.unref?.();
      }
    },
    async stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      if (identityManager) {
        await identityManager.clear();
      }
      logger.info("Worker: stopped");
    },
  };
}
