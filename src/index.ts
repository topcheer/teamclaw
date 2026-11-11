import fs from "node:fs/promises";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { parsePluginConfig } from "./src/types.js";
import type { TaskAssignmentPayload, TaskExecutionEventInput, TeamState, WorkerIdentity } from "./src/types.js";
import { buildConfigSchema } from "./src/config.js";
import { loadTeamState } from "./src/state.js";
import { createRoleTaskExecutor } from "./src/task-executor.js";
import { createWorkerService } from "./src/worker/worker-service.js";
import { createWorkerPromptInjector } from "./src/worker/prompt-injector.js";
import { createWorkerTools } from "./src/worker/tools.js";
import { MessageQueue } from "./src/worker/message-queue.js";
import { createControllerService } from "./src/controller/controller-service.js";
import { createControllerPromptInjector } from "./src/controller/prompt-injector.js";
import { createControllerTools } from "./src/controller/controller-tools.js";
import { publishWorkerRepo, syncWorkerRepo } from "./src/git-collaboration.js";
import { resolveTeamClawProjectsDir } from "./src/openclaw-workspace.js";
import { installRecommendedSkills } from "./src/worker/skill-installer.js";
// W6 of issue #226: local swallowing pathExists copy replaced by the shared
// one (identical semantics; alias keeps the call site byte-identical).
import { pathExistsTolerant as pathExists } from "./src/shared/utils.js";

// #253: the image build compiles this plugin into a flat rolldown bundle
// (dist/extensions/teamclaw/index.js) with NO nested dist/src tree, while the
// npm tarball layout ships dist/src/roles.js and no top-level index.js. The
// installer CLI (cli.mjs) reads the role registry through whichever layout it
// lands in, so the registry must be reachable from this entry as a named
// export for the bundled layout to resolve it.
export { ROLES, DEFAULT_ROLE } from "./src/roles.js";

export default definePluginEntry({
  id: "teamclaw",
  name: "TeamClaw",
  description:
    "Virtual team collaboration - multiple OpenClaw instances form a virtual software company with role-based task routing.",
  configSchema: buildConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig as Record<string, unknown>);

    if (config.mode === "controller") {
      registerController(api, config);
    } else {
      registerWorker(api, config);
    }
  },
});

function registerController(api: OpenClawPluginApi, config: ReturnType<typeof parsePluginConfig>) {
  const logger = api.logger;
  let getControllerTeamState = (): TeamState | null => null;
  let controllerUrl = `http://127.0.0.1:${config.port}`;
  let kickoffHandler: ((candidateRoles: import("./src/types.js").RoleId[], complexity: "simple" | "medium" | "complex", requirement: string) => Promise<{ assessments: import("./src/types.js").KickoffAssessment[]; summary: string }>) | undefined;
  let getTeamAutoScheduler: () => import("./src/teamauto/scheduler.js").TeamAutoScheduler | null = () => null;

  // Service (starts HTTP server + mDNS + WebSocket)
  api.registerService(createControllerService({
    config,
    logger,
    runtime: api.runtime,
    onTeamStateAvailable: (getter) => {
      getControllerTeamState = getter;
    },
    onActualPort: (port) => {
      controllerUrl = `http://127.0.0.1:${port}`;
    },
    onKickoffHandlerAvailable: (handler) => {
      kickoffHandler = handler;
      logger.info("TeamClaw: kickoff handler registered successfully");
    },
    onTeamAutoSchedulerAvailable: (getter) => {
      getTeamAutoScheduler = getter;
    },
  }));

  // Prompt injection
  api.on("before_prompt_build", async (_event: unknown, ctx: { sessionKey?: string | null }) => {
    const state = getControllerTeamState() ?? await loadTeamState(config.teamName);
    const injector = createControllerPromptInjector({
      config,
      getTeamState: () => state,
    });
    return injector() ?? {};
  });

  // Tools - register all controller tools via factory returning an array
  api.registerTool((ctx: { sessionKey?: string | null }) => {
    return createControllerTools({
      config,
      controllerUrl,
      getTeamState: getControllerTeamState,
      sessionKey: ctx.sessionKey ?? null,
      getKickoffHandler: () => kickoffHandler,
      getTeamAutoScheduler: () => getTeamAutoScheduler(),
    });
  });
}

/**
 * Issue #23 (client wave): headers for worker -> controller calls, same
 * pattern as identity.ts / worker-service.ts / worker/tools.ts. A configured
 * device token rides X-TeamClaw-Token; without one the headers are unchanged
 * (L0). The token value is never logged.
 */
function withDeviceToken(config: ReturnType<typeof parsePluginConfig>, headers: Record<string, string>): Record<string, string> {
  const token = config.securityToken?.trim();
  return token ? { ...headers, "X-TeamClaw-Token": token } : headers;
}

/**
 * Execution-event + checkpoint reporters (issue #23 review follow-up: the
 * execution stream and resume checkpoints MUST survive device protection, so
 * both POSTs carry the paired device token). Extracted from registerWorker
 * as an exported factory so the dist-level client tests can exercise the
 * real header behavior against a stub controller.
 */
export function createWorkerEventReporters(
  config: ReturnType<typeof parsePluginConfig>,
  logger: { warn(entry: string): void },
  state: { getControllerUrl: () => string | null; getWorkerId: () => string | null },
) {
  async function reportExecutionEvent(taskId: string, event: TaskExecutionEventInput): Promise<void> {
    const controllerUrl = state.getControllerUrl();
    if (!controllerUrl) {
      return;
    }

    try {
      const res = await fetch(`${controllerUrl}/api/v1/tasks/${taskId}/execution`, {
        method: "POST",
        headers: withDeviceToken(config, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          ...event,
          workerId: state.getWorkerId() ?? undefined,
          role: config.role,
        }),
      });
      if (!res.ok) {
        logger.warn(`Worker: failed to record execution event for ${taskId} (${res.status})`);
      }
    } catch (err) {
      logger.warn(`Worker: failed to POST execution event for ${taskId}: ${String(err)}`);
    }
  }

  async function reportCheckpoint(taskId: string, checkpoint: { lastAssistantMessage: string; progressNote?: string; sessionKey: string }): Promise<void> {
    const controllerUrl = state.getControllerUrl();
    if (!controllerUrl) {
      return;
    }
    try {
      await fetch(`${controllerUrl}/api/v1/tasks/${taskId}/checkpoint`, {
        method: "POST",
        headers: withDeviceToken(config, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ...checkpoint, workerId: state.getWorkerId() ?? undefined }),
      });
    } catch {
      // Checkpointing is best-effort; a lost heartbeat only costs resume freshness.
    }
  }

  return { reportExecutionEvent, reportCheckpoint };
}

function registerWorker(api: OpenClawPluginApi, config: ReturnType<typeof parsePluginConfig>) {
  const logger = api.logger;
  const messageQueue = new MessageQueue();
  let currentControllerUrl: string | null = null;
  let currentWorkerId: string | null = null;

  function getIdentity(): WorkerIdentity | null {
    if (!currentWorkerId || !currentControllerUrl) return null;
    return {
      workerId: currentWorkerId,
      role: config.role,
      controllerUrl: currentControllerUrl,
      registeredAt: Date.now(),
    };
  }

  const { reportExecutionEvent, reportCheckpoint } = createWorkerEventReporters(config, logger, {
    // Read through getters so the reporters always see the identity the
    // worker service has established by the time an event fires.
    getControllerUrl: () => currentControllerUrl,
    getWorkerId: () => currentWorkerId,
  });

  const getWorkerSessionKey = (assignment: TaskAssignmentPayload) =>
    assignment.executionSessionKey?.trim() || `teamclaw-task-${assignment.taskId}`;

  const taskExecutor = createRoleTaskExecutor({
    runtime: api.runtime,
    logger,
    role: config.role,
    taskTimeoutMs: config.taskTimeoutMs,
    config,
    getSessionKey: getWorkerSessionKey,
    getIdempotencyKey: (assignment) =>
      assignment.executionIdempotencyKey?.trim() || `teamclaw-${assignment.taskId}`,
    reportExecutionEvent,
    reportCheckpoint,
  });

  function resolveProjectSyncPaths(projectDir: string | undefined): { sharedProjectDir: string; localProjectDir: string } | null {
    const normalizedProjectDir = projectDir?.trim();
    const sharedWorkspaceOverride = process.env.TEAMCLAW_WORKSPACE_DIR?.trim();
    if (!normalizedProjectDir || !sharedWorkspaceOverride) {
      return null;
    }

    const sharedProjectDir = path.join(resolveTeamClawProjectsDir(), normalizedProjectDir);
    const localEnv = { ...process.env };
    delete localEnv.TEAMCLAW_WORKSPACE_DIR;
    const localProjectDir = path.join(resolveTeamClawProjectsDir(localEnv), normalizedProjectDir);
    if (sharedProjectDir === localProjectDir) {
      return null;
    }
    return { sharedProjectDir, localProjectDir };
  }

  async function syncProjectDir(sourceDir: string, destinationDir: string): Promise<boolean> {
    if (!await pathExists(sourceDir)) {
      return false;
    }
    await fs.mkdir(path.dirname(destinationDir), { recursive: true });
    await fs.cp(sourceDir, destinationDir, { recursive: true, force: true });
    return true;
  }

  // Service
  api.registerService(
    createWorkerService({
      config,
      logger,
      onIdentityEstablished: (identity) => {
        currentControllerUrl = identity.controllerUrl;
        currentWorkerId = identity.workerId;
      },
      prepareTaskAssignment: async (assignment) => {
        const controllerUrl = currentControllerUrl || config.controllerUrl.trim();
        if (assignment.recommendedSkills?.length) {
          try {
            const skillInstall = await installRecommendedSkills(assignment, logger);
            for (const event of skillInstall.events) {
              await reportExecutionEvent(assignment.taskId, event);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await reportExecutionEvent(assignment.taskId, {
              type: "error",
              phase: "skills_preflight_failed",
              source: "worker",
              status: "running",
              message,
            });
            logger.warn(`Worker: skill preflight failed for ${assignment.taskId}: ${message}`);
          }
        }

        const syncPaths = resolveProjectSyncPaths(assignment.projectDir);
        if (syncPaths) {
          const restored = await syncProjectDir(syncPaths.sharedProjectDir, syncPaths.localProjectDir);
          if (restored) {
            await reportExecutionEvent(assignment.taskId, {
              type: "lifecycle",
              phase: "project_sync_restored",
              source: "worker",
              status: "running",
              message: `Restored shared project files into the worker runtime from ${syncPaths.sharedProjectDir}.`,
            });
          }
        }

        if (!assignment.repo?.enabled || !controllerUrl) {
          return;
        }

        await reportExecutionEvent(assignment.taskId, {
          type: "lifecycle",
          phase: "repo_sync_started",
          source: "worker",
          status: "running",
          message: `Preparing ${assignment.repo.mode} git workspace sync before task execution.`,
        });

        try {
          const syncResult = await syncWorkerRepo(config, logger, controllerUrl, assignment.repo);
          await reportExecutionEvent(assignment.taskId, {
            type: "lifecycle",
            phase: "repo_sync_completed",
            source: "worker",
            status: "running",
            message: syncResult.message,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await reportExecutionEvent(assignment.taskId, {
            type: "error",
            phase: "repo_sync_failed",
            source: "worker",
            status: "running",
            message,
          });
          throw err;
        }
      },
      publishTaskAssignment: async (assignment) => {
        const syncPaths = resolveProjectSyncPaths(assignment.projectDir);
        if (syncPaths) {
          const published = await syncProjectDir(syncPaths.localProjectDir, syncPaths.sharedProjectDir);
          if (published) {
            await reportExecutionEvent(assignment.taskId, {
              type: "lifecycle",
              phase: "project_sync_published",
              source: "worker",
              status: "running",
              message: `Published worker runtime project files back to the shared workspace at ${syncPaths.sharedProjectDir}.`,
            });
          }
        }

        const controllerUrl = currentControllerUrl || config.controllerUrl.trim();
        if (!assignment.repo?.enabled || !controllerUrl) {
          return;
        }
        const workerId = currentWorkerId || "unknown-worker";

        await reportExecutionEvent(assignment.taskId, {
          type: "lifecycle",
          phase: "repo_publish_started",
          source: "worker",
          status: "running",
          message: `Publishing task changes through ${assignment.repo.mode} git collaboration.`,
        });

        try {
          const publishResult = await publishWorkerRepo(config, logger, controllerUrl, assignment.repo, {
            taskId: assignment.taskId,
            workerId,
            role: config.role,
          });
          await reportExecutionEvent(assignment.taskId, {
            type: "lifecycle",
            phase: publishResult.published ? "repo_publish_completed" : "repo_publish_skipped",
            source: "worker",
            status: "running",
            message: publishResult.message,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await reportExecutionEvent(assignment.taskId, {
            type: "error",
            phase: "repo_publish_failed",
            source: "worker",
            status: "running",
            message,
          });
          throw err;
        }
      },
      taskExecutor,
      cancelTaskExecution: async (taskId, sessionKey) => {
        const resolvedSessionKey = sessionKey || `teamclaw-task-${taskId}`;
        try {
          await api.runtime.subagent.deleteSession({ sessionKey: resolvedSessionKey });
          logger.info(`Worker: cancelled subagent session ${resolvedSessionKey} for task ${taskId}`);
          return true;
        } catch (err) {
          logger.warn(`Worker: failed to cancel session ${resolvedSessionKey} for task ${taskId}: ${String(err)}`);
          return false;
        }
      },
      messageQueue,
    }),
  );

  // Prompt injection
  api.on("before_prompt_build", async () => {
    const injector = createWorkerPromptInjector(config, getIdentity, messageQueue);
    return injector() ?? {};
  });

  // Tools - register all worker tools via factory returning an array
  api.registerTool(() => {
    return createWorkerTools({ config, getIdentity });
  });
}
