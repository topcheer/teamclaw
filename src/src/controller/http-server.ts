import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type {
  PluginConfig,
  RoleId,
  TaskInfo,
  TaskPriority,
  TaskStatus,
  TeamMessage,
  TeamState,
  WorkerInfo,
} from "../types.js";
import {
  parseJsonBody,
  sendJson,
  sendError,
  generateId,
} from "../protocol.js";
import { ROLES } from "../roles.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer, type WsEvent } from "./websocket.js";

export type ControllerHttpDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
  taskRouter: TaskRouter;
  messageRouter: MessageRouter;
  wsServer: TeamWebSocketServer;
};

function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(content);
  } catch {
    sendError(res, 404, "File not found");
  }
}

export function createControllerHttpServer(deps: ControllerHttpDeps): http.Server {
  const { config, logger, getTeamState, updateTeamState, taskRouter, messageRouter, wsServer } = deps;

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    try {
      await handleRequest(req, res, pathname, deps);
    } catch (err) {
      logger.error(`Controller HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  });

  // Attach WebSocket
  wsServer.attach(server);

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ControllerHttpDeps,
): Promise<void> {
  const { config, logger, getTeamState, updateTeamState, taskRouter, messageRouter, wsServer } = deps;

  // ==================== Web UI ====================
  if (req.method === "GET" && (pathname === "/ui" || pathname === "/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    serveStaticFile(res, path.join(uiPath, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    const file = pathname.slice(4); // remove "/ui/"
    if (file.endsWith(".css")) {
      serveStaticFile(res, path.join(uiPath, file), "text/css; charset=utf-8");
    } else if (file.endsWith(".js")) {
      serveStaticFile(res, path.join(uiPath, file), "application/javascript; charset=utf-8");
    } else {
      serveStaticFile(res, path.join(uiPath, file), "application/octet-stream");
    }
    return;
  }

  // ==================== Worker Management ====================

  // POST /api/v1/workers/register
  if (req.method === "POST" && pathname === "/api/v1/workers/register") {
    const body = await parseJsonBody(req);
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const role = typeof body.role === "string" ? body.role as RoleId : "";
    const label = typeof body.label === "string" ? body.label : role;
    const workerUrl = typeof body.url === "string" ? body.url : "";
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities as string[] : [];

    if (!workerId || !role || !workerUrl) {
      sendError(res, 400, "workerId, role, and url are required");
      return;
    }

    const state = updateTeamState((s) => {
      s.workers[workerId] = {
        id: workerId,
        role,
        label,
        status: "idle",
        url: workerUrl,
        lastHeartbeat: Date.now(),
        capabilities,
        registeredAt: Date.now(),
      };
    });

    wsServer.broadcastUpdate({ type: "worker:online", data: state.workers[workerId] });
    logger.info(`Controller: worker registered - ${label} (${workerId}) at ${workerUrl}`);
    sendJson(res, 201, { status: "registered", worker: state.workers[workerId] });
    return;
  }

  // DELETE /api/v1/workers/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/workers\/[^/]+$/)) {
    const workerId = pathname.split("/").pop()!;
    const state = updateTeamState((s) => {
      if (s.workers[workerId]) {
        s.workers[workerId].status = "offline";
        delete s.workers[workerId];
      }
    });

    wsServer.broadcastUpdate({ type: "worker:offline", data: { workerId } });
    logger.info(`Controller: worker removed - ${workerId}`);
    sendJson(res, 200, { status: "removed" });
    return;
  }

  // GET /api/v1/workers
  if (req.method === "GET" && pathname === "/api/v1/workers") {
    const state = getTeamState();
    const workers = state ? Object.values(state.workers) : [];
    sendJson(res, 200, { workers });
    return;
  }

  // POST /api/v1/workers/:id/heartbeat
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/workers\/[^/]+\/heartbeat$/)) {
    const workerId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const status = typeof body.status === "string" ? body.status as WorkerInfo["status"] : "idle";
    const currentTaskId = typeof body.currentTaskId === "string" ? body.currentTaskId : undefined;

    updateTeamState((s) => {
      if (s.workers[workerId]) {
        s.workers[workerId].lastHeartbeat = Date.now();
        s.workers[workerId].status = status;
        s.workers[workerId].currentTaskId = currentTaskId;
      }
    });

    sendJson(res, 200, { status: "ok" });
    return;
  }

  // ==================== Task Management ====================

  // POST /api/v1/tasks
  if (req.method === "POST" && pathname === "/api/v1/tasks") {
    const body = await parseJsonBody(req);
    const title = typeof body.title === "string" ? body.title : "";
    const description = typeof body.description === "string" ? body.description : "";
    const priority = typeof body.priority === "string" ? body.priority as TaskPriority : "medium";
    const assignedRole = typeof body.assignedRole === "string" ? body.assignedRole as RoleId : undefined;
    const createdBy = typeof body.createdBy === "string" ? body.createdBy : "boss";

    if (!title) {
      sendError(res, 400, "title is required");
      return;
    }

    const taskId = generateId();
    const now = Date.now();

    const task: TaskInfo = {
      id: taskId,
      title,
      description,
      status: "pending",
      priority,
      assignedRole,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };

    const state = updateTeamState((s) => {
      s.tasks[taskId] = task;
    });

    // Try auto-assign
    const assignments = taskRouter.autoAssignPendingTasks(state.tasks, state.workers);
    if (assignments.length > 0) {
      const { task: assignedTask, worker } = assignments[0]!;
      updateTeamState((s) => {
        s.tasks[assignedTask.id].status = "assigned";
        s.tasks[assignedTask.id].assignedWorkerId = worker.id;
        s.tasks[assignedTask.id].updatedAt = Date.now();
        s.workers[worker.id].status = "busy";
        s.workers[worker.id].currentTaskId = assignedTask.id;
      });

      // Push task to worker
      try {
        await fetch(`${worker.url}/api/v1/tasks/assign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: assignedTask.id,
            title: assignedTask.title,
            description: assignedTask.description,
            priority: assignedTask.priority,
          }),
        });
      } catch (err) {
        logger.warn(`Controller: failed to push task to worker ${worker.id}: ${String(err)}`);
      }
    }

    const updatedTask = getTeamState()?.tasks[taskId];
    wsServer.broadcastUpdate({ type: "task:created", data: updatedTask });
    sendJson(res, 201, { task: updatedTask });
    return;
  }

  // GET /api/v1/tasks
  if (req.method === "GET" && pathname === "/api/v1/tasks") {
    const state = getTeamState();
    const tasks = state ? Object.values(state.tasks) : [];
    sendJson(res, 200, { tasks });
    return;
  }

  // GET /api/v1/tasks/:id
  if (req.method === "GET" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    const taskId = pathname.split("/").pop()!;
    const state = getTeamState();
    const task = state?.tasks[taskId];
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }
    sendJson(res, 200, { task });
    return;
  }

  // PATCH /api/v1/tasks/:id
  if (req.method === "PATCH" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    const taskId = pathname.split("/").pop()!;
    const body = await parseJsonBody(req);

    const state = updateTeamState((s) => {
      const task = s.tasks[taskId];
      if (!task) return;
      if (typeof body.status === "string") task.status = body.status as TaskStatus;
      if (typeof body.progress === "string") task.progress = body.progress as string;
      if (typeof body.priority === "string") task.priority = body.priority as TaskPriority;
      if (typeof body.assignedRole === "string") task.assignedRole = body.assignedRole as RoleId;
      task.updatedAt = Date.now();
    });

    const updatedTask = state.tasks[taskId];
    if (updatedTask) {
      wsServer.broadcastUpdate({ type: "task:updated", data: updatedTask });
    }
    sendJson(res, 200, { task: updatedTask });
    return;
  }

  // POST /api/v1/tasks/:id/assign
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/assign$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;

    const state = getTeamState();
    if (!state?.tasks[taskId]) {
      sendError(res, 404, "Task not found");
      return;
    }

    let targetWorker: WorkerInfo | null = null;
    if (workerId && state.workers[workerId]) {
      targetWorker = state.workers[workerId]!;
    } else {
      targetWorker = taskRouter.routeTask(state.tasks[taskId], state.workers);
    }

    if (!targetWorker) {
      sendError(res, 404, "No available worker for this task");
      return;
    }

    updateTeamState((s) => {
      s.tasks[taskId].status = "assigned";
      s.tasks[taskId].assignedWorkerId = targetWorker!.id;
      s.tasks[taskId].updatedAt = Date.now();
      s.workers[targetWorker!.id].status = "busy";
      s.workers[targetWorker!.id].currentTaskId = taskId;
    });

    // Push task to worker
    try {
      const task = state.tasks[taskId];
      await fetch(`${targetWorker.url}/api/v1/tasks/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
        }),
      });
    } catch (err) {
      logger.warn(`Controller: failed to push task to worker: ${String(err)}`);
    }

    const updatedTask = getTeamState()?.tasks[taskId];
    wsServer.broadcastUpdate({ type: "task:updated", data: updatedTask });
    sendJson(res, 200, { task: updatedTask, worker: targetWorker });
    return;
  }

  // POST /api/v1/tasks/:id/handoff
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/handoff$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const targetRole = typeof body.targetRole === "string" ? body.targetRole as RoleId : undefined;

    const state = getTeamState();
    if (!state?.tasks[taskId]) {
      sendError(res, 404, "Task not found");
      return;
    }

    updateTeamState((s) => {
      s.tasks[taskId].status = "pending";
      s.tasks[taskId].assignedWorkerId = undefined;
      s.tasks[taskId].assignedRole = targetRole ?? s.tasks[taskId].assignedRole;
      s.tasks[taskId].updatedAt = Date.now();

      // Free old worker
      const oldWorkerId = state.tasks[taskId].assignedWorkerId;
      if (oldWorkerId && s.workers[oldWorkerId]) {
        s.workers[oldWorkerId].status = "idle";
        s.workers[oldWorkerId].currentTaskId = undefined;
      }
    });

    // Try auto-assign to new role
    const newState = getTeamState()!;
    const worker = taskRouter.routeTask(newState.tasks[taskId], newState.workers);
    if (worker) {
      updateTeamState((s) => {
        s.tasks[taskId].status = "assigned";
        s.tasks[taskId].assignedWorkerId = worker.id;
        s.workers[worker.id].status = "busy";
        s.workers[worker.id].currentTaskId = taskId;
      });
    }

    const updatedTask = getTeamState()?.tasks[taskId];
    wsServer.broadcastUpdate({ type: "task:updated", data: updatedTask });
    sendJson(res, 200, { task: updatedTask });
    return;
  }

  // POST /api/v1/tasks/:id/result
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/result$/)) {
    const taskId = pathname.split("/")[4]!;
    const body = await parseJsonBody(req);
    const result = typeof body.result === "string" ? body.result : "";
    const error = typeof body.error === "string" ? body.error : undefined;

    const state = updateTeamState((s) => {
      const task = s.tasks[taskId];
      if (!task) return;
      task.status = error ? "failed" : "completed";
      task.result = result;
      task.error = error;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();

      // Free worker
      if (task.assignedWorkerId && s.workers[task.assignedWorkerId]) {
        s.workers[task.assignedWorkerId].status = "idle";
        s.workers[task.assignedWorkerId].currentTaskId = undefined;
      }
    });

    const updatedTask = state.tasks[taskId];
    wsServer.broadcastUpdate({ type: "task:completed", data: updatedTask });
    logger.info(`Controller: task ${taskId} ${error ? "failed" : "completed"}`);
    sendJson(res, 200, { task: updatedTask });
    return;
  }

  // ==================== Message Routing ====================

  // POST /api/v1/messages/direct
  if (req.method === "POST" && pathname === "/api/v1/messages/direct") {
    const body = await parseJsonBody(req);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
      type: "direct",
      content: typeof body.content === "string" ? body.content : "",
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      createdAt: Date.now(),
    };

    updateTeamState((s) => { s.messages.push(message); });

    const state = getTeamState()!;
    const routed = messageRouter.routeDirectMessage(message, state.workers);
    if (routed) {
      try {
        await fetch(`${routed.worker.url}/api/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(routed.message),
        });
      } catch (err) {
        logger.warn(`Controller: failed to deliver message to ${routed.worker.id}: ${String(err)}`);
      }
    }

    wsServer.broadcastUpdate({ type: "message:new", data: message });
    sendJson(res, 201, { status: routed ? "delivered" : "no-target", message });
    return;
  }

  // POST /api/v1/messages/broadcast
  if (req.method === "POST" && pathname === "/api/v1/messages/broadcast") {
    const body = await parseJsonBody(req);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      type: "broadcast",
      content: typeof body.content === "string" ? body.content : "",
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      createdAt: Date.now(),
    };

    updateTeamState((s) => { s.messages.push(message); });

    const state = getTeamState()!;
    const routed = messageRouter.routeBroadcast(message, state.workers);
    for (const { worker, message: routedMsg } of routed) {
      try {
        await fetch(`${worker.url}/api/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(routedMsg),
        });
      } catch (err) {
        logger.warn(`Controller: failed to broadcast to ${worker.id}: ${String(err)}`);
      }
    }

    wsServer.broadcastUpdate({ type: "message:new", data: message });
    sendJson(res, 201, { status: "broadcast", recipients: routed.length });
    return;
  }

  // POST /api/v1/messages/review-request
  if (req.method === "POST" && pathname === "/api/v1/messages/review-request") {
    const body = await parseJsonBody(req);
    const message: TeamMessage = {
      id: generateId(),
      from: typeof body.from === "string" ? body.from : "",
      fromRole: typeof body.fromRole === "string" ? body.fromRole as RoleId : undefined,
      toRole: typeof body.toRole === "string" ? body.toRole as RoleId : undefined,
      type: "review-request",
      content: typeof body.content === "string" ? body.content : "",
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      createdAt: Date.now(),
    };

    updateTeamState((s) => { s.messages.push(message); });

    const state = getTeamState()!;
    const routed = messageRouter.routeReviewRequest(message, state.workers);
    if (routed) {
      try {
        await fetch(`${routed.worker.url}/api/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(routed.message),
        });
      } catch (err) {
        logger.warn(`Controller: failed to deliver review request: ${String(err)}`);
      }
    }

    wsServer.broadcastUpdate({ type: "message:new", data: message });
    sendJson(res, 201, { status: routed ? "delivered" : "no-target", message });
    return;
  }

  // GET /api/v1/messages
  if (req.method === "GET" && pathname === "/api/v1/messages") {
    const state = getTeamState();
    const messages = state?.messages ?? [];
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const limit = parseInt(reqUrl.searchParams.get("limit") ?? "50", 10);
    const offset = parseInt(reqUrl.searchParams.get("offset") ?? "0", 10);
    sendJson(res, 200, {
      messages: messages.slice(offset, offset + limit),
      total: messages.length,
    });
    return;
  }

  // ==================== Team Info ====================

  // GET /api/v1/team/status
  if (req.method === "GET" && pathname === "/api/v1/team/status") {
    const state = getTeamState();
    if (!state) {
      sendJson(res, 200, { teamName: config.teamName, workers: [], tasks: [], messages: [] });
      return;
    }
    sendJson(res, 200, {
      teamName: state.teamName,
      workers: Object.values(state.workers),
      tasks: Object.values(state.tasks),
      taskCount: Object.keys(state.tasks).length,
      workerCount: Object.keys(state.workers).length,
    });
    return;
  }

  // GET /api/v1/roles
  if (req.method === "GET" && pathname === "/api/v1/roles") {
    sendJson(res, 200, { roles: ROLES });
    return;
  }

  // GET /api/v1/health
  if (req.method === "GET" && pathname === "/api/v1/health") {
    sendJson(res, 200, { status: "ok", mode: "controller", timestamp: Date.now() });
    return;
  }

  sendError(res, 404, "Not found");
}
