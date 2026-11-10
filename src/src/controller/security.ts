// ===========================================================================
// Controller device-pairing security (issue #23, backend wave).
//
// Zero-friction ladder (product semantics, FIXED - do not change):
//   L0 local   - no devices persisted => zero authentication (today's
//                behavior; a TeamState without `security` or with an empty
//                devices array is L0)
//   L1 LAN     - LAN peers (loopback / RFC1918 / ULA / link-local) may
//                self-pair via POST /api/v1/security/pair-auto while
//                config.security.autoPair is true (default) - the mDNS
//                discovery scenario, zero user input
//   L2 exposed - one-shot 60s pairing codes (8-char uppercase base32)
//                minted by an authenticated device or the loopback console
// The user NEVER configures a token and the UI NEVER shows a login page.
// Each paired device holds its own 32-byte token (revocation granularity);
// only the sha256 hash is persisted, the plaintext is returned exactly once
// (web UI: HttpOnly SameSite=Strict cookie; worker/desktop/cli: their own
// config stores - client wave).
//
// Escape hatches (deliberate, physical-access trust model):
//   - POST /api/v1/security/enable is LOOPBACK-ONLY: the L2 console is the
//     controller host itself. A remote caller able to "enable" would mint
//     the FIRST device token and own the team, so remote enable is a 403.
//   - POST /api/v1/security/reset accepts an authenticated device OR a
//     loopback caller: whoever has physical access to the controller host
//     can always fall back to L0 (anti-lockout hatch).
//
// Module boundaries: this module never imports http-server.ts or
// route-table.ts at runtime (route-table imports the handlers below;
// route-table/route-context back-references are TYPE ONLY), keeping the
// controller module graph acyclic like the PR-C domain modules.
// ===========================================================================
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type {
  NonLanPeerObservation,
  PluginConfig,
  SecurityDevice,
  SecurityDeviceKind,
  SecurityPairingCode,
  TeamState,
} from "../types.js";
import { parseJsonBody, sendJson } from "../protocol.js";
import { secretsEqual } from "../protocol.js";
import type { RouteContext } from "./route-table.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session cookie set by /security/enable (and honored on every /api/v1 route). */
export const SESSION_COOKIE_NAME = "teamclaw_session";
/** Cookie lifetime: 30 days; revoking the device invalidates it regardless. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Pairing code entropy/shape: 8 chars of RFC 4648 base32 = 40 random bits. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 60_000;
/** Device token size (hex string is twice this). */
const TOKEN_BYTES = 32;
/** lastSeenAt persistence throttle: at most one state write per interval. */
const LAST_SEEN_PERSIST_INTERVAL_MS = 30_000;
/** Suggestion-signal persistence throttle (per source IP). */
const NON_LAN_SIGNAL_PERSIST_INTERVAL_MS = 60_000;
/** Online guessing throttle for POST /security/pair (defense in depth on top of the 40-bit code + 60s TTL). */
const PAIR_FAILURE_WINDOW_MS = 5 * 60_000;
const PAIR_FAILURE_MAX = 20;

const DEVICE_KINDS: readonly SecurityDeviceKind[] = ["web", "worker", "desktop", "cli"];
const DEFAULT_DEVICE_NAMES: Record<SecurityDeviceKind, string> = {
  web: "Web UI",
  worker: "Worker",
  desktop: "Desktop",
  cli: "CLI",
};

/** Pairing endpoints are exempt from the bearer middleware: each enforces its OWN stricter origin rule below. */
const SECURITY_EXEMPT_POST_PATHS = new Set([
  "/api/v1/security/enable",
  "/api/v1/security/pair/start",
  "/api/v1/security/pair",
  "/api/v1/security/pair-auto",
  "/api/v1/security/reset",
]);
const HEALTH_PATH = "/api/v1/health";

// ---------------------------------------------------------------------------
// Token / pairing-code primitives
// ---------------------------------------------------------------------------

/** Generates a fresh device token (64-char hex). Shown to the caller ONCE. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** sha256 hex of a device token - the ONLY representation persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time secret comparison lives in protocol.ts (leaf module) since
 * the #259 dependency gate - controller/security re-exports it for its
 * historical importers (tunnel-routes) so no external call site changes. */
export { secretsEqual };

/** 8-char uppercase base32 code from 40 random bits (5 bytes -> exactly 8 chars, no padding). */
export function generatePairingCode(): string {
  const bytes = randomBytes(5); // 5 bytes = 40 bits = exactly PAIRING_CODE_LENGTH base32 chars
  let out = "";
  let bitBuf = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bitBuf = (bitBuf << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && out.length < PAIRING_CODE_LENGTH) {
      bitCount -= 5;
      out += PAIRING_CODE_ALPHABET[(bitBuf >>> bitCount) & 31];
    }
    if (out.length >= PAIRING_CODE_LENGTH) {
      break;
    }
  }
  return out;
}

function mintPairingCode(): SecurityPairingCode {
  return { code: generatePairingCode(), expiresAt: Date.now() + PAIRING_CODE_TTL_MS, purpose: "device-pairing" };
}

// ---------------------------------------------------------------------------
// Peer classification (pure functions)
// ---------------------------------------------------------------------------

/** Lowercases, strips IPv6 zone ids and unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d). */
export function normalizePeerIp(ip: string | undefined): string {
  if (typeof ip !== "string") {
    return "";
  }
  let value = ip.trim().toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex > 0) {
    value = value.slice(0, zoneIndex);
  }
  if (value.startsWith("::ffff:")) {
    const tail = value.slice("::ffff:".length);
    if (net.isIPv4(tail)) {
      value = tail;
    }
  }
  return value;
}

/** Loopback = 127.0.0.0/8 or ::1 (the controller console itself). */
export function isLoopbackIp(ip: string | undefined): boolean {
  const value = normalizePeerIp(ip);
  if (!value) {
    return false;
  }
  if (value === "::1") {
    return true;
  }
  return net.isIPv4(value) && value.startsWith("127.");
}

/**
 * LAN = loopback, RFC1918 (10/8, 172.16/12, 192.168/16), IPv4 link-local
 * (169.254/16), IPv6 link-local (fe80::/10) and ULA (fc00::/7). Zero-input
 * pairing (L1) is bounded to exactly this set.
 */
export function isLanIp(ip: string | undefined): boolean {
  const value = normalizePeerIp(ip);
  if (!value) {
    return false;
  }
  if (isLoopbackIp(value)) {
    return true;
  }
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }
  if (net.isIPv6(value)) {
    if (/^f[cd]/.test(value)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(value)) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

export type SecurityPeer = {
  ip: string;
  /** Request arrived through the sharing tunnel - NEVER trusted as loopback/LAN even though cloudflared dials from 127.0.0.1. */
  viaTunnel: boolean;
  loopback: boolean;
  lan: boolean;
};

export function classifySecurityPeer(ip: string | undefined, viaTunnel: boolean): SecurityPeer {
  const normalized = normalizePeerIp(ip) || "unknown";
  return {
    ip: normalized,
    viaTunnel,
    loopback: !viaTunnel && isLoopbackIp(normalized),
    lan: !viaTunnel && isLanIp(normalized),
  };
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Protection is ON iff at least one paired device exists (the ladder switch). */
export function isProtectionOn(state: TeamState | null): boolean {
  return (state?.security?.devices?.length ?? 0) > 0;
}

function ensureSecurityState(state: TeamState): NonNullable<TeamState["security"]> {
  state.security ??= { devices: [] };
  return state.security;
}

// ---------------------------------------------------------------------------
// Token extraction / verification
// ---------------------------------------------------------------------------

function tokenFromCookieHeader(cookie: string | undefined): string | null {
  if (typeof cookie !== "string" || !cookie) {
    return null;
  }
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^\\s;]+)`));
  const value = match?.[1];
  return value ? value : null;
}

/**
 * Device token sources, in priority order: Authorization: Bearer,
 * X-TeamClaw-Token, then the teamclaw_session cookie. All three compare
 * against the SAME per-device token hash set.
 */
export function extractDeviceToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) {
      return token;
    }
  }
  const header = req.headers["x-teamclaw-token"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  const cookie = tokenFromCookieHeader(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  return cookie && cookie.trim() ? cookie.trim() : null;
}

export type AuthenticatedDevice = { device: SecurityDevice };

/** Timing-safe token verification against every stored device hash. */
export function authenticateDeviceToken(state: TeamState | null, token: string | null): AuthenticatedDevice | null {
  if (!state?.security || !token) {
    return null;
  }
  const tokenHash = hashToken(token);
  for (const device of state.security.devices) {
    if (secretsEqual(device.tokenHash, tokenHash)) {
      return { device };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CORS policy (issue #23: narrowed while protection is on)
// ---------------------------------------------------------------------------

/** True when the request's Origin matches the Host it was addressed to (the UI's own origin). */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || !origin || typeof host !== "string" || !host.trim()) {
    return false;
  }
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

export type CorsPreflightDecision = { status: number; headers: Record<string, string> };

/**
 * Preflight policy. Protection OFF: byte-identical to the historical
 * wildcard preflight (L0 zero drift). Protection ON: same-origin origins
 * are echoed (with the auth headers whitelisted so paired UIs can send
 * them), a foreign Origin gets an explicit 403 (the browser blocks the
 * actual request), and requests without an Origin header (non-browser
 * clients) answer plainly.
 */
export function corsPreflightDecision(req: IncomingMessage, protectionOn: boolean): CorsPreflightDecision {
  if (!protectionOn) {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }
  const methods = "GET, POST, PATCH, DELETE, OPTIONS";
  const allowHeaders = "Content-Type, Authorization, X-TeamClaw-Token";
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!origin) {
    return { status: 200, headers: { "Access-Control-Allow-Methods": methods, "Access-Control-Allow-Headers": allowHeaders } };
  }
  if (!isSameOriginRequest(req)) {
    return { status: 403, headers: { Vary: "Origin" } };
  }
  return {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": allowHeaders,
      Vary: "Origin",
    },
  };
}

/**
 * Narrows the Access-Control-Allow-Origin of every response while
 * protection is on, by pinning the header BEFORE dispatch: same-origin
 * requests echo their origin; foreign origins get an explicit empty value
 * (protocol.sendJson honors a pinned header, so no route can widen it back
 * to the L0 wildcard); requests without an Origin header (non-browser
 * clients) need no CORS headers at all. Protection OFF: no-op (wildcard
 * behavior everywhere, unchanged).
 */
export function applyResponseCorsPolicy(req: IncomingMessage, res: ServerResponse, protectionOn: boolean): void {
  if (!protectionOn) {
    return;
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!origin) {
    return;
  }
  if (!isSameOriginRequest(req)) {
    res.setHeader("Access-Control-Allow-Origin", "");
    res.setHeader("Vary", "Origin");
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
}

// ---------------------------------------------------------------------------
// Middleware (the guard in the http-server pipeline: CORS -> auth ->
// tunnel gate -> transition -> capability -> route table)
// ---------------------------------------------------------------------------

export type SecurityMiddlewareDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
};

export type SecurityMiddleware = (req: IncomingMessage, res: ServerResponse, pathname: string, peer: SecurityPeer) => boolean;

/**
 * True when the request path must NOT be blocked by the device gate:
 * health (liveness probes), UI static assets and the tunnel gate pages
 * (every non-/api path - static UI code carries no team data and the
 * unpaired browser still needs to load the page that DISPLAYS the pairing
 * hint), and the five pairing endpoints which each enforce a stricter
 * rule of their own (enable/reset: loopback-or-authenticated;
 * pair/start: authenticated-or-loopback; pair: one-shot code;
 * pair-auto: LAN peer + config switch).
 */
export function isSecurityExemptPath(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) {
    return true;
  }
  if (pathname === HEALTH_PATH) {
    return true;
  }
  return method === "POST" && SECURITY_EXEMPT_POST_PATHS.has(pathname);
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    error: "unauthorized",
    hint: "This TeamClaw controller requires paired devices. From a LAN host: POST /api/v1/security/pair-auto {\"kind\":\"cli\",\"name\":\"...\"}. Otherwise ask the controller owner for a pairing code and POST /api/v1/security/pair {\"code\",\"kind\",\"name\"}.",
  });
}

/**
 * Suggestion signal (protection off): remember the latest non-LAN peer so
 * /api/v1/team/status can recommend enabling protection. Throttled per
 * source IP to keep scanners from turning it into a write storm (at most
 * one persisted observation per peer per interval; the recorded path is
 * simply the most recent one seen).
 */
function recordNonLanPeerSignal(
  deps: SecurityMiddlewareDeps,
  state: TeamState | null,
  peer: SecurityPeer,
  pathname: string,
): void {
  if (!state || peer.lan || !pathname.startsWith("/api/")) {
    return;
  }
  const now = Date.now();
  const last = state.security?.lastNonLanPeer;
  if (last && last.ip === peer.ip && now - last.at < NON_LAN_SIGNAL_PERSIST_INTERVAL_MS) {
    return;
  }
  const observation: NonLanPeerObservation = { ip: peer.ip, at: now, path: pathname };
  deps.updateTeamState((s) => {
    ensureSecurityState(s).lastNonLanPeer = observation;
  });
}

/** Throttled lastSeenAt persistence: in-memory freshness, bounded write rate. */
function touchDeviceLastSeen(deps: SecurityMiddlewareDeps, deviceId: string): void {
  const device = deps.getTeamState()?.security?.devices.find((entry) => entry.id === deviceId);
  if (!device) {
    return;
  }
  const now = Date.now();
  if (device.lastSeenAt && now - device.lastSeenAt < LAST_SEEN_PERSIST_INTERVAL_MS) {
    return;
  }
  deps.updateTeamState((s) => {
    const target = s.security?.devices.find((entry) => entry.id === deviceId);
    if (target) {
      target.lastSeenAt = now;
    }
  });
}

/**
 * The device gate. Returns true to proceed. While protection is on every
 * non-exempt /api request must present a valid device token (Bearer /
 * X-TeamClaw-Token / session cookie); the matched device's lastSeenAt is
 * refreshed (throttled) and unauthenticated callers get a 401 whose body
 * points at the pairing commands instead of leaking any team detail.
 */
export function createSecurityMiddleware(deps: SecurityMiddlewareDeps): SecurityMiddleware {
  return function enforceDeviceAuth(req, res, pathname, peer): boolean {
    const state = deps.getTeamState();
    const protectionOn = isProtectionOn(state);

    applyResponseCorsPolicy(req, res, protectionOn);

    if (!protectionOn) {
      recordNonLanPeerSignal(deps, state, peer, pathname);
      return true;
    }

    if (isSecurityExemptPath(req.method ?? "", pathname)) {
      return true;
    }

    const auth = authenticateDeviceToken(state, extractDeviceToken(req));
    if (!auth) {
      deps.logger.warn(`Controller: rejected unauthenticated ${req.method ?? "?"} ${pathname} from ${peer.ip}${peer.viaTunnel ? " (via tunnel)" : ""}`);
      sendUnauthorized(res);
      return false;
    }
    touchDeviceLastSeen(deps, auth.device.id);
    return true;
  };
}

// ---------------------------------------------------------------------------
// WebSocket upgrade guard
// ---------------------------------------------------------------------------

/**
 * Upgrade policy for /ws: while protection is on, the upgrade request must
 * carry a valid device token (?token= query for browser WebSocket clients,
 * which cannot set headers, or the session cookie / Bearer header for
 * everyone else). Protection off: unchanged open door (L0).
 */
export type WebSocketUpgradeGuardDeps = SecurityMiddlewareDeps & {
  isTunnelHost: (host: string | undefined) => boolean;
};

export function createWebSocketUpgradeGuard(deps: WebSocketUpgradeGuardDeps): (req: IncomingMessage) => boolean {
  return function verifyUpgrade(req: IncomingMessage): boolean {
    const viaTunnel = deps.isTunnelHost(typeof req.headers.host === "string" ? req.headers.host : undefined);
    const peer = classifySecurityPeer(req.socket.remoteAddress, viaTunnel);
    const state = deps.getTeamState();
    if (!isProtectionOn(state)) {
      recordNonLanPeerSignal(deps, state, peer, "/ws");
      return true;
    }
    let token = extractDeviceToken(req);
    if (!token) {
      const url = new URL(req.url ?? "/ws", `http://${req.headers.host ?? "localhost"}`);
      const queryToken = url.searchParams.get("token");
      if (queryToken && queryToken.trim()) {
        token = queryToken.trim();
      }
    }
    const auth = authenticateDeviceToken(state, token);
    if (!auth) {
      deps.logger.warn(`Controller: rejected WebSocket upgrade from ${peer.ip}${peer.viaTunnel ? " (via tunnel)" : ""}`);
      return false;
    }
    touchDeviceLastSeen(deps, auth.device.id);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Serialization (never leaks tokenHash / pairing code text where it is not
// already owned by the caller)
// ---------------------------------------------------------------------------

function serializeDevice(device: SecurityDevice): Record<string, unknown> {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    createdAt: device.createdAt,
    ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
    ...(device.origin !== undefined ? { origin: device.origin } : {}),
  };
}

// ---------------------------------------------------------------------------
// Route handlers (registered in route-table.ts; each receives the peer
// classification computed by the composition root)
// ---------------------------------------------------------------------------

function newDeviceId(): string {
  return `dev-${randomUUID()}`;
}

function parseDeviceKind(raw: unknown): SecurityDeviceKind {
  return DEVICE_KINDS.includes(raw as SecurityDeviceKind) ? (raw as SecurityDeviceKind) : "cli";
}

function parseDeviceName(raw: unknown, kind: SecurityDeviceKind): string {
  if (typeof raw !== "string") {
    return DEFAULT_DEVICE_NAMES[kind];
  }
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return cleaned || DEFAULT_DEVICE_NAMES[kind];
}

function mintDevice(kind: SecurityDeviceKind, name: string, origin: string): { device: SecurityDevice; token: string } {
  const token = generateToken();
  // lastSeenAt intentionally unset: it is stamped by the device's first
  // AUTHENTICATED request (touchDeviceLastSeen), so a minted-but-never-used
  // device is distinguishable in the UI from an active one.
  const device: SecurityDevice = {
    id: newDeviceId(),
    name,
    kind,
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    origin,
  };
  return { device, token };
}

// POST /api/v1/security/enable - LOOPBACK ONLY (see module header).
export async function handleSecurityEnableRequest(ctx: RouteContext): Promise<void> {
  const { res, deps, peer } = ctx;
  if (!peer || !peer.loopback) {
    sendJson(res, 403, {
      error: "forbidden",
      hint: "Device protection can only be enabled from the controller host (loopback); a remote caller must never be able to mint the first device token.",
    });
    return;
  }
  if (isProtectionOn(deps.getTeamState())) {
    sendJson(res, 409, {
      error: "Device protection is already enabled",
      hint: "Issue additional pairing codes with POST /api/v1/security/pair/start and pair new devices with POST /api/v1/security/pair.",
    });
    return;
  }
  const { device, token } = mintDevice("web", DEFAULT_DEVICE_NAMES.web, "loopback");
  const pairingCode = mintPairingCode();
  const now = Date.now();
  deps.updateTeamState((s) => {
    const security = ensureSecurityState(s);
    security.devices.push(device);
    security.enabledAt ??= now;
    security.pairingCode = pairingCode;
  });
  deps.logger.info(`Controller: device protection enabled (web device ${device.id}); one-shot pairing code issued for the first external device`);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; Path=/api/v1; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict`,
  );
  sendJson(res, 201, {
    protection: true,
    device: serializeDevice(device),
    pairingCode: { code: pairingCode.code, expiresAt: pairingCode.expiresAt, purpose: pairingCode.purpose },
  });
}

// POST /api/v1/security/pair/start - authenticated device or loopback.
export async function handleSecurityPairStartRequest(ctx: RouteContext): Promise<void> {
  const { req, res, deps, peer } = ctx;
  const state = deps.getTeamState();
  if (!isProtectionOn(state)) {
    sendJson(res, 409, {
      error: "Device protection is not enabled",
      hint: "Enable it first from the controller host: POST /api/v1/security/enable (loopback only).",
    });
    return;
  }
  const auth = authenticateDeviceToken(state, extractDeviceToken(req));
  if (!auth && !(peer?.loopback ?? false)) {
    sendUnauthorized(res);
    return;
  }
  const pairingCode = mintPairingCode(); // a new code invalidates the previous one by replacement
  deps.updateTeamState((s) => {
    ensureSecurityState(s).pairingCode = pairingCode;
  });
  deps.logger.info("Controller: issued a new one-shot pairing code (previous code invalidated)");
  sendJson(res, 201, { pairingCode: { code: pairingCode.code, expiresAt: pairingCode.expiresAt, purpose: pairingCode.purpose } });
}

// In-process online-guessing throttle for POST /security/pair.
const pairFailureTimestamps: number[] = [];

function pairFailureThrottled(): boolean {
  const now = Date.now();
  while (pairFailureTimestamps.length > 0 && now - pairFailureTimestamps[0]! >= PAIR_FAILURE_WINDOW_MS) {
    pairFailureTimestamps.shift();
  }
  return pairFailureTimestamps.length >= PAIR_FAILURE_MAX;
}

function recordPairFailure(): void {
  pairFailureTimestamps.push(Date.now());
}

// POST /api/v1/security/pair {code, kind, name} - one-shot code exchange.
export async function handleSecurityPairRequest(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const state = deps.getTeamState();
  if (!isProtectionOn(state)) {
    sendJson(res, 409, {
      error: "Device protection is not enabled",
      hint: "Pairing codes only exist while protection is on; enable it from the controller host first.",
    });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, "invalid JSON body");
    return;
  }
  const submitted = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!submitted) {
    sendJson(res, 400, "code is required");
    return;
  }
  if (pairFailureThrottled()) {
    res.setHeader("Retry-After", "60");
    sendJson(res, 429, { error: "too many failed pairing attempts", hint: "Wait and ask the controller owner for a fresh pairing code." });
    return;
  }
  const kind = parseDeviceKind(body.kind);
  const name = parseDeviceName(body.name, kind);
  const codeShapeOk = /^[A-Z2-7]{8}$/.test(submitted);

  // Check-and-consume runs as ONE synchronous state mutation so a code can
  // never be exchanged twice by racing requests (single-use is structural,
  // not just a flag read elsewhere). Result travels through an object so
  // the outcome written inside the updater stays visible afterwards.
  type PairOutcome = "ok" | "invalid" | "used" | "expired";
  const result: { outcome: PairOutcome; minted: { device: SecurityDevice; token: string } | null } = {
    outcome: "invalid",
    minted: null,
  };
  deps.updateTeamState((s) => {
    const security = s.security;
    const active = security?.pairingCode;
    if (!security || !active || !codeShapeOk || !secretsEqual(active.code, submitted)) {
      result.outcome = "invalid";
      return;
    }
    if (active.usedAt !== undefined) {
      result.outcome = "used";
      return;
    }
    if (Date.now() >= active.expiresAt) {
      delete security.pairingCode; // prune the dead secret
      result.outcome = "expired";
      return;
    }
    const created = mintDevice(kind, name, peerOriginLabel(ctx));
    active.usedAt = Date.now();
    security.devices.push(created.device);
    result.minted = created;
    result.outcome = "ok";
  });

  if (result.outcome === "ok" && result.minted) {
    deps.logger.info(`Controller: paired new ${kind} device ${result.minted.device.id} ("${name}") via pairing code`);
    sendJson(res, 201, {
      token: result.minted.token,
      deviceId: result.minted.device.id,
      device: serializeDevice(result.minted.device),
    });
    return;
  }
  recordPairFailure();
  const hints: Record<PairOutcome, [string, string]> = {
    ok: ["unreachable", ""],
    invalid: ["invalid pairing code", "Ask the controller owner for the current code (it is single-use and expires 60s after issue)."],
    used: ["pairing code already used", "Each code pairs exactly one device; ask for a fresh one."],
    expired: ["pairing code expired", "Codes live 60 seconds; ask the controller owner to issue a new one."],
  };
  const [error, hint] = hints[result.outcome];
  sendJson(res, 400, { error, hint });
}

// POST /api/v1/security/pair-auto - LAN peer + config.security.autoPair + protection on.
export async function handleSecurityPairAutoRequest(ctx: RouteContext): Promise<void> {
  const { res, deps, peer } = ctx;
  if (!isProtectionOn(deps.getTeamState())) {
    sendJson(res, 409, {
      error: "Device protection is not enabled",
      hint: "Auto-pairing only applies once protection is on; enable it from the controller host first.",
    });
    return;
  }
  if (!peer || !peer.lan) {
    sendJson(res, 403, {
      error: "forbidden",
      hint: "Zero-input auto-pairing is limited to LAN peers; use a pairing code instead (POST /api/v1/security/pair {\"code\",\"kind\",\"name\"}).",
    });
    return;
  }
  if ((deps.config.security?.autoPair ?? true) !== true) {
    sendJson(res, 403, {
      error: "auto-pairing is disabled on this controller",
      hint: "The owner disabled security.autoPair; ask for a pairing code and POST /api/v1/security/pair {\"code\",\"kind\",\"name\"}.",
    });
    return;
  }
  let body: Record<string, unknown> = {};
  try {
    body = await parseJsonBody(ctx.req);
  } catch {
    body = {}; // body optional for auto-pair
  }
  const kind = parseDeviceKind(body.kind);
  const name = parseDeviceName(body.name, kind);
  const { device, token } = mintDevice(kind, name, peerOriginLabel(ctx));
  deps.updateTeamState((s) => {
    ensureSecurityState(s).devices.push(device);
  });
  deps.logger.info(`Controller: paired new ${kind} device ${device.id} ("${name}") via LAN auto-pairing from ${peer.ip}`);
  sendJson(res, 201, { token, deviceId: device.id, device: serializeDevice(device) });
}

// GET /api/v1/security - status (authenticated by the middleware while protection is on).
export async function handleSecurityGetRequest(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const state = deps.getTeamState();
  const security = state?.security;
  const pairingCode = security?.pairingCode;
  const active = pairingCode && pairingCode.usedAt === undefined && Date.now() < pairingCode.expiresAt
    ? pairingCode
    : undefined;
  sendJson(res, 200, {
    protection: isProtectionOn(state),
    devices: (security?.devices ?? []).map(serializeDevice),
    ...(active ? { pairingCode: { expiresAt: active.expiresAt, purpose: active.purpose } } : {}),
    autoPair: deps.config.security?.autoPair ?? true,
  });
}

// DELETE /api/v1/security/devices/:id - authenticated (middleware). Revoking
// the caller's OWN device is allowed on purpose: the UI revoking itself
// simply forces that browser to re-pair.
export async function handleSecurityDeviceDeleteRequest(ctx: RouteContext): Promise<void> {
  const { req, res, deps, pathname } = ctx;
  const deviceId = decodeURIComponent(pathname.split("/").pop() ?? "");
  const state = deps.getTeamState();
  const devices = state?.security?.devices ?? [];
  if (!devices.some((device) => device.id === deviceId)) {
    sendJson(res, 404, "Device not found");
    return;
  }
  const caller = authenticateDeviceToken(state, extractDeviceToken(req));
  deps.updateTeamState((s) => {
    if (!s.security) {
      return;
    }
    s.security.devices = s.security.devices.filter((device) => device.id !== deviceId);
  });
  const revokedSelf = caller?.device.id === deviceId;
  const protection = isProtectionOn(deps.getTeamState());
  deps.logger.info(`Controller: revoked device ${deviceId}${revokedSelf ? " (self-revocation; that client must re-pair)" : ""}; protection now ${protection ? "on" : "off"}`);
  sendJson(res, 200, { ok: true, revoked: deviceId, revokedSelf, protection });
}

// POST /api/v1/security/reset - authenticated OR loopback (anti-lockout hatch).
export async function handleSecurityResetRequest(ctx: RouteContext): Promise<void> {
  const { req, res, deps, peer } = ctx;
  const state = deps.getTeamState();
  const auth = authenticateDeviceToken(state, extractDeviceToken(req));
  if (!auth && !(peer?.loopback ?? false)) {
    sendUnauthorized(res);
    return;
  }
  deps.updateTeamState((s) => {
    delete s.security; // back to L0: no devices, no codes, no signal history
  });
  deps.logger.info("Controller: device protection reset (all devices revoked) - controller is back to unpaired L0");
  sendJson(res, 200, { ok: true, protection: false });
}

function peerOriginLabel(ctx: RouteContext): string {
  const peer = ctx.peer;
  if (!peer) {
    return "unknown";
  }
  if (peer.viaTunnel) {
    return "tunnel";
  }
  return peer.ip;
}

// ---------------------------------------------------------------------------
// /api/v1/team/status assembly (issue #23: the suggestion signal surface)
// ---------------------------------------------------------------------------

export type TeamStatusSecurity = {
  protection: boolean;
  suggested: boolean;
  reason: string;
  deviceCount: number;
  lastNonLanPeer?: NonLanPeerObservation;
};

/**
 * The `security` sub-object of GET /api/v1/team/status: protection state,
 * whether enabling protection is SUGGESTED (a non-LAN peer was observed
 * while L0), a human-readable reason, and the device count. Zero route
 * changes beyond attaching this field at the assembly point.
 */
export function buildTeamStatusSecurity(state: TeamState | null): TeamStatusSecurity {
  const protection = isProtectionOn(state);
  const observation = state?.security?.lastNonLanPeer;
  const suggested = !protection && Boolean(observation);
  const reason = protection
    ? "Device pairing protection is active."
    : observation
      ? `A non-LAN peer (${observation.ip}) recently reached ${observation.path}; enable device pairing to require per-device tokens.`
      : "";
  return {
    protection,
    suggested,
    reason,
    deviceCount: state?.security?.devices.length ?? 0,
    ...(observation ? { lastNonLanPeer: observation } : {}),
  };
}
