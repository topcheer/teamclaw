// ===========================================================================
// Controller HTTP server - COMPOSITION ROOT (issue #204 P0 split, PR-D).
//
// This file assembles the pieces and owns ONLY the dispatch-layer gates and
// the server lifecycle; request routing is declarative (see
// ./route-table.ts, PR-D) and every handler body lives in a domain module.
// Request pipeline, in order:
//
//   1. CORS preflight (OPTIONS short-circuit; wildcard while device
//      protection is off - the historical behavior - and narrowed to the
//      UI's own origin once it is on)
//   2. Device-auth gate (issue #23, ./security.ts createSecurityMiddleware):
//      zero-op while no devices are paired (L0); once devices exist every
//      non-exempt /api request must present a valid device token and the
//      response CORS policy is pinned before dispatch. Runs BEFORE the
//      tunnel gate and the handleRequest gates so transition/capability/
//      tunnel-management responses never leak to unpaired callers.
//   3. Tunnel gate (viaTunnel classification: gate page routes / gate
//      cookie 403 / tunnel management API - tables in ./route-table.ts)
//   4. handleRequest gates (verbatim, NOT part of the route table):
//      a. profile-switch transition matrix (409 worker re-register,
//         503+Retry-After task submission / repo import)
//      b. capability 404 gates (steady-state existence gate, after (a) on
//         purpose: transition semantics win over the 404)
//   5. declarative route table match (./route-table.ts, array order =
//      the historical if/startsWith chain, one-to-one)
//   6. fall-through 404
//
// Domain module index (the 18 modules this root composes; none of them may
// import this file):
//   PR-A: profile-switch.ts (six-step switch machine), ui-assets.ts
//   PR-B: teamauto-routes.ts, repo-routes.ts, preview-proxy.ts
//   PR-C: task-execution.ts, project-registry.ts, controller-runs.ts,
//         task-cleanup.ts, task-assignment.ts, controller-intake.ts,
//         controller-planning.ts, task-results.ts (via task-routes),
//         worker-routes.ts, task-routes.ts, message-routes.ts,
//         clarification-routes.ts
//   PR-D: route-table.ts (declarative route table + dispatcher + the
//         handlers that were inline here before the split)
// Pre-split peers that stayed: controller-service.ts (service lifecycle),
// websocket.ts, task-router.ts, message-router.ts, github-auth.ts,
// tunnel-manager.ts, delivery-report.ts, orchestration-manifest.ts,
// preview-manager.ts, worker-provisioning.ts, controller-capacity.ts,
// controller-tools.ts, kickoff-orchestrator.ts, prompt-injector.ts.
// ===========================================================================
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import type { PluginConfig, TeamState } from "../types.js";
import { sendJson, sendError } from "../protocol.js";
import { getActiveProfile, type TeamProfileCapabilities } from "../profile-loader.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
import type { WorkerProvisioningManager } from "./worker-provisioning.js";
import type { PreviewManager } from "./preview-manager.js";
import type { KickoffHandler, UpdateTeamStateFn } from "./controller-service.js";
import type { TeamAutoScheduler } from "../teamauto/scheduler.js";
import { autoAssignPendingTasks } from "./task-assignment.js";
import { createTunnelManager, gatePageHtml, type TunnelManager } from "./tunnel-manager.js";
// PR-D of issue #204: routing is declarative. route-table.ts owns the
// ordered controller route table, the tunnel-side tables, the dispatcher
// and every handler that used to be inline in this file's if/startsWith
// chain. This is the only runtime import direction between the two files
// (route-table imports this file as TYPE ONLY), so the module graph stays
// acyclic.
import {
  controllerRouteTable,
  createTunnelGateRoutes,
  createTunnelManagementRoutes,
  dispatchRoutes,
  SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
  type RouteContext,
  type RouteDef,
} from "./route-table.js";
// Issue #23 (backend wave): the device-pairing security module owns the
// auth middleware, the CORS narrowing policy, the WS upgrade guard and the
// pairing handlers (registered via route-table.ts). This file only wires
// them into the pipeline below - all pathname/method policy lives in
// security.ts.
import {
  classifySecurityPeer,
  corsPreflightDecision,
  createSecurityMiddleware,
  createWebSocketUpgradeGuard,
  isProtectionOn,
  type SecurityPeer,
} from "./security.js";

export type ControllerHttpDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  getTeamState: () => TeamState | null;
  // Issue #226 W4: widened to the single-write-entry contract (the optional
  // second argument + awaited-durability overload live in controller-service
  // next to the implementation; one-argument callers are unaffected).
  updateTeamState: UpdateTeamStateFn;
  taskRouter: TaskRouter;
  messageRouter: MessageRouter;
  wsServer: TeamWebSocketServer;
  workerProvisioningManager?: WorkerProvisioningManager | null;
  previewManager?: PreviewManager;
  /** Late-bound kickoff handler for automatic team kickoff on complex projects. */
  getKickoffHandler?: () => KickoffHandler | undefined;
  /** Late-bound TeamAuto scheduler (autonomous repo collaboration). */
  getTeamAutoScheduler?: () => TeamAutoScheduler | null;
};

// ===========================================================================
// Team profile switch dispatch-layer constants (Phase 2.1,
// vertical-team-profiles-design.md 2.3). The six-step switch machine itself
// (drain -> archive -> rebuild -> warm -> settle) lives in
// ./profile-switch.ts since PR-A of issue #204; these constants below gate
// request dispatch while a transition is in flight and stay with the router.
// ===========================================================================

/** Advisory backoff hint carried in 409 bodies for worker register/heartbeat. */
const SWITCH_WORKER_BACKOFF_HINT_MS = 5000;
// SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS moved to ./route-table.ts with
// PR-D (the intake handler body carries it too); imported above.
/** New-work entry points gated with 503 + Retry-While during a transition. */
const TRANSITION_BLOCKED_TASK_POST_PATHS = new Set([
  "/api/v1/tasks",
  "/api/v1/controller/intake",
  "/api/v1/controller/manifest",
]);
// Review fix: manual assign and parallel-help both spawn work for the
// outgoing team (parallel-help funnels into runControllerIntake, which also
// carries its own entry-level backstop); task handoff stays open - it is part
// of in-flight completion the drain waits on.
const TRANSITION_BLOCKED_TASK_POST_PATH_RES = [
  /^\/api\/v1\/tasks\/[^/]+\/assign$/,
  /^\/api\/v1\/tasks\/[^/]+\/parallel-help$/,
];
const WORKER_REGISTER_PATH = "/api/v1/workers/register";
const WORKER_HEARTBEAT_PATH_RE = /^\/api\/v1\/workers\/[^/]+\/heartbeat$/;

// ===========================================================================
// Capability 404 gates (Phase 2.3, vertical-team-profiles-design.md 4).
//
// Routes whose EXISTENCE depends on the active profile's capability switches.
// A disabled capability hides its routes entirely: 404 (never 403 - the
// resource does not exist for this team), with the owning `capability` key in
// the error body so CI can assert the reason. software-rd ships all four
// switches on, so its routing is unchanged.
//
// Ordering contract with the transition matrix above: the transition checks
// run FIRST in handleRequest, so while a profile switch is in flight the
// 503/409 transition semantics win over the steady-state 404 (e.g. POST
// /repo/import during a switch to a git-less profile reports "retry later",
// not "does not exist").
// ===========================================================================

type CapabilityGateKey = keyof TeamProfileCapabilities;

/**
 * Route -> capability map. Prefix entries hide the whole route family;
 * exact entries are method-bound single routes. Routes NOT listed here stay
 * up for every profile: capability-agnostic reads, capability reads that
 * degrade gracefully instead of disappearing (GET /api/v1/repo answers
 * { enabled: false } so the UI can render an off state), and - deliberately
 * - POST /api/v1/controller/manifest: that endpoint records the controller
 * INTAKE orchestration manifest (controllerRuns/projects/task bindings,
 * requirement:complete), it is not a delivery-report surface, and the
 * controller prompt rules make teamclaw_submit_manifest mandatory on every
 * reply (controller-tools POSTs this endpoint) - gating it under
 * deliveryReview would 404 every intake manifest of a deliveryReview=false
 * team and break the intake loop (cross-review fix).
 */
const CAPABILITY_GATE_PREFIXES: ReadonlyArray<readonly [prefix: string, capability: CapabilityGateKey]> = [
  ["/api/v1/teamauto", "teamauto"],
  ["/api/v1/previews/", "runnablePreview"],
  ["/api/v1/reports", "deliveryReview"],
];
const CAPABILITY_GATE_EXACT_PATHS: ReadonlyArray<readonly [method: string, pathname: string, capability: CapabilityGateKey]> = [
  ["POST", "/api/v1/repo/import", "git"],
  ["GET", "/api/v1/repo/bundle", "git"],
];

/**
 * Returns the capability that owns `pathname` when the ACTIVE profile has it
 * disabled, else null (route proceeds unchanged). Reads the active profile
 * per request so the gates flip atomically with the switch's step-4 profile
 * activation.
 */
function disabledCapabilityForPath(method: string, pathname: string): CapabilityGateKey | null {
  const { capabilities } = getActiveProfile();
  for (const [prefix, capability] of CAPABILITY_GATE_PREFIXES) {
    if (pathname.startsWith(prefix) && !capabilities[capability]) {
      return capability;
    }
  }
  for (const [gatedMethod, gatedPath, capability] of CAPABILITY_GATE_EXACT_PATHS) {
    if (method === gatedMethod && pathname === gatedPath && !capabilities[capability]) {
      return capability;
    }
  }
  return null;
}

export function createControllerHttpServer(deps: ControllerHttpDeps): http.Server {
  const { logger, wsServer } = deps;
  let tunnelManagerSingleton: TunnelManager | null = null;
  // Tunnel-side route tables are built once (lazily, next to the lazy
  // tunnel manager singleton they close over) and reused for every request.
  let tunnelRoutesSingleton: { gate: readonly RouteDef[]; management: readonly RouteDef[] } | null = null;

  // Issue #23: the device gate. Zero-friction ladder - while no device is
  // paired (protection off) this is a no-op passthrough (L0, the exact
  // pre-issue behavior); once devices exist it enforces per-device tokens
  // on every non-exempt /api route (exemptions and 401 shape in security.ts).
  const securityGate = createSecurityMiddleware(deps);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight (issue #23: wildcard while protection is off - the
    // historical bytes - and narrowed to the UI's own origin once on).
    if (req.method === "OPTIONS") {
      const decision = corsPreflightDecision(req, isProtectionOn(deps.getTeamState()));
      res.writeHead(decision.status, decision.headers);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Tunnel sharing: every request arriving via <user>.apps.teamclaw.dev is
    // gated behind the token the local web UI displays. The gate-page /
    // management route bodies live in ./route-table.ts (PR-D); the branch
    // structure below is unchanged from the pre-PR-D if/else chain.
    let tunnelManager = tunnelManagerSingleton;
    if (!tunnelManager) {
      tunnelManager = tunnelManagerSingleton = createTunnelManager({ logger, localPort: deps.config.port });
    }
    if (!tunnelRoutesSingleton) {
      tunnelRoutesSingleton = {
        gate: createTunnelGateRoutes(tunnelManager),
        management: createTunnelManagementRoutes(tunnelManager, deps),
      };
    }
    const tunnelCtx: RouteContext = {
      req, res, requestUrl: url, pathname, deps, currentState: null,
    };
    const viaTunnel = tunnelManager.isTunnelRequest(typeof req.headers.host === "string" ? req.headers.host : undefined);

    // ==================== Device auth gate (issue #23) ====================
    // Runs BEFORE the tunnel gate tables, the transition matrix and the
    // capability gates so none of those surfaces answer - or leak response
    // shape information - to unpaired callers while protection is on.
    // Requests arriving through the sharing tunnel are classified from the
    // Host header (cloudflared dials in from loopback, so the socket peer
    // address would lie); see classifySecurityPeer in ./security.ts.
    const peer = classifySecurityPeer(req.socket.remoteAddress, viaTunnel);
    if (!securityGate(req, res, pathname, peer)) {
      return;
    }

    if (viaTunnel) {
      if (await dispatchRoutes(tunnelRoutesSingleton.gate, tunnelCtx)) {
        return;
      }
      if (!tunnelManager.gateAllows(req)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
        return;
      }
    } else {
      if (await dispatchRoutes(tunnelRoutesSingleton.management, tunnelCtx)) {
        return;
      }
    }

    try {
      await handleRequest(req, res, pathname, deps, peer);
    } catch (err) {
      logger.error(`Controller HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  });

  // Attach WebSocket (issue #23: while device protection is on, upgrades
  // must carry a valid device token - ?token= query for browsers, cookie /
  // Bearer for native clients; see createWebSocketUpgradeGuard).
  wsServer.attach(server, {
    verifyUpgrade: createWebSocketUpgradeGuard({
      ...deps,
      isTunnelHost: (host) => tunnelManagerSingleton?.isTunnelRequest(host) ?? false,
    }),
  });

  // Plugin shutdown: kill the local connector and tear down the remote
  // tunnel so gateway exits never leak orphan cloudflared processes.
  server.on("close", () => {
    void tunnelManagerSingleton?.stop().catch(() => undefined);
  });

  // Boot reconciliation: reconnect a share persisted by a previous run
  // (gateway restart or kill -9) so the tunnel id and gate token survive.
  if (!tunnelManagerSingleton) {
    tunnelManagerSingleton = createTunnelManager({ logger, localPort: deps.config.port });
  }
  void tunnelManagerSingleton.recover().catch((err) => {
    logger.warn(`TeamClaw tunnel: boot recovery failed: ${String(err)}`);
  });

  setTimeout(() => {
    const state = deps.getTeamState();
    const pendingCount = state
      ? Object.values(state.tasks).filter((t) => t.status === "pending" && !t.assignedWorkerId).length
      : 0;
    if (pendingCount > 0) {
      logger.info(`Controller: startup reconciliation — ${pendingCount} pending tasks, triggering auto-assign`);
      void autoAssignPendingTasks(deps).catch((err) => {
        logger.warn(`Controller: startup auto-assign failed: ${String(err)}`);
      });
    }
  }, 2000);

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ControllerHttpDeps,
  peer?: SecurityPeer,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const currentState = deps.getTeamState();

  // ==================== Profile switch concurrency matrix ====================
  // Phase 2.1 (design 2.3): while a switch transition is in flight -
  //   - worker register/heartbeat -> 409 with an explicit backoff hint (the
  //     design contract for existing workers; they retry on their interval
  //     and re-register after team.switch_completed);
  //   - task submission POSTs -> 503 + Retry-After;
  //   - a second POST /api/v1/team/profile -> 409 (handled inside that
  //     endpoint, which owns the step-0 validation order);
  // Worker result/progress endpoints intentionally stay open: the drain step
  // waits for exactly those in-flight completions.
  const activeTransition = currentState?.transition;
  if (activeTransition) {
    if (req.method === "POST" && (pathname === WORKER_REGISTER_PATH || WORKER_HEARTBEAT_PATH_RE.test(pathname))) {
      sendJson(res, 409, {
        error: `Team profile switch to "${activeTransition.targetProfileId}" is in progress (phase: ${activeTransition.phase}); worker registration and heartbeat are temporarily rejected - back off and retry`,
        retryAfterMs: SWITCH_WORKER_BACKOFF_HINT_MS,
        transition: { phase: activeTransition.phase, targetProfileId: activeTransition.targetProfileId },
      });
      return;
    }
    if (
      req.method === "POST" &&
      (TRANSITION_BLOCKED_TASK_POST_PATHS.has(pathname) || TRANSITION_BLOCKED_TASK_POST_PATH_RES.some((re) => re.test(pathname)))
    ) {
      res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: `Team profile switch to "${activeTransition.targetProfileId}" is in progress (phase: ${activeTransition.phase}); task submission is temporarily unavailable - retry after the switch completes`,
        retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
        transition: { phase: activeTransition.phase, targetProfileId: activeTransition.targetProfileId },
      });
      return;
    }
    // Review fix: a bundle import during a transition would run after the
    // step-4 flip and stamp a repo field onto the new team even for profiles
    // with git disabled - the switch itself re-prepares repo state for
    // git-capable targets, so imports wait it out.
    if (req.method === "POST" && pathname === "/api/v1/repo/import") {
      res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: `Team profile switch to "${activeTransition.targetProfileId}" is in progress (phase: ${activeTransition.phase}); repo import is temporarily unavailable - retry after the switch completes`,
        retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
        transition: { phase: activeTransition.phase, targetProfileId: activeTransition.targetProfileId },
      });
      return;
    }
  }

  // ==================== Capability 404 gates (Phase 2.3) ====================
  // Steady-state existence gate, placed AFTER the transition matrix on
  // purpose: while a switch is in flight the 503/409 transition semantics
  // win over the steady-state 404 (e.g. repo import towards a git-less
  // target reports "retry later" during the switch, "does not exist" after
  // it). software-rd has all capabilities on, so this never fires there.
  const gatedCapability = disabledCapabilityForPath(req.method ?? "", pathname);
  if (gatedCapability) {
    const profile = getActiveProfile();
    sendJson(res, 404, {
      error: `Team profile "${profile.id}" has the "${gatedCapability}" capability disabled - this endpoint does not exist for this team`,
      capability: gatedCapability,
      profileId: profile.id,
    });
    return;
  }

  // ==================== Declarative route table (PR-D) ====================
  // Single ordered match over ./route-table.ts's controllerRouteTable
  // (array order = the pre-PR-D if/startsWith chain, one-to-one; see the
  // parity test tests/test-route-table.mjs). Handlers may decline (return
  // false) to continue matching; an exhausted table falls through to the
  // final 404 below - both semantics are preserved from the old chain.
  const handled = await dispatchRoutes(controllerRouteTable, {
    req, res, requestUrl, pathname, deps, currentState, peer,
  });
  if (!handled) {
    sendError(res, 404, "Not found");
  }
}
