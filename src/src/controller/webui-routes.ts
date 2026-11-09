// Issue #226 W2 (route-table carve-up): the Web UI static-serving handlers
// moved verbatim from route-table.ts (PR-D had moved them verbatim from
// http-server.ts before that) - bodies byte-identical, only the module home
// changed. route-table.ts keeps the table entries that bind these handlers.
// Like security.ts, this module imports route-table.js as TYPE ONLY
// (RouteContext), so the module graph stays acyclic.
import path from "node:path";
import type { RouteContext } from "./route-table.js";
import { serveStaticFile, serveVersionedHtml } from "./ui-assets.js";

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

export {
  webUiRootRoute,
  webUiIndexRoute,
  webUiGithubLoginPageRoute,
  webUiAssetsRoute,
};
