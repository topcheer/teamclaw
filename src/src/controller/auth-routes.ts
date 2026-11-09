// Issue #226 W2 (route-table carve-up): the GitHub login/logout route
// handlers (plus their private HTML-rendering helpers) moved verbatim from
// route-table.ts (PR-D had moved them verbatim from http-server.ts before
// that) - bodies byte-identical, only the module home changed. route-table.ts
// keeps the table entries that bind these handlers. Like security.ts, this
// module imports route-table.js as TYPE ONLY (RouteContext), so the module
// graph stays acyclic.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "../types.js";
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { getGithubAuthManager } from "./github-auth.js";
import type { RouteContext } from "./route-table.js";

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

async function githubAuthStatusRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { config, logger } = deps;
  try {
    const status = await getGithubAuthManager(config, logger).getStatus(resolveRequestOrigin(req, config));
    sendJson(res, 200, status);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to read GitHub login status");
  }
}

async function githubAuthLoginRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { config, logger } = deps;
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
}

async function githubAuthCallbackRoute(ctx: RouteContext): Promise<void> {
  const { req, res, requestUrl, deps } = ctx;
  const { config, logger } = deps;
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
}

async function githubAuthLogoutRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const { config, logger } = deps;
  try {
    await getGithubAuthManager(config, logger).logout();
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "failed to sign out of GitHub");
  }
}

async function githubAuthRefreshRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const { config, logger } = deps;
  try {
    const store = await getGithubAuthManager(config, logger).forceRefresh();
    sendJson(res, 200, { ok: true, account: store.account, expiresAt: store.expiresAt });
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "failed to refresh the GitHub token");
  }
}

export {
  githubAuthStatusRoute,
  githubAuthLoginRoute,
  githubAuthCallbackRoute,
  githubAuthLogoutRoute,
  githubAuthRefreshRoute,
};
