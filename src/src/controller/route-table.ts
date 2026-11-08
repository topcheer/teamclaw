import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig, TeamState } from "../types.js";
import {
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendError,
  pinnedCorsAllowOrigin,
} from "../protocol.js";
import { saveTeamState, listArchivedTeams } from "../state.js";
import { listWorkspaceTree, listWorkspaceSubtree, readWorkspaceFile, readWorkspaceRawFile } from "../workspace-browser.js";
import {
  BUILTIN_PROFILES,
  getActiveProfile,
  getActiveRoles,
  getActiveDefaultRole,
  hasProfile,
  validateActiveRoleId,
} from "../profile-loader.js";
import { importControllerGitBundle } from "../git-collaboration.js";
// PR-D of issue #204: this module owns the declarative route table + the
// dispatcher that replaced http-server.ts's serial if/startsWith chain. It
// imports the domain route modules (PR-A/B/C cuts) and keeps the handful of
// handlers that were still inline in http-server.ts verbatim (the handler
// bodies moved here unchanged; only the surrounding shell changed from an
// `if (method && pathname)` block into a table entry). It must never be
// imported by the domain modules and never imports http-server.ts at
// RUNTIME (only the ControllerHttpDeps type, which is erased at compile
// time) so the module graph stays acyclic.
import type { ControllerHttpDeps } from "./http-server.js";
import { startTeamProfileSwitch } from "./profile-switch.js";
import { serveStaticFile, serveVersionedHtml } from "./ui-assets.js";
import {
  handleTeamAutoActivityRequest,
  handleTeamAutoReposListRequest,
  handleTeamAutoRepoCandidatesRequest,
  handleTeamAutoRepoBindRequest,
  handleTeamAutoRepoItemRequest,
} from "./teamauto-routes.js";
import {
  handleRepoStatusRequest,
  handleRepoBundleRequest,
} from "./repo-routes.js";
import { handlePreviewProxyRequest } from "./preview-proxy.js";
import { getGithubAuthManager } from "./github-auth.js";
import { gatePageHtml, computeGateCookie, GATE_COOKIE_NAME, selfHostedTokenFromEnv, type TunnelManager } from "./tunnel-manager.js";
import { generateDeliveryReport, renderReportHtml } from "./delivery-report.js";
import {
  teamClawWorkspaceIsDefault,
  updateTeamClawWorkspaceDir,
  getTeamClawModelReadiness,
  getTeamClawModelCatalog,
  updateTeamClawModelConfig,
  resolveTeamClawWorkspaceDir,
} from "../openclaw-workspace.js";
import { resolvePreferredLanAddress } from "../networking.js";
import { normalizeControllerManifest } from "./orchestration-manifest.js";
import {
  normalizeControllerIntakeSessionKey,
  recordTaskExecutionEvent,
  serializeTask,
} from "./task-execution.js";
import {
  findLatestControllerRunIdForSession,
  syncProjectRegistryEntry,
} from "./project-registry.js";
import {
  appendControllerRunEvent,
  serializeControllerRun,
  updateControllerRun,
} from "./controller-runs.js";
import {
  deleteControllerRunCascade,
  deleteProjectCascade,
  resolveSafeProjectDirectory,
} from "./task-cleanup.js";
import {
  ControllerIntakeSwitchInProgressError,
  reconcileControllerClarifications,
  runControllerIntake,
} from "./controller-intake.js";
import { buildControllerManifestEventMessage } from "./controller-planning.js";
import {
  buildStartupReadinessMessage,
  getEffectiveStartupReadiness,
  shouldBlockControllerUntilProvisioningReady,
  handleWorkerDeleteRequest,
  handleWorkerHeartbeatRequest,
  handleWorkerListRequest,
  handleWorkerRegisterRequest,
} from "./worker-routes.js";
import {
  handleTaskAssignRequest,
  handleTaskCheckpointRequest,
  handleTaskCreateRequest,
  handleTaskDeleteRequest,
  handleTaskExecutionEventRequest,
  handleTaskExecutionGetRequest,
  handleTaskGetRequest,
  handleTaskHandoffRequest,
  handleTaskListRequest,
  handleTaskParallelHelpRequest,
  handleTaskPatchRequest,
  handleTaskResultContractRequest,
  handleTaskResultRequest,
} from "./task-routes.js";
import {
  handleBroadcastMessageRequest,
  handleDirectMessageRequest,
  handleMessageListRequest,
  handleReviewRequestMessageRequest,
} from "./message-routes.js";
import {
  handleClarificationAnswerRequest,
  handleClarificationCreateRequest,
  handleClarificationListRequest,
} from "./clarification-routes.js";
// Issue #23 (backend wave): device-pairing security domain module. It owns
// the token/pairing primitives, the auth middleware (wired by
// http-server.ts), the WS upgrade guard and the handlers registered in the
// security section of the table below. It imports this file as TYPE ONLY
// (RouteContext), so the module graph stays acyclic.
import {
  buildTeamStatusSecurity,
  handleSecurityDeviceDeleteRequest,
  handleSecurityEnableRequest,
  handleSecurityGetRequest,
  handleSecurityPairAutoRequest,
  handleSecurityPairRequest,
  handleSecurityPairStartRequest,
  handleSecurityResetRequest,
} from "./security.js";
import type { SecurityPeer } from "./security.js";

// ===========================================================================
// PR-D of issue #204: declarative route table + dispatcher.
//
// Every request that survives the dispatch-layer gates in http-server.ts
// (CORS preflight -> tunnel gate -> transition matrix -> capability 404
// gates) is matched against `controllerRouteTable` BELOW IN ARRAY ORDER -
// the order is a compatibility contract and mirrors the historical
// if/startsWith chain of http-server.ts one-to-one (order-sensitive pairs:
// the exact /ui/auth/github routes precede the /ui/ prefix; the exact
// teamauto repos routes precede the per-repo prefix whose handler may
// decline with `false` and fall through; the preview proxy prefix sits
// after every /api/v1 exact route and before reports/health). The parity
// is pinned by tests/test-route-table.mjs against the pre-PR-D source.
//
// RouteDef semantics:
//   - `method`: exact HTTP method, array whitelist, or "*" (any method -
//     used by the teamauto per-repo prefix whose handler self-dispatches).
//   - `path` + `prefix`: a string path is exact pathname equality, unless
//     `prefix: true` marks it as a startsWith prefix (kept as plain strings
//     so the prefix literals stay greppable); a RegExp path is
//     `.test(pathname)` (anchored, for :id routes).
//   - `handler`: receives the RouteContext; returning `false` means "not
//     handled - continue matching" (fall-through), anything else (void,
//     true, a thrown error) ends dispatch. No match at all => the caller
//     answers the final 404.
// ===========================================================================

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  /** The parsed request URL (query params via searchParams). */
  requestUrl: URL;
  /** The URL pathname of the request. */
  pathname: string;
  deps: ControllerHttpDeps;
  /**
   * Team state captured once at handleRequest entry (the transition matrix
   * gate reads the same snapshot); null for the tunnel-side tables, whose
   * handlers never read state.
   */
  currentState: TeamState | null;
  /**
   * Issue #23: per-request peer classification (loopback/LAN/tunnel)
   * computed by the composition root alongside the device-auth gate; the
   * pairing handlers read it to enforce their origin rules (enable:
   * loopback only; pair-auto: LAN only). Absent for the tunnel-side
   * tables.
   */
  peer?: SecurityPeer;
};

export type RouteHandler = (ctx: RouteContext) => Promise<boolean | void> | boolean | void;

export type RouteDef = {
  /** HTTP method, method whitelist, or "*" for any method. */
  method: string | string[];
  /** Exact pathname (string), startsWith prefix (string + prefix: true), or predicate (RegExp). */
  path: string | RegExp;
  /** Treat a string `path` as a startsWith prefix instead of exact equality. */
  prefix?: boolean;
  handler: RouteHandler;
};

function routeMethodMatches(routeMethod: string | string[], method: string): boolean {
  if (routeMethod === "*") {
    return true;
  }
  return Array.isArray(routeMethod) ? routeMethod.includes(method) : routeMethod === method;
}

function routePathMatches(route: RouteDef, pathname: string): boolean {
  if (typeof route.path === "string") {
    return route.prefix === true ? pathname.startsWith(route.path) : pathname === route.path;
  }
  return route.path.test(pathname);
}

/**
 * Matches `ctx` against `routes` in array order. Returns true when a route
 * handled the request (handler did not return false); false when the table
 * was exhausted, in which case the caller answers the final 404.
 */
export async function dispatchRoutes(routes: readonly RouteDef[], ctx: RouteContext): Promise<boolean> {
  const method = ctx.req.method ?? "";
  for (const route of routes) {
    if (!routeMethodMatches(route.method, method)) {
      continue;
    }
    if (!routePathMatches(route, ctx.pathname)) {
      continue;
    }
    const handled = await route.handler(ctx);
    if (handled !== false) {
      return true;
    }
    // handler declined (teamauto per-repo pattern): keep matching.
  }
  return false;
}

// ===========================================================================
// Shared helpers (moved verbatim from http-server.ts; PR-D only changed
// their module home, not their behavior).
// ===========================================================================

/**
 * Retry hint shared by the transition-matrix gate (http-server.ts, task
 * submission / repo import) and the intake handler below. Lives here since
 * PR-D because the intake handler body (which carries it in 503 bodies)
 * moved into this file; http-server.ts imports it back for the gates.
 */
export const SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS = 5;

const EXTERNAL_WORKER_INSTALL_SPEC = "@teamclaws/teamclaw";

async function readFormBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function resolveRequestPort(req: IncomingMessage, fallbackPort: number): number {
  const hostHeader = req.headers.host?.trim();
  if (!hostHeader) {
    return fallbackPort;
  }
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return parsed.port ? Number(parsed.port) : fallbackPort;
  } catch {
    return fallbackPort;
  }
}

function resolveRecommendedLanControllerUrl(req: IncomingMessage, fallbackPort: number): string {
  const port = resolveRequestPort(req, fallbackPort);
  const preferredLan = resolvePreferredLanAddress();
  return preferredLan ? `http://${preferredLan}:${port}` : "";
}

function shellEscapeSingleQuotes(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildExternalWorkerInstallInfo(req: IncomingMessage, config: PluginConfig): Record<string, unknown> {
  const recommendedControllerUrl = resolveRecommendedLanControllerUrl(req, config.port);
  return {
    teamName: config.teamName,
    recommendedControllerUrl,
    defaultRole: getActiveDefaultRole(),
    roles: getActiveRoles().map((role) => ({ id: role.id, label: role.label, icon: role.icon })),
    autoDiscoveryCommandPrefix:
      `npx -y ${EXTERNAL_WORKER_INSTALL_SPEC} install --yes --install-mode worker --team-name ${shellEscapeSingleQuotes(config.teamName)} --worker-role `,
    manualCommandPrefix:
      `npx -y ${EXTERNAL_WORKER_INSTALL_SPEC} install --yes --install-mode worker --team-name ${shellEscapeSingleQuotes(config.teamName)} --worker-role `,
    manualControllerUrlFlag: recommendedControllerUrl
      ? ` --controller-url ${shellEscapeSingleQuotes(recommendedControllerUrl)}`
      : "",
    manualControllerWarning: recommendedControllerUrl
      ? "Manual worker installs must use the controller LAN IP, not localhost/127.0.0.1."
      : "No private LAN IPv4 address was detected on this controller host yet, so manual worker install commands are unavailable until a LAN address exists.",
    autoDiscoveryWarning: "mDNS auto-discovery only works when the worker and controller are reachable on the same LAN.",
  };
}

function workspaceRequestErrorStatus(err: unknown): number {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
    return 404;
  }
  return 400;
}

function workspaceRequestErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Workspace request failed";
}

function resolveRequestOrigin(req: IncomingMessage, config: PluginConfig): string {
  const host = req.headers.host;
  if (typeof host === "string" && host.trim()) {
    return `http://${host.trim()}`;
  }
  return `http://127.0.0.1:${config.port}`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendGithubCallbackHtml(res: ServerResponse, statusCode: number, title: string, message: string): void {
  const html = [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtmlText(title)}</title>`,
    "<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0f1117;color:#e6e8ee}main{max-width:520px;padding:32px 40px;border:1px solid #2a2f3a;border-radius:14px;background:#161923;text-align:center}h1{font-size:20px;margin:0 0 10px}p{margin:6px 0;color:#a8b0c0;line-height:1.6}</style>",
    "</head><body><main>",
    `<h1>${escapeHtmlText(title)}</h1>`,
    `<p>${escapeHtmlText(message)}</p>`,
    "</main></body></html>",
  ].join("");
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

type TeamStatsResponse = {
  totalWorkers: number;
  workersByStatus: { idle: number; busy: number; offline: number };
  totalTasks: number;
  tasksByStatus: Record<string, number>;
  averageTaskDuration: number | null;
  uptime: number;
};

// PR-D note: computeTeamStats used to be declared INSIDE handleRequest
// (between task-route shells); it is hoisted to module scope here, body
// unchanged, single call site unchanged.
function computeTeamStats(state: TeamState): TeamStatsResponse {
  const workers = Object.values(state.workers);
  const tasks = Object.values(state.tasks);

  const workersByStatus = { idle: 0, busy: 0, offline: 0 };
  for (const worker of workers) {
    workersByStatus[worker.status] += 1;
  }

  const tasksByStatus: Record<string, number> = {};
  for (const task of tasks) {
    tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
  }

  const completedTasks = tasks.filter(
    (task) => task.status === "completed" && task.startedAt && task.completedAt,
  );
  const averageTaskDuration = completedTasks.length > 0
    ? completedTasks.reduce((sum, task) => sum + (task.completedAt! - task.startedAt!), 0) / completedTasks.length
    : null;

  return {
    totalWorkers: workers.length,
    workersByStatus,
    totalTasks: tasks.length,
    tasksByStatus,
    averageTaskDuration,
    uptime: process.uptime() * 1000,
  };
}

// ===========================================================================
// Route handlers. The PR-A/B/C domain handlers are forwarded to unchanged;
// the bodies that were inline in http-server.ts moved here verbatim (the
// only edit is reading req/res/requestUrl/pathname/deps/currentState from
// the RouteContext instead of the old function arguments).
// ===========================================================================

// ---- Web UI (http-server.ts pre-PR-D lines 588-625) ----

function webUiRootRoute(ctx: RouteContext): void {
  const { res } = ctx;
  res.statusCode = 302;
  res.setHeader("Location", "/ui");
  res.end();
}

function webUiIndexRoute(ctx: RouteContext): void {
  const { res } = ctx;
  const uiPath = path.join(import.meta.dirname, "..", "ui");
  serveVersionedHtml(res, path.join(uiPath, "index.html"));
}

// Standalone GitHub device-login page (big user code + prefilled link + polling).
function webUiGithubLoginPageRoute(ctx: RouteContext): void {
  const { res } = ctx;
  const uiPath = path.join(import.meta.dirname, "..", "ui");
  serveStaticFile(res, path.join(uiPath, "github-login.html"), "text/html; charset=utf-8");
}

function webUiAssetsRoute(ctx: RouteContext): void {
  const { res, pathname } = ctx;
  const uiPath = path.join(import.meta.dirname, "..", "ui");
  const file = pathname.slice(4); // remove "/ui/"
  if (file.endsWith(".css")) {
    serveStaticFile(res, path.join(uiPath, file), "text/css; charset=utf-8");
  } else if (file.endsWith(".js")) {
    serveStaticFile(res, path.join(uiPath, file), "application/javascript; charset=utf-8");
  } else if (file.endsWith(".png")) {
    serveStaticFile(res, path.join(uiPath, file), "image/png");
  } else if (file.endsWith(".svg")) {
    serveStaticFile(res, path.join(uiPath, file), "image/svg+xml; charset=utf-8");
  } else if (file.endsWith(".ico")) {
    serveStaticFile(res, path.join(uiPath, file), "image/x-icon");
  } else {
    serveStaticFile(res, path.join(uiPath, file), "application/octet-stream");
  }
}

// ---- TeamAuto (pre-PR-D lines 631-654; handlers in ./teamauto-routes.ts) ----

async function teamAutoActivityRoute(ctx: RouteContext): Promise<void> {
  await handleTeamAutoActivityRequest(ctx.deps, ctx.res);
}

async function teamAutoReposListRoute(ctx: RouteContext): Promise<void> {
  await handleTeamAutoReposListRequest(ctx.deps, ctx.res);
}

// Selectable repos for the bind picker (the logged-in GitHub account's).
async function teamAutoRepoCandidatesRoute(ctx: RouteContext): Promise<void> {
  await handleTeamAutoRepoCandidatesRequest(ctx.deps, ctx.res);
}

async function teamAutoRepoBindRoute(ctx: RouteContext): Promise<void> {
  await handleTeamAutoRepoBindRequest(ctx.deps, ctx.req, ctx.res);
}

// Any-method prefix route: the handler self-dispatches by method and
// DECLINES (returns false) for methods it does not own, falling through to
// the rest of the table - preserved by returning its boolean upstream.
function teamAutoRepoItemRoute(ctx: RouteContext): Promise<boolean> {
  return handleTeamAutoRepoItemRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

// ---- GitHub Auth (pre-PR-D lines 658-753) ----

async function githubAuthStatusRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { config, logger } = deps;
  try {
    const status = await getGithubAuthManager(config, logger).getStatus(resolveRequestOrigin(req, config));
    sendJson(res, 200, status);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to read GitHub login status");
  }
}

async function githubAuthLoginRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { config, logger } = deps;
  let flow: string | undefined;
  try {
    const body = await parseJsonBody(req) as { flow?: unknown };
    if (typeof body?.flow === "string") {
      flow = body.flow.trim();
    }
  } catch {
    // No body or invalid body: fall through to the default (device) flow.
  }
  const manager = getGithubAuthManager(config, logger);
  try {
    const loginPageUrl = resolveRequestOrigin(req, config).replace(/\/+$/, "") + "/ui/auth/github";
    if (flow === "web") {
      // Web flow needs a client secret for the code exchange; the device
      // flow (default) is fully secretless.
      const start = manager.beginLogin(resolveRequestOrigin(req, config));
      sendJson(res, 200, { mode: "web", loginPageUrl, ...start });
    } else {
      const start = await manager.beginDeviceLogin();
      // authorizeUrl intentionally points at our standalone login page so
      // older UI clients that just open response.authorizeUrl land on the
      // device-code page instead of a dead web-flow URL.
      sendJson(res, 200, { mode: "device", loginPageUrl, authorizeUrl: loginPageUrl, ...start });
    }
    logger.info(`Controller: GitHub login flow started (${flow === "web" ? "web" : "device"})`);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to start GitHub login");
  }
}

async function githubAuthCallbackRoute(ctx: RouteContext): Promise<void> {
  const { req, res, requestUrl, deps } = ctx;
  const { config, logger } = deps;
  const callbackError = requestUrl.searchParams.get("error");
  if (callbackError) {
    const description = requestUrl.searchParams.get("error_description") ?? "";
    logger.warn(`Controller: GitHub login was denied (${callbackError})`);
    sendGithubCallbackHtml(
      res,
      400,
      "GitHub login failed",
      `Authorization was denied: ${callbackError}${description ? ` (${description})` : ""}`,
    );
    return;
  }
  const code = requestUrl.searchParams.get("code") ?? "";
  const state = requestUrl.searchParams.get("state") ?? "";
  try {
    const account = await getGithubAuthManager(config, logger).completeLogin({
      code: code || undefined,
      state: state || undefined,
    });
    logger.info(`Controller: GitHub login completed for @${account.login}`);
    sendGithubCallbackHtml(
      res,
      200,
      "GitHub login successful",
      `Signed in as @${account.login}（GitHub 登录成功，可关闭本页返回 TeamClaw）。`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Controller: GitHub login callback failed: ${message}`);
    sendGithubCallbackHtml(res, 400, "GitHub login failed", `${message}`);
  }
}

async function githubAuthLogoutRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const { config, logger } = deps;
  try {
    await getGithubAuthManager(config, logger).logout();
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to sign out of GitHub");
  }
}

async function githubAuthRefreshRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const { config, logger } = deps;
  try {
    const store = await getGithubAuthManager(config, logger).forceRefresh();
    sendJson(res, 200, { ok: true, account: store.account, expiresAt: store.expiresAt });
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to refresh the GitHub token");
  }
}

// ---- Workspace Browser + model config (pre-PR-D lines 757-931) ----

function workspaceStatusRoute(ctx: RouteContext): void {
  const { res } = ctx;
  sendJson(res, 200, {
    workspaceDir: resolveTeamClawWorkspaceDir(),
    isDefault: teamClawWorkspaceIsDefault(),
  });
}

async function workspaceChangeDirRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendError(res, 400, "invalid JSON body");
    return;
  }
  const workspaceDir = typeof (body as { workspaceDir?: unknown })?.workspaceDir === "string"
    ? (body as { workspaceDir: string }).workspaceDir
    : "";
  if (!workspaceDir.trim()) {
    sendError(res, 400, "workspaceDir is required");
    return;
  }
  try {
    const result = await updateTeamClawWorkspaceDir(workspaceDir, {
      warn: (message: string) => deps.logger.info(message),
    });
    sendJson(res, 200, {
      ok: true,
      workspaceDir: result.agentEntryPath,
      configPath: result.configPath,
      restartRequired: true,
    });
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to update workspace directory");
  }
}

// GET /api/v1/models/config - model catalog + current selection for the UI settings dialog
async function modelsConfigGetRoute(ctx: RouteContext): Promise<void> {
  const { res } = ctx;
  try {
    sendJson(res, 200, await getTeamClawModelCatalog());
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to read model configuration");
  }
}

// PUT /api/v1/models/config - persist default and per-role model selection
async function modelsConfigPutRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  let body: { defaultModel?: unknown; roleModelOverrides?: unknown } | null = null;
  try {
    body = await parseJsonBody(req) as { defaultModel?: unknown; roleModelOverrides?: unknown };
  } catch {
    sendError(res, 400, "invalid JSON body");
    return;
  }
  const update: { defaultModel?: string; roleModelOverrides?: Record<string, string> } = {};
  if (typeof body?.defaultModel === "string") {
    update.defaultModel = body.defaultModel.trim();
  }
  if (body?.roleModelOverrides && typeof body.roleModelOverrides === "object" && !Array.isArray(body.roleModelOverrides)) {
    const overrides: Record<string, string> = {};
    for (const [role, value] of Object.entries(body.roleModelOverrides as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        overrides[role] = value.trim();
      }
    }
    update.roleModelOverrides = overrides;
  }
  if (update.defaultModel === undefined && update.roleModelOverrides === undefined) {
    sendError(res, 400, "defaultModel or roleModelOverrides is required");
    return;
  }
  try {
    await updateTeamClawModelConfig(update, {
      warn: (message: string) => deps.logger.info(message),
    });
    sendJson(res, 200, {
      ok: true,
      restartNote: "Config changes hot-reload; restart the gateway (openclaw gateway restart) if a change does not take effect.",
      catalog: await getTeamClawModelCatalog(),
    });
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to update model configuration");
  }
}

async function workspaceTreeRoute(ctx: RouteContext): Promise<void> {
  const { res, requestUrl } = ctx;
  try {
    // depth=N limits tree expansion (default 1 for lazy loading)
    const depthParam = requestUrl.searchParams.get("depth");
    const maxDepth = depthParam !== null ? Math.max(0, Math.min(parseInt(depthParam, 10) || 1, 8)) : 1;
    sendJson(res, 200, await listWorkspaceTree(maxDepth));
  } catch (err) {
    sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
  }
}

async function workspaceSubtreeRoute(ctx: RouteContext): Promise<void> {
  const { res, requestUrl } = ctx;
  const dirPath = requestUrl.searchParams.get("path") ?? "";
  if (!dirPath) {
    sendError(res, 400, "path is required");
    return;
  }
  try {
    sendJson(res, 200, { entries: await listWorkspaceSubtree(dirPath) });
  } catch (err) {
    sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
  }
}

async function workspaceFileRoute(ctx: RouteContext): Promise<void> {
  const { res, requestUrl } = ctx;
  const relativePath = requestUrl.searchParams.get("path") ?? "";
  if (!relativePath) {
    sendError(res, 400, "path is required");
    return;
  }

  try {
    sendJson(res, 200, { file: await readWorkspaceFile(relativePath) });
  } catch (err) {
    sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
  }
}

async function workspaceProjectPathRoute(ctx: RouteContext): Promise<void> {
  const { res, requestUrl } = ctx;
  const projectDir = requestUrl.searchParams.get("projectDir") ?? "";
  if (!projectDir) {
    sendError(res, 400, "projectDir is required");
    return;
  }
  const absolutePath = resolveSafeProjectDirectory(projectDir);
  if (!absolutePath) {
    sendError(res, 400, "Invalid projectDir");
    return;
  }
  if (!fs.existsSync(absolutePath)) {
    sendError(res, 404, "Project directory not found");
    return;
  }
  sendJson(res, 200, {
    projectDir,
    absolutePath,
  });
}

async function workspaceRawFileRoute(ctx: RouteContext): Promise<void> {
  const { res, pathname } = ctx;
  const rawPathname = pathname.slice("/api/v1/workspace/raw/".length);
  if (!rawPathname) {
    sendError(res, 400, "path is required");
    return;
  }

  try {
    const relativePath = decodeURIComponent(rawPathname);
    const file = await readWorkspaceRawFile(relativePath);
    res.writeHead(200, {
      "Content-Type": file.contentType,
      "Cache-Control": "no-store",
      // Issue #23 security review follow-up: honor a CORS origin the
      // security gate pinned (device protection on) instead of hardcoding
      // the wildcard, which silently widened it; unpinned keeps the
      // historical "*" byte for byte (shared helper, see protocol.ts).
      "Access-Control-Allow-Origin": pinnedCorsAllowOrigin(res),
      "X-Content-Type-Options": "nosniff",
    });
    res.end(file.content);
  } catch (err) {
    sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
  }
}

// ---- Worker Management (pre-PR-D lines 939-960; handlers in ./worker-routes.ts) ----

async function workerRegisterRoute(ctx: RouteContext): Promise<void> {
  await handleWorkerRegisterRequest(ctx.deps, ctx.req, ctx.res);
}

async function workerDeleteRoute(ctx: RouteContext): Promise<void> {
  await handleWorkerDeleteRequest(ctx.deps, ctx.res, ctx.pathname);
}

async function workerListRoute(ctx: RouteContext): Promise<void> {
  await handleWorkerListRequest(ctx.deps, ctx.res);
}

async function workerHeartbeatRoute(ctx: RouteContext): Promise<void> {
  await handleWorkerHeartbeatRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

// ---- Task Management (pre-PR-D lines 968-1100; handlers in ./task-routes.ts) ----

async function taskCreateRoute(ctx: RouteContext): Promise<void> {
  await handleTaskCreateRequest(ctx.deps, ctx.req, ctx.res);
}

async function taskListRoute(ctx: RouteContext): Promise<void> {
  await handleTaskListRequest(ctx.deps, ctx.res);
}

async function teamStatsRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const state = deps.getTeamState();
  if (!state) {
    sendError(res, 503, "Team state not available");
    return;
  }
  try {
    const stats = computeTeamStats(state);
    sendJson(res, 200, stats);
  } catch (err) {
    sendError(res, 500, `Failed to compute stats: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function taskGetRoute(ctx: RouteContext): Promise<void> {
  await handleTaskGetRequest(ctx.deps, ctx.res, ctx.pathname);
}

async function taskDeleteRoute(ctx: RouteContext): Promise<void> {
  await handleTaskDeleteRequest(ctx.deps, ctx.res, ctx.pathname);
}

async function taskExecutionGetRoute(ctx: RouteContext): Promise<void> {
  await handleTaskExecutionGetRequest(ctx.deps, ctx.res, ctx.pathname);
}

async function taskPatchRoute(ctx: RouteContext): Promise<void> {
  await handleTaskPatchRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

async function taskAssignRoute(ctx: RouteContext): Promise<void> {
  await handleTaskAssignRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

async function taskHandoffRoute(ctx: RouteContext): Promise<void> {
  await handleTaskHandoffRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

// POST /api/v1/tasks/:id/checkpoint - worker persists an execution progress
// snapshot so an interrupted task can resume instead of restarting.
async function taskCheckpointRoute(ctx: RouteContext): Promise<void> {
  await handleTaskCheckpointRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

async function taskResultContractRoute(ctx: RouteContext): Promise<void> {
  await handleTaskResultContractRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

async function taskResultRoute(ctx: RouteContext): Promise<void> {
  await handleTaskResultRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

async function taskExecutionEventRoute(ctx: RouteContext): Promise<void> {
  await handleTaskExecutionEventRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

async function taskParallelHelpRoute(ctx: RouteContext): Promise<void> {
  await handleTaskParallelHelpRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

// ---- Controller runs / intake (pre-PR-D lines 1109-1289) ----

async function controllerManifestRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { logger, getTeamState, updateTeamState, wsServer } = deps;
  const body = await parseJsonBody(req);
  const sessionKey = normalizeControllerIntakeSessionKey(body.sessionKey);
  const manifest = normalizeControllerManifest(body.manifest);
  if (!manifest) {
    sendError(res, 400, "manifest is required and must include requirementSummary");
    return;
  }

  const runId = findLatestControllerRunIdForSession(sessionKey, deps.getTeamState(), {
    preferActive: true,
  });
  if (!runId) {
    sendError(res, 404, "Controller run not found for session");
    return;
  }

  const updatedRun = updateControllerRun(runId, deps, (run) => {
    run.manifest = manifest;
    const state = deps.getTeamState();
    if (state) {
      const project = syncProjectRegistryEntry(state, {
        projectId: manifest.projectName ?? run.projectId,
        projectDir: run.projectDir ?? manifest.projectName,
        aliases: [manifest.projectName, run.projectId],
        summary: manifest.requirementSummary,
        updatedAt: Date.now(),
      });
      run.projectId = project.projectId;
      run.projectDir = project.projectDir;
    }

    if (run.projectDir) {
      const state = deps.getTeamState();
      if (state) {
        for (const taskId of run.createdTaskIds) {
          const task = state.tasks[taskId];
          if (task) {
            if (!task.projectDir) {
              task.projectDir = run.projectDir;
            }
            if (!task.projectId) {
              task.projectId = run.projectId;
            }
          }
        }
      }
    }

    appendControllerRunEvent(run, {
      type: "output",
      phase: "manifest_recorded",
      source: "controller",
      status: "running",
      sessionKey,
      message: buildControllerManifestEventMessage(manifest),
    });
  });

  if (!updatedRun) {
    sendError(res, 404, "Controller run not found");
    return;
  }

  if (manifest.requirementFullyComplete) {
    logger.info(`Controller: requirement fully complete for session ${sessionKey} (run ${runId})`);
    wsServer.broadcastUpdate({
      type: "requirement:complete",
      data: {
        runId,
        sessionKey,
        requirementSummary: manifest.requirementSummary,
      },
    });
  }

  sendJson(res, 201, {
    controllerRun: serializeControllerRun(updatedRun),
    manifest,
  });
}

async function controllerRunsListRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const state = reconcileControllerClarifications(deps);
  const controllerRuns = state
    ? Object.values(state.controllerRuns)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((run) => serializeControllerRun(run))
    : [];
  sendJson(res, 200, { controllerRuns });
}

async function projectDeleteRoute(ctx: RouteContext): Promise<void> {
  const { res, pathname, deps } = ctx;
  const projectDir = decodeURIComponent(pathname.split("/").pop()!);
  const result = await deleteProjectCascade(projectDir, deps);
  if (!result.deleted) {
    sendError(res, 404, "Project not found or project cleanup could not be confirmed");
    return;
  }
  const safeProjectPath = resolveSafeProjectDirectory(projectDir);
  const stillExists = safeProjectPath ? fs.existsSync(safeProjectPath) : true;
  if (stillExists) {
    sendError(res, 409, "Project cleanup could not be confirmed");
    return;
  }
  sendJson(res, 200, {
    status: "deleted",
    confirmed: true,
    projectDir,
    cleanup: result.summary,
  });
}

async function controllerRunDeleteRoute(ctx: RouteContext): Promise<void> {
  const { res, pathname, deps } = ctx;
  const { getTeamState } = deps;
  const runId = pathname.split("/").pop()!;
  const result = await deleteControllerRunCascade(runId, deps);
  if (!result.deleted) {
    sendError(res, 404, "Controller run not found");
    return;
  }
  const stillExists = !!getTeamState()?.controllerRuns[runId];
  if (stillExists) {
    sendError(res, 409, "Planning run cleanup could not be confirmed");
    return;
  }
  sendJson(res, 200, {
    status: "deleted",
    confirmed: true,
    runId,
    cleanup: result.summary,
  });
}

async function controllerIntakeRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps, currentState } = ctx;
  const { logger } = deps;
  const readinessGate = shouldBlockControllerUntilProvisioningReady(deps, currentState);
  if (readinessGate.blocked && readinessGate.readiness) {
    sendError(res, 503, buildStartupReadinessMessage(readinessGate.readiness));
    return;
  }
  const body = await parseJsonBody(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    sendError(res, 400, "message is required");
    return;
  }

  const sessionKey = normalizeControllerIntakeSessionKey(body.sessionKey);

  try {
    const result = await runControllerIntake(message, sessionKey, deps);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ControllerIntakeSwitchInProgressError) {
      // Same response shape as the URL-level transition gate (503 +
      // Retry-After); reachable here when a switch starts between the gate
      // and the intake entry (the gate reads the state once per request).
      res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: err.message,
        retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
        transition: {
          phase: err.transition.phase,
          targetProfileId: err.transition.targetProfileId,
        },
      });
      return;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`Controller: intake failed for ${sessionKey}: ${errorMessage}`);
    sendError(res, errorMessage.includes("timed out") ? 504 : 500, errorMessage);
  }
}

// ---- Message Routing (pre-PR-D lines 1292-1313; handlers in ./message-routes.ts) ----

async function messageDirectRoute(ctx: RouteContext): Promise<void> {
  await handleDirectMessageRequest(ctx.deps, ctx.req, ctx.res);
}

async function messageBroadcastRoute(ctx: RouteContext): Promise<void> {
  await handleBroadcastMessageRequest(ctx.deps, ctx.req, ctx.res);
}

async function messageReviewRequestRoute(ctx: RouteContext): Promise<void> {
  await handleReviewRequestMessageRequest(ctx.deps, ctx.req, ctx.res);
}

async function messageListRoute(ctx: RouteContext): Promise<void> {
  await handleMessageListRequest(ctx.deps, ctx.res, ctx.requestUrl);
}

// ---- Clarification Requests (pre-PR-D lines 1318-1333; handlers in ./clarification-routes.ts) ----

async function clarificationCreateRoute(ctx: RouteContext): Promise<void> {
  await handleClarificationCreateRequest(ctx.deps, ctx.req, ctx.res);
}

async function clarificationListRoute(ctx: RouteContext): Promise<void> {
  await handleClarificationListRequest(ctx.deps, ctx.res);
}

async function clarificationAnswerRoute(ctx: RouteContext): Promise<void> {
  await handleClarificationAnswerRequest(ctx.deps, ctx.req, ctx.res, ctx.pathname);
}

// ---- Git Collaboration (pre-PR-D lines 1342-1412) ----
// PR-B of issue #204: the repo status/bundle handlers and the shared
// refreshControllerRepoState glue live in ./repo-routes.ts; the POST
// /repo/import handler body moved here with PR-D (its
// recordTaskExecutionEvent dependency is task-lifecycle glue owned by the
// PR-C cut).

async function repoStatusRoute(ctx: RouteContext): Promise<void> {
  await handleRepoStatusRequest(ctx.deps, ctx.res);
}

async function repoBundleRoute(ctx: RouteContext): Promise<void> {
  await handleRepoBundleRequest(ctx.deps, ctx.res);
}

async function repoImportRoute(ctx: RouteContext): Promise<void> {
  const { req, res, requestUrl, deps } = ctx;
  const { config, logger, updateTeamState } = deps;
  const body = await readRequestBody(req);
  if (!body.length) {
    sendError(res, 400, "bundle body is required");
    return;
  }

  const taskId = typeof requestUrl.searchParams.get("taskId") === "string" && requestUrl.searchParams.get("taskId")
    ? requestUrl.searchParams.get("taskId")!
    : undefined;
  const workerId = typeof requestUrl.searchParams.get("workerId") === "string" && requestUrl.searchParams.get("workerId")
    ? requestUrl.searchParams.get("workerId")!
    : undefined;
  const role = validateActiveRoleId(requestUrl.searchParams.get("role"));

  try {
    const imported = await importControllerGitBundle(config, logger, body, { taskId, workerId });
    updateTeamState((s) => {
      s.repo = imported.repo;
    });

    if (taskId) {
      recordTaskExecutionEvent(taskId, {
        type: imported.merged || imported.alreadyUpToDate ? "lifecycle" : "error",
        phase: imported.merged
          ? "repo_imported"
          : imported.alreadyUpToDate
            ? "repo_import_skipped"
            : "repo_import_failed",
        source: "controller",
        message: imported.message,
        workerId,
        role,
      }, deps);
    }

    sendJson(res, imported.merged || imported.alreadyUpToDate ? 200 : 409, {
      repo: imported.repo,
      merged: imported.merged,
      fastForwarded: imported.fastForwarded,
      alreadyUpToDate: imported.alreadyUpToDate,
      message: imported.message,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (taskId) {
      recordTaskExecutionEvent(taskId, {
        type: "error",
        phase: "repo_import_failed",
        source: "controller",
        message,
        workerId,
        role,
      }, deps);
    }
    sendError(res, 500, message);
  }
}

// ---- Team Info / profiles (pre-PR-D lines 1417-1576) ----

async function teamStatusRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { config } = deps;
  const state = reconcileControllerClarifications(deps);
  const startupReadiness = getEffectiveStartupReadiness(deps, state);
  const modelReadiness = getTeamClawModelReadiness();
  const externalWorkerInstall = buildExternalWorkerInstallInfo(req, config);
  if (!state) {
    sendJson(res, 200, {
      teamName: config.teamName,
      workers: [],
      tasks: [],
      controllerRuns: [],
      messages: [],
      clarifications: [],
      previews: [],
      repo: null,
      pendingClarificationCount: 0,
      modelReadiness,
      externalWorkerInstall,
      provisioning: startupReadiness ? { startupReadiness } : undefined,
      security: buildTeamStatusSecurity(null),
    });
    return;
  }

  const clarifications = Object.values(state.clarifications).sort((left, right) => right.createdAt - left.createdAt);
  sendJson(res, 200, {
    teamName: state.teamName,
    workers: Object.values(state.workers),
    tasks: Object.values(state.tasks).map((task) => serializeTask(task)),
    controllerRuns: Object.values(state.controllerRuns)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((run) => serializeControllerRun(run)),
    messages: state.messages,
    clarifications,
    previews: Object.values(state.previews ?? {}),
    repo: state.repo ?? null,
    modelReadiness,
    externalWorkerInstall,
    provisioning: {
      ...(state.provisioning ?? { workers: {} }),
      startupReadiness,
    },
    taskCount: Object.keys(state.tasks).length,
    workerCount: Object.keys(state.workers).length,
    pendingClarificationCount: clarifications.filter((item) => item.status === "pending").length,
    // Issue #23: device-pairing protection state + the non-LAN-peer
    // suggestion signal (additive field; consumers ignore it pre-issue).
    security: buildTeamStatusSecurity(state),
  });
}

function teamRolesRoute(ctx: RouteContext): void {
  const { res } = ctx;
  sendJson(res, 200, { roles: getActiveRoles(), defaultRole: getActiveDefaultRole() });
}

// GET /api/v1/profiles — list the available team profile packages
// (Phase 2.1, design section 4: the switcher UI reads this list).
function teamProfilesListRoute(ctx: RouteContext): void {
  const { res } = ctx;
  const profiles = [...BUILTIN_PROFILES.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      nameZh: profile.nameZh,
      icon: profile.icon,
      industry: profile.industry,
      description: profile.description,
      roleCount: profile.roles.length,
      version: profile.version,
      // Capability switches ride along so the switcher confirm step can
      // warn that off -> on flips need a gateway restart to take effect
      // (subsystems are wired at controller startup only; runtime teardown
      // is one-directional). Additive field - existing consumers ignore it.
      capabilities: profile.capabilities,
      ...(profile.reviewedBy ? { reviewedBy: profile.reviewedBy } : {}),
    }));
  sendJson(res, 200, { profiles });
}

// GET /api/v1/team/profile — active profile detail incl. capabilities
// (design section 4: UI hides capability-gated entries based on this).
function teamProfileGetRoute(ctx: RouteContext): void {
  const { res, deps } = ctx;
  const { config } = deps;
  const state = deps.getTeamState();
  const profile = getActiveProfile();
  sendJson(res, 200, {
    profileId: state?.profileId ?? profile.id,
    profile,
    teamName: state?.teamName ?? config.teamName,
    transition: state?.transition ?? null,
  });
}

// POST /api/v1/team/profile { profileId } — six-step switch semantics
// (Phase 2.1, design section 2.3). Returns 202; progress arrives via the
// team.switch_started / team.switch_completed WS events.
async function teamProfileSwitchRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { config, logger, getTeamState, updateTeamState, wsServer } = deps;
  const body = await parseJsonBody(req);
  const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
  if (!profileId || !hasProfile(profileId)) {
    sendError(
      res,
      404,
      `unknown team profile "${profileId || "<empty>"}" (available: ${[...BUILTIN_PROFILES.keys()].sort().join(", ")})`,
    );
    return;
  }
  const state = getTeamState();
  if (!state) {
    sendError(res, 503, "Team state not loaded");
    return;
  }
  if (state.transition) {
    sendJson(res, 409, {
      error: `a team profile switch to "${state.transition.targetProfileId}" is already in progress (phase: ${state.transition.phase})`,
      transition: state.transition,
    });
    return;
  }

  // Step 1: persist the transition (the crash-resume truth) and announce.
  // The check-and-set above plus this mutation run without an await in
  // between, so a concurrent second POST observes the transition (409).
  const previousProfileId = state.profileId;
  updateTeamState((s) => {
    s.transition = { phase: "draining", targetProfileId: profileId, startedAt: Date.now() };
  });
  try {
    await saveTeamState(state);
  } catch (err) {
    // Durability failed: roll the in-memory transition back so the team is
    // never wedged behind a transition the crash-resume path cannot see.
    // Nothing has been broadcast yet, so no external observer was told a
    // switch had started.
    updateTeamState((s) => {
      delete s.transition;
    });
    sendError(res, 500, `failed to persist the team profile switch transition: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  wsServer.broadcastUpdate({ type: "team.switch_started", data: { profileId, previousProfileId } });
  logger.info(`Controller: team profile switch started - "${previousProfileId}" -> "${profileId}"`);

  // Steps 2-6 plus the failure broadcast path live in ./profile-switch.ts
  // (startTeamProfileSwitch: fire-and-forget executeTeamProfileSwitch with
  // the archive-preservation-aware team.switch_failed unwedging).
  startTeamProfileSwitch(deps, state, profileId, previousProfileId);

  sendJson(res, 202, { status: "switching", profileId, transition: state.transition });
}

// GET /api/v1/archived-teams — archived team metadata list
// (Phase 2.1, design section 4: profileId/teamName/time/taskCount; detail
// queries and the archive UI stay v1.1).
async function archivedTeamsRoute(ctx: RouteContext): Promise<void> {
  const { res } = ctx;
  const archives = await listArchivedTeams();
  sendJson(res, 200, { archives });
}

// ---- Previews / reports / health (pre-PR-D lines 1580-1633) ----

// /api/v1/previews/:id/* — proxy to preview subprocess.
// PR-B of issue #204: the proxy implementation lives in ./preview-proxy.ts.
// Deliberately NOT awaited (fire-and-forget proxy), exactly as before.
function previewsProxyRoute(ctx: RouteContext): void {
  handlePreviewProxyRequest(ctx.deps, ctx.req, ctx.res, ctx.requestUrl, ctx.pathname);
}

// GET /api/v1/reports — list all delivery reports
function reportsListRoute(ctx: RouteContext): void {
  const { res, deps } = ctx;
  const state = deps.getTeamState();
  const reports = Object.values(state?.reports ?? {}).sort((a, b) => b.generatedAt - a.generatedAt);
  sendJson(res, 200, { reports });
}

// GET /api/v1/reports/:sessionKey — serve delivery report page
async function reportsSessionRoute(ctx: RouteContext): Promise<void> {
  const { req, res, pathname, deps } = ctx;
  const sessionKey = decodeURIComponent(pathname.slice("/api/v1/reports/".length));
  const state = deps.getTeamState();
  if (!state) {
    sendError(res, 503, "Team state not loaded");
    return;
  }
  const report = generateDeliveryReport(sessionKey, state, normalizeControllerIntakeSessionKey);
  if (!report) {
    sendError(res, 404, "No report found for this session");
    return;
  }
  const accept = (req.headers["accept"] ?? "").toLowerCase();
  if (accept.includes("application/json")) {
    sendJson(res, 200, { report });
  } else {
    const html = renderReportHtml(report);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html, "utf-8") });
    res.end(html);
  }
}

function healthRoute(ctx: RouteContext): void {
  const { res, deps, currentState } = ctx;
  const readiness = getEffectiveStartupReadiness(deps, currentState);
  const modelReadiness = getTeamClawModelReadiness();
  const statusCode = readiness && readiness.status !== "ready" ? 503 : 200;
  sendJson(res, statusCode, {
    status: readiness?.status === "degraded" ? "degraded" : readiness?.status === "checking" ? "starting" : "ok",
    mode: "controller",
    timestamp: Date.now(),
    provisioningReadiness: readiness,
    modelReadiness,
  });
}

// ===========================================================================
// The controller route table. ORDER IS LOAD-BEARING: it mirrors the pre-PR-D
// if/startsWith chain of http-server.ts one-to-one (the "old lines" in the
// section comments refer to http-server.ts at e223767, the merge base of
// this branch). tests/test-route-table.mjs asserts this order against both
// a hardcoded expectation and that git snapshot.
// ===========================================================================

export const controllerRouteTable: readonly RouteDef[] = [
  // ==================== Web UI (old lines 588-625) ====================
  { method: "GET", path: "/", handler: webUiRootRoute },
  { method: "GET", path: "/ui", handler: webUiIndexRoute },
  { method: "GET", path: "/ui/", handler: webUiIndexRoute },
  // Standalone GitHub device-login page (big user code + prefilled link + polling).
  { method: "GET", path: "/ui/auth/github", handler: webUiGithubLoginPageRoute },
  { method: "GET", path: "/ui/auth/github/", handler: webUiGithubLoginPageRoute },
  { method: "GET", path: "/ui/", prefix: true, handler: webUiAssetsRoute },

  // ==================== TeamAuto (old lines 631-654) ====================
  { method: "GET", path: "/api/v1/teamauto/activity", handler: teamAutoActivityRoute },
  { method: "GET", path: "/api/v1/teamauto/repos", handler: teamAutoReposListRoute },
  // Selectable repos for the bind picker (the logged-in GitHub account's).
  { method: "GET", path: "/api/v1/teamauto/repo-candidates", handler: teamAutoRepoCandidatesRoute },
  { method: "POST", path: "/api/v1/teamauto/repos", handler: teamAutoRepoBindRoute },
  // Per-repo prefix, any method: exact entries above win first; the handler
  // declines (false) for unknown methods and dispatch falls through.
  { method: "*", path: "/api/v1/teamauto/repos/", prefix: true, handler: teamAutoRepoItemRoute },

  // ==================== GitHub Auth (old lines 658-753) ====================
  { method: "GET", path: "/api/v1/auth/github/status", handler: githubAuthStatusRoute },
  { method: "POST", path: "/api/v1/auth/github/login", handler: githubAuthLoginRoute },
  { method: "GET", path: "/api/v1/auth/github/callback", handler: githubAuthCallbackRoute },
  { method: "POST", path: "/api/v1/auth/github/logout", handler: githubAuthLogoutRoute },
  { method: "POST", path: "/api/v1/auth/github/refresh", handler: githubAuthRefreshRoute },

  // ==================== Workspace Browser (old lines 757-931) ====================
  { method: "GET", path: "/api/v1/workspace/status", handler: workspaceStatusRoute },
  { method: "POST", path: "/api/v1/workspace/change-dir", handler: workspaceChangeDirRoute },
  // GET /api/v1/models/config - model catalog + current selection for the UI settings dialog
  { method: "GET", path: "/api/v1/models/config", handler: modelsConfigGetRoute },
  // PUT /api/v1/models/config - persist default and per-role model selection
  { method: "PUT", path: "/api/v1/models/config", handler: modelsConfigPutRoute },
  { method: "GET", path: "/api/v1/workspace/tree", handler: workspaceTreeRoute },
  { method: "GET", path: "/api/v1/workspace/subtree", handler: workspaceSubtreeRoute },
  { method: "GET", path: "/api/v1/workspace/file", handler: workspaceFileRoute },
  { method: "GET", path: "/api/v1/workspace/project-path", handler: workspaceProjectPathRoute },
  { method: "GET", path: "/api/v1/workspace/raw/", prefix: true, handler: workspaceRawFileRoute },

  // ==================== Worker Management (old lines 939-960) ====================
  // POST /api/v1/workers/register
  { method: "POST", path: "/api/v1/workers/register", handler: workerRegisterRoute },
  // DELETE /api/v1/workers/:id
  { method: "DELETE", path: /^\/api\/v1\/workers\/[^/]+$/, handler: workerDeleteRoute },
  // GET /api/v1/workers
  { method: "GET", path: "/api/v1/workers", handler: workerListRoute },
  // POST /api/v1/workers/:id/heartbeat
  { method: "POST", path: /^\/api\/v1\/workers\/[^/]+\/heartbeat$/, handler: workerHeartbeatRoute },

  // ==================== Task Management (old lines 968-1100) ====================
  // POST /api/v1/tasks
  { method: "POST", path: "/api/v1/tasks", handler: taskCreateRoute },
  // GET /api/v1/tasks
  { method: "GET", path: "/api/v1/tasks", handler: taskListRoute },
  // GET /api/v1/stats
  { method: "GET", path: "/api/v1/stats", handler: teamStatsRoute },
  // GET /api/v1/tasks/:id
  { method: "GET", path: /^\/api\/v1\/tasks\/[^/]+$/, handler: taskGetRoute },
  // DELETE /api/v1/tasks/:id
  { method: "DELETE", path: /^\/api\/v1\/tasks\/[^/]+$/, handler: taskDeleteRoute },
  // GET /api/v1/tasks/:id/execution
  { method: "GET", path: /^\/api\/v1\/tasks\/[^/]+\/execution$/, handler: taskExecutionGetRoute },
  // PATCH /api/v1/tasks/:id
  { method: "PATCH", path: /^\/api\/v1\/tasks\/[^/]+$/, handler: taskPatchRoute },
  // POST /api/v1/tasks/:id/assign
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/assign$/, handler: taskAssignRoute },
  // POST /api/v1/tasks/:id/handoff
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/handoff$/, handler: taskHandoffRoute },
  // POST /api/v1/tasks/:id/checkpoint - worker persists an execution progress
  // snapshot so an interrupted task can resume instead of restarting.
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/checkpoint$/, handler: taskCheckpointRoute },
  // POST /api/v1/tasks/:id/result-contract
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/result-contract$/, handler: taskResultContractRoute },
  // POST /api/v1/tasks/:id/result
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/result$/, handler: taskResultRoute },
  // POST /api/v1/tasks/:id/execution
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/execution$/, handler: taskExecutionEventRoute },
  // POST /api/v1/tasks/:id/parallel-help
  { method: "POST", path: /^\/api\/v1\/tasks\/[^/]+\/parallel-help$/, handler: taskParallelHelpRoute },

  // ==================== Message Routing (old lines 1109-1313) ====================
  // POST /api/v1/controller/manifest
  { method: "POST", path: "/api/v1/controller/manifest", handler: controllerManifestRoute },
  // GET /api/v1/controller/runs
  { method: "GET", path: "/api/v1/controller/runs", handler: controllerRunsListRoute },
  // DELETE /api/v1/projects/:projectDir
  { method: "DELETE", path: /^\/api\/v1\/projects\/[^/]+$/, handler: projectDeleteRoute },
  // DELETE /api/v1/controller/runs/:id
  { method: "DELETE", path: /^\/api\/v1\/controller\/runs\/[^/]+$/, handler: controllerRunDeleteRoute },
  // POST /api/v1/controller/intake
  { method: "POST", path: "/api/v1/controller/intake", handler: controllerIntakeRoute },
  // POST /api/v1/messages/direct
  { method: "POST", path: "/api/v1/messages/direct", handler: messageDirectRoute },
  // POST /api/v1/messages/broadcast
  { method: "POST", path: "/api/v1/messages/broadcast", handler: messageBroadcastRoute },
  // POST /api/v1/messages/review-request
  { method: "POST", path: "/api/v1/messages/review-request", handler: messageReviewRequestRoute },
  // GET /api/v1/messages
  { method: "GET", path: "/api/v1/messages", handler: messageListRoute },

  // ==================== Clarification Requests (old lines 1318-1333) ====================
  // POST /api/v1/clarifications
  { method: "POST", path: "/api/v1/clarifications", handler: clarificationCreateRoute },
  // GET /api/v1/clarifications
  { method: "GET", path: "/api/v1/clarifications", handler: clarificationListRoute },
  // POST /api/v1/clarifications/:id/answer
  { method: "POST", path: /^\/api\/v1\/clarifications\/[^/]+\/answer$/, handler: clarificationAnswerRoute },

  // ==================== Git Collaboration (old lines 1342-1412) ====================
  // GET /api/v1/repo
  { method: "GET", path: "/api/v1/repo", handler: repoStatusRoute },
  // GET /api/v1/repo/bundle
  { method: "GET", path: "/api/v1/repo/bundle", handler: repoBundleRoute },
  // POST /api/v1/repo/import
  { method: "POST", path: "/api/v1/repo/import", handler: repoImportRoute },

  // ==================== Team Info (old lines 1417-1576) ====================
  // GET /api/v1/team/status
  { method: "GET", path: "/api/v1/team/status", handler: teamStatusRoute },
  // GET /api/v1/roles
  { method: "GET", path: "/api/v1/roles", handler: teamRolesRoute },
  // GET /api/v1/profiles — list the available team profile packages
  // (Phase 2.1, design section 4: the switcher UI reads this list).
  { method: "GET", path: "/api/v1/profiles", handler: teamProfilesListRoute },
  // GET /api/v1/team/profile — active profile detail incl. capabilities
  // (design section 4: UI hides capability-gated entries based on this).
  { method: "GET", path: "/api/v1/team/profile", handler: teamProfileGetRoute },
  // POST /api/v1/team/profile { profileId } — six-step switch semantics
  // (Phase 2.1, design section 2.3). Returns 202; progress arrives via the
  // team.switch_started / team.switch_completed WS events.
  { method: "POST", path: "/api/v1/team/profile", handler: teamProfileSwitchRoute },
  // GET /api/v1/archived-teams — archived team metadata list
  // (Phase 2.1, design section 4: profileId/teamName/time/taskCount; detail
  // queries and the archive UI stay v1.1).
  { method: "GET", path: "/api/v1/archived-teams", handler: archivedTeamsRoute },

  // ==================== Previews / reports / health (old lines 1580-1633) ====================
  // /api/v1/previews/:id/* — proxy to preview subprocess (5-method
  // whitelist, prefix route; sits after every exact /api/v1 route so it can
  // never shadow them).
  { method: ["GET", "HEAD", "POST", "PUT", "DELETE"], path: "/api/v1/previews/", prefix: true, handler: previewsProxyRoute },
  // GET /api/v1/reports — list all delivery reports
  { method: "GET", path: "/api/v1/reports", handler: reportsListRoute },
  // GET /api/v1/reports/:sessionKey — serve delivery report page
  { method: "GET", path: "/api/v1/reports/", prefix: true, handler: reportsSessionRoute },
  // GET /api/v1/health
  { method: "GET", path: "/api/v1/health", handler: healthRoute },

  // ==================== Device pairing security (issue #23) ====================
  // The five POST endpoints are EXEMPT from the device-auth middleware and
  // enforce their own stricter origin rules inside controller/security.ts:
  //   enable    - loopback only (mints the FIRST device; remote = attacker)
  //   pair/start- authenticated device or loopback (mints a fresh code,
  //               invalidating the previous one)
  //   pair      - one-shot 60s code exchange -> {token, deviceId}
  //   pair-auto - LAN peer + config.security.autoPair + protection on
  //   reset     - authenticated device or loopback (anti-lockout hatch)
  // GET /security and DELETE /security/devices/:id are NOT exempt: the
  // middleware itself guarantees the caller holds a valid device token.
  { method: "POST", path: "/api/v1/security/enable", handler: handleSecurityEnableRequest },
  { method: "POST", path: "/api/v1/security/pair/start", handler: handleSecurityPairStartRequest },
  { method: "POST", path: "/api/v1/security/pair", handler: handleSecurityPairRequest },
  { method: "POST", path: "/api/v1/security/pair-auto", handler: handleSecurityPairAutoRequest },
  { method: "GET", path: "/api/v1/security", handler: handleSecurityGetRequest },
  { method: "DELETE", path: /^\/api\/v1\/security\/devices\/[^/]+$/, handler: handleSecurityDeviceDeleteRequest },
  { method: "POST", path: "/api/v1/security/reset", handler: handleSecurityResetRequest },
];

// ===========================================================================
// Tunnel-side route tables (pre-PR-D http-server.ts lines 348-432, the
// outer server callback's tunnel branch). These run BEFORE handleRequest
// and are split exactly along the old viaTunnel if/else:
//   - viaTunnel: the gate page routes answer; every other tunnel request
//     must pass the gate cookie (403 gate page), then continues to the
//     controller route table;
//   - direct (non-tunnel): the tunnel management API answers, everything
//     else continues to the controller route table.
// ===========================================================================

/** GET /__tunnel_gate + GET / + POST /__tunnel_gate/verify (via tunnel only). */
export function createTunnelGateRoutes(tunnelManager: TunnelManager): readonly RouteDef[] {
  return [
    {
      method: "GET",
      path: "/__tunnel_gate",
      handler: ({ res, req }) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
      },
    },
    {
      // Valid gate cookie on "/" goes straight to the dashboard; the gate
      // page only greets visitors who have not authenticated yet.
      method: "GET",
      path: "/",
      handler: ({ res, req, pathname }) => {
        if (pathname === "/" && tunnelManager.gateAllows(req)) {
          res.writeHead(302, { Location: "/ui/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
      },
    },
    {
      method: "POST",
      path: "/__tunnel_gate/verify",
      handler: async ({ res, req }) => {
        const form = await readFormBody(req);
        const submitted = String((form as { token?: unknown }).token ?? "").trim().toUpperCase();
        const st = tunnelManager.status();
        if (st.active && st.gateToken && submitted === st.gateToken) {
          const cookie = `${GATE_COOKIE_NAME}=${computeGateCookie(st.gateToken, st.tunnelId ?? "")}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax`;
          res.writeHead(302, { "Set-Cookie": cookie, Location: "/" });
          res.end();
          return;
        }
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), true));
      },
    },
  ];
}

/** /api/v1/tunnel/* management API (direct requests only, never via tunnel). */
export function createTunnelManagementRoutes(tunnelManager: TunnelManager, deps: ControllerHttpDeps): readonly RouteDef[] {
  const { config, logger } = deps;
  return [
    {
      method: "GET",
      path: "/api/v1/tunnel/status",
      handler: ({ res }) => {
        sendJson(res, 200, tunnelManager.status());
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/start",
      handler: async ({ res }) => {
        const authStatus = await getGithubAuthManager(config, logger).getStatus();
        const account = authStatus.account;
        if (!account?.login) { sendError(res, 401, "GitHub login required to share a tunnel"); return; }
        // Async launch: poll /tunnel/status for phase progress and the
        // resulting hostname/gateToken once startOp.phase === "done".
        const launched = tunnelManager.start(account.login);
        sendJson(res, 202, { launched, status: tunnelManager.status() });
      },
    },
    {
      // Self-hosted: user-owned Cloudflare tunnel via connector token (no
      // GitHub login, no platform tunnel server). Token from the request
      // body, or the TEAMCLAW_TUNNEL_TOKEN env injection when body is empty.
      method: "POST",
      path: "/api/v1/tunnel/start-self-hosted",
      handler: async ({ req, res }) => {
        let token = "";
        try {
          const body = await readFormBody(req) as { token?: unknown };
          token = String(body.token ?? "");
        } catch { /* fall through to env */ }
        if (!token.trim()) {
          const envToken = selfHostedTokenFromEnv();
          if (!envToken) { sendError(res, 400, "connector token required (or set TEAMCLAW_TUNNEL_TOKEN)"); return; }
          token = envToken;
        }
        const r = tunnelManager.startSelfHosted(token);
        if (!r.launched) { sendError(res, 400, r.error ?? "failed to start self-hosted tunnel"); return; }
        sendJson(res, 202, { launched: true, status: tunnelManager.status() });
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/start-quick",
      handler: ({ res }) => {
        const r = tunnelManager.startQuick();
        if (!r.launched) { sendError(res, 400, r.error ?? "failed to start quick tunnel"); return; }
        sendJson(res, 202, { launched: true, status: tunnelManager.status() });
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/stop",
      handler: async ({ res }) => {
        await tunnelManager.stop();
        sendJson(res, 200, tunnelManager.status());
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/install-cloudflared",
      handler: async ({ res }) => {
        try {
          const result = await tunnelManager.installCloudflared();
          sendJson(res, result.ok ? 200 : 500, { ...result, status: tunnelManager.status() });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : "install failed");
        }
      },
    },
  ];
}
