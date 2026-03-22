import http from "node:http";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import type { PluginConfig, WorkerIdentity } from "../types.js";
import { createHeartbeatPayload } from "../protocol.js";
import { IdentityManager } from "../identity.js";
import { MessageQueue } from "./message-queue.js";
import { createWorkerHttpHandler } from "./http-handler.js";

export type WorkerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  onIdentityEstablished: (identity: WorkerIdentity) => void;
  taskExecutor?: (taskDescription: string, taskId: string) => Promise<string>;
};

export function createWorkerService(deps: WorkerServiceDeps): OpenClawPluginService {
  const { config, logger, onIdentityEstablished, taskExecutor: externalTaskExecutor } = deps;
  let identityManager: IdentityManager;
  let messageQueue: MessageQueue;
  let server: http.Server | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let controllerUrl: string | null = null;
  let workerId: string | null = null;

  function reportTaskResult(taskId: string, result: string, error: string | null): void {
    if (!controllerUrl) return;
    fetch(`${controllerUrl}/api/v1/tasks/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, error }),
    }).catch((err) => {
      logger.error(`Worker: failed to report task result: ${String(err)}`);
    });
  }

  async function startServer(): Promise<void> {
    const handler = createWorkerHttpHandler(
      { role: config.role, port: config.port },
      logger,
      messageQueue,
      workerId ?? "",
      externalTaskExecutor,
      reportTaskResult,
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
      messageQueue = new MessageQueue();
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
        // Restart server with worker ID and task executor
        await startServer();
        onIdentityEstablished(identity);
      }

      // Start heartbeat
      heartbeatTimer = setInterval(async () => {
        if (!identityManager.hasIdentity()) {
          const newIdentity = await identityManager.register();
          if (newIdentity && !controllerUrl) {
            controllerUrl = newIdentity.controllerUrl;
            workerId = newIdentity.workerId;
            await startServer();
            onIdentityEstablished(newIdentity);
          }
          return;
        }

        const id = identityManager.getIdentity();
        if (!id || !controllerUrl) return;

        try {
          const heartbeat = createHeartbeatPayload(id.workerId, "idle");
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
        heartbeatTimer.unref();
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
