// PR-B of issue #204 (http-server monolith split): the git collaboration
// read-side routes (GET /api/v1/repo status, GET /api/v1/repo/bundle export)
// and the repo state refresh glue extracted verbatim from
// controller/http-server.ts. Zero behavior change - the route shells in
// http-server keep the method+pathname matches and call these functions with
// the same deps object as before. This module must NEVER import http-server
// (the reverse edge exists: http-server -> repo-routes); POST /repo/import
// stays in http-server for now because its recordTaskExecutionEvent
// dependency is task-lifecycle glue owned by the PR-C cut.
import type { ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type { GitRepoState, PluginConfig, TeamState } from "../types.js";
import { sendJson, sendError } from "../protocol.js";
import { getActiveProfile } from "../profile-loader.js";
import { ensureControllerGitRepo, exportControllerGitBundle } from "../git-collaboration.js";

/**
 * Structural slice of ControllerHttpDeps (http-server.ts) covering exactly
 * the fields the repo route handlers and the refresh glue read. http-server
 * keeps passing its full ControllerHttpDeps object; TypeScript structural
 * typing accepts it, so no call site changes beyond the import path.
 */
export type RepoRouteDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
};

export async function refreshControllerRepoState(deps: RepoRouteDeps): Promise<GitRepoState | null> {
  // Phase 2.3: the ACTIVE PROFILE's git switch outranks the legacy config
  // knob here - refreshing (or stamping) repo state for a profile that
  // declared git off would re-introduce exactly the repo field the switch
  // omitted for it (design 2.3: banking keeps no repo initialization). All
  // callers already treat null as "no repo" (same as config gitEnabled off).
  if (!deps.config.gitEnabled || !getActiveProfile().capabilities.git) {
    return null;
  }

  try {
    const repo = await ensureControllerGitRepo(deps.config, deps.logger);
    if (repo) {
      deps.updateTeamState((s) => {
        s.repo = repo;
      });
    }
    return repo;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn(`Controller: failed to refresh git repo state: ${message}`);
    deps.updateTeamState((s) => {
      if (s.repo?.enabled) {
        s.repo = {
          ...s.repo,
          error: message,
          lastPreparedAt: Date.now(),
        };
      }
    });
    return deps.getTeamState()?.repo ?? null;
  }
}

// GET /api/v1/repo
export async function handleRepoStatusRequest(deps: RepoRouteDeps, res: ServerResponse): Promise<void> {
  const repo = await refreshControllerRepoState(deps);
  if (!repo?.enabled) {
    sendJson(res, 200, { enabled: false });
    return;
  }

  sendJson(res, 200, { repo });
}

// GET /api/v1/repo/bundle
export async function handleRepoBundleRequest(deps: RepoRouteDeps, res: ServerResponse): Promise<void> {
  try {
    const exported = await exportControllerGitBundle(deps.config, deps.logger);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": exported.data.byteLength,
      "Content-Disposition": `attachment; filename="${exported.filename}"`,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(exported.data);
  } catch (err) {
    sendError(res, 503, err instanceof Error ? err.message : String(err));
  }
}
