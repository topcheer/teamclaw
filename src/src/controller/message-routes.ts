// PR-C of issue #204 (http-server monolith split): the team message routes
// (direct/broadcast/review-request send + list) lifted verbatim from the
// inline dispatch blocks in controller/http-server.ts. Zero behavior change -
// the route shells in http-server keep the method+pathname matches and call
// these handlers with the same deps object as before. This module must NEVER
// import http-server (the reverse edge exists: http-server -> message-routes).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeamMessage } from "../types.js";
import { generateId, parseJsonBody, sendJson } from "../protocol.js";
import { ensureTeamMessageContract } from "../interaction-contracts.js";
import { validateActiveRoleId } from "../profile-loader.js";
import {
  deliverMessageToWorker,
  routeDirectMessage,
} from "./message-delivery.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

// POST /api/v1/messages/direct
export async function handleDirectMessageRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { updateTeamState, wsServer } = deps;
  const body = await parseJsonBody(req);
  const fromRole = validateActiveRoleId(body.fromRole);
  const toRole = validateActiveRoleId(body.toRole);
  const message: TeamMessage = {
    id: generateId(),
    from: typeof body.from === "string" ? body.from : "",
    fromRole,
    toRole,
    type: "direct",
    content: typeof body.content === "string" ? body.content : "",
    contract: ensureTeamMessageContract(body.contract, {
      type: "direct",
      content: typeof body.content === "string" ? body.content : "",
      toRole,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    }),
    taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    createdAt: Date.now(),
  };

  updateTeamState((s) => { s.messages.push(message); });

  const routed = await routeDirectMessage(message, deps);

  wsServer.broadcastUpdate({ type: "message:new", data: message });
  sendJson(res, 201, { status: routed ? "delivered" : "no-target", message });
}

// POST /api/v1/messages/broadcast
export async function handleBroadcastMessageRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { logger, getTeamState, updateTeamState, messageRouter, wsServer } = deps;
  const body = await parseJsonBody(req);
  const fromRole = validateActiveRoleId(body.fromRole);
  const message: TeamMessage = {
    id: generateId(),
    from: typeof body.from === "string" ? body.from : "",
    fromRole,
    type: "broadcast",
    content: typeof body.content === "string" ? body.content : "",
    contract: ensureTeamMessageContract(body.contract, {
      type: "broadcast",
      content: typeof body.content === "string" ? body.content : "",
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    }),
    taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    createdAt: Date.now(),
  };

  updateTeamState((s) => { s.messages.push(message); });

  const state = getTeamState()!;
  const routed = messageRouter.routeBroadcast(message, state.workers);
  for (const { worker, message: routedMsg } of routed) {
    try {
      await deliverMessageToWorker(worker, routedMsg, deps);
    } catch (err) {
      logger.warn(`Controller: failed to broadcast to ${worker.id}: ${String(err)}`);
    }
  }

  wsServer.broadcastUpdate({ type: "message:new", data: message });
  sendJson(res, 201, { status: "broadcast", recipients: routed.length });
}

// POST /api/v1/messages/review-request
export async function handleReviewRequestMessageRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { logger, getTeamState, updateTeamState, messageRouter, wsServer } = deps;
  const body = await parseJsonBody(req);
  const fromRole = validateActiveRoleId(body.fromRole);
  const toRole = validateActiveRoleId(body.toRole);
  const message: TeamMessage = {
    id: generateId(),
    from: typeof body.from === "string" ? body.from : "",
    fromRole,
    toRole,
    type: "review-request",
    content: typeof body.content === "string" ? body.content : "",
    contract: ensureTeamMessageContract(body.contract, {
      type: "review-request",
      content: typeof body.content === "string" ? body.content : "",
      toRole,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      intent: "review-request",
      needsResponse: true,
    }),
    taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    createdAt: Date.now(),
  };

  updateTeamState((s) => { s.messages.push(message); });

  const state = getTeamState()!;
  const routed = messageRouter.routeReviewRequest(message, state.workers);
  if (routed) {
    try {
      await deliverMessageToWorker(routed.worker, routed.message, deps);
    } catch (err) {
      logger.warn(`Controller: failed to deliver review request: ${String(err)}`);
    }
  }

  wsServer.broadcastUpdate({ type: "message:new", data: message });
  sendJson(res, 201, { status: routed ? "delivered" : "no-target", message });
}

// GET /api/v1/messages
export async function handleMessageListRequest(deps: ControllerTaskDomainDeps, res: ServerResponse, requestUrl: URL): Promise<void> {
  const { getTeamState } = deps;
  const state = getTeamState();
  const messages = state?.messages ?? [];
  const limit = parseInt(requestUrl.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(requestUrl.searchParams.get("offset") ?? "0", 10);
  sendJson(res, 200, {
    messages: messages.slice(offset, offset + limit),
    total: messages.length,
  });
}
