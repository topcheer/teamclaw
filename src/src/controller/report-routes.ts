// Issue #226 W2 (route-table carve-up): the delivery-report / health route
// handlers moved verbatim from route-table.ts (PR-D had moved them verbatim
// from http-server.ts before that) - bodies byte-identical, only the module
// home changed. route-table.ts keeps the table entries that bind these
// handlers. Like security.ts, this module imports route-table.js as TYPE
// ONLY (RouteContext), so the module graph stays acyclic.
import { sendJson, sendError } from "../protocol.js";
import { getTeamClawModelReadiness } from "../openclaw-workspace.js";
import { generateDeliveryReport, renderReportHtml } from "./delivery-report.js";
import { normalizeControllerIntakeSessionKey } from "./task-execution.js";
import { getEffectiveStartupReadiness } from "./worker-routes.js";
import type { RouteContext } from "./route-table.js";

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

export {
  reportsListRoute,
  reportsSessionRoute,
  healthRoute,
};
