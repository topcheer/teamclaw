import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { PluginLogger } from "../../api.js";

/**
 * Internet tunnel sharing for the local web UI.
 *
 * Flow: the controller asks the TeamClaw tunnel server (a Cloudflare Worker
 * at apps.teamclaw.dev/api) to provision a per-user Cloudflare Tunnel, then
 * runs `cloudflared` locally with the returned connector token. Visitors hit
 * https://<github_user>.apps.teamclaw.dev and must enter the gate token that
 * the local web UI displays (enforced by the controller's gate middleware).
 */

export const TUNNEL_SERVER_URL = "https://apps.teamclaw.dev/api";
const TUNNEL_HOST_SUFFIX = ".apps.teamclaw.dev";
const GATE_COOKIE = "tc_tunnel_gate";

export type TunnelStatus = {
  active: boolean;
  hostname: string | null;
  gateToken: string | null;
  connectorRunning: boolean;
  error: string | null;
};

export type TunnelHandle = {
  tunnelId: string;
  hostname: string;
  gateToken: string;
};

const CLOUDFLARED_CANDIDATES = [
  "cloudflared",
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
];

function findCloudflared(): string | null {
  for (const bin of CLOUDFLARED_CANDIDATES) {
    try {
      if (fs.existsSync(bin) && fs.accessSync(bin, fs.constants.X_OK) === undefined) {
        return bin;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function gateCookieValue(gateToken: string, tunnelId: string): string {
  return createHash("sha256").update(`${gateToken}:${tunnelId}`).digest("hex").slice(0, 32);
}

export function createTunnelManager(deps: { logger: PluginLogger; localPort: number }) {
  const { logger } = deps;
  let child: ChildProcess | null = null;
  let handle: TunnelHandle | null = null;
  let lastError: string | null = null;

  function isTunnelRequest(hostHeader: string | undefined): boolean {
    return Boolean(hostHeader && hostHeader.toLowerCase().endsWith(TUNNEL_HOST_SUFFIX));
  }

  function gateAllows(req: { headers: Record<string, unknown> }): boolean {
    if (!handle) return false;
    const cookie = String(req.headers.cookie ?? "");
    const match = cookie.match(new RegExp(`${GATE_COOKIE}=([0-9a-f]+)`));
    return Boolean(match && match[1] === gateCookieValue(handle.gateToken, handle.tunnelId));
  }

  async function start(githubUser: string): Promise<TunnelHandle> {
    if (handle && child) return handle;
    const bin = findCloudflared();
    if (!bin) throw new Error("cloudflared not found (brew install cloudflared)");
    const gateToken = randomBytes(6).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toUpperCase();
    const res = await fetch(`${TUNNEL_SERVER_URL}/tunnels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ github_user: githubUser, local_port: deps.localPort }),
    });
    const body = (await res.json().catch(() => ({}))) as { tunnel_id?: string; connector_token?: string; hostname?: string; error?: string };
    if (!res.ok || !body.tunnel_id || !body.connector_token || !body.hostname) {
      throw new Error(body.error ?? `tunnel server responded ${res.status}`);
    }
    stopConnector();
    child = spawn(bin, ["tunnel", "--no-autoupdate", "run", "--token", body.connector_token], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    child.on("exit", (code: number | null) => {
      logger.warn(`TeamClaw tunnel: cloudflared exited (code ${code})`);
      child = null;
    });
    handle = { tunnelId: body.tunnel_id, hostname: body.hostname, gateToken };
    lastError = null;
    logger.info(`TeamClaw tunnel: serving https://${body.hostname}`);
    return handle;
  }

  function stopConnector(): void {
    if (child) {
      child.kill("SIGTERM");
      child = null;
    }
  }

  async function stop(): Promise<void> {
    stopConnector();
    if (handle) {
      const gone = handle;
      handle = null;
      await fetch(`${TUNNEL_SERVER_URL}/tunnels/${gone.tunnelId}?user=${encodeURIComponent(gone.hostname.split(".")[0]!)}`, {
        method: "DELETE",
      }).catch(() => undefined);
      logger.info(`TeamClaw tunnel: stopped ${gone.hostname}`);
    }
  }

  function status(): TunnelStatus {
    return {
      active: Boolean(handle),
      hostname: handle?.hostname ?? null,
      gateToken: handle?.gateToken ?? null,
      connectorRunning: Boolean(child),
      error: lastError,
    };
  }

  return { start, stop, status, isTunnelRequest, gateAllows };
}

export type TunnelManager = ReturnType<typeof createTunnelManager>;

export function gatePageHtml(hostname: string, wrong: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TeamClaw Tunnel</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#121110;color:#ecebe6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a1917;border:1px solid #2d2b27;border-radius:12px;padding:32px;width:min(360px,90vw);text-align:center}
h1{font-size:16px;margin:0 0 6px}p{font-size:12.5px;color:#a8a49a;margin:0 0 18px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #3a3731;background:#232120;color:#ecebe6;font-size:16px;letter-spacing:.2em;text-align:center;text-transform:uppercase;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:10px;border:none;border-radius:8px;background:#d9a664;color:#1a1510;font-weight:600;font-size:14px;cursor:pointer}
.err{color:#c96f5e;font-size:12px;margin-top:10px}</style></head>
<body><div class="card"><h1>TeamClaw</h1><p>${hostname} is protected by a gate token. Ask the owner for it.</p>
<form method="POST" action="/__tunnel_gate/verify"><input name="token" placeholder="GATE TOKEN" autofocus autocomplete="off"><button type="submit">Enter</button>${wrong ? '<div class="err">Wrong token, try again.</div>' : ""}</form></div></body></html>`;
}

export const GATE_COOKIE_NAME = GATE_COOKIE;
export function computeGateCookie(gateToken: string, tunnelId: string): string {
  return gateCookieValue(gateToken, tunnelId);
}
