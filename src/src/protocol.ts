import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeartbeatPayload, RegistrationRequest, RoleId } from "./types.js";

export const MDNS_TYPE = "_teamclaw._tcp";
export const DEFAULT_PORT = 9527;
export const HEARTBEAT_MS = 10000;
export const WORKER_TIMEOUT_MS = 30000;
export const API_PREFIX = "/api/v1";

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req);
  if (!raw.length) {
    return {};
  }

  try {
    return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function createRegistrationRequest(
  workerId: string,
  role: RoleId,
  label: string,
  url: string,
  capabilities: string[],
  launchToken?: string,
): RegistrationRequest {
  return { workerId, role, label, url, capabilities, launchToken };
}

function createHeartbeatPayload(
  workerId: string,
  status: HeartbeatPayload["status"],
  currentTaskId?: string,
): HeartbeatPayload {
  return {
    workerId,
    status,
    currentTaskId,
    timestamp: Date.now(),
  };
}

export {
  generateId,
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendError,
  createRegistrationRequest,
  createHeartbeatPayload,
};
