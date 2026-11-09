// Issue #226 W2 (route-table carve-up): the workspace browser + model-config
// route handlers (plus their private error-mapping helpers) moved verbatim
// from route-table.ts (PR-D had moved them verbatim from http-server.ts
// before that) - bodies byte-identical, only the module home changed.
// route-table.ts keeps the table entries that bind these handlers. Like
// security.ts, this module imports route-table.js as TYPE ONLY
// (RouteContext), so the module graph stays acyclic.
import fs from "node:fs";
import { parseJsonBody, sendJson, sendError, pinnedCorsAllowOrigin } from "../protocol.js";
import { listWorkspaceTree, listWorkspaceSubtree, readWorkspaceFile, readWorkspaceRawFile } from "../workspace-browser.js";
import {
  teamClawWorkspaceIsDefault,
  updateTeamClawWorkspaceDir,
  getTeamClawModelCatalog,
  updateTeamClawModelConfig,
  resolveTeamClawWorkspaceDir,
} from "../openclaw-workspace.js";
import { resolveSafeProjectDirectory } from "./task-cleanup.js";
import type { RouteContext } from "./route-table.js";

function workspaceRequestErrorStatus(err: unknown): number {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
    return 404;
  }
  return 400;
}

function workspaceRequestErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Workspace request failed";
}

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

export {
  workspaceStatusRoute,
  workspaceChangeDirRoute,
  modelsConfigGetRoute,
  modelsConfigPutRoute,
  workspaceTreeRoute,
  workspaceSubtreeRoute,
  workspaceFileRoute,
  workspaceProjectPathRoute,
  workspaceRawFileRoute,
};
