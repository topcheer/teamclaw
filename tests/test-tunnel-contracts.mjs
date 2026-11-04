#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFile(path.join(root, rel), "utf8");
const [worker, mgr, http, uiHtml, uiApp] = await Promise.all([
  read("deploy/tunnel-server/src/index.ts"),
  read("src/src/controller/tunnel-manager.ts"),
  read("src/src/controller/http-server.ts"),
  read("src/src/ui/index.html"),
  read("src/src/ui/app.js"),
]);

// Worker: least privilege + guardrails; connector token only in the create response.
assert.match(worker, /MAX_TUNNELS_PER_USER = 1/, "one live tunnel per user (replace semantics)");
assert.match(worker, /GLOBAL_WATERMARK = 800/, "global watermark protects the 1000-tunnel account limit");
assert.match(worker, /config_src: "cloudflare"/, "remotely-managed tunnels (zero local config)");
assert.match(worker, /"\/api\/tunnels"/, "create endpoint present");
assert.doesNotMatch(worker, /console\.log/, "no logging in the worker (token hygiene)");

// Controller: gate everything on the tunnel host; management endpoints local-only.
assert.match(mgr, /isTunnelRequest/, "manager exposes host detection");
assert.match(mgr, /gateAllows/, "manager validates the gate cookie");
assert.match(mgr, /cloudflared/, "manager spawns cloudflared");
assert.match(mgr, /stdio: \["ignore", "ignore", "pipe"\]/, "connector pipes stderr only (stdout unused by cloudflared)");
assert.match(mgr, /proc\.stderr\?\.pipe/, "connector stderr is consumed (piped to cloudflared.log, no leak)");
assert.match(mgr, /proc\.stdout\?\.on\("data"/, "install progress consumes spawn stdout");
assert.match(http, /__tunnel_gate\/verify/, "gate verify endpoint exists");
assert.match(http, /Set-Cookie/, "verify sets the gate cookie");
assert.match(http, /viaTunnel/, "requests are classified by arrival host");
assert.match(worker, /rateLimited\(req, 10, 3600_000\)/, "create is per-IP rate limited");
assert.match(worker, /rateLimited\(req, 20, 3600_000\)/, "delete is per-IP rate limited");
assert.match(worker, /tunnelLive/, "live-connector guard protects shares from unauthenticated disruption");
assert.match(worker, /delete_token: deleteToken/, "create issues an HMAC delete token");
assert.match(mgr, /tunnels\/\$\{gone\.tunnelId\}\?user=[^`]*&token=/, "stop() presents the delete token to the tunnel server");
assert.match(mgr, /tunnel-state\.json/, "tunnel handle (connector token + pid) persisted for boot recovery");
assert.match(mgr, /async function recover/, "manager implements boot recovery (reconnect same tunnel, preserve gate token)");
assert.match(mgr, /connectorPidIsCloudflared/, "orphan reaping is pid-reuse safe (binary verified before kill)");

// Container install path (2026-11-04 audit, ghcr.io/openclaw/openclaw base):
// linux releases have NO .tgz asset (the old URL 404s) and the ~/.local/bin
// install target was invisible to detection (existsSync("cloudflared") is a
// CWD check, not a PATH lookup).
assert.match(mgr, /cloudflaredInstallTarget\(\)/, "detection checks the install target ($HOME/.local/bin/cloudflared)");
assert.match(mgr, /path\.delimiter/, "detection scans PATH entries (real PATH lookup, not CWD)");
assert.match(mgr, /cloudflared-linux-" \+ arch/, "linux install downloads the RAW binary asset");
assert.doesNotMatch(mgr, /cloudflared-linux-" \+ arch \+ "\.tgz"/, "linux has no .tgz release asset (404)");
assert.match(mgr, /nativeDownload/, "curl-less https download fallback exists (distroless images)");
assert.match(http, /tunnelManagerSingleton\.recover\(\)/, "controller reconnects a persisted share at boot");
assert.match(http, /\/api\/v1\/tunnel\/start/, "start endpoint present");
assert.match(http, /serveVersionedHtml/, "index.html is served with content-versioned asset URLs (?v=<hash>) so tunnel/CDN browser-cache freezes cannot pin a stale app.js");
assert.match(http, /\/api\/v1\/tunnel\/stop/, "stop endpoint present");
assert.match(http, /GitHub login required/, "sharing requires github login (server-derived username)");

const tunnelManagerSrc = await read("src/src/controller/tunnel-manager.ts");

// UI: settings popover (header-triggered) + managed-URL pill; the panel no
// longer lives in the workspace tab (moved out 2026-11 by request).
assert.match(uiHtml, /tunnel-settings-toggle/, "header hosts the Tunnel settings button");
assert.match(uiHtml, /tunnel-popover/, "tunnel settings live in a popover");
assert.doesNotMatch(uiHtml, /id="tunnel-panel"/, "workspace tab no longer hosts the tunnel panel");
assert.match(uiHtml, /tunnel-live-pill/, "header hosts the live managed tunnel URL pill");
assert.match(uiApp, /initTunnelPanel/, "panel logic initialized");
assert.match(uiApp, /st\.mode === "managed"/, "pill shows managed (*.teamclaw.dev) URLs only");
assert.match(uiApp, /Gate token/, "gate token displayed for sharing");
// Unexpected connector exits must clear active state (dead tunnel never
// reports live) - regression guard for the "UI stuck on live after stop".
assert.match(tunnelManagerSrc, /exited unexpectedly/, "unexpected connector exit clears active state");
assert.match(tunnelManagerSrc, /userStopping/, "planned stops are distinguished from crashes");
// Quick anonymous tunnel (trycloudflare.com).
assert.match(tunnelManagerSrc, /startQuick/, "anonymous quick tunnel supported");
assert.match(tunnelManagerSrc, /trycloudflare\.com/, "quick tunnel announces trycloudflare.com URL");
assert.match(uiApp, /start-quick/, "quick tunnel button in the settings popover");

console.log("test-tunnel-contracts: ok");
