import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { PluginLogger } from "../../api.js";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const TUNNEL_API_HOST = "apps.teamclaw.dev";
async function tunnelFetch(pathq: string, method: "POST" | "DELETE", body?: unknown): Promise<{ status: number; json: any }> {
  const ip = await new Promise<string>((resolve, reject) => {
    const r = https.request({ host: "1.1.1.1", path: `/dns-query?name=${TUNNEL_API_HOST}&type=A`, method: "GET", headers: { accept: "application/dns-json" }, servername: "cloudflare-dns.com" } as never, (res: import("node:http").IncomingMessage) => {
      let d = ""; res.on("data", (c: Buffer) => (d += c)); res.on("end", () => {
        try { const rec = (JSON.parse(d).Answer || []).map((x: { data: string }) => x.data).find((x: string) => /^\d+\./.test(x)); rec ? resolve(rec) : reject(new Error("DoH no A record")); } catch (e) { reject(e); }
      });
    });
    r.on("error", reject); r.end();
  });
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({ host: ip, servername: TUNNEL_API_HOST, path: `/api${pathq}`, method, headers: { host: TUNNEL_API_HOST, "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } } as never, (res: import("node:http").IncomingMessage) => {
      let d = ""; res.on("data", (c: Buffer) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, json: d ? JSON.parse(d) : {} }); } catch { resolve({ status: res.statusCode ?? 0, json: {} }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}


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
const TUNNEL_HOST_SUFFIX = ".teamclaw.dev";
const GATE_COOKIE = "tc_tunnel_gate";

export type TunnelStatus = {
  active: boolean;
  hostname: string | null;
  gateToken: string | null;
  connectorRunning: boolean;
  tunnelId: string | null;
  cloudflaredInstalled: boolean;
  cloudflaredPath: string | null;
  startOp: { running: boolean; phase: string; detail: string | null };
  install: { running: boolean; phase: string; percent: number | null; detail: string | null };
  error: string | null;
};

export type TunnelHandle = {
  tunnelId: string;
  hostname: string;
  gateToken: string;
  // HMAC(tunnelId) issued by the tunnel server at create time; required to
  // delete a live tunnel (tunnel ids are public via the DNS CNAME).
  deleteToken: string;
};

const CLOUDFLARED_CANDIDATES = [
  "cloudflared",
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
];
function tunnelRuntimeHome(): string {
  try {
    const dir = path.join(os.tmpdir(), "teamclaw-cloudflared-home");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return process.env.HOME ?? "/tmp";
  }
}

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
  let startOp: { running: boolean; phase: string; detail: string | null } = { running: false, phase: "idle", detail: null };
  let installState: { running: boolean; phase: string; percent: number | null; detail: string | null } = { running: false, phase: "idle", percent: null, detail: null };

  function isTunnelRequest(hostHeader: string | undefined): boolean {
    return Boolean(hostHeader && hostHeader.toLowerCase().endsWith(TUNNEL_HOST_SUFFIX));
  }

  function gateAllows(req: { headers: Record<string, unknown> }): boolean {
    if (!handle) return false;
    const cookie = String(req.headers.cookie ?? "");
    const match = cookie.match(new RegExp(`${GATE_COOKIE}=([0-9a-f]+)`));
    return Boolean(match && match[1] === gateCookieValue(handle.gateToken, handle.tunnelId));
  }

  function launchStart(githubUser: string): { running: boolean; phase: string } {
    if (startOp.running) return { running: true, phase: startOp.phase };
    startOp = { running: true, phase: "creating-tunnel", detail: null };
    void (async () => {
      try {
        const h = await start(githubUser);
        startOp = { running: false, phase: "done", detail: h.hostname };
      } catch (e) {
        startOp = { running: false, phase: "error", detail: e instanceof Error ? e.message : String(e) };
      }
    })();
    return { running: true, phase: startOp.phase };
  }

  async function start(githubUser: string): Promise<TunnelHandle> {
    if (handle && child) return handle;
    const bin = findCloudflared();
    if (!bin) throw new Error("cloudflared not found (brew install cloudflared)");
    const gateToken = randomBytes(6).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toUpperCase();
    const res = await tunnelFetch("/tunnels", "POST", { github_user: githubUser, local_port: deps.localPort });
    const body = res.json as { tunnel_id?: string; connector_token?: string; hostname?: string; delete_token?: string; error?: string };
    if (res.status !== 201 || !body.tunnel_id || !body.connector_token || !body.hostname) {
      throw new Error(body.error ?? `tunnel server responded ${res.status}`);
    }
    startOp = { running: true, phase: "starting-connector", detail: body.hostname };
    stopConnector();
    child = spawn(bin, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run", "--token", body.connector_token], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
      // Isolate from ~/.cloudflared/cert.pem (a local origin-cert would
      // override the remotely-managed token config) and from QUIC-blocking
      // networks (http2 rides regular TCP 443).
      env: { ...process.env, HOME: tunnelRuntimeHome() },
    });
    child.on("exit", (code: number | null) => {
      logger.warn(`TeamClaw tunnel: cloudflared exited (code ${code})`);
      child = null;
    });
    // cloudflared logs land in a rotating-free single file for diagnosis.
    const logPath = path.join(tunnelRuntimeHome(), "cloudflared.log");
    const logFd = fs.openSync(logPath, "a");
    child.stderr?.pipe(fs.createWriteStream(logPath, { flags: "a" }));
    child.stdout?.pipe(fs.createWriteStream(logPath, { flags: "a" }));
    fs.closeSync(logFd);
    handle = { tunnelId: body.tunnel_id, hostname: body.hostname, gateToken, deleteToken: body.delete_token ?? "" };
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
      await tunnelFetch(`/tunnels/${gone.tunnelId}?user=${encodeURIComponent(gone.hostname.split(".")[0]!.replace(/^team-/, ""))}&token=${encodeURIComponent(gone.deleteToken)}`, "DELETE").catch(() => undefined);
      logger.info(`TeamClaw tunnel: stopped ${gone.hostname}`);
    }
  }

  function status(): TunnelStatus {
    return {
      active: Boolean(handle),
      tunnelId: handle?.tunnelId ?? null,
      hostname: handle?.hostname ?? null,
      gateToken: handle?.gateToken ?? null,
      connectorRunning: Boolean(child),
      cloudflaredInstalled: findCloudflared() !== null,
      cloudflaredPath: findCloudflared(),
      startOp: { ...startOp },
      install: { ...installState },
      error: lastError,
    };
  }

  /**
   * One-click cloudflared install across platforms:
   *   darwin  -> brew install cloudflared (Homebrew), tarball fallback
   *   linux   -> official tarball into ~/.local/bin (no sudo needed)
   *   win32   -> winget install Cloudflare.cloudflared
   */

  function installCloudflared(): Promise<{ ok: boolean; detail: string }> {
    if (installState.running) {
      return Promise.resolve({ ok: false, detail: "install already in progress" });
    }
    const home = process.env.HOME ?? "/tmp";
    const userBin = path.join(home, ".local", "bin");
    const target = path.join(userBin, "cloudflared");
    const tail = (s: string) => s.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    const setPhase = (phase: string, percent: number | null, detail: string | null) => {
      installState = { running: true, phase, percent, detail };
    };
    const finish = (phase: string, detail: string) => {
      installState = { running: false, phase, percent: phase === "done" ? 100 : null, detail };
    };
    const run = (cmd: string, args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        proc.stdout?.on("data", (c) => (out += c));
        proc.stderr?.on("data", (c) => (out += c));
        proc.on("error", (e) => resolve({ code: 1, out: String(e) }));
        proc.on("close", (code) => resolve({ code: code ?? 1, out }));
      });

    const job = (async (): Promise<{ ok: boolean; detail: string }> => {
      const plat = process.platform + ":" + process.arch;
      logger.info("TeamClaw tunnel: installing cloudflared for " + plat);
      setPhase("installing", null, plat);
      if (process.platform === "win32") {
        const w = await run("winget", ["install", "--id", "Cloudflare.cloudflared", "--accept-source-agreements", "--accept-package-agreements"]);
        return w.code === 0 ? { ok: true, detail: "installed via winget" } : { ok: false, detail: "winget: " + tail(w.out) };
      }
      if (process.platform === "darwin") {
        setPhase("brew", 30, "Homebrew");
        const brew = await run("brew", ["install", "cloudflared"]);
        if (brew.code === 0) return { ok: true, detail: "installed via Homebrew" };
      }
      const arch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "386" : "amd64";
      const name = process.platform === "darwin" ? "cloudflared-darwin-" + arch + ".tgz" : "cloudflared-linux-" + arch + ".tgz";
      fs.mkdirSync(userBin, { recursive: true });
      const tgz = path.join(userBin, name);
      const url = "https://github.com/cloudflare/cloudflared/releases/latest/download/" + name;
      let total = 0;
      try {
        const head = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
          const r = https.request(url, { method: "HEAD" } as never, resolve as never);
          r.on("error", reject); r.end();
        });
        total = Number(head.headers["content-length"] ?? 0);
      } catch { total = 0; }
      setPhase("downloading", 0, url);
      const timer = setInterval(() => {
        try {
          const size = fs.statSync(tgz).size;
          if (total > 0) setPhase("downloading", Math.min(99, Math.floor((size / total) * 100)), null);
        } catch { /* file not created yet */ }
      }, 500);
      const dl = await run("curl", ["-fsSL", "--retry", "3", "-o", tgz, url]);
      clearInterval(timer);
      if (dl.code !== 0) return { ok: false, detail: "download: " + tail(dl.out) };
      setPhase("extracting", 99, null);
      const ex = await run("tar", ["xzf", tgz, "-C", userBin]);
      fs.rmSync(tgz, { force: true });
      if (ex.code !== 0) return { ok: false, detail: "extract: " + tail(ex.out) };
      fs.chmodSync(target, 0o755);
      return { ok: true, detail: "installed to " + target };
    })();

    job.then(
      (r) => finish(r.ok ? "done" : "error", r.detail),
      (e) => finish("error", String(e)),
    );
    return job;
  }


  return { start: launchStart, stop, status, installCloudflared, isTunnelRequest, gateAllows };
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
