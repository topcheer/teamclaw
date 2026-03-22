import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import type { PluginConfig, TeamState } from "../types.js";
import { loadTeamState, saveTeamState } from "../state.js";
import { MDnsAdvertiser } from "../discovery.js";
import { WORKER_TIMEOUT_MS } from "../protocol.js";
import { createControllerHttpServer } from "./http-server.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";

export type ControllerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
};

export function createControllerService(deps: ControllerServiceDeps): OpenClawPluginService {
  const { config, logger } = deps;
  let teamState: TeamState | null = null;
  let mdnsAdvertiser: MDnsAdvertiser;
  let taskRouter: TaskRouter;
  let messageRouter: MessageRouter;
  let wsServer: TeamWebSocketServer;
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;

  return {
    id: "teamclaw-controller",
    async start(_ctx: OpenClawPluginServiceContext) {
      // Load or create team state
      teamState = await loadTeamState(config.teamName);
      if (!teamState) {
        teamState = {
          teamName: config.teamName,
          workers: {},
          tasks: {},
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await saveTeamState(teamState);
        logger.info(`Controller: created new team "${config.teamName}"`);
      } else {
        logger.info(`Controller: restored team "${config.teamName}" with ${Object.keys(teamState.workers).length} workers`);
      }

      mdnsAdvertiser = new MDnsAdvertiser(logger);
      taskRouter = new TaskRouter(logger);
      messageRouter = new MessageRouter(logger);
      wsServer = new TeamWebSocketServer(logger);

      // Start mDNS advertising
      await mdnsAdvertiser.start(config.port, config.teamName);

      // Start HTTP server
      const server = createControllerHttpServer({
        config,
        logger,
        getTeamState: () => teamState,
        updateTeamState: (updater) => {
          updater(teamState!);
          saveTeamState(teamState!);
          return teamState!;
        },
        taskRouter,
        messageRouter,
        wsServer,
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(config.port, () => {
          logger.info(`Controller: HTTP server listening on port ${config.port}`);
          logger.info(`Controller: Web UI available at http://localhost:${config.port}/ui`);
          resolve();
        });
        server.on("error", reject);
      });

      // Start timeout monitoring
      timeoutTimer = setInterval(() => {
        if (!teamState) return;

        let changed = false;
        const now = Date.now();

        for (const [workerId, worker] of Object.entries(teamState.workers)) {
          if (worker.status === "offline") continue;
          if (now - worker.lastHeartbeat > WORKER_TIMEOUT_MS) {
            logger.info(`Controller: worker ${workerId} timed out`);
            worker.status = "offline";
            changed = true;
            wsServer.broadcastUpdate({ type: "worker:offline", data: { workerId } });
          }
        }

        if (changed) {
          saveTeamState(teamState);
        }
      }, 15000);

      if (timeoutTimer) {
        timeoutTimer.unref();
      }
    },
    async stop() {
      if (timeoutTimer) {
        clearInterval(timeoutTimer);
        timeoutTimer = null;
      }
      wsServer.close();
      mdnsAdvertiser.stop();
      logger.info("Controller: stopped");
    },
  };
}
