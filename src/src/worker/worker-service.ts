import fs from "node:fs";
import http from "node:http";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "../../api.js";
import type { PluginConfig, TaskAssignmentPayload, WorkerIdentity } from "../types.js";
import { createHeartbeatPayload } from "../protocol.js";
import { IdentityManager } from "../identity.js";
import { MessageQueue } from "./message-queue.js";
import { createWorkerHttpHandler } from "./http-handler.js";
import { buildTeamClawAgentSessionKey, ensureOpenClawWorkspaceMemoryDir } from "../openclaw-workspace.js";

export type TaskExecutorResultLike = string | { text: string; contract?: Record<string, unknown> };

/**
 * Issue #27: container detection mirrors the controller's resolve step in
 * controller-service.ts (/.dockerenv, /run/.containerenv, or the Kubernetes
 * service env). Inside Docker/K8s the worker must bind all interfaces so
 * port mapping, service networking, and the controller can reach it; on a
 * host it stays loopback by default.
 */
export function detectWorkerContainerEnvironment(): boolean {
  return fs.existsSync("/.dockerenv") ||
    fs.existsSync("/run/.containerenv") ||
    process.env.KUBERNETES_SERVICE_HOST !== undefined;
}

/**
 * Issue #27: worker HTTP bind address resolution. Precedence:
 * 1. explicit `listenHost` config (overrides everything),
 * 2. 0.0.0.0 inside containers (Docker/K8s),
 * 3. 127.0.0.1 loopback default on hosts.
 * Previously `listen(config.port)` bound `::` (all interfaces) everywhere,
 * exposing the unauthenticated task/message endpoints to the whole network.
 */
export function resolveWorkerListenHost(config: Pick<PluginConfig, "listenHost">): string {
  const explicit = config.listenHost?.trim();
  if (explicit) {
    return explicit;
  }
  return detectWorkerContainerEnvironment() ? "0.0.0.0" : "127.0.0.1";
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Issue #23 (client wave): worker -> controller requests carry the paired
 * device token (config.securityToken) as X-TeamClaw-Token when one is
 * configured; without a token the headers are unchanged (L0 behavior). The
 * token value is never logged.
 */
function withDeviceToken(config: PluginConfig, headers: Record<string, string>): Record<string, string> {
  const token = config.securityToken?.trim();
  return token ? { ...headers, "X-TeamClaw-Token": token } : headers;
}

export type WorkerServiceDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  onIdentityEstablished: (identity: WorkerIdentity) => void;
  taskExecutor?: (taskDescription: string, assignment: TaskAssignmentPayload) => Promise<TaskExecutorResultLike>;
  prepareTaskAssignment?: (assignment: TaskAssignmentPayload) => Promise<void> | void;
  publishTaskAssignment?: (assignment: TaskAssignmentPayload, result: string) => Promise<void> | void;
  cancelTaskExecution?: (taskId: string, sessionKey?: string) => Promise<boolean> | boolean;
  messageQueue?: MessageQueue;
};

export function createWorkerService(deps: WorkerServiceDeps): OpenClawPluginService {
  const { config, logger, onIdentityEstablished, taskExecutor: externalTaskExecutor } = deps;
  let identityManager: IdentityManager;
  let messageQueue: MessageQueue;
  let server: http.Server | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let controllerUrl: string | null = null;
  let workerId: string | null = null;
  let activeTaskId: string | undefined;
  const activeTaskSessionKeys = new Map<string, string>();
  const cancelledTaskIds = new Set<string>();
  let consecutiveHeartbeatFailures = 0;
  let warnedLoopbackReachability = false;

  // Issue #27: with the loopback bind default, an external worker (controller
  // on another host) still advertises its LAN IP (identity.ts getLocalIp),
  // so the controller could never reach it. Surface that mismatch once
  // instead of failing silently; `listenHost` is the escape hatch.
  function warnIfLoopbackBindBlocksRemoteController(targetControllerUrl: string): void {
    if (warnedLoopbackReachability) {
      return;
    }
    const listenHost = resolveWorkerListenHost(config);
    if (!isLoopbackHost(listenHost)) {
      return;
    }
    let controllerHost: string;
    try {
      controllerHost = new URL(targetControllerUrl).hostname;
    } catch {
      return;
    }
    if (!controllerHost || isLoopbackHost(controllerHost)) {
      return;
    }
    warnedLoopbackReachability = true;
    logger.warn(
      `Worker: HTTP server is bound to loopback (${listenHost}) but the controller is at ${targetControllerUrl} (different host) - the controller cannot reach this worker. ` +
      `Set the "listenHost" plugin config (e.g. "0.0.0.0" or this machine's LAN address) for external-worker deployments.`,
    );
  }

  const taskExecutor = externalTaskExecutor
    ? async (assignment: TaskAssignmentPayload): Promise<{ text: string; contract?: Record<string, unknown> }> => {
        const taskId = assignment.taskId;
        cancelledTaskIds.delete(taskId);
        activeTaskId = taskId;
        activeTaskSessionKeys.set(taskId, assignment.executionSessionKey || buildTeamClawAgentSessionKey(`teamclaw-task-${taskId}`));
        try {
          await deps.prepareTaskAssignment?.(assignment);
          let taskPrompt = [assignment.title.trim(), assignment.description.trim()].filter(Boolean).join("\n\n");
          if (assignment.checkpoint) {
            const cp = assignment.checkpoint;
            const resumeLines = [
              "## RESUMED EXECUTION",
              `This task was interrupted mid-execution (resume attempt ${assignment.resumeAttempt ?? cp.attempt}). You are CONTINUING previous work, not starting over. The OpenClaw session you are running in already contains the full prior conversation - review it before acting.`,
              "Do NOT redo steps that are already done. Re-verify state on disk/git instead of redoing work.",
              "",
              "Last assistant activity before interruption:",
              (cp.lastAssistantMessage || "(none recorded)").slice(0, 4000),
            ];
            if (cp.progressNotes?.length) {
              resumeLines.push("", "Progress notes from prior attempts:", ...cp.progressNotes.map((n) => `- ${n}`));
            }
            taskPrompt = `${taskPrompt}\n\n${resumeLines.join("\n")}`;
          }
          const raw = await externalTaskExecutor(taskPrompt, assignment);
          if (cancelledTaskIds.has(taskId)) {
            throw new Error("Task execution cancelled by controller");
          }
          const result = typeof raw === "string" ? { text: raw } : raw;
          await deps.publishTaskAssignment?.(assignment, result.text);
          return result;
        } finally {
          activeTaskId = undefined;
          activeTaskSessionKeys.delete(taskId);
          if (!cancelledTaskIds.has(taskId)) {
            cancelledTaskIds.delete(taskId);
          }
        }
      }
    : undefined;

  function reportTaskResult(taskId: string, result: string, error: string | null, contract?: Record<string, unknown>): void {
    if (cancelledTaskIds.has(taskId)) {
      logger.info(`Worker: suppressing result report for cancelled task ${taskId}`);
      return;
    }
    if (!controllerUrl) return;
    const body: Record<string, unknown> = { result, error, workerId };
    if (contract) {
      body.resultContract = contract;
    }
    fetch(`${controllerUrl}/api/v1/tasks/${taskId}/result`, {
      method: "POST",
      headers: withDeviceToken(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }).catch((err) => {
      logger.error(`Worker: failed to report task result: ${String(err)}`);
    });
  }

  async function cancelAssignedTask(taskId: string): Promise<boolean> {
    if (activeTaskId !== taskId) {
      return false;
    }

    cancelledTaskIds.add(taskId);
    try {
      const cancelled = await deps.cancelTaskExecution?.(taskId, activeTaskSessionKeys.get(taskId));
      return cancelled ?? true;
    } catch (err) {
      logger.warn(`Worker: failed to cancel task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  function isTaskCancelled(taskId: string): boolean {
    return cancelledTaskIds.has(taskId);
  }

  async function startServer(): Promise<void> {
    // Kickoff assessor — uses the worker's subagent runtime for lightweight assessment
    const kickoffAssessor = externalTaskExecutor
      ? async (requirement: string, role: string): Promise<Record<string, unknown>> => {
          const { buildKickoffAssessmentPrompt } = await import("../controller/kickoff-orchestrator.js");
          const prompt = buildKickoffAssessmentPrompt(role as import("../types.js").RoleId, requirement);
          const sessionKey = buildTeamClawAgentSessionKey(`teamclaw-kickoff-${role}-${Date.now()}`);
          const raw = await externalTaskExecutor(prompt, {
            taskId: `kickoff-${role}`,
            title: `Kickoff Assessment (${role})`,
            description: prompt,
            executionSessionKey: sessionKey,
          });
          const text = typeof raw === "string" ? raw : raw.text;
          // Parse the JSON response
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
          const jsonStr = jsonMatch?.[1]?.trim() ?? text.trim();
          try {
            const parsed = JSON.parse(jsonStr);
            return {
              role,
              needed: Boolean(parsed.needed),
              scope: String(parsed.scope ?? ""),
              suggestedTasks: Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks : [],
              dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
              risks: Array.isArray(parsed.risks) ? parsed.risks : [],
              questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            };
          } catch {
            return { role, needed: false, scope: `Could not parse: ${text.slice(0, 200)}`, suggestedTasks: [], dependencies: [], risks: [], questions: [] };
          }
        }
      : undefined;

    const handler = createWorkerHttpHandler(
        { role: config.role, port: config.port, securityToken: config.securityToken },
        logger,
        messageQueue,
        workerId ?? "",
        taskExecutor,
        reportTaskResult,
        cancelAssignedTask,
        isTaskCancelled,
        kickoffAssessor,
      );

    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }

    server = http.createServer(handler);
    const listenHost = resolveWorkerListenHost(config);
    await new Promise<void>((resolve, reject) => {
      server!.listen(config.port, listenHost, () => {
        logger.info(`Worker: HTTP server listening on ${listenHost}:${config.port}`);
        resolve();
      });
      server!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Issue #27: the worker default port is also the controller default,
          // so same-host dual-process setups crash here with no pointer.
          reject(new Error(
            `Worker: cannot listen on ${listenHost}:${config.port} - address already in use` +
            (config.port === 9527
              ? ". Port 9527 is also the controller default; when running a controller and this worker on the same host, point this worker's \`port\` config at another value"
              : "") +
            ". Adjust the `port` and `listenHost` plugin config keys to change the bind address.",
          ));
          return;
        }
        reject(err);
      });
    });
  }

  return {
    id: "teamclaw-worker",
    async start(_ctx: OpenClawPluginServiceContext) {
      await ensureOpenClawWorkspaceMemoryDir(logger);

      messageQueue = deps.messageQueue ?? new MessageQueue();
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
        onIdentityEstablished(identity);
        warnIfLoopbackBindBlocksRemoteController(controllerUrl);
        // Restart server with worker ID and task executor
        await startServer();
      }

      // Start heartbeat
      heartbeatTimer = setInterval(async () => {
        if (!identityManager.hasIdentity()) {
          const newIdentity = await identityManager.register();
          if (newIdentity && !controllerUrl) {
            controllerUrl = newIdentity.controllerUrl;
            workerId = newIdentity.workerId;
            onIdentityEstablished(newIdentity);
            warnIfLoopbackBindBlocksRemoteController(controllerUrl);
            await startServer();
          }
          return;
        }

        const id = identityManager.getIdentity();
        if (!id || !controllerUrl) return;

        try {
          const heartbeat = createHeartbeatPayload(
            id.workerId,
            activeTaskId ? "busy" : "idle",
            activeTaskId,
          );
          const res = await fetch(`${controllerUrl}/api/v1/workers/${id.workerId}/heartbeat`, {
            method: "POST",
            headers: withDeviceToken(config, { "Content-Type": "application/json" }),
            body: JSON.stringify(heartbeat),
          });

          if (!res.ok) {
            consecutiveHeartbeatFailures += 1;
            logger.warn(`Worker: heartbeat failed (${res.status})`);
            if (consecutiveHeartbeatFailures >= 3) {
              logger.warn("Worker: controller heartbeat failed repeatedly; clearing identity and forcing re-registration");
              await identityManager.clear();
              controllerUrl = null;
              workerId = null;
              consecutiveHeartbeatFailures = 0;
              await startServer();
            }
          } else {
            consecutiveHeartbeatFailures = 0;
          }
        } catch (err) {
          consecutiveHeartbeatFailures += 1;
          logger.warn(`Worker: heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
          if (consecutiveHeartbeatFailures >= 3) {
            logger.warn("Worker: controller heartbeat errored repeatedly; clearing identity and forcing re-registration");
            await identityManager.clear();
            controllerUrl = null;
            workerId = null;
            consecutiveHeartbeatFailures = 0;
            await startServer();
          }
        }
      }, config.heartbeatIntervalMs);

      if (heartbeatTimer) {
        const timer = heartbeatTimer as unknown as { unref?: () => void };
        timer.unref?.();
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
