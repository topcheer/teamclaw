import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { parsePluginConfig } from "./src/types.js";
import type { TaskExecutionEventInput, TeamState, WorkerIdentity } from "./src/types.js";
import { buildConfigSchema } from "./src/config.js";
import { loadTeamState } from "./src/state.js";
import { createRoleTaskExecutor } from "./src/task-executor.js";
import { createWorkerService } from "./src/worker/worker-service.js";
import { createWorkerPromptInjector } from "./src/worker/prompt-injector.js";
import { createWorkerTools } from "./src/worker/tools.js";
import { MessageQueue } from "./src/worker/message-queue.js";
import { createControllerService } from "./src/controller/controller-service.js";
import { LocalWorkerManager } from "./src/controller/local-worker-manager.js";
import { createControllerPromptInjector } from "./src/controller/prompt-injector.js";
import { createControllerTools } from "./src/controller/controller-tools.js";
import { publishWorkerRepo, syncWorkerRepo } from "./src/git-collaboration.js";
import { installRecommendedSkills } from "./src/worker/skill-installer.js";

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
  const localWorkerManager = new LocalWorkerManager({
    config,
    logger,
    runtime: api.runtime,
  });
  let getControllerTeamState = (): TeamState | null => null;

  // Service (starts HTTP server + mDNS + WebSocket)
  api.registerService(createControllerService({
    config,
    logger,
    runtime: api.runtime,
    localWorkerManager,
    onTeamStateAvailable: (getter) => {
      getControllerTeamState = getter;
    },
  }));

  // Prompt injection
  api.on("before_prompt_build", async (_event: unknown, ctx: { sessionKey?: string | null }) => {
    const localIdentity = localWorkerManager.getIdentityForSession(ctx.sessionKey);
    const localMessageQueue = localWorkerManager.getMessageQueueForSession(ctx.sessionKey);
    if (localIdentity && localMessageQueue) {
      const injector = createWorkerPromptInjector(
        { ...config, role: localIdentity.role },
        () => localIdentity,
        localMessageQueue,
      );
      return injector() ?? {};
    }

    const state = getControllerTeamState() ?? await loadTeamState(config.teamName);
    const injector = createControllerPromptInjector({
      config,
      getTeamState: () => state,
    });
    return injector() ?? {};
  });

  // Tools - register all controller tools via factory returning an array
  const controllerUrl = `http://localhost:${config.port}`;
  api.registerTool((ctx: { sessionKey?: string | null }) => {
    const localIdentity = localWorkerManager.getIdentityForSession(ctx.sessionKey);
    if (localIdentity) {
      return createWorkerTools({
        config: { ...config, role: localIdentity.role },
        getIdentity: () => localIdentity,
      });
    }

    return createControllerTools({
      config,
      controllerUrl,
      getTeamState: getControllerTeamState,
      sessionKey: ctx.sessionKey ?? null,
    });
  });
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

  async function reportExecutionEvent(taskId: string, event: TaskExecutionEventInput): Promise<void> {
    if (!currentControllerUrl) {
      return;
    }

    try {
      const res = await fetch(`${currentControllerUrl}/api/v1/tasks/${taskId}/execution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...event,
          workerId: currentWorkerId ?? undefined,
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

  const getWorkerSessionKey = (taskId: string) => `teamclaw-task-${taskId}`;

  const taskExecutor = createRoleTaskExecutor({
    runtime: api.runtime,
    logger,
    role: config.role,
    taskTimeoutMs: config.taskTimeoutMs,
    getSessionKey: getWorkerSessionKey,
    getIdempotencyKey: (taskId) => `teamclaw-${taskId}`,
    reportExecutionEvent,
  });

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

        if (!assignment.repo?.enabled || !currentControllerUrl) {
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
          const syncResult = await syncWorkerRepo(config, logger, currentControllerUrl, assignment.repo);
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
        if (!assignment.repo?.enabled || !currentControllerUrl || !currentWorkerId) {
          return;
        }

        await reportExecutionEvent(assignment.taskId, {
          type: "lifecycle",
          phase: "repo_publish_started",
          source: "worker",
          status: "running",
          message: `Publishing task changes through ${assignment.repo.mode} git collaboration.`,
        });

        try {
          const publishResult = await publishWorkerRepo(config, logger, currentControllerUrl, assignment.repo, {
            taskId: assignment.taskId,
            workerId: currentWorkerId,
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
      cancelTaskExecution: async (taskId) => {
        const sessionKey = getWorkerSessionKey(taskId);
        try {
          await api.runtime.subagent.deleteSession({ sessionKey });
          logger.info(`Worker: cancelled subagent session ${sessionKey} for task ${taskId}`);
          return true;
        } catch (err) {
          logger.warn(`Worker: failed to cancel session ${sessionKey} for task ${taskId}: ${String(err)}`);
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
