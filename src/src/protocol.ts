import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeartbeatPayload, RegistrationRequest, RoleId } from "./types.js";

export const MDNS_TYPE = "_teamclaw._tcp";
export const DEFAULT_PORT = 9527;
export const HEARTBEAT_MS = 10000;
export const WORKER_TIMEOUT_MS = 30000;
export const API_PREFIX = "/api/v1";

// Issue #255 P0-1: id fragments used to come from the V8 Math PRNG
// (xorshift128+ - the internal state is recoverable from a handful of
// observed outputs, so past fragments leak future ones). Fragments now
// derive from the CSPRNG. The output shape (timestamp + 6 base36 chars) is
// kept byte-compatible so no generateId consumer sees a format change.
const ID_FRAGMENT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomIdFragment(length = 6): string {
  let fragment = "";
  while (fragment.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 256 is not a multiple of 36: bytes >= 252 would bias the last four
      // alphabet symbols - reject them and draw again.
      if (byte >= 252) {
        continue;
      }
      fragment += ID_FRAGMENT_ALPHABET[byte % 36]!;
      if (fragment.length === length) {
        break;
      }
    }
  }
  return fragment;
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = randomIdFragment();
  return `${ts}-${rand}`;
}

/**
 * Issue #255 P0-1: bearer token a provisioned worker must present at
 * registration (and that the controller echoes on task dispatch). 256 bits
 * from the CSPRNG, hex-encoded. This is an internal value with no external
 * format contract - it travels controller -> worker through the
 * TEAMCLAW_LAUNCH_TOKEN env var and is only ever equality-checked - so the
 * old `${generateId()}-${generateId()}` shape (two ~31-bit xorshift128+
 * fragments) is replaced outright. Tokens minted by older builds stay valid:
 * the check is an equality either way (now constant-time), only generation
 * changes.
 */
function generateLaunchToken(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time string equality for secrets (length guard: token length is
 * a public format detail, not secret content).
 * #259 follow-up: canonical home is this leaf module so controller leaves
 * (worker-provisioning) can compare secrets without importing
 * controller/security.ts, which would close a module cycle
 * (http-server <-> route-table <-> security <-> worker-provisioning). */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
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

/**
 * Issue #23: the Access-Control-Allow-Origin value a response should carry.
 * A header the security gate PINNED before dispatch (device protection on:
 * same-origin echo, or an explicit empty value for foreign origins) wins;
 * with nothing pinned (protection off / non-browser requests) the value is
 * the historical wildcard, byte for byte. Every response path that sets
 * ACAO (sendJson here, the raw-file and repo-bundle octet-stream writers in
 * the controller routes) must go through this helper so no route can widen
 * a pinned response back to the L0 wildcard.
 */
function pinnedCorsAllowOrigin(res: ServerResponse): string {
  const pinned = res.getHeader("Access-Control-Allow-Origin");
  return typeof pinned === "string" ? pinned : "*";
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": pinnedCorsAllowOrigin(res),
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
  generateLaunchToken,
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendError,
  pinnedCorsAllowOrigin,
  createRegistrationRequest,
  createHeartbeatPayload,
};
