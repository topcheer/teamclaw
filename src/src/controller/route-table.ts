import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeamState } from "../types.js";
// PR-D of issue #204: this module owns the declarative route table + the
// dispatcher that replaced http-server.ts's serial if/startsWith chain. It
// imports the domain route modules (PR-A/B/C cuts) and must never be
// imported by the domain modules at runtime and never imports http-server.ts
// at RUNTIME (only the ControllerHttpDeps type, which is erased at compile
// time) so the module graph stays acyclic.
// Issue #226 W2: the handler bodies that PR-D had still kept inline here
// (web UI / GitHub auth / workspace+model config / controller runs+intake /
// team status+profiles+switch / reports+health / repo import) moved verbatim
// into the domain modules below; route-table is now the pure table +
// dispatcher (+ the tunnel-side tables, whose handlers never read state).
import type { ControllerHttpDeps } from "./http-server.js";
import {
  webUiRootRoute,
  webUiIndexRoute,
  webUiGithubLoginPageRoute,
  webUiAssetsRoute,
} from "./webui-routes.js";
import {
  githubAuthStatusRoute,
  githubAuthLoginRoute,
  githubAuthCallbackRoute,
  githubAuthLogoutRoute,
  githubAuthRefreshRoute,
} from "./auth-routes.js";
import {
  workspaceStatusRoute,
  workspaceChangeDirRoute,
  modelsConfigGetRoute,
  modelsConfigPutRoute,
  workspaceTreeRoute,
  workspaceSubtreeRoute,
  workspaceFileRoute,
  workspaceProjectPathRoute,
  workspaceRawFileRoute,
} from "./workspace-routes.js";
import {
  controllerManifestRoute,
  controllerRunsListRoute,
  projectDeleteRoute,
  controllerRunDeleteRoute,
  controllerIntakeRoute,
} from "./controller-routes.js";
import {
  teamStatsRoute,
  teamStatusRoute,
  teamRolesRoute,
  teamProfilesListRoute,
  teamProfileGetRoute,
  teamProfileSwitchRoute,
  archivedTeamsRoute,
} from "./status-routes.js";
import {
  reportsListRoute,
  reportsSessionRoute,
  healthRoute,
} from "./report-routes.js";
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
  repoImportRoute,
} from "./repo-routes.js";
import { handlePreviewProxyRequest } from "./preview-proxy.js";
// Issue #226 W2: the tunnel-side tables (gate page + management API, with
// their inline handler bodies, the gate-page HTML rendering and the tunnel
// form reader) live in ./tunnel-routes.ts; both factories are re-exported
// below so http-server.ts's imports are unchanged.
export { createTunnelGateRoutes, createTunnelManagementRoutes } from "./tunnel-routes.js";
import {
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
// Shared helpers. W2 of issue #226: the helpers whose consumers moved out
// (shell escaping, LAN-URL building, the GitHub callback HTML renderer,
// workspace error mapping, team stats, the tunnel form reader) moved with
// them; nothing inline remains in this module.
// ===========================================================================

/**
 * Retry hint shared by the transition-matrix gate (http-server.ts, task
 * submission / repo import) and the intake handler. Declared in
 * ./controller-routes.ts since W2 (it moved with the intake handler body);
 * re-exported here so http-server.ts's gate import is unchanged.
 */
export { SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS } from "./controller-routes.js";

// ===========================================================================
// Route handlers. The PR-A/B/C domain handlers are forwarded to unchanged;
// every handler body that was still inline here moved verbatim into its
// domain module with W2 of issue #226 (see the import block): route-table
// binds the exported handlers directly, exactly like the issue-#23 security
// handlers. Only the thin forwarder shells for the PR-A/B/C domain modules
// (whose handlers predate RouteContext) and the preview-proxy fire-and-
// forget shell remain below.
// ===========================================================================

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
// /repo/import handler body joined them with W2 of issue #226 (its
// recordTaskExecutionEvent dependency is task-lifecycle glue owned by the
// PR-C cut - acyclic, see the repo-routes.ts header).

async function repoStatusRoute(ctx: RouteContext): Promise<void> {
  await handleRepoStatusRequest(ctx.deps, ctx.res);
}

async function repoBundleRoute(ctx: RouteContext): Promise<void> {
  await handleRepoBundleRequest(ctx.deps, ctx.res);
}

// ---- Previews / reports / health (pre-PR-D lines 1580-1633) ----
// W2 of issue #226: the reports list/session and health handler bodies live
// in ./report-routes.ts; only the fire-and-forget preview-proxy shell stays.

// /api/v1/previews/:id/* — proxy to preview subprocess.
// PR-B of issue #204: the proxy implementation lives in ./preview-proxy.ts.
// Deliberately NOT awaited (fire-and-forget proxy), exactly as before.
function previewsProxyRoute(ctx: RouteContext): void {
  handlePreviewProxyRequest(ctx.deps, ctx.req, ctx.res, ctx.requestUrl, ctx.pathname);
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
