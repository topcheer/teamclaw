import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type { TaskAssignmentPayload, TeamMessage } from "../types.js";
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { MessageQueue } from "./message-queue.js";

export type TaskExecutor = (assignment: TaskAssignmentPayload) => Promise<string | { text: string; contract?: Record<string, unknown> }>;
export type ResultReporter = (taskId: string, result: string, error: string | null, contract?: Record<string, unknown>) => void;
export type TaskCanceller = (taskId: string) => Promise<boolean> | boolean;
export type TaskCancelChecker = (taskId: string) => boolean;
export type KickoffAssessor = (requirement: string, role: string) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Inbound API auth (issue #222, coordinated scope after #23/#227).
//
// The controller's device gate (#23) protects controller->world traffic; the
// REVERSE direction (controller dispatching tasks/messages INTO this worker)
// had no check at all, so any pod/host that can reach the worker port could
// submit tasks and poison results (review finding C2). Token model, chosen
// for minimal invasion with no NEW pairing surface:
//
//   expected tokens = { config.securityToken, env TEAMCLAW_LAUNCH_TOKEN }
//
//   - Provisioned workers: the provisioner already generates a per-worker
//     launch token, delivers it via the TEAMCLAW_LAUNCH_TOKEN env, and the
//     controller keeps it in the provisioning record - reuse it (it is
//     already decoupled from the #23 device registry, so option (a)'s shape
//     without a second token).
//   - Manual/external workers: the operator syncs `securityToken` to the
//     same value on the controller and the worker (documentation stance for
//     self-managed fleets); provisioning-record tokens take precedence on
//     the controller side.
//   - BOTH are accepted (either match passes): pairing a provisioned worker
//     later (`teamclaw pair` overwrites config.securityToken) must never
//     lock the controller out of its own dispatch path.
//   - Neither set => L0: zero checks, byte-identical historical behavior.
//
// /api/v1/health stays exempt: kubelet/docker probes (helm charts probe
// this path) cannot attach headers, mirroring the controller gate's health
// exemption. Comparison is constant-time on the raw token (a single shared
// secret per direction; hashing buys nothing here).
// ---------------------------------------------------------------------------

/** Constant-time string equality; length mismatch short-circuits (leaks only length, never content). */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The non-empty token values this worker accepts on inbound /api requests
 * (config.securityToken and/or the provisioner's TEAMCLAW_LAUNCH_TOKEN).
 * Empty result = L0 (no inbound auth).
 */
export function resolveWorkerInboundTokens(config: { securityToken?: string }): string[] {
  const configured = config.securityToken?.trim();
  const launch = process.env.TEAMCLAW_LAUNCH_TOKEN?.trim();
  return [configured, launch].filter((token): token is string => Boolean(token));
}

export function createWorkerHttpHandler(
  config: { role: string; port: number; securityToken?: string },
  logger: PluginLogger,
  messageQueue: MessageQueue,
  workerId: string,
  taskExecutor?: TaskExecutor,
  resultReporter?: ResultReporter,
  cancelTaskExecution?: TaskCanceller,
  isTaskCancelled?: TaskCancelChecker,
  kickoffAssessor?: KickoffAssessor,
) {
  const inboundTokens = resolveWorkerInboundTokens(config);
  return async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Inbound device gate (issue #222): every /api route except the health
    // probe requires X-TeamClaw-Token while this worker holds an expected
    // token. No expected token configured => proceed (L0, zero change).
    if (inboundTokens.length > 0 && pathname.startsWith("/api/") && pathname !== "/api/v1/health") {
      const presented = typeof req.headers["x-teamclaw-token"] === "string" ? req.headers["x-teamclaw-token"].trim() : "";
      if (!presented || !inboundTokens.some((expected) => constantTimeEqual(expected, presented))) {
        logger.warn(`Worker: rejected unauthenticated ${req.method ?? "?"} ${pathname} from ${req.socket.remoteAddress ?? "unknown"}`);
        sendError(res, 401, "unauthorized: this worker requires the X-TeamClaw-Token header (the controller's dispatch token for this worker, or the value synced into securityToken)");
        return;
      }
    }

    try {
      // GET /api/v1/health
      if (req.method === "GET" && pathname === "/api/v1/health") {
        sendJson(res, 200, {
          status: "ok",
          workerId,
          role: config.role,
          timestamp: Date.now(),
        });
        return;
      }

      // GET /api/v1/messages (drain queued messages)
      if (req.method === "GET" && pathname === "/api/v1/messages") {
        const messages = messageQueue.drain();
        sendJson(res, 200, { messages });
        return;
      }

      // POST /api/v1/tasks/assign
      if (req.method === "POST" && pathname === "/api/v1/tasks/assign") {
        const body = await parseJsonBody(req);
        const taskId = typeof body.taskId === "string" ? body.taskId : "";
        const title = typeof body.title === "string" ? body.title : "";
        const description = typeof body.description === "string" ? body.description : "";
        const recommendedSkills = Array.isArray(body.recommendedSkills)
          ? body.recommendedSkills.map((entry) => String(entry ?? ""))
          : undefined;
        const executionSessionKey = typeof body.executionSessionKey === "string"
          ? body.executionSessionKey
          : undefined;
        const executionIdempotencyKey = typeof body.executionIdempotencyKey === "string"
          ? body.executionIdempotencyKey
          : undefined;
        const projectDir = typeof body.projectDir === "string"
          ? body.projectDir
          : undefined;
        const repo = body.repo && typeof body.repo === "object"
          ? body.repo as TaskAssignmentPayload["repo"]
          : undefined;

        if (!taskId || !title || !description) {
          sendError(res, 400, "taskId, title, and description are required");
          return;
        }

        logger.info(`Worker: received task assignment - ${title} (${taskId})`);

        if (taskExecutor && resultReporter) {
            taskExecutor({
              taskId,
              title,
              description,
              recommendedSkills,
              projectDir,
              executionSessionKey,
              executionIdempotencyKey,
              repo,
            })
            .then((raw) => {
              if (isTaskCancelled?.(taskId)) {
                logger.info(`Worker: skipping result report for cancelled task ${taskId}`);
                return;
              }
              const result = typeof raw === "string" ? { text: raw } : raw;
              resultReporter(taskId, result.text, null, result.contract);
            })
            .catch((err) => {
              if (isTaskCancelled?.(taskId)) {
                logger.info(`Worker: skipping error report for cancelled task ${taskId}`);
                return;
              }
              const errorMsg = err instanceof Error ? err.message : String(err);
              resultReporter(taskId, "", errorMsg);
            });
        }

        sendJson(res, 202, { status: "accepted", taskId });
        return;
      }

      // POST /api/v1/tasks/:id/cancel
      if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/cancel$/)) {
        if (!cancelTaskExecution) {
          sendError(res, 501, "Task cancellation is not supported");
          return;
        }

        const taskId = pathname.split("/")[4]!;
        const cancelled = await cancelTaskExecution(taskId);
        sendJson(res, 200, { status: cancelled ? "cancelled" : "not-active", taskId });
        return;
      }

      // POST /api/v1/messages
      if (req.method === "POST" && pathname === "/api/v1/messages") {
        const body = await parseJsonBody(req);
        const message = body as unknown as TeamMessage;

        if (!message || typeof message.content !== "string") {
          sendError(res, 400, "Invalid message format");
          return;
        }

        messageQueue.push(message);
        logger.info(`Worker: received message from ${message.from ?? "unknown"}: ${message.content.slice(0, 50)}`);
        sendJson(res, 201, { status: "queued" });
        return;
      }

      // POST /api/v1/kickoff/assess
      if (req.method === "POST" && pathname === "/api/v1/kickoff/assess") {
        if (!kickoffAssessor) {
          sendError(res, 501, "Kickoff assessment is not supported by this worker");
          return;
        }

        const body = await parseJsonBody(req);
        const requirement = typeof body.requirement === "string" ? body.requirement : "";
        const role = typeof body.role === "string" ? body.role : config.role;

        if (!requirement) {
          sendError(res, 400, "requirement is required");
          return;
        }

        logger.info(`Worker: received kickoff assessment request for role ${role}`);

        try {
          const assessment = await kickoffAssessor(requirement, role);
          sendJson(res, 200, { assessment });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error(`Worker: kickoff assessment failed: ${errorMsg}`);
          sendError(res, 500, `Assessment failed: ${errorMsg}`);
        }
        return;
      }

      sendError(res, 404, "Not found");
    } catch (err) {
      logger.error(`Worker HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  };
}
