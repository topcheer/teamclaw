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
assert.match(mgr, /stdio: \["ignore", "ignore", "ignore"\]/, "connector stdio detached (no pipe leaks)");
assert.match(http, /__tunnel_gate\/verify/, "gate verify endpoint exists");
assert.match(http, /Set-Cookie/, "verify sets the gate cookie");
assert.match(http, /viaTunnel/, "requests are classified by arrival host");
assert.match(worker, /rateLimited\(req, 10, 3600_000\)/, "create is per-IP rate limited");
assert.match(worker, /rateLimited\(req, 20, 3600_000\)/, "delete is per-IP rate limited");
assert.match(worker, /tunnelLive/, "live-connector guard protects shares from unauthenticated disruption");
assert.match(worker, /delete_token: deleteToken/, "create issues an HMAC delete token");
assert.match(http, /\/api\/v1\/tunnel\/start/, "start endpoint present");
assert.match(http, /\/api\/v1\/tunnel\/stop/, "stop endpoint present");
assert.match(http, /GitHub login required/, "sharing requires github login (server-derived username)");

// UI: panel with share/stop + token display.
assert.match(uiHtml, /tunnel-panel/, "workspace tab hosts the tunnel panel");
assert.match(uiApp, /initTunnelPanel/, "panel logic initialized");
assert.match(uiApp, /Gate token/, "gate token displayed for sharing");

console.log("test-tunnel-contracts: ok");
