// Issue #226 W2 (route-table carve-up): the tunnel-side route tables (the
// pre-PR-D http-server.ts outer callback's tunnel branch, moved into
// route-table.ts verbatim by PR-D) moved verbatim into this module -
// bodies byte-identical, only the module home changed. route-table.ts
// re-exports both factories so http-server.ts's imports are unchanged.
// The tunnel gate-page HTML rendering (gatePageHtml calls below) and the
// form reader live here with their only consumers. This module imports
// http-server.js as TYPE ONLY (ControllerHttpDeps), so the module graph
// stays acyclic - same discipline as security.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendError } from "../protocol.js";
import { getGithubAuthManager } from "./github-auth.js";
import { gatePageHtml, computeGateCookie, GATE_COOKIE_NAME, selfHostedTokenFromEnv, type TunnelManager } from "./tunnel-manager.js";
import { isLanIp, isProtectionOn } from "./security.js";
import type { ControllerHttpDeps } from "./http-server.js";
import type { RouteDef } from "./route-table.js";

async function readFormBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}


// ===========================================================================
// Tunnel-side route tables (pre-PR-D http-server.ts lines 348-432, the
// outer server callback's tunnel branch). These run BEFORE handleRequest
// and are split exactly along the old viaTunnel if/else:
//   - viaTunnel: the gate page routes answer; every other tunnel request
//     must pass the gate cookie (403 gate page), then continues to the
//     controller route table;
//   - direct (non-tunnel): the tunnel management API answers, everything
//     else continues to the controller route table.
// ===========================================================================

/** GET /__tunnel_gate + GET / + POST /__tunnel_gate/verify (via tunnel only). */
export function createTunnelGateRoutes(tunnelManager: TunnelManager): readonly RouteDef[] {
  return [
    {
      method: "GET",
      path: "/__tunnel_gate",
      handler: ({ res, req }) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
      },
    },
    {
      // Valid gate cookie on "/" goes straight to the dashboard; the gate
      // page only greets visitors who have not authenticated yet.
      method: "GET",
      path: "/",
      handler: ({ res, req, pathname }) => {
        if (pathname === "/" && tunnelManager.gateAllows(req)) {
          res.writeHead(302, { Location: "/ui/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gatePageHtml(String(req.headers.host), false));
      },
    },
    {
      method: "POST",
      path: "/__tunnel_gate/verify",
      handler: async ({ res, req }) => {
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
      },
    },
  ];
}

/** /api/v1/tunnel/* management API (direct requests only, never via tunnel). */
export function createTunnelManagementRoutes(tunnelManager: TunnelManager, deps: ControllerHttpDeps): readonly RouteDef[] {
  const { config, logger } = deps;

  // Issue #222 (coordinated scope): creating a public tunnel is an
  // internet-EXPOSURE escalation, so in L0 (protection off) the three start
  // endpoints accept only loopback/LAN origins - a public-network peer that
  // merely reached the port must never be able to open a share URL into
  // this controller. While protection is on, the device gate in
  // http-server.ts has already authenticated the caller (#23) and stays the
  // governing rule: a deliberately paired device may share, including
  // remotely. Loopback/LAN classification reuses the security module's
  // isLanIp (via-tunnel requests never reach this table - they dispatch to
  // the gate table instead - so the raw socket peer is authoritative).
  const tunnelStartAllowedFrom = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isProtectionOn(deps.getTeamState())) {
      return true;
    }
    if (isLanIp(req.socket.remoteAddress)) {
      return true;
    }
    sendJson(res, 403, {
      error: "forbidden",
      hint: "Creating a public tunnel exposes this controller to the internet. Start tunnels from the controller host (loopback or LAN), or enable device pairing (POST /api/v1/security/enable from the controller host) and share from a paired device.",
    });
    return false;
  };

  return [
    {
      method: "GET",
      path: "/api/v1/tunnel/status",
      handler: ({ res }) => {
        sendJson(res, 200, tunnelManager.status());
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/start",
      handler: async ({ req, res }) => {
        if (!tunnelStartAllowedFrom(req, res)) {
          return;
        }
        const authStatus = await getGithubAuthManager(config, logger).getStatus();
        const account = authStatus.account;
        if (!account?.login) { sendError(res, 401, "GitHub login required to share a tunnel"); return; }
        // Async launch: poll /tunnel/status for phase progress and the
        // resulting hostname/gateToken once startOp.phase === "done".
        const launched = tunnelManager.start(account.login);
        sendJson(res, 202, { launched, status: tunnelManager.status() });
      },
    },
    {
      // Self-hosted: user-owned Cloudflare tunnel via connector token (no
      // GitHub login, no platform tunnel server). Token from the request
      // body, or the TEAMCLAW_TUNNEL_TOKEN env injection when body is empty.
      method: "POST",
      path: "/api/v1/tunnel/start-self-hosted",
      handler: async ({ req, res }) => {
        if (!tunnelStartAllowedFrom(req, res)) {
          return;
        }
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
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/start-quick",
      handler: ({ req, res }) => {
        if (!tunnelStartAllowedFrom(req, res)) {
          return;
        }
        const r = tunnelManager.startQuick();
        if (!r.launched) { sendError(res, 400, r.error ?? "failed to start quick tunnel"); return; }
        sendJson(res, 202, { launched: true, status: tunnelManager.status() });
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/stop",
      handler: async ({ res }) => {
        await tunnelManager.stop();
        sendJson(res, 200, tunnelManager.status());
      },
    },
    {
      method: "POST",
      path: "/api/v1/tunnel/install-cloudflared",
      handler: async ({ res }) => {
        try {
          const result = await tunnelManager.installCloudflared();
          sendJson(res, result.ok ? 200 : 500, { ...result, status: tunnelManager.status() });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : "install failed");
        }
      },
    },
  ];
}
