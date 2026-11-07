import type { OpenClawPluginApi, OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import type { KickoffAssessment, PluginConfig, RoleId, TeamState } from "../types.js";
import { loadTeamState, saveTeamState } from "../state.js";
import { MDnsAdvertiser } from "../discovery.js";
import { WORKER_TIMEOUT_MS } from "../protocol.js";
import { createControllerHttpServer, autoAssignPendingTasks } from "./http-server.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import { ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";
import { ensureControllerGitRepo } from "../git-collaboration.js";
import { WorkerProvisioningManager } from "./worker-provisioning.js";
import { PreviewManager } from "./preview-manager.js";
import { runKickoffMeeting, buildKickoffAssessmentPrompt, ASSESSMENT_TIMEOUT_MS } from "./kickoff-orchestrator.js";
import { resolvePreferredLanAddress } from "../networking.js";
import { createTeamAutoScheduler, type TeamAutoScheduler } from "../teamauto/scheduler.js";
import { getGithubAuthManager } from "./github-auth.js";
// Phase 1.6 (design 2.3): TeamState.profileId is the single runtime truth for
// the active TeamProfile; config teamProfile only seeds first initialization.
import { hasProfile, setActiveProfileId, SOFTWARE_RD_PROFILE_ID } from "../profile-loader.js";

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
  /** Late-binding getter for the TeamAuto scheduler (created during service start). */
  onTeamAutoSchedulerAvailable?: (getter: () => import("../teamauto/scheduler.js").TeamAutoScheduler | null) => void;
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
  let teamAutoSchedulerRef: TeamAutoScheduler | null = null;
  let previewManager: PreviewManager;

  return {
    id: "teamclaw-controller",
    async start(_ctx: OpenClawPluginServiceContext) {
      const serviceStartedAt = Date.now();
      await ensureOpenClawWorkspaceMemoryDir(logger);
      const repoState = await ensureControllerGitRepo(config, logger).catch((err) => {
        logger.warn(`Controller: failed to prepare git collaboration repo: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      // Load or create team state
      teamState = await loadTeamState(config.teamName);
      let repoStateChanged = false;
      if (!teamState) {
        // Phase 1.6: first initialization seeds the active profile from the
        // config bootstrap value. An unknown id is the one sanctioned
        // fallback (design 2.2): warn and run the software-rd baseline.
        const requestedProfileId = config.teamProfile;
        let profileId = requestedProfileId;
        if (!hasProfile(requestedProfileId)) {
          profileId = SOFTWARE_RD_PROFILE_ID;
          logger.warn(`Controller: configured teamProfile "${requestedProfileId}" is not a built-in profile; falling back to "${SOFTWARE_RD_PROFILE_ID}"`);
        }
        setActiveProfileId(profileId);
        teamState = {
          profileId,
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
        logger.info(`Controller: created new team "${config.teamName}" (profile: ${profileId})`);
      } else {
        // Restored state: TeamState.profileId is the runtime truth (config
        // changes do not re-seed it). v1 states migrated by state.ts always
        // carry a known id; a dangling reference would mean the profile was
        // removed in a newer profile package - warn and stay on the baseline.
        if (hasProfile(teamState.profileId)) {
          setActiveProfileId(teamState.profileId);
        } else {
          setActiveProfileId(SOFTWARE_RD_PROFILE_ID);
          logger.warn(`Controller: team state references unknown team profile "${teamState.profileId}"; running the "${SOFTWARE_RD_PROFILE_ID}" baseline`);
        }
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

      // Provisioned workers die with the previous gateway process. Their
      // persisted entries flip to offline once heartbeats stop but were
      // never removed, so every gateway restart accumulated ghost rows in
      // the workers list. Clear them on startup: provisioned-* entries that
      // are offline (or whose heartbeat predates this process) cannot be
      // alive because no worker for them exists yet.
      const ghostWorkerIds = Object.values(teamState.workers)
        .filter((worker) =>
          worker.id.startsWith("provisioned-")
          && (worker.status === "offline" || !worker.lastHeartbeat || worker.lastHeartbeat < serviceStartedAt),
        )
        .map((worker) => worker.id);
      if (ghostWorkerIds.length > 0) {
        updateState((state) => {
          for (const workerId of ghostWorkerIds) {
            delete state.workers[workerId];
          }
        });
        logger.info(`Controller: removed ${ghostWorkerIds.length} stale provisioned worker record(s) from a previous gateway process`);
      }

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
      // Resume support: instead of silently restarting, keep the checkpoint and
      // count resume attempts; past MAX the task fails fast instead of looping.
      const MAX_RESUME_ATTEMPTS = 3;
      {
        let orphanCleaned = false;
        for (const task of Object.values(teamState.tasks)) {
          if (
            task.assignedWorkerId &&
            (task.status === "assigned" || task.status === "in_progress")
          ) {
            const worker = teamState.workers[task.assignedWorkerId];
            if (!worker || worker.status === "offline") {
              const attempt = (task.resumeAttempt ?? 0) + 1;
              if (attempt > MAX_RESUME_ATTEMPTS) {
                logger.warn(`Controller: task ${task.id} exceeded ${MAX_RESUME_ATTEMPTS} resume attempts - failing`);
                task.status = "failed";
                task.error = `resumed ${MAX_RESUME_ATTEMPTS} times without completing (last checkpoint: ${task.checkpoint?.lastAssistantMessage?.slice(0, 200) ?? "none"})`;
                task.updatedAt = Date.now();
                orphanCleaned = true;
                continue;
              }
              logger.info(`Controller: resetting orphaned task ${task.id} for resume attempt ${attempt} (worker ${task.assignedWorkerId} ${worker ? "offline" : "missing"})`);
              task.status = "pending";
              task.assignedWorkerId = undefined;
              task.resumeAttempt = attempt;
              if (task.checkpoint) {
                task.checkpoint.attempt = attempt;
              }
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
        getTeamAutoScheduler: () => teamAutoSchedulerRef,
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

      // TeamAuto: autonomous repo collaboration (bind repos via /api/v1/teamauto/*).
      try {
        const auth = getGithubAuthManager(config, logger);
        const httpDepsForAutoAssign = { config, logger, getTeamState: () => teamState, updateTeamState: updateState, taskRouter, messageRouter, wsServer } as Parameters<typeof autoAssignPendingTasks>[0];
        teamAutoSchedulerRef = createTeamAutoScheduler({
          logger,
          auth,
          getTeamState: () => teamState,
          updateTeamState: updateState,
          onTasksCreated: async () => {
            await autoAssignPendingTasks(httpDepsForAutoAssign);
          },
          onActivity: (entry) => {
            wsServer.broadcastUpdate({
              type: "teamauto:activity",
              data: { at: entry.at, repoId: entry.repoId, kind: entry.kind, text: entry.text },
            });
          },
        });
        await teamAutoSchedulerRef.start();
        deps.onTeamAutoSchedulerAvailable?.(() => teamAutoSchedulerRef);
      } catch (err) {
        logger.warn(`Controller: TeamAuto scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`);
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
          if (worker.status === "offline") {
            // Stale offline entries are dead session workers (provisioned
            // per-task workers exit when their task ends; their registry
            // entries used to linger forever and pile up - observed live:
            // the intake agent read a wall of offline developers and
            // misreported the repos they had served as "repo offline").
            // Same reap semantics as the startup sweep, applied at runtime.
            if (now - worker.lastHeartbeat > WORKER_TIMEOUT_MS) {
              delete teamState.workers[workerId];
              changed = true;
              logger.info(`Controller: reaped stale offline worker ${workerId}`);
            }
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

        // Runtime orphan-task reconciliation (user-found: one live worker but
        // two active tasks - the second task was pinned to a worker whose
        // registry entry was already gone). The startup sweep handles this
        // once at boot; tasks whose worker disappears AFTER claiming sat in
        // in_progress forever. Mirror the startup semantics: reset to pending
        // (bounded resume attempts), re-dispatch happens via the reconcile
        // call below. Skip workers the sweep above just released - their
        // tasks were already handled with a broadcast.
        {
          let orphaned = false;
          for (const task of Object.values(teamState.tasks)) {
            if (
              task.assignedWorkerId &&
              (task.status === "assigned" || task.status === "in_progress") &&
              !teamState.workers[task.assignedWorkerId]
            ) {
              const attempt = (task.resumeAttempt ?? 0) + 1;
              const MAX_RESUME_ATTEMPTS = 3;
              if (attempt > MAX_RESUME_ATTEMPTS) {
                logger.warn(`Controller: task ${task.id} exceeded ${MAX_RESUME_ATTEMPTS} resume attempts (worker gone) - failing`);
                task.status = "failed";
                task.error = `worker disappeared without completing (resumed ${MAX_RESUME_ATTEMPTS} times)`;
              } else {
                logger.info(`Controller: resetting orphaned task ${task.id} for resume attempt ${attempt} (worker ${task.assignedWorkerId} missing)`);
                task.status = "pending";
                task.resumeAttempt = attempt;
                if (task.checkpoint) {
                  task.checkpoint.attempt = attempt;
                }
              }
              task.assignedWorkerId = undefined;
              task.updatedAt = now;
              wsServer.broadcastUpdate({ type: "task:updated", data: { ...task } });
              orphaned = true;
            }
          }
          if (orphaned) {
            saveTeamState(teamState);
            changed = true;
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
      try {
        await teamAutoSchedulerRef?.stop();
      } catch { /* scheduler already stopped */ }
      teamAutoSchedulerRef = null;
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
