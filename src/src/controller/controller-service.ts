import type { OpenClawPluginApi, OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import os from "node:os";
import fs from "node:fs";
import { exec } from "node:child_process";
import type { KickoffAssessment, PluginConfig, RoleId, TeamState } from "../types.js";
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
import { runKickoffMeeting, buildKickoffAssessmentPrompt, ASSESSMENT_TIMEOUT_MS } from "./kickoff-orchestrator.js";
import { getRole } from "../roles.js";

export type KickoffHandler = (
  candidateRoles: RoleId[],
  complexity: "simple" | "medium" | "complex",
  requirement: string,
) => Promise<{ assessments: KickoffAssessment[]; summary: string }>;

export type ControllerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  localWorkerManager?: LocalWorkerManager;
  inProcessWorkerManager?: InProcessWorkerManager;
  onTeamStateAvailable?: (getter: () => TeamState | null) => void;
  /** Called once the HTTP server has bound to an actual port. */
  onActualPort?: (port: number) => void;
  /** Called once the kickoff handler is ready. */
  onKickoffHandlerAvailable?: (handler: KickoffHandler) => void;
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
        localWorkerManager,
        inProcessWorkerManager,
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
      // (Orphaned tasks were already reset to pending by the earlier cleanup block.)
      if (inProcessWorkerManager) {
        if (inProcessWorkerManager.syncState(teamState!)) {
          await saveTeamState(teamState!);
        }
        logger.info(`Controller: in-process worker manager ready (on-demand provisioning)`);
      }

      if (workerProvisioningManager.isEnabled()) {
        void workerProvisioningManager.requestReconcile("controller startup");
      }

      // ── Kickoff handler ───────────────────────────────────────────────
      const kickoffHandler: KickoffHandler = async (candidateRoles, complexity, requirement) => {
        const result = await runKickoffMeeting(
          { requirement, candidateRoles, complexity },
          {
            logger,
            getTeamState: () => teamState,
            ensureRoleProvisioned: async (role) => {
              if (inProcessWorkerManager) {
                inProcessWorkerManager.ensureWorker(role);
                inProcessWorkerManager.syncState(teamState!);
                return;
              }
              if (workerProvisioningManager?.isEnabled()) {
                await workerProvisioningManager.requestReconcile(`kickoff-provision-${role}`);
                return;
              }
              // For local workers, trigger a reconcile which will provision as needed
              if (localWorkerManager) {
                // Local workers are statically provisioned; nothing to do
                return;
              }
            },
            requestWorkerAssessment: async (worker, req) => {
              return await requestKickoffAssessment(worker, req, deps, inProcessWorkerManager, actualPort);
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

/**
 * Request a kickoff assessment from a worker.
 *
 * For in-process workers: runs a lightweight subagent session.
 * For external workers (HTTP): POSTs to the worker's kickoff endpoint.
 */
async function requestKickoffAssessment(
  worker: import("../types.js").WorkerInfo,
  requirement: string,
  deps: ControllerServiceDeps,
  inProcessWorkerManager: InProcessWorkerManager | undefined,
  controllerPort: number,
): Promise<import("../types.js").KickoffAssessment> {
  const role = worker.role;
  const prompt = buildKickoffAssessmentPrompt(role, requirement);

  if (worker.transport === "in-process" && inProcessWorkerManager) {
    // Run a lightweight subagent session for assessment
    const roleDef = getRole(role);
    const systemPrompt = roleDef?.systemPrompt ?? `You are a ${role} in a virtual software team.`;
    const sessionKey = `teamclaw-kickoff-${role}-${Date.now()}`;

    const runResult = await deps.runtime.subagent.run({
      sessionKey,
      message: prompt,
      extraSystemPrompt: systemPrompt,
      idempotencyKey: `kickoff-assess-${role}-${Date.now()}`,
    });

    const waitResult = await deps.runtime.subagent.waitForRun({
      runId: runResult.runId,
      timeoutMs: ASSESSMENT_TIMEOUT_MS,
    });

    if (waitResult.status !== "ok") {
      throw new Error(`Assessment timed out or failed for ${role} (status=${waitResult.status})`);
    }

    // Extract the response text
    const sessionMessages = await deps.runtime.subagent.getSessionMessages({ sessionKey });
    const messages = Array.isArray(sessionMessages?.messages) ? sessionMessages.messages : [];
    const lastAssistant = [...messages].reverse().find(
      (m: unknown) => (m as Record<string, unknown>).role === "assistant",
    );
    const responseText = extractTextFromMessage(lastAssistant);
    return parseAssessmentResponse(role, responseText);
  }

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

function extractTextFromMessage(message: unknown): string {
  if (!message) return "";
  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block: unknown) => {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseAssessmentResponse(role: import("../types.js").RoleId, text: string): import("../types.js").KickoffAssessment {
  const defaultAssessment: import("../types.js").KickoffAssessment = {
    role,
    needed: false,
    scope: "Could not parse assessment response",
    suggestedTasks: [],
    dependencies: [],
    risks: [],
    questions: [],
  };

  if (!text.trim()) return defaultAssessment;

  // Try to extract JSON from the response (may be wrapped in markdown fences)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch?.[1]?.trim() ?? text.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      role,
      needed: Boolean(parsed.needed),
      scope: String(parsed.scope ?? ""),
      suggestedTasks: Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks.map(String) : [],
      dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.map(String) : [],
    };
  } catch {
    return { ...defaultAssessment, scope: `Raw response: ${text.slice(0, 200)}` };
  }
}
