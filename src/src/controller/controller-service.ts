import type { OpenClawPluginApi, OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import os from "node:os";
import fs from "node:fs";
import { exec } from "node:child_process";
import type { PluginConfig, TeamState } from "../types.js";
import { loadTeamState, saveTeamState } from "../state.js";
import { MDnsAdvertiser } from "../discovery.js";
import { WORKER_TIMEOUT_MS } from "../protocol.js";
import { createControllerHttpServer } from "./http-server.js";
import type { LocalWorkerManager } from "./local-worker-manager.js";
import type { InProcessWorkerManager } from "./in-process-worker-manager.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import { ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";
import { ensureControllerGitRepo } from "../git-collaboration.js";
import { WorkerProvisioningManager } from "./worker-provisioning.js";
import { PreviewManager } from "./preview-manager.js";

export type ControllerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  localWorkerManager?: LocalWorkerManager;
  inProcessWorkerManager?: InProcessWorkerManager;
  onTeamStateAvailable?: (getter: () => TeamState | null) => void;
  /** Called once the HTTP server has bound to an actual port. */
  onActualPort?: (port: number) => void;
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
  const { config, logger, localWorkerManager, inProcessWorkerManager } = deps;
  let teamState: TeamState | null = null;
  let mdnsAdvertiser: MDnsAdvertiser;
  let taskRouter: TaskRouter;
  let messageRouter: MessageRouter;
  let wsServer: TeamWebSocketServer;
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;
  let workerProvisioningManager: WorkerProvisioningManager | null = null;
  let previewManager: PreviewManager;

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

      previewManager = new PreviewManager({
        logger,
        getTeamState: () => teamState,
        updateTeamState: updateState,
      });

      // Run ALL syncState calls (avoid || short-circuit skipping some).
      const syncA = localWorkerManager?.syncState(teamState) ?? false;
      const syncB = inProcessWorkerManager?.syncState(teamState) ?? false;
      const syncC = workerProvisioningManager.syncState(teamState);
      if (repoStateChanged || syncA || syncB || syncC) {
        await saveTeamState(teamState);
      }

      // Clean up orphaned tasks — tasks assigned to workers that no longer
      // exist OR that are offline (stale entries surviving from a previous run).
      {
        let orphanCleaned = false;
        for (const task of Object.values(teamState.tasks)) {
          if (
            task.assignedWorkerId &&
            (task.status === "assigned" || task.status === "in_progress")
          ) {
            const worker = teamState.workers[task.assignedWorkerId];
            if (!worker || worker.status === "offline") {
              logger.info(`Controller: resetting orphaned task ${task.id} (worker ${task.assignedWorkerId} ${worker ? "offline" : "missing"})`);
              task.status = "pending";
              task.assignedWorkerId = undefined;
              task.updatedAt = Date.now();
              orphanCleaned = true;
            }
          }
        }
        if (orphanCleaned) {
          await saveTeamState(teamState);
        }
      }

      mdnsAdvertiser = new MDnsAdvertiser(logger);
      taskRouter = new TaskRouter(logger);
      messageRouter = new MessageRouter(logger);
      wsServer = new TeamWebSocketServer(logger);

      // When running inside a Docker container, use config.port and bind to
      // 0.0.0.0 so that Docker port mapping and healthchecks work correctly.
      // When running locally (host machine), try config.port first; fall back
      // to a dynamic port only when binding fails (e.g. port already in use).
      const isInDocker = fs.existsSync("/.dockerenv");
      const listenPort = config.port;
      const listenHost = isInDocker ? "0.0.0.0" : "127.0.0.1";

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
        inProcessWorkerManager,
        workerProvisioningManager,
        previewManager,
      });

      const PORT_RETRY_STEP = 10;
      const PORT_MAX_RETRIES = 10;

      let actualPort = 0;
      await new Promise<void>((resolve, reject) => {
        let attempt = 0;
        const tryListen = (port: number) => {
          server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && attempt < PORT_MAX_RETRIES) {
              attempt++;
              const nextPort = config.port + attempt * PORT_RETRY_STEP;
              logger.warn(`Controller: port ${port} in use, retrying on ${nextPort}`);
              tryListen(nextPort);
            } else {
              reject(err);
            }
          });
          server.listen(port, listenHost, () => {
            const addr = server.address();
            actualPort = typeof addr === "object" && addr ? addr.port : 0;
            if (actualPort !== config.port) {
              logger.info(`Controller: configured port ${config.port} unavailable, bound to ${actualPort} instead`);
            }
            logger.info(`Controller: HTTP server listening on port ${actualPort}`);
            const uiUrl = `http://127.0.0.1:${actualPort}/ui`;
            logger.info(`Controller: Web UI available at ${uiUrl}`);
            const lanUiUrl = getPreferredLanUiUrl(actualPort);
            if (lanUiUrl) {
              logger.info(`Controller: Web UI available on LAN at ${lanUiUrl}`);
            }
            deps.onActualPort?.(actualPort);
            openBrowser(uiUrl, logger);
            resolve();
          });
        };
        tryListen(listenPort);
      });

      // Propagate the actual port to worker provisioning (created earlier, before port was known)
      if (workerProvisioningManager.isEnabled()) {
        workerProvisioningManager.setActualPort(actualPort);
      }
      if (inProcessWorkerManager) {
        inProcessWorkerManager.setControllerPort(actualPort);
      }

      // Start mDNS advertising with the actual port
      await mdnsAdvertiser.start(actualPort, config.teamName);

      if (localWorkerManager?.hasLocalWorkers()) {
        logger.info(`Controller: starting ${localWorkerManager.workerCount()} local workers...`);
        try {
          await localWorkerManager.start();
          logger.info(`Controller: local workers started`);
        } catch (err) {
          logger.error(`Controller: failed to start local workers: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Single-process: in-process workers are now provisioned on-demand
      // when tasks arrive.  Sync any pre-existing workers into state.
      if (inProcessWorkerManager) {
        if (inProcessWorkerManager.syncState(teamState!)) {
          await saveTeamState(teamState!);
        }
        logger.info(`Controller: in-process worker manager ready (on-demand provisioning)`);
      }

      if (workerProvisioningManager.isEnabled()) {
        void workerProvisioningManager.requestReconcile("controller startup");
      }

      logger.info(`Controller: starting preview restoration...`);
      void previewManager.restorePreviewsOnStartup().then(() => {
        logger.info(`Controller: preview restoration completed`);
      }).catch((err) => {
        logger.warn(`Controller: failed to restore previews on startup: ${String(err)}`);
      });

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
          if (inProcessWorkerManager?.isInProcessWorker(worker)) {
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

        // Reap idle in-process workers (on-demand provisioning cleanup)
        if (inProcessWorkerManager) {
          const idleTtl = config.workerProvisioningIdleTtlMs || 300_000; // default 5 min
          const reaped = inProcessWorkerManager.reapIdleWorkers(idleTtl);
          if (reaped.length > 0) {
            for (const wid of reaped) {
              delete teamState.workers[wid];
              wsServer.broadcastUpdate({ type: "worker:offline", data: { workerId: wid } });
            }
            saveTeamState(teamState);
          }
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
      if (inProcessWorkerManager) {
        await inProcessWorkerManager.stop();
      }
      if (workerProvisioningManager) {
        await workerProvisioningManager.stop();
      }
      await previewManager.stopAll();
      wsServer.close();
      mdnsAdvertiser.stop();
      logger.info("Controller: stopped");
    },
  };
}

function openBrowser(url: string, logger: PluginLogger): void {
  const cmd = process.platform === "darwin"
    ? `open "${url}"`
    : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      logger.warn(`Controller: failed to open browser: ${err.message}`);
    }
  });
}
