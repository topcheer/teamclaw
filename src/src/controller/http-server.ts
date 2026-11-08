import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import type { PluginConfig, TeamState } from "../types.js";
import {
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendError,
} from "../protocol.js";
import { saveTeamState, listArchivedTeams } from "../state.js";
import { listWorkspaceTree, listWorkspaceSubtree, readWorkspaceFile, readWorkspaceRawFile } from "../workspace-browser.js";
// Phase 1.3: runtime role data comes from the active TeamProfile loader
// (software-rd baseline) instead of the roles.ts registry; roles.ts/role-ids.ts
// remain the type layer and the generator source.
import {
  BUILTIN_PROFILES,
  getActiveProfile,
  getActiveRoles,
  getActiveDefaultRole,
  hasProfile,
  validateActiveRoleId,
  type TeamProfileCapabilities,
} from "../profile-loader.js";
import { importControllerGitBundle } from "../git-collaboration.js";
import { TaskRouter } from "./task-router.js";
import { MessageRouter } from "./message-router.js";
import { TeamWebSocketServer } from "./websocket.js";
// PR-A of issue #204: the profile switch state machine (drain/archive/warm)
// and the static UI asset serving live in their own modules; http-server
// keeps only the route shells. profile-switch must never import this file.
import { startTeamProfileSwitch } from "./profile-switch.js";
import { serveStaticFile, serveVersionedHtml } from "./ui-assets.js";
// PR-B of issue #204: the TeamAuto route handlers, the git collaboration
// read-side routes (+ the shared refreshControllerRepoState glue), and the
// preview subprocess proxy live in their own modules; http-server keeps only
// the route shells. None of them may import this file.
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
import type { WorkerProvisioningManager } from "./worker-provisioning.js";
import type { PreviewManager } from "./preview-manager.js";
import { getGithubAuthManager } from "./github-auth.js";
import { createTunnelManager, gatePageHtml, computeGateCookie, GATE_COOKIE_NAME, selfHostedTokenFromEnv, type TunnelManager } from "./tunnel-manager.js";
import type { TeamAutoScheduler } from "../teamauto/scheduler.js";
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
import type { KickoffHandler } from "./controller-service.js";
// PR-C of issue #204: the task/team lifecycle domain (cut line b) lives in
// its own modules - the execution event ring + serializeTask
// (task-execution), the project identity/registry family (project-registry),
// the controller-run lifecycle (controller-runs), the cascade cleanup family
// (task-cleanup), the assignment pipeline incl. the gated auto-assign loop
// (task-assignment), the worker message delivery helpers (message-delivery),
// the controller planning domain (controller-planning), the intake
// orchestration (controller-intake), the task result domain (task-results),
// the worker routes + readiness gate (worker-routes), the task routes
// (task-routes), the message routes (message-routes) and the clarification
// routes (clarification-routes). http-server keeps only the route shells and
// the dispatch-layer gates. None of them may import this file.
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
import { autoAssignPendingTasks } from "./task-assignment.js";
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

export type ControllerHttpDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  runtime: OpenClawPluginApi["runtime"];
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
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

const EXTERNAL_WORKER_INSTALL_SPEC = "@teamclaws/teamclaw";

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

// Static UI asset serving (content-versioned HTML + cache-busting file
// serving) lives in ./ui-assets.ts since PR-A of issue #204; the /ui route
// shells below call it unchanged.

function workspaceRequestErrorStatus(err: unknown): number {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
    return 404;
  }
  return 400;
}

function workspaceRequestErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Workspace request failed";
}

// ===========================================================================
// Team profile switch dispatch-layer constants (Phase 2.1,
// vertical-team-profiles-design.md 2.3). The six-step switch machine itself
// (drain -> archive -> rebuild -> warm -> settle) lives in
// ./profile-switch.ts since PR-A of issue #204; these constants below gate
// request dispatch while a transition is in flight and stay with the router.
// ===========================================================================

/** Advisory backoff hint carried in 409 bodies for worker register/heartbeat. */
const SWITCH_WORKER_BACKOFF_HINT_MS = 5000;
const SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS = 5;
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

  const readFormBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  };

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

    // Tunnel sharing: every request arriving via <user>.apps.teamclaw.dev is
    // gated behind the token the local web UI displays.
    let tunnelManager = tunnelManagerSingleton;
    if (!tunnelManager) {
      tunnelManager = tunnelManagerSingleton = createTunnelManager({ logger, localPort: deps.config.port });
    }
    const viaTunnel = tunnelManager.isTunnelRequest(typeof req.headers.host === "string" ? req.headers.host : undefined);
    if (viaTunnel) {
      if (req.method === "GET" && (pathname === "/__tunnel_gate" || pathname === "/")) {
        // Valid gate cookie on "/" goes straight to the dashboard; the gate
        // page only greets visitors who have not authenticated yet.
        if (pathname === "/" && tunnelManager.gateAllows(req)) {
          res.writeHead(302, { Location: "/ui/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
        return;
      }
      if (req.method === "POST" && pathname === "/__tunnel_gate/verify") {
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
        return;
      }
      if (!tunnelManager.gateAllows(req)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
        return;
      }
    } else {
      if (req.method === "GET" && pathname === "/api/v1/tunnel/status") {
        sendJson(res, 200, tunnelManager.status());
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/start") {
        const authStatus = await getGithubAuthManager(deps.config, logger).getStatus();
        const account = authStatus.account;
        if (!account?.login) { sendError(res, 401, "GitHub login required to share a tunnel"); return; }
        // Async launch: poll /tunnel/status for phase progress and the
        // resulting hostname/gateToken once startOp.phase === "done".
        const launched = tunnelManager.start(account.login);
        sendJson(res, 202, { launched, status: tunnelManager.status() });
        return;
      }
      // Self-hosted: user-owned Cloudflare tunnel via connector token (no
      // GitHub login, no platform tunnel server). Token from the request
      // body, or the TEAMCLAW_TUNNEL_TOKEN env injection when body is empty.
      if (req.method === "POST" && pathname === "/api/v1/tunnel/start-self-hosted") {
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
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/start-quick") {
        const r = tunnelManager.startQuick();
        if (!r.launched) { sendError(res, 400, r.error ?? "failed to start quick tunnel"); return; }
        sendJson(res, 202, { launched: true, status: tunnelManager.status() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/stop") {
        await tunnelManager.stop();
        sendJson(res, 200, tunnelManager.status());
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tunnel/install-cloudflared") {
        try {
          const result = await tunnelManager.installCloudflared();
          sendJson(res, result.ok ? 200 : 500, { ...result, status: tunnelManager.status() });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : "install failed");
        }
        return;
      }
    }

    try {
      await handleRequest(req, res, pathname, deps);
    } catch (err) {
      logger.error(`Controller HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "Internal server error");
    }
  });

  // Attach WebSocket
  wsServer.attach(server);

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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ControllerHttpDeps,
): Promise<void> {
  void pathname;
  const { config, logger, getTeamState, updateTeamState, taskRouter, messageRouter, wsServer } = deps;
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const currentState = getTeamState();

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

  // ==================== Web UI ====================
  if (req.method === "GET" && pathname === "/") {
    res.statusCode = 302;
    res.setHeader("Location", "/ui");
    res.end();
    return;
  }

  if (req.method === "GET" && (pathname === "/ui" || pathname === "/ui/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    serveVersionedHtml(res, path.join(uiPath, "index.html"));
    return;
  }

  // Standalone GitHub device-login page (big user code + prefilled link + polling).
  if (req.method === "GET" && (pathname === "/ui/auth/github" || pathname === "/ui/auth/github/")) {
    const uiPath = path.join(import.meta.dirname, "..", "ui");
    serveStaticFile(res, path.join(uiPath, "github-login.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/ui/")) {
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
    return;
  }

  // ==================== TeamAuto ====================
  // PR-B of issue #204: the handlers live in ./teamauto-routes.ts; these
  // shells keep the method+pathname matches and forward the same deps.

  if (req.method === "GET" && pathname === "/api/v1/teamauto/activity") {
    await handleTeamAutoActivityRequest(deps, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/teamauto/repos") {
    await handleTeamAutoReposListRequest(deps, res);
    return;
  }

  // Selectable repos for the bind picker (the logged-in GitHub account's).
  if (req.method === "GET" && pathname === "/api/v1/teamauto/repo-candidates") {
    await handleTeamAutoRepoCandidatesRequest(deps, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/teamauto/repos") {
    await handleTeamAutoRepoBindRequest(deps, req, res);
    return;
  }

  if (pathname.startsWith("/api/v1/teamauto/repos/")) {
    if (await handleTeamAutoRepoItemRequest(deps, req, res, pathname)) return;
  }

  // ==================== GitHub Auth ====================

  if (req.method === "GET" && pathname === "/api/v1/auth/github/status") {
    try {
      const status = await getGithubAuthManager(config, logger).getStatus(resolveRequestOrigin(req, config));
      sendJson(res, 200, status);
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to read GitHub login status");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/github/login") {
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
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/auth/github/callback") {
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
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/github/logout") {
    try {
      await getGithubAuthManager(config, logger).logout();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to sign out of GitHub");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/github/refresh") {
    try {
      const store = await getGithubAuthManager(config, logger).forceRefresh();
      sendJson(res, 200, { ok: true, account: store.account, expiresAt: store.expiresAt });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "failed to refresh the GitHub token");
    }
    return;
  }

  // ==================== Workspace Browser ====================

  if (req.method === "GET" && pathname === "/api/v1/workspace/status") {
    sendJson(res, 200, {
      workspaceDir: resolveTeamClawWorkspaceDir(),
      isDefault: teamClawWorkspaceIsDefault(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/workspace/change-dir") {
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
    return;
  }

  // GET /api/v1/models/config - model catalog + current selection for the UI settings dialog
  if (req.method === "GET" && pathname === "/api/v1/models/config") {
    try {
      sendJson(res, 200, await getTeamClawModelCatalog());
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "failed to read model configuration");
    }
    return;
  }

  // PUT /api/v1/models/config - persist default and per-role model selection
  if (req.method === "PUT" && pathname === "/api/v1/models/config") {
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
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/tree") {
    try {
      // depth=N limits tree expansion (default 1 for lazy loading)
      const depthParam = requestUrl.searchParams.get("depth");
      const maxDepth = depthParam !== null ? Math.max(0, Math.min(parseInt(depthParam, 10) || 1, 8)) : 1;
      sendJson(res, 200, await listWorkspaceTree(maxDepth));
    } catch (err) {
      sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/subtree") {
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
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/file") {
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
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/workspace/project-path") {
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
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/v1/workspace/raw/")) {
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
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(file.content);
    } catch (err) {
      sendError(res, workspaceRequestErrorStatus(err), workspaceRequestErrorMessage(err));
    }
    return;
  }

  // ==================== Worker Management ====================

  // PR-C of issue #204: the worker lifecycle handlers live in
  // ./worker-routes.ts; these shells keep the method+pathname matches.

  // POST /api/v1/workers/register
  if (req.method === "POST" && pathname === "/api/v1/workers/register") {
    await handleWorkerRegisterRequest(deps, req, res);
    return;
  }

  // DELETE /api/v1/workers/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/workers\/[^/]+$/)) {
    await handleWorkerDeleteRequest(deps, res, pathname);
    return;
  }

  // GET /api/v1/workers
  if (req.method === "GET" && pathname === "/api/v1/workers") {
    await handleWorkerListRequest(deps, res);
    return;
  }

  // POST /api/v1/workers/:id/heartbeat
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/workers\/[^/]+\/heartbeat$/)) {
    await handleWorkerHeartbeatRequest(deps, req, res, pathname);
    return;
  }

  // ==================== Task Management ====================

  // PR-C of issue #204: the task CRUD/lifecycle handlers live in
  // ./task-routes.ts; these shells keep the method+pathname matches.

  // POST /api/v1/tasks
  if (req.method === "POST" && pathname === "/api/v1/tasks") {
    await handleTaskCreateRequest(deps, req, res);
    return;
  }

type TeamStatsResponse = {
  totalWorkers: number;
  workersByStatus: { idle: number; busy: number; offline: number };
  totalTasks: number;
  tasksByStatus: Record<string, number>;
  averageTaskDuration: number | null;
  uptime: number;
};

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

  // GET /api/v1/tasks
  if (req.method === "GET" && pathname === "/api/v1/tasks") {
    await handleTaskListRequest(deps, res);
    return;
  }

  // GET /api/v1/stats
  if (req.method === "GET" && pathname === "/api/v1/stats") {
    const state = getTeamState();
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
    return;
  }

  // GET /api/v1/tasks/:id
  if (req.method === "GET" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    await handleTaskGetRequest(deps, res, pathname);
    return;
  }

  // DELETE /api/v1/tasks/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    await handleTaskDeleteRequest(deps, res, pathname);
    return;
  }

  // GET /api/v1/tasks/:id/execution
  if (req.method === "GET" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/execution$/)) {
    await handleTaskExecutionGetRequest(deps, res, pathname);
    return;
  }

  // PATCH /api/v1/tasks/:id
  if (req.method === "PATCH" && pathname.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
    await handleTaskPatchRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/assign
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/assign$/)) {
    await handleTaskAssignRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/handoff
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/handoff$/)) {
    await handleTaskHandoffRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/checkpoint - worker persists an execution progress
  // snapshot so an interrupted task can resume instead of restarting.
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/checkpoint$/)) {
    await handleTaskCheckpointRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/result-contract
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/result-contract$/)) {
    await handleTaskResultContractRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/result
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/result$/)) {
    await handleTaskResultRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/execution
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/execution$/)) {
    await handleTaskExecutionEventRequest(deps, req, res, pathname);
    return;
  }

  // POST /api/v1/tasks/:id/parallel-help
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/tasks\/[^/]+\/parallel-help$/)) {
    await handleTaskParallelHelpRequest(deps, req, res, pathname);
    return;
  }

  // ==================== Message Routing ====================

  // PR-C of issue #204: the message and clarification handlers live in
  // ./message-routes.ts and ./clarification-routes.ts; these shells keep
  // the method+pathname matches.

  // POST /api/v1/controller/manifest
  if (req.method === "POST" && pathname === "/api/v1/controller/manifest") {
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
    return;
  }

  // GET /api/v1/controller/runs
  if (req.method === "GET" && pathname === "/api/v1/controller/runs") {
    const state = reconcileControllerClarifications(deps);
    const controllerRuns = state
      ? Object.values(state.controllerRuns)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((run) => serializeControllerRun(run))
      : [];
    sendJson(res, 200, { controllerRuns });
    return;
  }

  // DELETE /api/v1/projects/:projectDir
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/projects\/[^/]+$/)) {
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
    return;
  }

  // DELETE /api/v1/controller/runs/:id
  if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/controller\/runs\/[^/]+$/)) {
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
    return;
  }

  // POST /api/v1/controller/intake
  if (req.method === "POST" && pathname === "/api/v1/controller/intake") {
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
    return;
  }

  // POST /api/v1/messages/direct
  if (req.method === "POST" && pathname === "/api/v1/messages/direct") {
    await handleDirectMessageRequest(deps, req, res);
    return;
  }

  // POST /api/v1/messages/broadcast
  if (req.method === "POST" && pathname === "/api/v1/messages/broadcast") {
    await handleBroadcastMessageRequest(deps, req, res);
    return;
  }

  // POST /api/v1/messages/review-request
  if (req.method === "POST" && pathname === "/api/v1/messages/review-request") {
    await handleReviewRequestMessageRequest(deps, req, res);
    return;
  }

  // GET /api/v1/messages
  if (req.method === "GET" && pathname === "/api/v1/messages") {
    await handleMessageListRequest(deps, res, requestUrl);
    return;
  }

  // ==================== Clarification Requests ====================

  // POST /api/v1/clarifications
  if (req.method === "POST" && pathname === "/api/v1/clarifications") {
    await handleClarificationCreateRequest(deps, req, res);
    return;
  }

  // GET /api/v1/clarifications
  if (req.method === "GET" && pathname === "/api/v1/clarifications") {
    await handleClarificationListRequest(deps, res);
    return;
  }

  // POST /api/v1/clarifications/:id/answer
  if (req.method === "POST" && pathname.match(/^\/api\/v1\/clarifications\/[^/]+\/answer$/)) {
    await handleClarificationAnswerRequest(deps, req, res, pathname);
    return;
  }

  // ==================== Git Collaboration ====================
  // PR-B of issue #204: the repo status/bundle handlers and the shared
  // refreshControllerRepoState glue live in ./repo-routes.ts; the POST
  // /repo/import handler stays here (its recordTaskExecutionEvent dependency
  // is task-lifecycle glue owned by the PR-C cut).

  // GET /api/v1/repo
  if (req.method === "GET" && pathname === "/api/v1/repo") {
    await handleRepoStatusRequest(deps, res);
    return;
  }

  // GET /api/v1/repo/bundle
  if (req.method === "GET" && pathname === "/api/v1/repo/bundle") {
    await handleRepoBundleRequest(deps, res);
    return;
  }

  // POST /api/v1/repo/import
  if (req.method === "POST" && pathname === "/api/v1/repo/import") {
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
    return;
  }

  // ==================== Team Info ====================

  // GET /api/v1/team/status
  if (req.method === "GET" && pathname === "/api/v1/team/status") {
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
    });
    return;
  }

  // GET /api/v1/roles
  if (req.method === "GET" && pathname === "/api/v1/roles") {
    sendJson(res, 200, { roles: getActiveRoles(), defaultRole: getActiveDefaultRole() });
    return;
  }

  // GET /api/v1/profiles — list the available team profile packages
  // (Phase 2.1, design section 4: the switcher UI reads this list).
  if (req.method === "GET" && pathname === "/api/v1/profiles") {
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
    return;
  }

  // GET /api/v1/team/profile — active profile detail incl. capabilities
  // (design section 4: UI hides capability-gated entries based on this).
  if (req.method === "GET" && pathname === "/api/v1/team/profile") {
    const state = getTeamState();
    const profile = getActiveProfile();
    sendJson(res, 200, {
      profileId: state?.profileId ?? profile.id,
      profile,
      teamName: state?.teamName ?? config.teamName,
      transition: state?.transition ?? null,
    });
    return;
  }

  // POST /api/v1/team/profile { profileId } — six-step switch semantics
  // (Phase 2.1, design section 2.3). Returns 202; progress arrives via the
  // team.switch_started / team.switch_completed WS events.
  if (req.method === "POST" && pathname === "/api/v1/team/profile") {
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
    return;
  }

  // GET /api/v1/archived-teams — archived team metadata list
  // (Phase 2.1, design section 4: profileId/teamName/time/taskCount; detail
  // queries and the archive UI stay v1.1).
  if (req.method === "GET" && pathname === "/api/v1/archived-teams") {
    const archives = await listArchivedTeams();
    sendJson(res, 200, { archives });
    return;
  }

  // /api/v1/previews/:id/* — proxy to preview subprocess
  // PR-B of issue #204: the proxy implementation lives in ./preview-proxy.ts.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
    const previewPrefix = "/api/v1/previews/";
    if (pathname.startsWith(previewPrefix)) {
      handlePreviewProxyRequest(deps, req, res, requestUrl, pathname);
      return;
    }
  }

  // GET /api/v1/reports — list all delivery reports
  if (req.method === "GET" && pathname === "/api/v1/reports") {
    const state = deps.getTeamState();
    const reports = Object.values(state?.reports ?? {}).sort((a, b) => b.generatedAt - a.generatedAt);
    sendJson(res, 200, { reports });
    return;
  }

  // GET /api/v1/reports/:sessionKey — serve delivery report page
  if (req.method === "GET" && pathname.startsWith("/api/v1/reports/")) {
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
    return;
  }

  // GET /api/v1/health
  if (req.method === "GET" && pathname === "/api/v1/health") {
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
    return;
  }

  sendError(res, 404, "Not found");
}
