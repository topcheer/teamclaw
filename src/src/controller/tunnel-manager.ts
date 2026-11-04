import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
];
function cloudflaredInstallTarget(): string {
  // Keep in sync with installCloudflared(): the one-click install drops the
  // binary at $HOME/.local/bin/cloudflared (no sudo needed, non-root friendly
  // in containers where HOME is writable but /usr/local/bin is not).
  const home = process.env.HOME ?? "/tmp";
  return path.join(home, ".local", "bin", "cloudflared");
}
// curl-less download fallback (distroless images): plain https.get with
// redirect following. GitHub release URLs 302 to objects.githubusercontent.com.
function nativeDownload(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const req = https.get(url, (res: import("node:http").IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        nativeDownload(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve())));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}
function tunnelRuntimeHome(): string {
  try {
    const dir = path.join(os.tmpdir(), "teamclaw-cloudflared-home");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return process.env.HOME ?? "/tmp";
  }
}

export interface PersistedTunnelState {
  tunnelId: string;
  hostname: string;
  gateToken: string;
  deleteToken: string;
  connectorToken: string;
  pid: number | null;
  savedAt: number;
}

function tunnelStatePath(): string {
  return path.join(tunnelRuntimeHome(), "tunnel-state.json");
}

function readTunnelState(): PersistedTunnelState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(tunnelStatePath(), "utf8")) as PersistedTunnelState;
    return raw && raw.tunnelId && raw.connectorToken ? raw : null;
  } catch {
    return null;
  }
}

function writeTunnelState(st: PersistedTunnelState): void {
  try {
    fs.writeFileSync(tunnelStatePath(), JSON.stringify(st), { mode: 0o600 });
  } catch { /* best effort */ }
}

function clearTunnelState(): void {
  try { fs.rmSync(tunnelStatePath(), { force: true }); } catch { /* best effort */ }
}

// pid-reuse-safe liveness: only treat the pid as OUR orphan when the binary
// still matches cloudflared.
function connectorPidIsCloudflared(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.includes("cloudflared");
  } catch {
    return false;
  }
}

function findCloudflared(): string | null {
  // The install target first: installCloudflared() puts the binary in
  // $HOME/.local/bin, which is on PATH in stock images (Debian node images
  // prepend it) but must be found even when PATH is minimal (K8s pods).
  const candidates = [cloudflaredInstallTarget(), ...CLOUDFLARED_CANDIDATES];
  // Real PATH scan. (fs.existsSync("cloudflared") checks CWD, not PATH -
  // the old behavior missed every PATH-resolvable install.)
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) candidates.push(path.join(dir, "cloudflared"));
  for (const bin of candidates) {
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
    child = spawnConnector(bin, body.connector_token);
    handle = { tunnelId: body.tunnel_id, hostname: body.hostname, gateToken, deleteToken: body.delete_token ?? "" };
    writeTunnelState({ tunnelId: body.tunnel_id, hostname: body.hostname, gateToken, deleteToken: body.delete_token ?? "", connectorToken: body.connector_token, pid: child.pid ?? null, savedAt: Date.now() });
    lastError = null;
    logger.info(`TeamClaw tunnel: serving https://${body.hostname}`);
    return handle;
  }

  function spawnConnector(bin: string, connectorToken: string): ChildProcess {
    const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run", "--token", connectorToken], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
      // Isolate from ~/.cloudflared/cert.pem (a local origin-cert would
      // override the remotely-managed token config) and from QUIC-blocking
      // networks (http2 rides regular TCP 443).
      env: { ...process.env, HOME: tunnelRuntimeHome() },
    });
    proc.on("exit", (code: number | null) => {
      logger.warn(`TeamClaw tunnel: cloudflared exited (code ${code})`);
      if (child === proc) child = null;
    });
    // cloudflared logs (stderr) land in a single file for diagnosis.
    // (stdout is "ignore" in stdio above, so there is nothing to pipe.)
    const logPath = path.join(tunnelRuntimeHome(), "cloudflared.log");
    proc.stderr?.pipe(fs.createWriteStream(logPath, { flags: "a" }));
    return proc;
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
      clearTunnelState();
      logger.info(`TeamClaw tunnel: stopped ${gone.hostname}`);
    }
  }

  // Boot reconciliation: reconnect the share persisted by a previous run.
  // Reuses the SAME remotely-managed tunnel (its connector token), so the
  // tunnel id and gate token survive gateway restarts and visitor gate
  // cookies stay valid.
  async function recover(): Promise<TunnelHandle | null> {
    if (handle) return handle;
    const st = readTunnelState();
    if (!st) return null;
    const bin = findCloudflared();
    if (!bin) {
      logger.warn("TeamClaw tunnel: previous share found but cloudflared is not installed; not recovering");
      return null;
    }
    // kill -9 of the gateway leaves an orphaned connector behind (SIGKILL
    // cannot run the close handler). Reap it before reconnecting - pid-reuse
    // safe: only when the binary still matches.
    if (st.pid && connectorPidIsCloudflared(st.pid)) {
      try {
        process.kill(st.pid, "SIGKILL");
        logger.warn(`TeamClaw tunnel: killed orphaned connector (pid ${st.pid})`);
      } catch { /* already gone */ }
    }
    startOp = { running: true, phase: "starting-connector", detail: st.hostname };
    stopConnector();
    child = spawnConnector(bin, st.connectorToken);
    handle = { tunnelId: st.tunnelId, hostname: st.hostname, gateToken: st.gateToken, deleteToken: st.deleteToken };
    writeTunnelState({ ...st, pid: child.pid ?? null, savedAt: Date.now() });
    startOp = { running: false, phase: "done", detail: st.hostname };
    lastError = null;
    logger.info(`TeamClaw tunnel: recovered https://${st.hostname} (tunnel id and gate token preserved)`);
    return handle;
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
   *   linux   -> official RAW binary into ~/.local/bin (no sudo needed;
   *              cloudflared ships NO .tgz asset for linux - only darwin
   *              has tgz packages, and the binary is statically linked so
   *              it runs on any distro without glibc concerns)
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
      const isDarwin = process.platform === "darwin";
      // Linux assets are RAW binaries (no .tgz exists for linux - verified
      // against the official release page; the old .tgz URL 404s there).
      const name = isDarwin ? "cloudflared-darwin-" + arch + ".tgz" : "cloudflared-linux-" + arch;
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
      const watch = (file: string) => {
        const timer = setInterval(() => {
          try {
            const size = fs.statSync(file).size;
            if (total > 0) setPhase("downloading", Math.min(99, Math.floor((size / total) * 100)), null);
          } catch { /* file not created yet */ }
        }, 500);
        return () => clearInterval(timer);
      };
      // curl first (resume/retry flags), native https fallback for images
      // without curl (distroless etc.). GitHub releases redirect - follow them.
      const dlPath = isDarwin ? tgz : target;
      const stopWatch = watch(dlPath);
      const dl = await run("curl", ["-fsSL", "--retry", "3", "-o", dlPath, url]);
      stopWatch();
      if (dl.code !== 0) {
        setPhase("downloading", null, "native https fallback");
        try {
          await nativeDownload(url, dlPath);
        } catch (e) {
          return { ok: false, detail: "download: " + (e instanceof Error ? e.message : String(e)) };
        }
      }
      if (isDarwin) {
        setPhase("extracting", 99, null);
        const ex = await run("tar", ["xzf", tgz, "-C", userBin]);
        fs.rmSync(tgz, { force: true });
        if (ex.code !== 0) return { ok: false, detail: "extract: " + tail(ex.out) };
      }
      fs.chmodSync(target, 0o755);
      return { ok: true, detail: "installed to " + target };
    })();

    job.then(
      (r) => finish(r.ok ? "done" : "error", r.detail),
      (e) => finish("error", String(e)),
    );
    return job;
  }


  return { start: launchStart, stop, recover, status, installCloudflared, isTunnelRequest, gateAllows };
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
