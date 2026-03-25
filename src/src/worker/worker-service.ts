import http from "node:http";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import type { PluginConfig, TaskAssignmentPayload, WorkerIdentity } from "../types.js";
import { createHeartbeatPayload } from "../protocol.js";
import { IdentityManager } from "../identity.js";
import { MessageQueue } from "./message-queue.js";
import { createWorkerHttpHandler } from "./http-handler.js";
import { ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";

export type WorkerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  onIdentityEstablished: (identity: WorkerIdentity) => void;
  taskExecutor?: (taskDescription: string, assignment: TaskAssignmentPayload) => Promise<string>;
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
    ? async (assignment: TaskAssignmentPayload): Promise<string> => {
        const taskId = assignment.taskId;
        cancelledTaskIds.delete(taskId);
        activeTaskId = taskId;
        activeTaskSessionKeys.set(taskId, assignment.executionSessionKey || `teamclaw-task-${taskId}`);
        try {
          await deps.prepareTaskAssignment?.(assignment);
          const taskPrompt = [assignment.title.trim(), assignment.description.trim()].filter(Boolean).join("\n\n");
          const result = await externalTaskExecutor(taskPrompt, assignment);
          if (cancelledTaskIds.has(taskId)) {
            throw new Error("Task execution cancelled by controller");
          }
          await deps.publishTaskAssignment?.(assignment, result);
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

  function reportTaskResult(taskId: string, result: string, error: string | null): void {
    if (cancelledTaskIds.has(taskId)) {
      logger.info(`Worker: suppressing result report for cancelled task ${taskId}`);
      return;
    }
    if (!controllerUrl) return;
    fetch(`${controllerUrl}/api/v1/tasks/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, error, workerId }),
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
    const handler = createWorkerHttpHandler(
        { role: config.role, port: config.port },
        logger,
        messageQueue,
        workerId ?? "",
        taskExecutor,
        reportTaskResult,
        cancelAssignedTask,
        isTaskCancelled,
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
