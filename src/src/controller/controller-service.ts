import type { OpenClawPluginApi, OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import os from "node:os";
import type { PluginConfig, TeamState } from "../types.js";
import { loadTeamState, saveTeamState } from "../state.js";
import { MDnsAdvertiser } from "../discovery.js";
import { WORKER_TIMEOUT_MS } from "../protocol.js";
import { createControllerHttpServer } from "./http-server.js";
import type { LocalWorkerManager } from "./local-worker-manager.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import { ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";
import { ensureControllerGitRepo } from "../git-collaboration.js";
import { WorkerProvisioningManager } from "./worker-provisioning.js";

export type ControllerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  localWorkerManager?: LocalWorkerManager;
  onTeamStateAvailable?: (getter: () => TeamState | null) => void;
};

function getPreferredLanUiUrl(port: number): string | null {
  const candidates: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (!record || record.internal || record.family !== "IPv4") {
        continue;
      }
      candidates.push(record.address);
    }
  }
  candidates.sort((left, right) => left.localeCompare(right));
  if (candidates.length === 0) {
    return null;
  }
  return `http://${candidates[0]}:${port}/ui`;
}

export function createControllerService(deps: ControllerServiceDeps): OpenClawPluginService {
  const { config, logger, localWorkerManager } = deps;
  let teamState: TeamState | null = null;
  let mdnsAdvertiser: MDnsAdvertiser;
  let taskRouter: TaskRouter;
  let messageRouter: MessageRouter;
  let wsServer: TeamWebSocketServer;
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;
  let workerProvisioningManager: WorkerProvisioningManager | null = null;

  return {
    id: "teamclaw-controller",
    async start(_ctx: OpenClawPluginServiceContext) {
      await ensureOpenClawWorkspaceMemoryDir(logger);
      const repoState = await ensureControllerGitRepo(config, logger).catch((err) => {
        logger.warn(`Controller: failed to prepare git collaboration repo: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      // Load or create team state
      teamState = await loadTeamState(config.teamName);
      let repoStateChanged = false;
      if (!teamState) {
        teamState = {
          teamName: config.teamName,
          workers: {},
          tasks: {},
          controllerRuns: {},
          messages: [],
          clarifications: {},
          repo: repoState ?? undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await saveTeamState(teamState);
        logger.info(`Controller: created new team "${config.teamName}"`);
      } else {
        const previousRepoState = JSON.stringify(teamState.repo ?? null);
        teamState.repo = repoState ?? teamState.repo;
        repoStateChanged = JSON.stringify(teamState.repo ?? null) !== previousRepoState;
        logger.info(`Controller: restored team "${config.teamName}" with ${Object.keys(teamState.workers).length} workers`);
      }
      deps.onTeamStateAvailable?.(() => teamState);

      const updateState = (updater: (state: TeamState) => void): TeamState => {
        updater(teamState!);
        void saveTeamState(teamState!);
        return teamState!;
      };

      workerProvisioningManager = new WorkerProvisioningManager({
        config,
        logger,
        getTeamState: () => teamState,
        updateTeamState: updateState,
      });

      if (
        repoStateChanged ||
        localWorkerManager?.syncState(teamState) ||
        workerProvisioningManager.syncState(teamState)
      ) {
        await saveTeamState(teamState);
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
        runtime: deps.runtime,
        getTeamState: () => teamState,
        updateTeamState: updateState,
        taskRouter,
        messageRouter,
        wsServer,
        localWorkerManager,
        workerProvisioningManager,
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(config.port, () => {
          logger.info(`Controller: HTTP server listening on port ${config.port}`);
          logger.info(`Controller: Web UI available at http://127.0.0.1:${config.port}/ui`);
          const lanUiUrl = getPreferredLanUiUrl(config.port);
          if (lanUiUrl) {
            logger.info(`Controller: Web UI available on LAN at ${lanUiUrl}`);
          }
          resolve();
        });
        server.on("error", reject);
      });

      if (localWorkerManager?.hasLocalWorkers()) {
        await localWorkerManager.start();
      }

      if (workerProvisioningManager.isEnabled()) {
        void workerProvisioningManager.requestReconcile("controller startup");
      }

      // Start timeout monitoring
      timeoutTimer = setInterval(() => {
        if (!teamState) return;

        let changed = false;
        const now = Date.now();

        for (const [workerId, worker] of Object.entries(teamState.workers)) {
          if (worker.status === "offline") continue;
          if (localWorkerManager?.isLocalWorker(worker)) {
            worker.lastHeartbeat = now;
            continue;
          }
          if (now - worker.lastHeartbeat > WORKER_TIMEOUT_MS) {
            logger.info(`Controller: worker ${workerId} timed out`);
            const activeTaskId = worker.currentTaskId;
            worker.status = "offline";
            worker.currentTaskId = undefined;
            changed = true;
            wsServer.broadcastUpdate({ type: "worker:offline", data: { workerId } });

            if (activeTaskId) {
              const task = teamState.tasks[activeTaskId];
              if (
                task &&
                task.assignedWorkerId === workerId &&
                task.status !== "completed" &&
                task.status !== "failed" &&
                task.status !== "blocked"
              ) {
                task.status = "pending";
                task.assignedWorkerId = undefined;
                task.updatedAt = now;
                wsServer.broadcastUpdate({ type: "task:updated", data: { ...task } });
              }
            }

            if (workerProvisioningManager?.hasManagedWorker(workerId)) {
              void workerProvisioningManager.onWorkerRemoved(workerId, "heartbeat timeout");
            }
          }
        }

        if (changed) {
          saveTeamState(teamState);
        }

        if (workerProvisioningManager?.isEnabled()) {
          void workerProvisioningManager.requestReconcile("periodic controller sync");
        }
      }, 15000);

      if (timeoutTimer) {
        const timer = timeoutTimer as unknown as { unref?: () => void };
        timer.unref?.();
      }
    },
    async stop() {
      deps.onTeamStateAvailable?.(() => null);
      if (timeoutTimer) {
        clearInterval(timeoutTimer);
        timeoutTimer = null;
      }
      if (localWorkerManager?.hasLocalWorkers()) {
        await localWorkerManager.stop();
      }
      if (workerProvisioningManager) {
        await workerProvisioningManager.stop();
      }
      wsServer.close();
      mdnsAdvertiser.stop();
      logger.info("Controller: stopped");
    },
  };
}
