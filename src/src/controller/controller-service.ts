import type { OpenClawPluginApi, OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import type { KickoffAssessment, PluginConfig, RoleId, TeamState } from "../types.js";
import { loadTeamState, saveTeamState } from "../state.js";
import { MDnsAdvertiser } from "../discovery.js";
import { WORKER_TIMEOUT_MS } from "../protocol.js";
import { createControllerHttpServer, type ControllerHttpDeps } from "./http-server.js";
// PR-C of issue #204: the assignment pipeline incl. the gated auto-assign
// loop lives in ./task-assignment.js, not http-server.ts.
import { autoAssignPendingTasks } from "./task-assignment.js";
// PR-A of issue #204: the profile switch state machine (incl. crash resume)
// lives in ./profile-switch.ts, not http-server.ts.
import { resumeTeamProfileSwitch } from "./profile-switch.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import { ensureOpenClawWorkspaceMemoryDir, buildTeamClawAgentSessionKey } from "../openclaw-workspace.js";
import { ensureControllerGitRepo } from "../git-collaboration.js";
import { WorkerProvisioningManager } from "./worker-provisioning.js";
import { PreviewManager } from "./preview-manager.js";
import { runKickoffMeeting, buildKickoffAssessmentPrompt, ASSESSMENT_TIMEOUT_MS, type TaskRoleResolutionDeps } from "./kickoff-orchestrator.js";
import { resolvePreferredLanAddress } from "../networking.js";
import { createTeamAutoScheduler, type TeamAutoScheduler } from "../teamauto/scheduler.js";
import { getGithubAuthManager } from "./github-auth.js";
// Phase 1.6 (design 2.3): TeamState.profileId is the single runtime truth for
// the active TeamProfile; config teamProfile only seeds first initialization.
import { getActiveProfile, getActiveRoleIds, hasProfile, setActiveProfileId, validateActiveRoleId, SOFTWARE_RD_PROFILE_ID } from "../profile-loader.js";

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

      // Load or create team state. The active profile is resolved FIRST (from
      // the restored TeamState.profileId, or the config bootstrap value on
      // first initialization) so that capability-dependent startup wiring
      // below knows which profile it is initializing (Phase 2.3 preview).
      teamState = await loadTeamState(config.teamName);
      let seededProfileId: string;
      if (!teamState) {
        // Phase 1.6: first initialization seeds the active profile from the
        // config bootstrap value. An unknown id is the one sanctioned
        // fallback (design 2.2): warn and run the software-rd baseline.
        const requestedProfileId = config.teamProfile;
        seededProfileId = requestedProfileId;
        if (!hasProfile(requestedProfileId)) {
          seededProfileId = SOFTWARE_RD_PROFILE_ID;
          logger.warn(`Controller: configured teamProfile "${requestedProfileId}" is not a built-in profile; falling back to "${SOFTWARE_RD_PROFILE_ID}"`);
        }
      } else {
        // Restored state: TeamState.profileId is the runtime truth (config
        // changes do not re-seed it). A dangling reference means the profile
        // package this team ran on is not available in this installation.
        // Design 2.2 red line: FATAL, never silently run another profile -
        // that is exactly how a banking team would degrade into the software
        // baseline unnoticed. (The config-miss fallback above stays a warn:
        // it only seeds first initialization, where no team exists yet.)
        if (!hasProfile(teamState.profileId)) {
          throw new Error(
            `Controller: team state references team profile "${teamState.profileId}", which is not available in this installation. `
              + "Check the teamProfile config value and the persisted state profileId, or reinstall a TeamClaw version that ships this profile.",
          );
        }
        seededProfileId = teamState.profileId;
      }
      setActiveProfileId(seededProfileId);
      const activeCapabilities = getActiveProfile().capabilities;

      // Phase 2.3 preview (minimal capability wiring, design 2.1): the git
      // collaboration repo is only prepared for profiles with git enabled -
      // a document-delivery team has no repo concept. On the software-rd
      // baseline (git: true) behavior is unchanged.
      const repoState = activeCapabilities.git
        ? await ensureControllerGitRepo(config, logger).catch((err) => {
            logger.warn(`Controller: failed to prepare git collaboration repo: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        : null;

      let repoStateChanged = false;
      if (!teamState) {
        teamState = {
          profileId: seededProfileId,
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
        logger.info(`Controller: created new team "${config.teamName}" (profile: ${seededProfileId})`);
      } else {
        const previousRepoState = JSON.stringify(teamState.repo ?? null);
        teamState.repo = repoState ?? (activeCapabilities.git ? teamState.repo : undefined);
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
      // Phase 2.5 wiring (design 2.3 "LLM 兜底", P2.5 follow-up): the
      // controller LLM session is the production role judge for tasks the
      // bilingual token fast path refuses to decide (tie / all-zero). The
      // judge runs on a dedicated one-shot subagent session - NOT the intake
      // conversation - so verdicts never pollute intake semantics. Missing
      // runtime subagent => no judge, and the TaskRouter keeps its exact
      // pre-wiring behavior.
      const llmRoleJudge = createControllerLlmRoleJudge(deps);
      if (llmRoleJudge) {
        logger.info("Controller: LLM role judge wired into task dispatch (unconfident role inference escalates to the controller LLM)");
      }
      taskRouter = new TaskRouter(logger, llmRoleJudge ? { llmRoleJudge } : undefined);
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

      const httpDeps: ControllerHttpDeps = {
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
      };

      const server = createControllerHttpServer(httpDeps);

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

      // Phase 2.1 (design 2.3 crash semantics): resume an interrupted team
      // profile switch before TeamAuto/preview restoration/provisioning kick
      // in, so no subsystem fights the resume. Runs after the port is known
      // (switch warmup launches need the actual controller URL). Requests
      // arriving mid-resume hit the transition concurrency matrix (409/503),
      // which is exactly what it exists for. An unavailable target profile is
      // fatal here - same red line as restoring an unknown profileId.
      await resumeTeamProfileSwitch(httpDeps);

      // TeamAuto: autonomous repo collaboration (bind repos via /api/v1/teamauto/*).
      // Phase 2.3 preview (minimal capability wiring): a profile with
      // teamauto disabled never starts the scheduler at all.
      if (getActiveProfile().capabilities.teamauto) {
        try {
          const auth = getGithubAuthManager(config, logger);
          teamAutoSchedulerRef = createTeamAutoScheduler({
            logger,
            auth,
            getTeamState: () => teamState,
            updateTeamState: updateState,
            onTasksCreated: async () => {
              // Same deps object as every HTTP call site (issue #191 gate
              // review): the autoAssign re-entrancy gate is keyed per deps
              // object, so an ad-hoc object here would open a SECOND gate -
              // a TeamAuto round and an HTTP round could then run concurrently
              // with separate attemptedPairs sets (double dispatch attempts,
              // same-task double LLM-judge window). The ad-hoc object also
              // silently dropped workerProvisioningManager/getTeamAutoScheduler
              // for these rounds (no reconcile nudge; teamauto write tasks
              // dispatched from this path fell back to the shared checkout
              // instead of a task-scoped worktree). It was a leftover from
              // before the shared httpDeps existed, not a deliberate split.
              await autoAssignPendingTasks(httpDeps);
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
      } else {
        logger.info("Controller: TeamAuto scheduler skipped (capability disabled by the active team profile)");
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

      // Phase 2.3 preview (minimal capability wiring): only profiles with
      // runnablePreview enabled restore dynamic previews on startup.
      if (getActiveProfile().capabilities.runnablePreview) {
        logger.info(`Controller: starting preview restoration...`);
        void previewManager.restorePreviewsOnStartup().then(() => {
          logger.info(`Controller: preview restoration completed`);
        }).catch((err) => {
          logger.warn(`Controller: failed to restore previews on startup: ${String(err)}`);
        });
      }

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

// ── Phase 2.5 wiring: controller LLM as the role judge ───────────────────────
//
// resolveTaskRoleWithLlmFallback (kickoff-orchestrator) defined the seam in
// P2.5 with fake-driven tests but no production caller. This factory builds
// the production llmRoleJudge: a ONE-SHOT subagent session on the controller
// runtime (never the long-lived intake conversation, so verdicts cannot
// pollute intake semantics) that answers with a single role id of the ACTIVE
// profile. The resolver validates the answer (validateActiveRoleId) and
// degrades to the profile defaultRole when the judge is unavailable, times
// out, errors, or names a role outside the active profile - the TaskRouter
// then treats the outcome as a routing hint, so dispatch never blocks on a
// strand.

/** Budget for a one-id LLM verdict; past it the resolver degrades to defaultRole. */
const ROLE_JUDGE_TIMEOUT_MS = 30_000;
const ROLE_JUDGE_SESSION_PREFIX = "teamclaw-role-judge:";
const ROLE_JUDGE_SYSTEM_PROMPT = [
  "You are the role router of a TeamClaw controller.",
  "Given one task, pick the single team role that should own it.",
  "Reply with EXACTLY one role id from the provided list - no prose, no markdown, no explanation.",
].join(" ");

function createControllerLlmRoleJudge(
  deps: Pick<ControllerServiceDeps, "runtime" | "logger">,
): TaskRoleResolutionDeps["llmRoleJudge"] | undefined {
  const subagent = deps.runtime?.subagent;
  if (
    !subagent
    || typeof subagent.run !== "function"
    || typeof subagent.waitForRun !== "function"
    || typeof subagent.getSessionMessages !== "function"
  ) {
    // Runtime without an LLM subagent (e.g. minimal test doubles): leave the
    // seam unwired; the TaskRouter keeps its pre-wiring behavior.
    return undefined;
  }
  const logger = deps.logger;

  return async ({ task, verdict }) => {
    const roleIds = getActiveRoleIds();
    const message = [
      `Task title: ${task.title}`,
      `Task description: ${task.description?.trim() || "(none)"}`,
      "",
      `Token-based role scoring refused to decide (${verdict.reason}).`,
      `Pick the single role that should own this task. Answer with EXACTLY one role id from: ${roleIds.join(", ")}`,
    ].join("\n");

    // Fresh one-shot session per verdict: the judge must stay stateless and
    // separate from any intake/worker conversation.
    const sessionKey = buildTeamClawAgentSessionKey(
      `${ROLE_JUDGE_SESSION_PREFIX}${task.id}-${Date.now()}`,
    );
    const run = await subagent.run({
      sessionKey,
      message,
      extraSystemPrompt: ROLE_JUDGE_SYSTEM_PROMPT,
      idempotencyKey: `role-judge-${task.id}-${Date.now()}`,
    });
    const waited = await subagent.waitForRun({
      runId: run.runId,
      timeoutMs: ROLE_JUDGE_TIMEOUT_MS,
    });
    if (waited.status !== "ok") {
      logger.warn(
        `Controller: LLM role judge did not complete for task ${task.id} (${waited.status}${"error" in waited && waited.error ? `: ${waited.error}` : ""}); using the profile defaultRole`,
      );
      return null;
    }

    const session = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    const reply = extractLastAssistantText(session.messages);
    const direct = validateActiveRoleId(reply.trim());
    if (direct) {
      return direct;
    }
    // Tolerate light prose wrapping ("The role is: qa."): first ACTIVE role
    // id that appears as a whole word in the reply.
    for (const roleId of roleIds) {
      const pattern = new RegExp(`(^|[^a-z0-9-])${roleId.replace(/[-]/g, "\\-")}([^a-z0-9-]|$)`);
      if (pattern.test(reply)) {
        return roleId;
      }
    }
    logger.warn(
      `Controller: LLM role judge reply for task ${task.id} named no active role (${reply.slice(0, 120) || "empty reply"}); using the profile defaultRole`,
    );
    return null;
  };
}

/** Last assistant message text (string or text blocks), mirroring the http-server intake helper semantics. */
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
  return "";
}
