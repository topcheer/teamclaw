// PR-B of issue #204 (http-server monolith split): the TeamAuto route
// handlers extracted verbatim from controller/http-server.ts. Zero behavior
// change - the route shells in http-server keep the method+pathname matches
// and call these functions with the same deps object as before. This module
// must NEVER import http-server (the reverse edge exists:
// http-server -> teamauto-routes); the scheduler and the GitHub auth manager
// arrive through the deps slice and direct peer imports below.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type { PluginConfig } from "../types.js";
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { getGithubAuthManager } from "./github-auth.js";
import { createGithubClient } from "../teamauto/github-client.js";
import type { TeamAutoScheduler } from "../teamauto/scheduler.js";

/**
 * Structural slice of ControllerHttpDeps (http-server.ts) covering exactly
 * the fields the TeamAuto route handlers read. http-server keeps passing its
 * full ControllerHttpDeps object; TypeScript structural typing accepts it,
 * so no call site changes beyond the import path.
 */
export type TeamAutoRouteDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  /** Late-bound TeamAuto scheduler (autonomous repo collaboration). */
  getTeamAutoScheduler?: () => TeamAutoScheduler | null;
};

export async function handleTeamAutoActivityRequest(deps: TeamAutoRouteDeps, res: ServerResponse): Promise<void> {
  const teamAuto = deps.getTeamAutoScheduler?.() ?? null;
  if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
  try {
    const activity = await teamAuto.getActivity();
    sendJson(res, 200, { activity });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to load activity");
  }
}

export async function handleTeamAutoReposListRequest(deps: TeamAutoRouteDeps, res: ServerResponse): Promise<void> {
  const teamAuto = deps.getTeamAutoScheduler?.() ?? null;
  if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
  try {
    sendJson(res, 200, await teamAuto.getStatus());
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to read TeamAuto status");
  }
}

// Selectable repos for the bind picker (the logged-in GitHub account's).
export async function handleTeamAutoRepoCandidatesRequest(deps: TeamAutoRouteDeps, res: ServerResponse): Promise<void> {
  try {
    const auth = getGithubAuthManager(deps.config, deps.logger);
    const candidates = await createGithubClient(auth).listUserRepos();
    sendJson(res, 200, { candidates });
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to list repositories");
  }
}

export async function handleTeamAutoRepoBindRequest(deps: TeamAutoRouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const teamAuto = deps.getTeamAutoScheduler?.() ?? null;
  if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return; }
  let body: Record<string, unknown> = {};
  try { body = await parseJsonBody(req); } catch { /* empty body */ }
  const repo = typeof body.repo === "string" ? body.repo : "";
  if (!repo) { sendError(res, 400, "repo (owner/name) is required"); return; }
  try {
    const created = await teamAuto.addRepo(repo, {
      schedule: typeof body.schedule === "string" ? body.schedule : undefined,
      keywordInclude: Array.isArray(body.keywordInclude) ? body.keywordInclude.filter((k): k is string => typeof k === "string") : undefined,
      keywordExclude: Array.isArray(body.keywordExclude) ? body.keywordExclude.filter((k): k is string => typeof k === "string") : undefined,
    });
    sendJson(res, 201, created);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to bind repo");
  }
}

/**
 * Per-repo actions under /api/v1/teamauto/repos/:id (DELETE unbind / PATCH
 * update / POST :id/sweep). Returns false when the method does not match any
 * action, leaving the request to fall through to the dispatcher's 404 exactly
 * as the inline block did.
 */
export async function handleTeamAutoRepoItemRequest(
  deps: TeamAutoRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const teamAuto = deps.getTeamAutoScheduler?.() ?? null;
  if (!teamAuto) { sendError(res, 503, "TeamAuto scheduler is not running"); return true; }
  const repoId = decodeURIComponent(pathname.slice("/api/v1/teamauto/repos/".length).replace(/\/sweep$/, ""));
  const isSweep = pathname.endsWith("/sweep");
  if (req.method === "DELETE" && !isSweep) {
    try { await teamAuto.removeRepo(repoId); sendJson(res, 200, { ok: true }); }
    catch (err) { sendError(res, 400, err instanceof Error ? err.message : "failed to unbind"); }
    return true;
  }
  if (req.method === "PATCH" && !isSweep) {
    let body: Record<string, unknown> = {};
    try { body = await parseJsonBody(req); } catch { /* empty */ }
    try {
      // #269 (user report): the enabled flag used to be silently dropped
      // here - the web UI's disable toggle returned 200 but never reached
      // setRepoEnabled, so sweeps kept running. Wire it explicitly; the
      // enable/disable path has different persistence semantics (pausedReason
      // + timer reschedule) than the plain field patch below.
      if (typeof body.enabled === "boolean" && Object.keys(body).every((k) => k === "enabled")) {
        await teamAuto.setRepoEnabled(repoId, body.enabled);
        const status = await teamAuto.getStatus();
        const repo = (status?.repos ?? []).find((r: { id: string }) => r.id === repoId);
        sendJson(res, 200, repo ?? { ok: true });
        return true;
      }
      const updated = await teamAuto.updateRepo(repoId, {
        schedule: typeof body.schedule === "string" ? body.schedule : undefined,
        maxTasksPerSweep: typeof body.maxTasksPerSweep === "number" ? body.maxTasksPerSweep : undefined,
        fullReview: body.fullReview === "off" || body.fullReview === "weekly" || body.fullReview === "daily" ? body.fullReview : undefined,
        takeOwnership: typeof body.takeOwnership === "boolean" ? body.takeOwnership : undefined,
      });
      sendJson(res, 200, updated);
    } catch (err) { sendError(res, 400, err instanceof Error ? err.message : "failed to update"); }
    return true;
  }
  if (req.method === "POST" && isSweep) {
    try { sendJson(res, 200, { summary: await teamAuto.runSweepNow(repoId, true) }); }
    catch (err) { sendError(res, 400, err instanceof Error ? err.message : "sweep failed"); }
    return true;
  }
  return false;
}
