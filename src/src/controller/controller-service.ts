import type { OpenClawPluginApi, OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import type { KickoffAssessment, PluginConfig, RoleId, TeamState } from "../types.js";
import { loadTeamState, saveTeamState } from "../state.js";
import { MDnsAdvertiser } from "../discovery.js";
import { WORKER_TIMEOUT_MS } from "../protocol.js";
import { createControllerHttpServer } from "./http-server.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import { ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";
import { ensureControllerGitRepo } from "../git-collaboration.js";
import { WorkerProvisioningManager } from "./worker-provisioning.js";
import { PreviewManager } from "./preview-manager.js";
import { runKickoffMeeting, buildKickoffAssessmentPrompt, ASSESSMENT_TIMEOUT_MS } from "./kickoff-orchestrator.js";
import { resolvePreferredLanAddress } from "../networking.js";

export type KickoffHandler = (
  candidateRoles: RoleId[],
  complexity: "simple" | "medium" | "complex",
  requirement: string,
) => Promise<{ assessments: KickoffAssessment[]; summary: string }>;

export type ControllerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  onTeamStateAvailable?: (getter: () => TeamState | null) => void;
  /** Called once the HTTP server has bound to an actual port. */
  onActualPort?: (port: number) => void;
  /** Called once the kickoff handler is ready. */
  onKickoffHandlerAvailable?: (handler: KickoffHandler) => void;
};

function getPreferredLanUiUrl(port: number): string | null {
  const preferredLanAddress = resolvePreferredLanAddress();
  if (!preferredLanAddress) {
    return null;
  }
  return `http://${preferredLanAddress}:${port}/ui`;
}

export function createControllerService(deps: ControllerServiceDeps): OpenClawPluginService {
  const { config, logger } = deps;
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
          projects: {},
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
      if (workerProvisioningManager.isEnabled()) {
        workerProvisioningManager.primeStartupReadiness();
      }

      previewManager = new PreviewManager({
        logger,
        getTeamState: () => teamState,
        updateTeamState: updateState,
      });

      // Run ALL syncState calls (avoid || short-circuit skipping some).
      const syncC = workerProvisioningManager.syncState(teamState);
      if (repoStateChanged || syncC) {
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

      // When running inside a container (Docker or K8s), bind to 0.0.0.0
      // so that port mapping, service networking, and health probes work.
      // When running locally (host machine), bind to 127.0.0.1 for safety.
      const isContainer = fs.existsSync("/.dockerenv") ||
        fs.existsSync("/run/.containerenv") ||
        process.env.KUBERNETES_SERVICE_HOST !== undefined;
      const listenPort = config.port;
      const listenHost = isContainer ? "0.0.0.0" : "127.0.0.1";

      let serviceKickoffHandler: KickoffHandler | undefined;

      const server = createControllerHttpServer({
        config,
        logger,
        runtime: deps.runtime,
        getTeamState: () => teamState,
        updateTeamState: updateState,
        taskRouter,
        messageRouter,
        wsServer,
        workerProvisioningManager,
        previewManager,
        getKickoffHandler: () => serviceKickoffHandler,
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

      // Start mDNS advertising with the actual port
      await mdnsAdvertiser.start(actualPort, config.teamName);

      if (workerProvisioningManager.isEnabled()) {
        void workerProvisioningManager.runStartupReadinessCheck();
      }

      // ── Kickoff handler ───────────────────────────────────────────────
      const kickoffHandler: KickoffHandler = async (candidateRoles, complexity, requirement) => {
        const result = await runKickoffMeeting(
          { requirement, candidateRoles, complexity },
          {
            logger,
            getTeamState: () => teamState,
            ensureRoleProvisioned: async (role) => {
              if (workerProvisioningManager?.isEnabled()) {
                await workerProvisioningManager.requestReconcile(`kickoff-provision-${role}`);
              }
            },
            requestWorkerAssessment: async (worker, req) => {
              return await requestKickoffAssessment(worker, req);
            },
          },
        );
        return { assessments: result.plan.assessments, summary: result.summary };
      };
      serviceKickoffHandler = kickoffHandler;
      deps.onKickoffHandlerAvailable?.(kickoffHandler);

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

/**
 * Request a kickoff assessment from a worker.
 *
 * Request kickoff assessment from a worker over HTTP.
 */
async function requestKickoffAssessment(
  worker: import("../types.js").WorkerInfo,
  requirement: string,
): Promise<import("../types.js").KickoffAssessment> {
  const role = worker.role;
  const prompt = buildKickoffAssessmentPrompt(role, requirement);

  // External worker — POST to kickoff assess endpoint
  if (!worker.url) {
    throw new Error(`Worker ${worker.id} has no URL for kickoff assessment`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASSESSMENT_TIMEOUT_MS);

  try {
    const res = await fetch(`${worker.url}/api/v1/kickoff/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirement, role }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Worker ${worker.id} returned ${res.status} for kickoff assessment`);
    }

    const data = await res.json() as { assessment: import("../types.js").KickoffAssessment };
    return data.assessment;
  } finally {
    clearTimeout(timeout);
  }
}
