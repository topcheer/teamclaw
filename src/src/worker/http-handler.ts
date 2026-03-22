import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type { TeamMessage } from "../types.js";
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { MessageQueue } from "./message-queue.js";

export type TaskExecutor = (taskDescription: string, taskId: string) => Promise<string>;
export type ResultReporter = (taskId: string, result: string, error: string | null) => void;

export function createWorkerHttpHandler(
  config: { role: string; port: number },
  logger: PluginLogger,
  messageQueue: MessageQueue,
  workerId: string,
  taskExecutor?: TaskExecutor,
  resultReporter?: ResultReporter,
) {
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

        if (!taskId || !title || !description) {
          sendError(res, 400, "taskId, title, and description are required");
          return;
        }

        logger.info(`Worker: received task assignment - ${title} (${taskId})`);

        if (taskExecutor && resultReporter) {
          taskExecutor(description, taskId)
            .then((result) => resultReporter(taskId, result, null))
            .catch((err) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              resultReporter(taskId, "", errorMsg);
            });
        }

        sendJson(res, 202, { status: "accepted", taskId });
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

      sendError(res, 404, "Not found");
    } catch (err) {
      logger.error(`Worker HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  };
}
