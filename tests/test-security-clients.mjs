#!/usr/bin/env node
// Issue #23 client wave: device pairing across the three client surfaces
// plus the worker token injection - a mix of real-spawn CLI runs against
// stub servers (dist/exec level) and source-level assertions for the web UI
// and the desktop renderer (test-ui-contracts.mjs style; no Electron).
//
//   1. CLI (real `node src/cli.mjs` spawns against a stub controller):
//      - pair --code: one-shot code exchange, token stored at
//        plugins.entries.teamclaw.config.securityToken (same layer as
//        teamName) in the OpenClaw config
//      - pair with a WRONG code: non-zero exit, server error surfaced, no
//        token written
//      - pair WITHOUT --code: tries pair-auto first (LAN zero-input path)
//        and stores the returned token
//      - pair without --code against a 403 pair-auto: non-zero exit with the
//        "ask for a code / --code" hint
//      - token reset: loopback-style reset succeeds, prints the L0 message,
//        and clears a stale locally stored token; --token rides the
//        X-TeamClaw-Token header
//   2. Web UI source level: suggestion banner gating on the /team/status
//      `security.suggested` signal, enable wiring, pairing modal (one-shot
//      code + countdown + copyable `npx @teamclaws/teamclaw pair` command +
//      pair/start refresh), device management (GET /security list, DELETE
//      device with confirm, POST reset with confirm, self-revocation hint),
//      and the i18n keys in BOTH dictionaries.
//   3. Desktop renderer source level: the optional pairing-code field on the
//      remote connect path, the pair-before-connect wiring, securityToken
//      persistence in settings, and the X-TeamClaw-Token injection point
//      (all api wrappers + the WS ?token= upgrade).
//   4. Worker token injection (dist level): parsePluginConfig carries
//      securityToken; the worker tools and identity registration send
//      X-TeamClaw-Token to a stub controller when the token is configured
//      (and the source keeps the heartbeat/result fetches on the same
//      helper); config schema exposes the field but uiHints never echoes it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(projectRoot, "src", "cli.mjs");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ----------------------
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");
process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-security-clients-state-"));
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-security-clients-ws-"));

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// ===========================================================================
// Helpers: stub controller + CLI spawn
// ===========================================================================

function startSecurityStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      const outcome = handler(record) ?? { status: 404, body: { error: "not found" } };
      res.writeHead(outcome.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(outcome.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function readCliConfig(stateDir) {
  const configPath = path.join(stateDir, "openclaw.json");
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function teamclawConfigOf(config) {
  return config?.plugins?.entries?.teamclaw?.config ?? null;
}

const STUB_TOKEN = "f".repeat(64);

// ===========================================================================
// 1. CLI pair / token reset (real spawns against the stub controller)
// ===========================================================================
{
  // Each case gets its own state dir so config writes stay isolated.
  const stateDirs = Array.from({ length: 5 }, () => fs.mkdtempSync(path.join(os.tmpdir(), "tc-security-cli-")));

  // --- 1a. pair --code: success path --------------------------------------
  {
    const stub = await startSecurityStub(() => ({
      status: 201,
      body: { token: STUB_TOKEN, deviceId: "dev-cli-1", device: { id: "dev-cli-1", name: "CI Worker", kind: "worker", createdAt: Date.now() } },
    }));
    try {
      const result = await runCli(
        ["pair", stub.baseUrl, "--code", "abcd2345", "--kind", "worker", "--name", "CI Worker"],
        { OPENCLAW_STATE_DIR: stateDirs[0] },
      );
      assert.equal(result.code, 0, `pair --code must exit 0 (stderr: ${result.stderr})`);
      const pairRequest = stub.requests.find((r) => r.url === "/api/v1/security/pair");
      assert.ok(pairRequest, "CLI hit POST /api/v1/security/pair");
      assert.deepEqual(
        { code: pairRequest.body.code, kind: pairRequest.body.kind, name: pairRequest.body.name },
        { code: "ABCD2345", kind: "worker", name: "CI Worker" },
        "pair submits {code (uppercased), kind, name}",
      );
      const config = readCliConfig(stateDirs[0]);
      assert.equal(teamclawConfigOf(config)?.securityToken, STUB_TOKEN, "token stored at plugins.entries.teamclaw.config.securityToken (same layer as teamName)");
      assert.equal(teamclawConfigOf(config)?.controllerUrl, stub.baseUrl, "controller URL recorded for later worker calls");
      assert.match(result.stdout, /Paired with/, "success output names the controller");
      assert.doesNotMatch(result.stdout, new RegExp(STUB_TOKEN), "the CLI never echoes the token into stdout");
    } finally {
      await closeServer(stub.server);
    }
  }

  // --- 1b. pair --code with a WRONG code ----------------------------------
  {
    const stub = await startSecurityStub(() => ({
      status: 400,
      body: { error: "invalid pairing code", hint: "Ask the controller owner for the current code." },
    }));
    try {
      const result = await runCli(["pair", stub.baseUrl, "--code", "AAAAAAAA"], { OPENCLAW_STATE_DIR: stateDirs[1] });
      assert.notEqual(result.code, 0, "a rejected pairing must exit non-zero");
      assert.match(result.stderr, /invalid pairing code/, "the server error text is surfaced");
      assert.equal(teamclawConfigOf(readCliConfig(stateDirs[1])), null, "no config/token written on failure");
    } finally {
      await closeServer(stub.server);
    }
  }

  // --- 1c. pair WITHOUT --code: LAN zero-input pair-auto path --------------
  {
    const stub = await startSecurityStub(() => ({
      status: 201,
      body: { token: STUB_TOKEN, deviceId: "dev-auto-1", device: { id: "dev-auto-1", name: "auto", kind: "cli", createdAt: Date.now() } },
    }));
    try {
      const result = await runCli(["pair", stub.baseUrl], { OPENCLAW_STATE_DIR: stateDirs[2] });
      assert.equal(result.code, 0, `pair without --code exits 0 on a pair-auto success (stderr: ${result.stderr})`);
      const autoRequest = stub.requests.find((r) => r.url === "/api/v1/security/pair-auto");
      assert.ok(autoRequest, "CLI tried POST /api/v1/security/pair-auto first (zero-input LAN path)");
      assert.equal(autoRequest.body.kind, "cli", "default kind is cli");
      assert.equal(teamclawConfigOf(readCliConfig(stateDirs[2]))?.securityToken, STUB_TOKEN, "auto-paired token stored");
      assert.equal(stub.requests.some((r) => r.url === "/api/v1/security/pair"), false, "no code pairing attempt was needed");
    } finally {
      await closeServer(stub.server);
    }
  }

  // --- 1d. pair without --code against a refusing pair-auto ----------------
  {
    const stub = await startSecurityStub(() => ({
      status: 403,
      body: { error: "forbidden", hint: "Zero-input auto-pairing is limited to LAN peers; use a pairing code instead." },
    }));
    try {
      const result = await runCli(["pair", stub.baseUrl], { OPENCLAW_STATE_DIR: stateDirs[3] });
      assert.notEqual(result.code, 0, "refused auto-pairing must exit non-zero");
      assert.match(result.stderr, /--code/, "the hint tells the user to rerun with --code");
    } finally {
      await closeServer(stub.server);
    }
  }

  // --- 1e. token reset: loopback-style success + local token cleared -------
  {
    const stub = await startSecurityStub((r) => {
      if (r.url === "/api/v1/security/reset" && r.method === "POST") {
        return { status: 200, body: { ok: true, protection: false } };
      }
      return null;
    });
    try {
      // Pre-seed a stale token that the reset must clear.
      const configPath = path.join(stateDirs[4], "openclaw.json");
      fs.mkdirSync(stateDirs[4], { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        plugins: { entries: { teamclaw: { enabled: true, config: { teamName: "T", securityToken: "stale".repeat(8) } } } },
      }, null, 2));

      const result = await runCli(["token", "reset", stub.baseUrl], { OPENCLAW_STATE_DIR: stateDirs[4] });
      assert.equal(result.code, 0, `token reset exits 0 (stderr: ${result.stderr})`);
      const resetRequest = stub.requests.find((r) => r.url === "/api/v1/security/reset");
      assert.ok(resetRequest, "CLI hit POST /api/v1/security/reset");
      assert.equal(resetRequest.headers["x-teamclaw-token"], undefined, "loopback reset sends no token");
      assert.match(result.stdout, /local mode/, "output announces the return to local mode (L0)");
      const after = teamclawConfigOf(readCliConfig(stateDirs[4]));
      assert.equal(after.securityToken, undefined, "the stale local token was cleared");
      assert.equal(after.teamName, "T", "unrelated config keys survive the token cleanup");
    } finally {
      await closeServer(stub.server);
    }
  }

  // --- 1f. token reset --token rides the header (remote device path) ------
  {
    const stub = await startSecurityStub((r) => {
      if (r.url === "/api/v1/security/reset" && r.headers["x-teamclaw-token"] === STUB_TOKEN) {
        return { status: 200, body: { ok: true, protection: false } };
      }
      return { status: 401, body: { error: "unauthorized" } };
    });
    try {
      const result = await runCli(["token", "reset", stub.baseUrl, "--token", STUB_TOKEN], { OPENCLAW_STATE_DIR: stateDirs[4] });
      assert.equal(result.code, 0, `token reset --token exits 0 (stderr: ${result.stderr})`);
      assert.equal(stub.requests.some((r) => r.headers["x-teamclaw-token"] === STUB_TOKEN), true, "--token is sent as X-TeamClaw-Token");
    } finally {
      await closeServer(stub.server);
    }
  }
}

// ===========================================================================
// 2. Web UI source level (src/src/ui/app.js + index.html)
// ===========================================================================
{
  const appSource = fs.readFileSync(path.join(projectRoot, "src", "src", "ui", "app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(projectRoot, "src", "src", "ui", "index.html"), "utf8");

  // Banner: container + condition + enable wiring.
  assert.match(htmlSource, /id="security-suggest-banner"/, "index.html carries the suggestion banner container");
  assert.match(appSource, /securityStatus\.suggested && !securityStatus\.protection/, "banner renders only when protection is off AND the backend suggests it");
  assert.match(appSource, /securityStatus = statusRes\.security \|\| null/, "refreshAll captures the /team/status security object");
  assert.match(appSource, /apiPost\("\/security\/enable"/, "the Enable button POSTs /api/v1/security/enable (same-origin cookie auth)");

  // Pairing modal: one-shot code, countdown, copyable CLI command, new code.
  assert.match(htmlSource, /id="security-pair-modal"/, "pairing modal markup exists");
  assert.match(htmlSource, /id="security-pair-code"/, "big-font pairing code element exists");
  assert.match(htmlSource, /id="security-pair-countdown"/, "countdown element exists");
  assert.match(htmlSource, /id="security-pair-command"/, "copyable command element exists");
  assert.match(htmlSource, /id="security-pair-new"/, "new-pairing-code button exists");
  assert.match(appSource, /npx @teamclaws\/teamclaw pair " \+ window\.location\.origin \+ " --code /, "the command line is built from the page origin (controller URL)");
  assert.match(appSource, /apiPost\("\/security\/pair\/start"/, "issuing a fresh code calls POST /api/v1/security/pair/start");
  assert.match(appSource, /security\.pairExpiresIn/, "the countdown uses the security.pairExpiresIn i18n key");
  assert.match(appSource, /openSecurityPairModal\(data\.pairingCode\.code/, "a successful enable opens the pairing modal with the issued code");

  // Device management: list + revoke (confirm path) + reset (confirm path).
  assert.match(htmlSource, /id="security-devices-section"/, "the devices section lives inside the team-profile modal");
  assert.match(appSource, /apiGet\("\/security"\)/, "device management lists GET /api/v1/security");
  assert.match(appSource, /\/security\/devices\/" \+ encodeURIComponent/, "revoke calls DELETE /api/v1/security/devices/:id");
  assert.match(appSource, /method: "DELETE"/, "the revoke request is a DELETE");
  assert.match(appSource, /window\.confirm\(t\("security\.resetConfirm"\)\)/, "reset all devices is guarded by a confirm");
  assert.match(appSource, /apiPost\("\/security\/reset"/, "reset calls POST /api/v1/security/reset");
  assert.match(appSource, /revokedSelf/, "self-revocation is detected from the response");
  assert.match(appSource, /security\.selfRevoked/, "self-revocation surfaces the re-pair notice");
  assert.match(appSource, /security\.statusOn/, "protection-on status line uses the i18n key");

  // i18n: keys exist in BOTH dictionaries (en then zh blocks).
  for (const key of ["security.bannerTitle", "security.enableAction", "security.pairHint", "security.devicesTitle", "security.resetConfirm", "security.statusOff"]) {
    const occurrences = appSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key "${key}" must appear in both the en and zh dictionaries`);
  }
}

// ===========================================================================
// 3. Desktop renderer source level (desktop/renderer/{app.js,index.html,i18n.js})
// ===========================================================================
{
  const appSource = fs.readFileSync(path.join(projectRoot, "desktop", "renderer", "app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(projectRoot, "desktop", "renderer", "index.html"), "utf8");
  const i18nSource = fs.readFileSync(path.join(projectRoot, "desktop", "renderer", "i18n.js"), "utf8");

  assert.match(htmlSource, /id="bootstrap-pairing-code"/, "the remote connect row carries the optional pairing code field");
  assert.match(htmlSource, /data-i18n-placeholder="bootstrap\.pairingCodePlaceholder"/, "the pairing field placeholder is localized");

  // Pair-before-connect wiring.
  assert.match(appSource, /\/api\/v1\/security\/pair/, "the desktop pairing flow calls the pair endpoint");
  assert.match(appSource, /kind: "desktop"/, "desktop pairs with kind=desktop");
  assert.match(appSource, /pairWithController\(rawUrl, codeInput\.value\)/, "the connect button exchanges the code BEFORE connecting when one is typed");
  assert.match(appSource, /bootstrap\.pairingFailed/, "a failed pairing surfaces the localized error");

  // Token storage + restore.
  assert.match(appSource, /securityToken: payload\.token/, "a successful pairing persists the token into settings");
  assert.match(appSource, /state\.securityToken = typeof \(state\.settings \|\| \{\}\)\.securityToken/, "boot restores the stored token before reconnecting");

  // Header injection: the single helper + every api wrapper + WS upgrade.
  assert.match(appSource, /headers\["X-TeamClaw-Token"\] = state\.securityToken/, "controllerHeaders injects X-TeamClaw-Token");
  const wrapperCount = (appSource.match(/controllerHeaders\(/g) ?? []).length;
  assert.ok(wrapperCount >= 8, `all api wrappers route through controllerHeaders (found ${wrapperCount} usages incl. WS/profile echo)`);
  assert.match(appSource, /url\.searchParams\.set\("token", state\.securityToken\)/, "the WS upgrade carries the token via ?token= (browsers cannot set headers)");

  // i18n keys in both desktop dictionaries.
  for (const key of ["bootstrap.pairingCodeLabel", "bootstrap.pairingCodePlaceholder", "bootstrap.pairingFailed", "bootstrap.pairedNote"]) {
    const occurrences = i18nSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `desktop i18n key "${key}" must appear in both the en and zh dictionaries`);
  }
}

// ===========================================================================
// 4. Worker token injection (dist level against a stub controller)
// ===========================================================================
{
  const { parsePluginConfig } = await dist("types.js");

  // Config parse: securityToken is optional, trimmed, never logged.
  assert.equal(parsePluginConfig({ securityToken: `  ${STUB_TOKEN}  ` }).securityToken, STUB_TOKEN, "parsePluginConfig trims and keeps securityToken");
  assert.equal(parsePluginConfig({}).securityToken, "", "default securityToken is the empty string (L0)");
  assert.equal(typeof parsePluginConfig({ securityToken: 42 }).securityToken, "string", "non-string securityToken falls back to empty, never throws");

  // Schema echo guard: the field exists in the schema but uiHints must NOT
  // carry it (no config UI may display the secret).
  const configTs = fs.readFileSync(path.join(projectRoot, "src", "src", "config.ts"), "utf8");
  const schemaBlock = configTs.slice(configTs.indexOf("jsonSchema:"), configTs.indexOf("uiHints:"));
  const uiHintsBlock = configTs.slice(configTs.indexOf("uiHints:"), configTs.indexOf("parse(raw"));
  assert.match(schemaBlock, /securityToken:/, "config schema declares securityToken");
  assert.doesNotMatch(uiHintsBlock, /securityToken/, "uiHints never echoes securityToken (secret stays invisible)");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "src", "openclaw.plugin.json"), "utf8"));
  assert.ok(manifest.configSchema?.properties?.securityToken, "the generated manifest carries the securityToken schema entry");
  assert.equal(manifest.uiHints && "securityToken" in manifest.uiHints, false, "the manifest uiHints never echoes securityToken");

  // Worker tools: a configured token rides X-TeamClaw-Token on a real call.
  {
    const stub = await startSecurityStub(() => ({ status: 201, body: { ok: true } }));
    try {
      const { createWorkerTools } = await dist("worker/tools.js");
      const config = parsePluginConfig({ mode: "worker", controllerUrl: stub.baseUrl, teamName: "ClientWave", securityToken: STUB_TOKEN, role: "developer" });
      const tools = createWorkerTools({ config, getIdentity: () => ({ workerId: "w-cli-1", role: "developer", controllerUrl: stub.baseUrl, registeredAt: Date.now() }) });
      const askPeer = tools.find((tool) => tool.name === "teamclaw_ask_peer");
      assert.ok(askPeer, "teamclaw_ask_peer tool present");
      const outcome = await askPeer.execute("w-cli-1", { targetRole: "developer", question: "ping" });
      const direct = stub.requests.find((r) => r.url === "/api/v1/messages/direct");
      assert.ok(direct, "the tool call reached the stub controller");
      assert.equal(direct.headers["x-teamclaw-token"], STUB_TOKEN, "worker tool calls carry X-TeamClaw-Token when a token is configured");
      assert.match(outcome.content[0].text, /Message sent/, "the call succeeded end to end");

      // Without a token the header must be absent (L0 unchanged).
      const bareConfig = parsePluginConfig({ mode: "worker", controllerUrl: stub.baseUrl, teamName: "ClientWave", role: "developer" });
      const bareTools = createWorkerTools({ config: bareConfig, getIdentity: () => ({ workerId: "w-bare", role: "developer", controllerUrl: stub.baseUrl, registeredAt: Date.now() }) });
      await bareTools.find((tool) => tool.name === "teamclaw_ask_peer").execute("w-bare", { targetRole: "developer", question: "bare" });
      const bareDirect = [...stub.requests].reverse().find((r) => r.url === "/api/v1/messages/direct");
      assert.equal(bareDirect.headers["x-teamclaw-token"], undefined, "no token configured => no X-TeamClaw-Token header (zero drift)");
    } finally {
      await closeServer(stub.server);
    }
  }

  // Identity registration: same header on POST /workers/register.
  {
    const stub = await startSecurityStub(() => ({ status: 200, body: { ok: true } }));
    try {
      const { IdentityManager } = await dist("identity.js");
      const config = parsePluginConfig({ mode: "worker", controllerUrl: stub.baseUrl, teamName: "ClientWave", securityToken: STUB_TOKEN, role: "developer", port: 19555 });
      const manager = new IdentityManager(config, logger);
      const identity = await manager.register();
      assert.ok(identity, "registration completed against the stub controller");
      const register = stub.requests.find((r) => r.url === "/api/v1/workers/register");
      assert.ok(register, "registration POST seen by the stub");
      assert.equal(register.headers["x-teamclaw-token"], STUB_TOKEN, "identity registration carries X-TeamClaw-Token when configured");
      await manager.clear();
      const clearRequest = stub.requests.find((r) => r.method === "DELETE" && r.url.startsWith("/api/v1/workers/"));
      assert.ok(clearRequest, "identity clear DELETEs the worker record");
      assert.equal(clearRequest.headers["x-teamclaw-token"], STUB_TOKEN, "the worker DELETE also carries the device token");
    } finally {
      await closeServer(stub.server);
    }
  }

  // Worker-service heartbeat + result reporting keep the same helper
  // (source-level: spinning the whole service adds no signal beyond the
  // header merge already proven above).
  {
    const serviceSource = fs.readFileSync(path.join(projectRoot, "src", "src", "worker", "worker-service.ts"), "utf8");
    assert.match(serviceSource, /withDeviceToken\(config, \{ "Content-Type": "application\/json" \}\)/, "heartbeat and result fetches merge the device token header");
    const heartbeatCalls = serviceSource.match(/fetch\(`\$\{controllerUrl\}\/api\/v1\/workers\/\$\{id\.workerId\}\/heartbeat[\s\S]{0,220}?withDeviceToken/g) ?? [];
    assert.ok(heartbeatCalls.length >= 1, "the heartbeat fetch itself routes through withDeviceToken");
    const toolsSource = fs.readFileSync(path.join(projectRoot, "src", "src", "worker", "tools.ts"), "utf8");
    const toolCallSites = (toolsSource.match(/withDeviceToken\(/g) ?? []).length - (toolsSource.match(/function withDeviceToken\(/g) ?? []).length;
    assert.equal(toolCallSites, 9, "all 9 worker-tool controller fetches carry the token helper (8 header merges + the headerless GET)");
  }
}

console.log("Security clients smoke passed.");
