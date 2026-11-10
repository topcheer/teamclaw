// Issue #226 W2 (route-table carve-up): the team status / roles / profiles /
// profile-switch / archived-teams / stats route handlers (plus their private
// helpers: team stats computation and the external-worker install command
// builder with its shell-escape and LAN-URL helpers) moved verbatim from
// route-table.ts (PR-D had moved them verbatim from http-server.ts before
// that) - bodies byte-identical, only the module home changed. route-table.ts
// keeps the table entries that bind these handlers. Like security.ts, this
// module imports route-table.js as TYPE ONLY (RouteContext), so the module
// graph stays acyclic.
import type { IncomingMessage } from "node:http";
import type { PluginConfig, TeamState } from "../types.js";
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { listArchivedTeams } from "../state.js";
import {
  BUILTIN_PROFILES,
  getActiveProfile,
  getActiveRoles,
  getActiveDefaultRole,
  hasProfile,
} from "../profile-loader.js";
import { getTeamClawModelReadiness } from "../openclaw-workspace.js";
import { resolvePreferredLanAddress } from "../networking.js";
import { serializeTask } from "./task-execution.js";
import { serializeControllerRun } from "./controller-runs.js";
import { reconcileControllerClarifications } from "./controller-intake.js";
import { getEffectiveStartupReadiness } from "./worker-routes.js";
import { buildTeamStatusSecurity } from "./security.js";
// PR-A of issue #204: the six-step switch state machine lives in
// ./profile-switch.ts; the POST endpoint below only runs step 1 (persist +
// announce) and hands off to startTeamProfileSwitch.
import { startTeamProfileSwitch } from "./profile-switch.js";
import type { RouteContext } from "./route-table.js";

type TeamStatsResponse = {
  totalWorkers: number;
  workersByStatus: { idle: number; busy: number; offline: number };
  totalTasks: number;
  tasksByStatus: Record<string, number>;
  averageTaskDuration: number | null;
  uptime: number;
};

// PR-D note: computeTeamStats used to be declared INSIDE handleRequest
// (between task-route shells); hoisted to module scope by PR-D, moved to
// this module by W2 - body unchanged, single call site unchanged.
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

const EXTERNAL_WORKER_INSTALL_SPEC = "@teamclaws/teamclaw";

function shellEscapeSingleQuotes(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
  const { config, logger, getTeamState, updateTeamState } = deps;
  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    // #251 L6: a malformed request body is a client error (400), not a
    // top-level 500 - parseJsonBody throws "Invalid JSON body: ...".
    sendError(res, 400, error instanceof Error ? error.message : "invalid JSON body");
    return;
  }
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
  // W4 (#226): mutation, awaited persistence and the switch_started
  // broadcast all ride the single write entry - the broadcast fires from
  // the save's fulfillment, so nothing is announced before the transition
  // is durable, and it never fires when the write fails.
  const previousProfileId = state.profileId;
  const { persisted } = updateTeamState((s) => {
    s.transition = { phase: "draining", targetProfileId: profileId, startedAt: Date.now() };
  }, {
    persist: "awaited",
    broadcast: [{ type: "team.switch_started", data: { profileId, previousProfileId } }],
  });
  try {
    await persisted;
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

export {
  teamStatsRoute,
  teamStatusRoute,
  teamRolesRoute,
  teamProfilesListRoute,
  teamProfileGetRoute,
  teamProfileSwitchRoute,
  archivedTeamsRoute,
};
