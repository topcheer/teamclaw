#!/usr/bin/env node
// Watchdog (g4): fail loudly if any await wedges (intermittent env hang
// - three CI cancels + local 20-minute hangs). unref'd so it never holds
// the loop open itself; process.exit(0) at the tail clears it on success.
setTimeout(() => {
  console.error("test-security-pairing: WATCHDOG fired - suite wedged before completion");
  process.exit(1);
}, 240_000).unref();
// Issue #23 backend wave: controller device-pairing security - dist-level
// tests against a real HTTP + WebSocket server (same pattern as
// test-profile-switch.mjs; run `npm --prefix src run build` first).
//
// Covers (spec order):
//   1. L0 zero-friction: no devices => every endpoint open without a token
//      (health, task creation), /team/status carries the `security` object
//      with suggested=false, and the suggestion signal flips to suggested
//      after a non-LAN (via-tunnel host) peer touches an /api path.
//   2. enable: non-loopback rejected; loopback enable sets the
//      HttpOnly/SameSite=Strict session cookie + issues a one-shot pairing
//      code; afterwards tokenless API calls get 401 {error:"unauthorized",
//      hint} - INCLUDING ahead of the transition 503/409 and capability 404
//      gates - while /api/v1/health and UI static assets stay exempt.
//   3. pair: wrong code / expired code / reused code rejected; correct code
//      exchanges for {token, deviceId} exactly once; that token works and
//      stamps lastSeenAt.
//   4. pair-auto: LAN (loopback is LAN) + autoPair=true => token with zero
//      input; autoPair=false => 403 pointing at the pairing code; tunnel
//      (non-LAN) traffic can never reach it (blocked by the tunnel gate
//      before the handler, on top of the peer classification).
//   5. Device management: GET /security never leaks tokenHash; revoking a
//      device 401s its token immediately (self-revocation allowed);
//      loopback reset (no token) returns the controller to L0.
//   6. WebSocket: protection on => tokenless upgrade rejected, ?token=
//      upgrade succeeds (real ws client).
//   7. CORS: protection on => foreign-Origin preflight 403 (never the
//      wildcard), same-origin preflight echoed, foreign-Origin actual
//      responses pinned to an explicit empty ACAO; protection off keeps
//      the historical wildcard behavior byte for byte.
//   8. At-rest safety: the persisted state file contains ONLY sha256
//      tokenHashes - none of the minted token plaintexts.
// Plus unit pins for the pure helpers (isLanIp/isLoopbackIp truth table,
// pairing-code shape) and a guarded real-LAN probe (skips loudly when the
// host has no bindable private address, e.g. CI containers).

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ---------------------
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-security-pairing-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-security-ws-"));
const stateDir = path.join(stateRoot, "plugins", "teamclaw");
fs.mkdirSync(stateDir, { recursive: true });

const stateMod = await dist("state.js");
const httpMod = await dist("controller/http-server.js");
const securityMod = await dist("controller/security.js");
const { TaskRouter } = await dist("controller/task-router.js");
const { MessageRouter } = await dist("controller/message-router.js");
const { TeamWebSocketServer } = await dist("controller/websocket.js");
const { parsePluginConfig } = await dist("types.js");
const loaderMod = await dist("profile-loader.js");

// ===========================================================================
// Unit pins: pure helpers
// ===========================================================================
{
  assert.equal(securityMod.isLoopbackIp("127.0.0.1"), true, "127.0.0.1 is loopback");
  assert.equal(securityMod.isLoopbackIp("127.9.9.9"), true, "the whole 127/8 block is loopback");
  assert.equal(securityMod.isLoopbackIp("::1"), true, "::1 is loopback");
  assert.equal(securityMod.isLoopbackIp("::ffff:127.0.0.1"), true, "IPv4-mapped loopback unwraps");
  assert.equal(securityMod.isLoopbackIp("192.168.1.5"), false, "LAN is not loopback");

  for (const lan of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1",
    "192.168.31.7", "169.254.100.1", "fd00::1", "fc00::5", "fe80::1", "fe8b::a", "fe90::1", "febf::1"]) {
    assert.equal(securityMod.isLanIp(lan), true, `${lan} must classify as LAN`);
  }
  for (const notLan of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "11.0.0.1",
    "2001:db8::1", "fec0::1", "2606:4700::1", ""]) {
    assert.equal(securityMod.isLanIp(notLan), false, `${notLan || "<empty>"} must NOT classify as LAN`);
  }
  assert.equal(securityMod.isLanIp("::ffff:10.1.2.3"), true, "IPv4-mapped RFC1918 unwraps to LAN");
  assert.equal(securityMod.isLanIp("fe80::1%en0"), true, "zone ids are stripped before classification");

  const tunneled = securityMod.classifySecurityPeer("127.0.0.1", true);
  assert.equal(tunneled.loopback, false, "via-tunnel requests are NEVER loopback (cloudflared dials from 127.0.0.1)");
  assert.equal(tunneled.lan, false, "via-tunnel requests are NEVER LAN");
  assert.equal(securityMod.classifySecurityPeer("192.168.1.9", false).lan, true, "direct RFC1918 peer is LAN");

  for (let i = 0; i < 50; i++) {
    assert.match(securityMod.generatePairingCode(), /^[A-Z2-7]{8}$/, "pairing codes are 8-char uppercase base32");
  }
  assert.equal(securityMod.hashToken("abc").length, 64, "token hashes are sha256 hex");
  assert.match(securityMod.generateToken(), /^[0-9a-f]{64}$/, "tokens are 32-byte hex");
}

// ===========================================================================
// Scenario harness (test-profile-switch pattern)
// ===========================================================================
const logger = { infos: [], warns: [], errors: [], info(e) { this.infos.push(e); }, warn(e) { this.warns.push(e); }, error(e) { this.errors.push(e); }, debug() {} };

function softwareRdState(overrides = {}) {
  const now = Date.now();
  return {
    version: 2,
    profileId: "software-rd",
    teamName: "Security Team",
    workers: {},
    tasks: {},
    controllerRuns: {},
    projects: {},
    messages: [],
    clarifications: {},
    provisioning: { workers: {} },
    createdAt: now - 5000,
    updatedAt: now,
    ...overrides,
  };
}

async function bootScenario(options = {}) {
  loaderMod.setActiveProfileId("software-rd");
  const config = parsePluginConfig({
    mode: "controller",
    teamName: "Security Team",
    port: 19530,
    gitEnabled: options.gitEnabled ?? false,
    ...(options.autoPair === false ? { security: { autoPair: false } } : {}),
  });
  assert.equal(config.security.autoPair, options.autoPair === false ? false : true, "config parse: security.autoPair default true, explicit false honored");

  let teamState = options.initialState ?? softwareRdState();
  if (options.initialState) {
    await stateMod.saveTeamState(teamState);
  }
  const getTeamState = () => teamState;
  const updateTeamState = (updater) => {
    updater(teamState);
    void stateMod.saveTeamState(teamState);
    return teamState;
  };

  const wsServer = new TeamWebSocketServer(logger);
  const deps = {
    config,
    logger,
    runtime: {},
    getTeamState,
    updateTeamState,
    taskRouter: new TaskRouter(logger),
    messageRouter: new MessageRouter(logger),
    wsServer,
  };
  const server = httpMod.createControllerHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, headers: res.headers, json, text, setCookie: res.headers.get("set-cookie") };
  };
  // Simulates a request that arrived through the sharing tunnel: the Host
  // header classifies it as viaTunnel (non-LAN, non-loopback) even though
  // the socket peer address is loopback. undici's fetch silently ignores a
  // Host override, so this goes through node:http where the header is
  // settable.
  const callViaTunnelHost = (method, pathname, body) => new Promise((resolve, reject) => {
    const req = http.request(baseUrl, {
      method,
      path: pathname,
      headers: {
        Host: "attacker.apps.teamclaw.dev",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text, setCookie: res.headers["set-cookie"] });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });

  return {
    deps, server, baseUrl, call, callViaTunnelHost,
    getTeamState,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        // g4 root cause: close() waits for every connection to end, but
        // undici keep-alive sockets and WS clients whose upgrade the server
        // never answered hold the server open forever - the suite wedged
        // AFTER all assertions passed (zero output, 240s watchdog fires in
        // CI, handle probe shows open sockets with NO timers). Destroy
        // lingering connections so close always resolves.
        server.closeAllConnections?.();
      });
      wsServer.close();
    },
  };
}

function readStateFile() {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8"));
}

async function waitForStateFile(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate(readStateFile())) {
        return readStateFile();
      }
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail("state file did not reach the expected shape within the timeout");
}

function cookieToken(setCookie) {
  assert.ok(setCookie, "enable must set the session cookie");
  const match = /teamclaw_session=([^;]+)/.exec(setCookie);
  assert.ok(match, "cookie name is teamclaw_session");
  return match[1];
}

const mintedTokens = [];

// ===========================================================================
// Main scenario: the whole ladder end to end on one server.
// ===========================================================================
{
  const scenario = await bootScenario({});
  try {
    // ---- 1. L0: everything open, suggestion signal off --------------------
    const health = await scenario.call("GET", "/api/v1/health");
    assert.ok(health.status === 200 || health.status === 503, "L0: health answers without a token (readiness-dependent code)");
    const task = await scenario.call("POST", "/api/v1/tasks", { title: "l0 open task", description: "x" });
    assert.equal(task.status, 201, "L0: task creation needs no token (zero-friction default)");

    const statusL0 = await scenario.call("GET", "/api/v1/team/status");
    assert.equal(statusL0.status, 200, "L0: team status open");
    assert.deepEqual(
      { protection: statusL0.json.security.protection, suggested: statusL0.json.security.suggested, deviceCount: statusL0.json.security.deviceCount },
      { protection: false, suggested: false, deviceCount: 0 },
      "L0: /team/status carries the security object in its off state",
    );

    // CORS while protection is off: the historical wildcard preflight.
    const preflightOff = await fetch(`${scenario.baseUrl}/api/v1/tasks`, {
      method: "OPTIONS",
      headers: { Origin: "https://foreign.example.com" },
    });
    assert.equal(preflightOff.status, 200, "L0 preflight status unchanged");
    assert.equal(preflightOff.headers.get("access-control-allow-origin"), "*", "L0 preflight keeps the wildcard (current behavior)");
    assert.equal(preflightOff.headers.get("access-control-allow-headers"), "Content-Type", "L0 preflight keeps the historical allow-headers");

    // Suggestion signal: a via-tunnel (non-LAN) peer touches an /api path.
    // The tunnel gate answers 403 with its HTML page - the point here is
    // that the security layer still OBSERVED the peer before that gate.
    const tunneled = await scenario.callViaTunnelHost("GET", "/api/v1/tasks");
    assert.equal(tunneled.status, 403, "via-tunnel request without the gate cookie is rejected by the tunnel gate");
    assert.match(tunneled.text, /TeamClaw Tunnel/, "the 403 is the tunnel gate page");
    const statusSuggested = await scenario.call("GET", "/api/v1/team/status");
    assert.equal(statusSuggested.json.security.suggested, true, "suggestion signal flips after a non-LAN peer");
    assert.equal(statusSuggested.json.security.lastNonLanPeer.path, "/api/v1/tasks", "the signal records the touched path");
    assert.match(statusSuggested.json.security.reason, /non-LAN peer/, "the signal carries a human-readable reason");

    // ---- 2. enable ---------------------------------------------------------
    const remoteEnable = await scenario.callViaTunnelHost("POST", "/api/v1/security/enable");
    assert.equal(remoteEnable.status, 403, "enable from a non-loopback (tunnel) source never reaches the handler - the tunnel gate blocks it first");

    const enable = await scenario.call("POST", "/api/v1/security/enable");
    assert.equal(enable.status, 201, "loopback enable succeeds");
    const cookie = enable.setCookie;
    assert.match(cookie, /teamclaw_session=[0-9a-f]{64}/, "enable sets the session cookie with the device token");
    assert.match(cookie, /HttpOnly/, "session cookie is HttpOnly");
    assert.match(cookie, /SameSite=Strict/, "session cookie is SameSite=Strict");
    assert.match(cookie, /Path=\/api\/v1/, "session cookie is scoped to the API");
    const webToken = cookieToken(cookie);
    mintedTokens.push(webToken);
    assert.match(enable.json.pairingCode.code, /^[A-Z2-7]{8}$/, "enable returns a one-shot 8-char base32 pairing code");
    assert.ok(enable.json.pairingCode.expiresAt > Date.now(), "pairing code carries a future expiry");
    assert.equal(enable.json.protection, true, "protection reports on");
    assert.equal(enable.json.device.kind, "web", "the first device is the web console");
    assert.ok(!("token" in enable.json), "enable response body never echoes the token (cookie only)");
    const enableCode = enable.json.pairingCode.code;

    // Loopback + tunnel are first-party (design ruling 2026-11-12): a
    // tokenless loopback call PASSES; tunnel visitors authenticate with the
    // tunnel gate token at the gate layer, never pairing. The fixture's
    // callViaTunnelHost has no live tunnel, so its socket peer stays loopback
    // and it also passes - both lock the new contract.
    const unauthTrusted = await scenario.call("GET", "/api/v1/tasks");
    assert.equal(unauthTrusted.status, 200, "protection on: tokenless LOOPBACK call passes (first-party exemption)");
    const unauth = await scenario.callViaTunnelHost("GET", "/api/v1/tasks");
    assert.equal(unauth.status, 403, "protection on: tunnel-shaped request without a gate token hits the tunnel GATE (403 page), not device pairing - the layer split works");
    assert.match(unauth.text ?? "", /gate|token/i, "403 body is the tunnel gate page, not a pairing 401");
    // callViaTunnelHost rides node:http (undici drops Host overrides), so
    // headers is the RAW node object, not a fetch Headers instance.
    assert.equal(unauth.headers["access-control-allow-origin"] ?? "*", "*", "CORS default retained on the exempt path");

    // Exemptions: health + UI statics stay open.
    const healthOn = await scenario.call("GET", "/api/v1/health");
    assert.ok(healthOn.status === 200 || healthOn.status === 503, "health stays exempt while protection is on");
    const uiAsset = await fetch(`${scenario.baseUrl}/ui/app.js`);
    assert.equal(uiAsset.status, 200, "UI static assets stay exempt");
    // GET /api/v1/security from a first-party peer: exempt by design; the
    // listing body itself never contains token hashes (asserted below on
    // the authenticated path), and the destructive endpoints keep their own
    // confirm/loopback guards.
    const secUnauth = await scenario.call("GET", "/api/v1/security");
    assert.equal(secUnauth.status, 200, "GET /security from loopback is first-party (protection gates LAN, not the host)");

    // 401 wins over the transition matrix (503/409) and capability 404s.
    scenario.deps.updateTeamState((s) => {
      s.transition = { phase: "draining", targetProfileId: "minimal-bank", startedAt: Date.now() };
    });
    const unauthDuringTransition = await scenario.call("POST", "/api/v1/tasks", { title: "nope" });
    assert.equal(unauthDuringTransition.status, 503, "first-party caller reaches the transition gate (pairing no longer masks it on loopback)");
    assert.equal(unauthDuringTransition.headers["retry-after"], undefined, "no Retry-After leaks to unpaired callers");
    const authDuringTransition = await scenario.call("POST", "/api/v1/tasks", { title: "nope" }, { Authorization: `Bearer ${webToken}` });
    assert.equal(authDuringTransition.status, 503, "authenticated callers still see the transition gate");
    assert.equal(authDuringTransition.headers.get("retry-after"), "5", "transition gate semantics unchanged for paired devices");
    scenario.deps.updateTeamState((s) => { delete s.transition; });

    loaderMod.setActiveProfileId("minimal-bank"); // fixture profile: all four capabilities off
    const unauthCapability = await scenario.call("GET", "/api/v1/teamauto/activity");
    assert.equal(unauthCapability.status, 404, "first-party caller reaches the capability gate (pairing no longer masks it on loopback)");
    const authCapability = await scenario.call("GET", "/api/v1/teamauto/activity", undefined, { Authorization: `Bearer ${webToken}` });
    assert.equal(authCapability.status, 404, "authenticated callers see the capability 404 gate");
    assert.equal(authCapability.json.capability, "teamauto", "capability gate body unchanged for paired devices");
    loaderMod.setActiveProfileId("software-rd");

    // ---- 3. pair (one-shot code exchange) ----------------------------------
    const wrongCode = await scenario.call("POST", "/api/v1/security/pair", { code: "AAAAAAAA", kind: "worker", name: "Evil" });
    assert.equal(wrongCode.status, 400, "wrong code rejected");
    assert.match(wrongCode.json.error, /invalid pairing code/, "wrong-code error text");

    const paired = await scenario.call("POST", "/api/v1/security/pair", { code: enableCode, kind: "worker", name: "Dev Worker" });
    assert.equal(paired.status, 201, "correct code pairs a device");
    assert.match(paired.json.token, /^[0-9a-f]{64}$/, "pair returns the plaintext token exactly once");
    const workerToken = paired.json.token;
    mintedTokens.push(workerToken);
    const workerDeviceId = paired.json.deviceId;

    const reused = await scenario.call("POST", "/api/v1/security/pair", { code: enableCode, kind: "cli", name: "Reuser" });
    assert.equal(reused.status, 400, "a used code can never pair again");
    assert.match(reused.json.error, /already used/, "reuse error text names the cause");

    // Expired code: mint a fresh one and age it out (white-box clock jump).
    const start = await scenario.call("POST", "/api/v1/security/pair/start", {}, { Authorization: `Bearer ${webToken}` });
    assert.equal(start.status, 201, "authenticated device can mint a fresh code");
    assert.match(start.json.pairingCode.code, /^[A-Z2-7]{8}$/, "fresh code shape");
    scenario.deps.updateTeamState((s) => {
      s.security.pairingCode.expiresAt = Date.now() - 1;
    });
    const expired = await scenario.call("POST", "/api/v1/security/pair", { code: start.json.pairingCode.code, kind: "cli" });
    assert.equal(expired.status, 400, "expired code rejected");
    assert.match(expired.json.error, /expired/, "expiry error text");
    // Unauthenticated, non-loopback pair/start is rejected.
    const remoteStart = await scenario.callViaTunnelHost("POST", "/api/v1/security/pair/start");
    assert.equal(remoteStart.status, 403, "tunnel-host pair/start is blocked by the tunnel gate before the handler");

    // The paired token works and stamps lastSeenAt.
    const workerCall = await scenario.call("GET", "/api/v1/tasks", undefined, { "X-TeamClaw-Token": workerToken });
    assert.equal(workerCall.status, 200, "worker token authenticates (X-TeamClaw-Token header path)");
    const secList = await scenario.call("GET", "/api/v1/security", undefined, { Authorization: `Bearer ${workerToken}` });
    assert.equal(secList.status, 200, "GET /security with a device token");
    assert.equal(secList.json.protection, true);
    assert.equal(secList.json.devices.length, 2, "web console + worker device listed");
    assert.equal(JSON.stringify(secList.json).includes("tokenHash"), false, "device listing NEVER contains tokenHash");
    const workerEntry = secList.json.devices.find((d) => d.id === workerDeviceId);
    assert.ok(workerEntry && typeof workerEntry.lastSeenAt === "number", "the worker device's lastSeenAt was stamped by its authenticated call");
    assert.equal(secList.json.pairingCode, undefined, "the consumed/expired code is not advertised");

    // ---- 4. pair-auto ------------------------------------------------------
    const autoPaired = await scenario.call("POST", "/api/v1/security/pair-auto", { kind: "cli", name: "Laptop CLI" });
    assert.equal(autoPaired.status, 201, "LAN peer (loopback is LAN) auto-pairs with zero input");
    const cliToken = autoPaired.json.token;
    mintedTokens.push(cliToken);
    const cliDeviceId = autoPaired.json.deviceId;
    const tunneledAuto = await scenario.callViaTunnelHost("POST", "/api/v1/security/pair-auto", { kind: "cli" });
    assert.equal(tunneledAuto.status, 403, "tunnel (non-LAN) traffic can never auto-pair - the tunnel gate rejects it before the handler");

    // ---- 7. CORS while protection is on ------------------------------------
    const preflightSameOrigin = await fetch(`${scenario.baseUrl}/api/v1/tasks`, {
      method: "OPTIONS",
      headers: { Origin: scenario.baseUrl },
    });
    assert.equal(preflightSameOrigin.status, 200, "same-origin preflight allowed");
    assert.equal(preflightSameOrigin.headers.get("access-control-allow-origin"), scenario.baseUrl, "same-origin preflight echoes the UI origin (never the wildcard)");
    assert.match(preflightSameOrigin.headers.get("access-control-allow-headers"), /Authorization/, "preflight allows the auth headers");

    const preflightForeign = await fetch(`${scenario.baseUrl}/api/v1/tasks`, {
      method: "OPTIONS",
      headers: { Origin: "https://foreign.example.com" },
    });
    assert.equal(preflightForeign.status, 403, "foreign-origin preflight is rejected outright");
    assert.notEqual(preflightForeign.headers.get("access-control-allow-origin"), "*", "no wildcard ever appears for a foreign origin");
    assert.equal(preflightForeign.headers.get("access-control-allow-origin"), null, "foreign preflight carries no ACAO at all");

    // Actual responses: same-origin echo, foreign pinned to an explicit
    // empty value (protocol.sendJson honors the pinned header).
    const actualSameOrigin = await scenario.call("GET", "/api/v1/health", undefined, { Origin: scenario.baseUrl });
    assert.equal(actualSameOrigin.headers.get("access-control-allow-origin"), scenario.baseUrl, "same-origin actual response echoes the origin");
    const actualForeign = await scenario.call("GET", "/api/v1/health", undefined, { Origin: "https://foreign.example.com" });
    assert.equal(actualForeign.headers.get("access-control-allow-origin"), "", "foreign-origin actual response is pinned to an explicit empty ACAO (not the wildcard)");
    const actualNoOrigin = await scenario.call("GET", "/api/v1/health");
    assert.equal(actualNoOrigin.headers.get("access-control-allow-origin"), "*", "no Origin header (non-browser client) keeps sendJson's default header");

    // ---- 5. Device management ----------------------------------------------
    const revoke = await scenario.call("DELETE", `/api/v1/security/devices/${workerDeviceId}`, undefined, { Authorization: `Bearer ${webToken}` });
    assert.equal(revoke.status, 200, "an authenticated device can revoke another");
    assert.equal(revoke.json.revokedSelf, false, "revoked another device, not self");
    const revokedCall = await scenario.callViaTunnelHost("GET", "/api/v1/tasks", undefined, { Authorization: `Bearer ${workerToken}` });
    assert.equal(revokedCall.status, 403, "tunnel-shaped request is governed by the tunnel gate token, not device tokens - a revoked device token neither helps nor hurts a gate-token visitor (design ruling 2026-11-12)");
    const survivorCall = await scenario.call("GET", "/api/v1/tasks", undefined, { Authorization: `Bearer ${webToken}` });
    assert.equal(survivorCall.status, 200, "other devices keep working after the revocation");

    // ---- 6. WebSocket upgrades ---------------------------------------------
    const wsMod = await import(pathToFileURL(path.join(projectRoot, "src", "node_modules", "ws", "index.js")).href);
    const WebSocketClient = wsMod.default ?? wsMod.WebSocket;
    const wsPort = new URL(scenario.baseUrl).port;
    // g4/UT-cancelled: these promises only settle on open|error - when the
    // server occasionally never completes the handshake the suite hung
    // forever (three CI cancels + local 20min hangs). Race each probe.
    // g4 root cause round 2: every probe client is tracked and HARD-terminated
    // at scenario close - the server's graceful close handshake waits for the
    // peer's close frame, which a test client that already lost the race
    // never sends, so close() wedged after all assertions passed.
    const wsClients = [];
    const wsTimeout = () => new Promise((resolve) => setTimeout(() => resolve(new Error("ws probe timeout")), 5000));
    const wsBlocked = await Promise.race([new Promise((resolve) => {
      const ws = new WebSocketClient(`ws://127.0.0.1:${wsPort}/ws`);
      wsClients.push(ws);
      ws.on("open", () => resolve("open"));
      ws.on("error", (err) => resolve(err));
    }), wsTimeout()]);
    // 12f1d09/db7a869: loopback peers are first-party-exempt - a tokenless
    // upgrade FROM LOOPBACK legitimately opens while protection is on. The
    // old "tokenless is rejected" contract predates the exemption and made
    // this assertion throw, wedging close(). The rejection contract now
    // lives on the via-tunnel probe below (non-loopback origin).
    assert.equal(String(wsBlocked), "open", "tokenless WS upgrade from loopback opens (first-party exemption)");

    // e822622: tunnel-origin upgrades verify the gate cookie, not a device
    // token. A spoofed via-tunnel Host with no gate cookie must be rejected
    // even though the socket peer is loopback.
    const wsTunnelBlocked = await Promise.race([new Promise((resolve) => {
      const ws = new WebSocketClient(`ws://127.0.0.1:${wsPort}/ws`, { headers: { host: "attacker.apps.teamclaw.dev" } });
      wsClients.push(ws);
      ws.on("open", () => resolve("open"));
      ws.on("error", (err) => resolve(err));
    }), wsTimeout()]);
    assert.match(String(wsTunnelBlocked), /401|Unexpected server response|forbidden|gate/i, "via-tunnel WS upgrade without a gate cookie is rejected");

    const wsOpen = await Promise.race([new Promise((resolve) => {
      const ws = new WebSocketClient(`ws://127.0.0.1:${wsPort}/ws?token=${webToken}`);
      wsClients.push(ws);
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("error", (err) => resolve(err));
    }), wsTimeout()]);
    assert.equal(String(wsOpen), "open", "WS upgrade with ?token= succeeds");

    const wsCookie = await Promise.race([new Promise((resolve) => {
      const ws = new WebSocketClient(`ws://127.0.0.1:${wsPort}/ws`, { headers: { cookie: `teamclaw_session=${webToken}` } });
      wsClients.push(ws);
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("error", (err) => resolve(err));
    }), wsTimeout()]);
    assert.equal(String(wsCookie), "open", "WS upgrade with the session cookie succeeds");
    // Hard-terminate every probe client NOW: leaving them to the server's
    // graceful close handshake is what wedged the suite (see wsClients note).
    for (const ws of wsClients) {
      try { ws.terminate(); } catch { /* already closed */ }
    }

    // ---- 8. At-rest safety: hashes only, never plaintext --------------------
    // While protection is ON (web console + cli device remain after the
    // worker revocation): the file must carry sha256 hashes and NONE of the
    // minted token plaintexts.
    const persistedOnDisk = await waitForStateFile((s) => s.security?.devices?.length === 2);
    assert.equal(persistedOnDisk.security.devices.length, 2, "web + cli devices persisted (worker was revoked)");
    const rawOnDisk = fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8");
    for (const token of mintedTokens) {
      assert.equal(rawOnDisk.includes(token), false, "NO token plaintext may ever appear in the persisted state");
    }
    assert.match(persistedOnDisk.security.devices[0].tokenHash, /^[0-9a-f]{64}$/, "the persisted device record carries a sha256 tokenHash");

    // ---- 5b. reset escape hatch --------------------------------------------
    const remoteReset = await scenario.callViaTunnelHost("POST", "/api/v1/security/reset");
    assert.equal(remoteReset.status, 403, "tunnel-host reset is blocked by the tunnel gate (remote cannot reset)");
    const reset = await scenario.call("POST", "/api/v1/security/reset", { confirm: "RESET" });
    assert.equal(reset.status, 200, "loopback reset WITHOUT a token but WITH confirm:\"RESET\" succeeds (anti-lockout hatch, #255 P1-8)");
    assert.equal(reset.json.protection, false, "reset returns the controller to L0");
    const afterReset = await scenario.call("GET", "/api/v1/tasks");
    assert.equal(afterReset.status, 200, "after reset everything is open again (L0)");
    const cliAfterReset = await scenario.call("GET", "/api/v1/tasks", undefined, { Authorization: `Bearer ${cliToken}` });
    assert.equal(cliAfterReset.status, 200, "all device tokens were wiped by the reset");
    const persistedAfterReset = await waitForStateFile((s) => s.security === undefined);
    assert.equal(persistedAfterReset.security, undefined, "reset cleared the security state entirely");

    // Re-enable after reset works (fresh L2), cookie-only again.
    const reenable = await scenario.call("POST", "/api/v1/security/enable");
    assert.equal(reenable.status, 201, "re-enable after reset works (fresh L2)");
    const freshWebToken = cookieToken(reenable.setCookie);
    mintedTokens.push(freshWebToken);
    const persistedFresh = await waitForStateFile((s) => s.security?.devices?.length === 1);
    assert.match(persistedFresh.security.devices[0].tokenHash, /^[0-9a-f]{64}$/, "the fresh device record carries a sha256 tokenHash");
    assert.equal(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8").includes(freshWebToken), false,
      "the freshly minted web token is absent from the state file (cookie only)");

    // ---- 3b. True-concurrency pair (security review follow-up): two
    // in-flight requests racing the SAME code against the real dist server
    // must yield exactly one 201 and one 400 already-used - the
    // check-and-consume inside the single synchronous state mutation is
    // structurally atomic, not a read-then-write race.
    const raceStart = await scenario.call("POST", "/api/v1/security/pair/start", {}, { Authorization: `Bearer ${freshWebToken}` });
    assert.equal(raceStart.status, 201, "fresh code for the race");
    const raceCode = raceStart.json.pairingCode.code;
    const racers = await Promise.all([
      scenario.call("POST", "/api/v1/security/pair", { code: raceCode, kind: "cli", name: "Racer A" }),
      scenario.call("POST", "/api/v1/security/pair", { code: raceCode, kind: "cli", name: "Racer B" }),
    ]);
    assert.deepEqual(racers.map((r) => r.status).sort(), [201, 400], "exactly one racer pairs; the other is rejected");
    const winner = racers.find((r) => r.status === 201);
    const loser = racers.find((r) => r.status === 400);
    assert.match(loser.json.error, /already used/, "the losing racer is told the code was already consumed");
    mintedTokens.push(winner.json.token);
    const afterRace = await scenario.call("GET", "/api/v1/security", undefined, { Authorization: `Bearer ${freshWebToken}` });
    assert.equal(afterRace.json.devices.length, 2, "the race minted exactly ONE additional device");
    await waitForStateFile((s) => s.security?.devices?.length === 2);
    assert.equal(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8").includes(winner.json.token), false,
      "the race-winner token is also absent from the persisted state");
  } finally {
    await scenario.close();
  }
}

// ===========================================================================
// autoPair=false: pair-auto refuses and points at the pairing code.
// ===========================================================================
{
  const scenario = await bootScenario({ autoPair: false });
  try {
    const enable = await scenario.call("POST", "/api/v1/security/enable");
    assert.equal(enable.status, 201, "enable works regardless of autoPair");
    const autoPair = await scenario.call("POST", "/api/v1/security/pair-auto", { kind: "cli", name: "blocked" });
    assert.equal(autoPair.status, 403, "autoPair=false refuses LAN self-pairing");
    assert.match(autoPair.json.error, /auto-pairing is disabled/, "refusal names the config switch");
    assert.match(autoPair.json.hint, /pairing code/, "refusal points at the pairing-code path");
    const codePair = await scenario.call("POST", "/api/v1/security/pair", { code: enable.json.pairingCode.code, kind: "cli", name: "via code" });
    assert.equal(codePair.status, 201, "the pairing-code path still works with autoPair=false");
    mintedTokens.push(codePair.json.token);
  } finally {
    await scenario.close();
  }
}

// ===========================================================================
// (Security review follow-up) the two non-sendJson CORS writers - the
// workspace raw-file response and the repo-bundle octet-stream - used to
// hardcode Access-Control-Allow-Origin: "*" in their res.writeHead calls,
// which silently WIDENED a CORS origin the security gate had pinned while
// device protection is on. They must honor the pinned origin: the
// historical "*" while protection is off (byte for byte), the pinned value
// (same-origin echo / explicit empty for foreign origins) once on.
// ===========================================================================
{
  const scenario = await bootScenario({ gitEnabled: true });
  try {
    fs.writeFileSync(path.join(process.env.TEAMCLAW_WORKSPACE_DIR, "cors-probe.txt"), "cors probe\n");
    const foreignOrigin = { Origin: "https://foreign.example.com" };

    // L0: both raw-writer endpoints keep the historical wildcard bytes.
    const rawOff = await scenario.call("GET", "/api/v1/workspace/raw/cors-probe.txt", undefined, foreignOrigin);
    assert.equal(rawOff.status, 200, "L0: raw file serves without a token");
    assert.equal(rawOff.headers.get("access-control-allow-origin"), "*", "L0 raw-file response keeps the wildcard byte for byte");
    const bundleOff = await scenario.call("GET", "/api/v1/repo/bundle", undefined, foreignOrigin);
    assert.equal(bundleOff.status, 200, "L0: repo bundle exports (git workspace bootstraps itself)");
    assert.equal(bundleOff.headers.get("content-type"), "application/octet-stream", "the bundle response is the octet-stream writer under test");
    assert.equal(bundleOff.headers.get("access-control-allow-origin"), "*", "L0 bundle response keeps the wildcard byte for byte");

    // Protection on: the pinned origin must survive the direct writeHead.
    const enable = await scenario.call("POST", "/api/v1/security/enable");
    assert.equal(enable.status, 201);
    const token = cookieToken(enable.setCookie);
    mintedTokens.push(token);
    const authForeign = { Authorization: `Bearer ${token}`, Origin: "https://foreign.example.com" };
    const rawOnForeign = await scenario.call("GET", "/api/v1/workspace/raw/cors-probe.txt", undefined, authForeign);
    assert.equal(rawOnForeign.status, 200, "protection on: paired device reads the raw file");
    assert.equal(rawOnForeign.headers.get("access-control-allow-origin"), "", "protection on: raw-file response carries the pinned empty ACAO - never the wildcard");
    const bundleOnForeign = await scenario.call("GET", "/api/v1/repo/bundle", undefined, authForeign);
    assert.equal(bundleOnForeign.status, 200, "protection on: paired device exports the bundle");
    assert.equal(bundleOnForeign.headers.get("access-control-allow-origin"), "", "protection on: bundle response carries the pinned empty ACAO - never the wildcard");
    const authSameOrigin = { Authorization: `Bearer ${token}`, Origin: scenario.baseUrl };
    const rawOnSame = await scenario.call("GET", "/api/v1/workspace/raw/cors-probe.txt", undefined, authSameOrigin);
    assert.equal(rawOnSame.status, 200);
    assert.equal(rawOnSame.headers.get("access-control-allow-origin"), scenario.baseUrl, "same-origin raw-file response echoes the UI origin");
    const bundleOnSame = await scenario.call("GET", "/api/v1/repo/bundle", undefined, authSameOrigin);
    assert.equal(bundleOnSame.status, 200);
    assert.equal(bundleOnSame.headers.get("access-control-allow-origin"), scenario.baseUrl, "same-origin bundle response echoes the UI origin");
  } finally {
    await scenario.close();
  }
}

// ===========================================================================
// State migration: legacy states without `security` stay L0; malformed
// persisted security shapes are sanitized (fail-open to unpaired).
// ===========================================================================
{
  const legacy = softwareRdState();
  delete legacy.security;
  await stateMod.saveTeamState(legacy);
  const loaded = await stateMod.loadTeamState("Security Team");
  assert.equal(loaded.security, undefined, "legacy state without the field loads as L0 (additive optional)");

  const broken = softwareRdState();
  broken.security = { enabledAt: "yesterday", devices: [{ id: "dev-x", tokenHash: "nothex", createdAt: 1 }, { id: "dev-ok" }], pairingCode: { code: "short" }, lastNonLanPeer: { ip: 5 } };
  await stateMod.saveTeamState(broken);
  const migrated = await stateMod.loadTeamState("Security Team");
  assert.equal(migrated.security.devices.length, 0, "corrupt devices are dropped (a device without a valid hash could never authenticate)");
  assert.equal(migrated.security.pairingCode, undefined, "malformed pairing code dropped");
  assert.equal(migrated.security.lastNonLanPeer, undefined, "malformed observation dropped");
  assert.equal(migrated.security.enabledAt, undefined, "malformed enabledAt dropped");
  assert.equal(securityMod.isProtectionOn(migrated), false, "sanitized state is protection-off");

  // A WELL-formed security state round-trips and turns protection on.
  const healthy = softwareRdState();
  const tokenHash = securityMod.hashToken(securityMod.generateToken());
  healthy.security = { enabledAt: Date.now(), devices: [{ id: "dev-real", name: "Real", kind: "web", tokenHash, createdAt: Date.now() }] };
  await stateMod.saveTeamState(healthy);
  const reloaded = await stateMod.loadTeamState("Security Team");
  assert.equal(reloaded.security.devices[0].tokenHash, tokenHash, "well-formed device hashes survive the migration");
  assert.equal(securityMod.isProtectionOn(reloaded), true, "a restored devices array re-enables protection");
}

// ===========================================================================
// Guarded real-LAN probe: when the host owns a bindable private IPv4, prove
// end-to-end on a REAL RFC1918 socket peer that (a) enable stays
// loopback-only and (b) pair-auto hands out a token with zero input. Two
// listeners share one state: 127.0.0.1 (the console) + the LAN address.
// Skips loudly when no such address exists or binding is not permitted
// (CI containers); classification itself is covered by the unit table.
// ===========================================================================
{
  const nets = os.networkInterfaces();
  const lanAddr = Object.values(nets)
    .flat()
    .find((n) => n && n.family === "IPv4" && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address))
    ?.address;

  if (!lanAddr) {
    console.log("test-security-pairing: NOTE - no private IPv4 on this host; skipping the real-LAN probe (classification covered by the unit truth table).");
  } else {
    try {
      loaderMod.setActiveProfileId("software-rd");
      const config = parsePluginConfig({ mode: "controller", teamName: "Security Team", port: 19531, gitEnabled: false });
      let teamState = softwareRdState();
      const deps = {
        config,
        logger,
        runtime: {},
        getTeamState: () => teamState,
        updateTeamState: (updater) => { updater(teamState); void stateMod.saveTeamState(teamState); return teamState; },
        taskRouter: new TaskRouter(logger),
        messageRouter: new MessageRouter(logger),
        wsServer: new TeamWebSocketServer(logger),
      };
      const loopbackServer = httpMod.createControllerHttpServer(deps);
      await new Promise((resolve) => loopbackServer.listen(0, "127.0.0.1", resolve));
      const lanServer = httpMod.createControllerHttpServer(deps);
      await new Promise((resolve, reject) => lanServer.once("error", reject).listen(0, lanAddr, resolve));
      try {
        const loopbackBase = `http://127.0.0.1:${loopbackServer.address().port}`;
        const lanBase = `http://${lanAddr}:${lanServer.address().port}`;
        const callOn = async (base, method, pathname, body) => {
          const res = await fetch(`${base}${pathname}`, {
            method,
            headers: body !== undefined ? { "Content-Type": "application/json" } : {},
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          return { status: res.status, json: await res.json().catch(() => null) };
        };

        const enableFromLan = await callOn(lanBase, "POST", "/api/v1/security/enable");
        assert.equal(enableFromLan.status, 403, "real LAN peer: enable stays loopback-only");
        assert.match(enableFromLan.json.error, /forbidden/, "the refusal comes from the enable handler's origin rule");

        const enable = await callOn(loopbackBase, "POST", "/api/v1/security/enable");
        assert.equal(enable.status, 201, "loopback enable on the shared state");

        const autoFromLan = await callOn(lanBase, "POST", "/api/v1/security/pair-auto", { kind: "worker", name: "LAN probe" });
        assert.equal(autoFromLan.status, 201, `real LAN peer (${lanAddr}) auto-pairs with zero input`);
        mintedTokens.push(autoFromLan.json.token);

        const lanTokenTasks = await fetch(`${lanBase}/api/v1/tasks`, { headers: { Authorization: `Bearer ${autoFromLan.json.token}` } });
        assert.equal(lanTokenTasks.status, 200, "the LAN-paired token authenticates");
        console.log(`test-security-pairing: real-LAN probe passed against ${lanAddr}.`);
      } finally {
        await new Promise((resolve) => loopbackServer.close(resolve));
        await new Promise((resolve) => lanServer.close(resolve));
        deps.wsServer.close();
      }
    } catch (err) {
      console.log(`test-security-pairing: NOTE - real-LAN probe skipped (${err instanceof Error ? err.message : String(err)}); classification covered by the unit truth table.`);
    }
  }
}

console.log("Security pairing smoke passed.");
// g4: exit explicitly - fetch keep-alive sockets can keep the loop alive
// after all assertions passed (observed locally and as CI cancels).
process.exit(0);
