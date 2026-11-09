// PR-B of issue #204 (http-server monolith split): the git collaboration
// routes (GET /api/v1/repo status, GET /api/v1/repo/bundle export, POST
// /api/v1/repo/import) and the repo state refresh glue extracted verbatim
// from controller/http-server.ts. Zero behavior change. This module must
// NEVER import http-server (the reverse edge exists: http-server ->
// repo-routes). The import handler's stay in route-table.ts ended with W2
// of issue #226 (its recordTaskExecutionEvent dependency is task-lifecycle
// glue owned by the PR-C cut - task-execution.js does not import this
// module, so hosting it here is acyclic); it keeps its RouteContext shape
// and moved byte-identical.
import type { ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type { GitRepoState, PluginConfig, TeamState } from "../types.js";
import { sendJson, sendError, pinnedCorsAllowOrigin, readRequestBody } from "../protocol.js";
import { getActiveProfile, validateActiveRoleId } from "../profile-loader.js";
import { ensureControllerGitRepo, exportControllerGitBundle, importControllerGitBundle } from "../git-collaboration.js";
import { recordTaskExecutionEvent } from "./task-execution.js";
import type { RouteContext } from "./route-table.js";

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
      // Issue #23 security review follow-up: this response used to hardcode
      // the L0 wildcard, which silently WIDENED a CORS origin the security
      // gate had pinned while device protection is on. Honor the pinned
      // header via the shared protocol helper; unpinned (protection off /
      // non-browser) keeps the historical "*" byte for byte.
      "Access-Control-Allow-Origin": pinnedCorsAllowOrigin(res),
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(exported.data);
  } catch (err) {
    sendError(res, 503, err instanceof Error ? err.message : String(err));
  }
}

// POST /api/v1/repo/import - issue #226 W2: moved verbatim from route-table.ts
// (which had moved it verbatim from http-server.ts with PR-D). Keeps the
// RouteContext shape; route-table's table entry binds it directly.
export async function repoImportRoute(ctx: RouteContext): Promise<void> {
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
