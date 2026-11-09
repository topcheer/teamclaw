#!/usr/bin/env node
// Issue #222 (coordinated new scope after #23/#227): worker inbound API
// auth + controller->worker dispatch tokens + L0 tunnel-creation origin
// tightening. Dist-level tests against the real compiled modules (run
// `npm --prefix src run build` first).
//
// Covers:
//   1. Token model units: resolveWorkerInboundTokens (config.securityToken
//      and/or the provisioner's TEAMCLAW_LAUNCH_TOKEN env; none = L0) and
//      resolveWorkerDispatchToken / withWorkerDispatchToken (provisioning
//      record launchToken first, controller securityToken fallback, else no
//      header).
//   2. Worker inbound gate on a REAL worker HTTP handler (dist
//      http-handler.js behind http.createServer):
//      L0 = zero change (every route open, stray tokens ignored); with an
//      expected token = missing/wrong X-TeamClaw-Token 401, correct token
//      200/201/202, /api/v1/health stays exempt (kubelet/docker probes
//      cannot send headers), both accepted token sources validate.
//   3. Controller->worker dispatch carries the token end to end:
//      deliverMessageToWorker and cancelTaskExecution against a live
//      token-paired worker - correct provisioning-record token passes,
//      wrong token is refused by the worker (401 surfaces at the call
//      site), L0 workers keep accepting.
//   4. Tunnel start origin matrix (issue #222 item 2): in L0 the three
//      /api/v1/tunnel/start* endpoints accept only loopback/LAN socket
//      peers (public IPv4/IPv6/unknown origin 403 with the operate-from-
//      the-controller-host hint); while protection is on the device gate
//      stays the governing rule (paired devices keep sharing). Includes a
//      real-server pass: loopback reaches the handler (GitHub-login 401,
//      not the origin 403) and a via-tunnel Host is stopped by the tunnel
//      gate before the management table.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ---------------------
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-worker-auth-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-worker-auth-ws-"));
delete process.env.TEAMCLAW_LAUNCH_TOKEN; // deterministic L0 baseline for the unit pins

const logger = { infos: [], warns: [], errors: [], info(e) { this.infos.push(e); }, warn(e) { this.warns.push(e); }, error(e) { this.errors.push(e); }, debug() {} };

const workerHandlerMod = await dist("worker/http-handler.js");
const messageQueueMod = await dist("worker/message-queue.js");
const taskExecutionMod = await dist("controller/task-execution.js");
const messageDeliveryMod = await dist("controller/message-delivery.js");
const routeTableMod = await dist("controller/route-table.js");
const stateMod = await dist("state.js");
const typesMod = await dist("types.js");

// ===========================================================================
// 1. Token model units
// ===========================================================================
{
  const { resolveWorkerInboundTokens } = workerHandlerMod;

  assert.deepEqual(resolveWorkerInboundTokens({}), [], "no config token + no launch env = L0 (no expected tokens)");
  assert.deepEqual(resolveWorkerInboundTokens({ securityToken: "   " }), [], "whitespace-only securityToken trims to nothing (L0)");

  assert.deepEqual(resolveWorkerInboundTokens({ securityToken: "cfg-token" }), ["cfg-token"], "config.securityToken is an expected inbound token");

  process.env.TEAMCLAW_LAUNCH_TOKEN = "launch-token";
  try {
    assert.deepEqual(resolveWorkerInboundTokens({}), ["launch-token"], "the provisioner's TEAMCLAW_LAUNCH_TOKEN env alone arms the inbound gate");
    assert.deepEqual(
      resolveWorkerInboundTokens({ securityToken: "cfg-token" }),
      ["cfg-token", "launch-token"],
      "both sources arm the gate together (either may authenticate)",
    );
  } finally {
    delete process.env.TEAMCLAW_LAUNCH_TOKEN;
  }

  const { resolveWorkerDispatchToken, withWorkerDispatchToken } = taskExecutionMod;
  const provisioningState = {
    provisioning: { workers: { "provisioned-dev-1": { launchToken: "record-token" } } },
  };
  const controllerCfg = { securityToken: "shared-manual-token" };

  assert.equal(resolveWorkerDispatchToken("provisioned-dev-1", controllerCfg, provisioningState), "record-token",
    "provisioning-record launchToken wins (provisioned fleets, decoupled from the device registry)");
  assert.equal(resolveWorkerDispatchToken("manual-worker", controllerCfg, provisioningState), "shared-manual-token",
    "manual/external workers fall back to the controller's securityToken (the operator syncs both ends)");
  assert.equal(resolveWorkerDispatchToken("manual-worker", { securityToken: "" }, provisioningState), undefined,
    "no record + empty controller token = no dispatch token (L0)");
  assert.equal(resolveWorkerDispatchToken("manual-worker", { securityToken: "  " }, null), undefined,
    "whitespace controller token trims to no dispatch token");

  assert.deepEqual(withWorkerDispatchToken({ "Content-Type": "application/json" }, "provisioned-dev-1", controllerCfg, provisioningState), {
    "Content-Type": "application/json",
    "X-TeamClaw-Token": "record-token",
  }, "withWorkerDispatchToken attaches X-TeamClaw-Token with the resolved value");
  assert.deepEqual(withWorkerDispatchToken({ "Content-Type": "application/json" }, "unknown", { securityToken: "" }, null), {
    "Content-Type": "application/json",
  }, "L0 keeps the historical header set byte for byte (no token header)");
}

// ===========================================================================
// 2/3. Real worker handler harness: boot the dist http-handler behind a real
// http.Server and drive controller-side dispatch helpers against it.
// ===========================================================================
function bootWorkerServer(handlerConfig, extras = {}) {
  const cancelled = [];
  const handler = workerHandlerMod.createWorkerHttpHandler(
    handlerConfig,
    logger,
    new messageQueueMod.MessageQueue(),
    extras.workerId ?? "worker-test-1",
    undefined, // taskExecutor: assign is accepted (202) without executing
    undefined, // resultReporter
    extras.canceller ?? ((taskId) => { cancelled.push(taskId); return true; }),
  );
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        cancelled,
        async close() { await new Promise((done) => server.close(done)); },
      });
    });
  });
}

const callWorker = async (base, method, pathname, body, headers = {}) => {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};

// --- 2a. L0: zero change ----------------------------------------------------
{
  const worker = await bootWorkerServer({ role: "dev", port: 19540 });
  try {
    const health = await callWorker(worker.baseUrl, "GET", "/api/v1/health");
    assert.equal(health.status, 200, "L0 worker: health open");
    const assign = await callWorker(worker.baseUrl, "POST", "/api/v1/tasks/assign", { taskId: "t1", title: "T", description: "D" });
    assert.equal(assign.status, 202, "L0 worker: task assignment accepted without a token");
    const msg = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "hi" });
    assert.equal(msg.status, 201, "L0 worker: message injection accepted without a token");
    const drain = await callWorker(worker.baseUrl, "GET", "/api/v1/messages");
    assert.equal(drain.status, 200, "L0 worker: message drain open");
    // A stray token header must never REJECT on an unpaired worker: the
    // controller may know a provisioning record while the worker itself
    // stayed L0 (e.g. older worker image).
    const stray = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "again" }, { "X-TeamClaw-Token": "some-stale-token" });
    assert.equal(stray.status, 201, "L0 worker: a presented-but-unexpected token header is ignored, not rejected");
  } finally {
    await worker.close();
  }
}

// --- 2b. config.securityToken arms the inbound gate --------------------------
{
  const TOKEN = "6".repeat(64);
  const worker = await bootWorkerServer({ role: "dev", port: 19541, securityToken: TOKEN });
  try {
    const health = await callWorker(worker.baseUrl, "GET", "/api/v1/health");
    assert.equal(health.status, 200, "health stays exempt (kubelet/docker probes cannot send headers)");

    const noHeader = await callWorker(worker.baseUrl, "POST", "/api/v1/tasks/assign", { taskId: "t1", title: "T", description: "D" });
    assert.equal(noHeader.status, 401, "tokenless assignment is 401 on a paired worker");
    assert.match(noHeader.json.error, /unauthorized.*X-TeamClaw-Token/, "401 body names the required header");

    const wrong = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "x" }, { "X-TeamClaw-Token": "f".repeat(64) });
    assert.equal(wrong.status, 401, "wrong token is 401");

    const drainBlocked = await callWorker(worker.baseUrl, "GET", "/api/v1/messages");
    assert.equal(drainBlocked.status, 401, "GET /messages (drain) is protected too");
    const kickoffBlocked = await callWorker(worker.baseUrl, "POST", "/api/v1/kickoff/assess", { requirement: "r" });
    assert.equal(kickoffBlocked.status, 401, "kickoff assessment is protected too");

    const ok = await callWorker(worker.baseUrl, "POST", "/api/v1/tasks/assign", { taskId: "t2", title: "T", description: "D" }, { "X-TeamClaw-Token": TOKEN });
    assert.equal(ok.status, 202, "correct token authenticates the assignment");
    const msgOk = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "hi" }, { "X-TeamClaw-Token": TOKEN });
    assert.equal(msgOk.status, 201, "correct token authenticates message injection");
    const drainOk = await callWorker(worker.baseUrl, "GET", "/api/v1/messages", undefined, { "X-TeamClaw-Token": TOKEN });
    assert.equal(drainOk.status, 200, "correct token authenticates the drain");
  } finally {
    await worker.close();
  }
}

// --- 2c. the provisioner's TEAMCLAW_LAUNCH_TOKEN env arms the gate too -------
// (resolveWorkerInboundTokens is consulted at handler creation, so set the
// env before booting; both accepted sources must validate when both exist.)
{
  process.env.TEAMCLAW_LAUNCH_TOKEN = "launch-secret-1";
  try {
    const worker = await bootWorkerServer({ role: "dev", port: 19542, securityToken: "config-secret-1" });
    try {
      const blocked = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "x" });
      assert.equal(blocked.status, 401, "launch-token worker rejects tokenless calls");

      const viaLaunch = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "x" }, { "X-TeamClaw-Token": "launch-secret-1" });
      assert.equal(viaLaunch.status, 201, "the launch token authenticates (provisioned-worker path)");
      const viaConfig = await callWorker(worker.baseUrl, "POST", "/api/v1/messages", { from: "controller", content: "x" }, { "X-TeamClaw-Token": "config-secret-1" });
      assert.equal(viaConfig.status, 201, "the config token also authenticates (pairing later must not lock the controller out)");
    } finally {
      await worker.close();
    }

    const workerEnvOnly = await bootWorkerServer({ role: "dev", port: 19543 });
    try {
      const blocked = await callWorker(workerEnvOnly.baseUrl, "GET", "/api/v1/messages");
      assert.equal(blocked.status, 401, "env-token-only worker is protected with zero worker config changes");
      const ok = await callWorker(workerEnvOnly.baseUrl, "GET", "/api/v1/messages", undefined, { "X-TeamClaw-Token": "launch-secret-1" });
      assert.equal(ok.status, 200, "launch token authenticates on the env-only worker");
    } finally {
      await workerEnvOnly.close();
    }
  } finally {
    delete process.env.TEAMCLAW_LAUNCH_TOKEN;
  }
}

// --- 3. Controller -> worker dispatch carries the token end to end -----------
{
  const config = typesMod.parsePluginConfig({ mode: "controller", teamName: "Worker Auth Team", port: 19544, gitEnabled: false });
  const workerInfo = (url) => ({
    id: "provisioned-dev-1",
    role: "dev",
    label: "Dev",
    status: "idle",
    url,
    lastHeartbeat: Date.now(),
    capabilities: [],
    registeredAt: Date.now(),
  });
  const stateWithRecord = (launchToken) => ({
    workers: { "provisioned-dev-1": workerInfo("http://127.0.0.1:1") },
    provisioning: { workers: { "provisioned-dev-1": { launchToken } } },
  });
  const depsFor = (teamState) => ({
    config,
    logger,
    getTeamState: () => teamState,
    // cancelTaskExecution records a lifecycle event on success; give the
    // state mutator + WS broadcaster the same in-memory semantics as the
    // controller (the broadcast target is irrelevant to these assertions).
    updateTeamState: (updater) => { updater(teamState); return teamState; },
    wsServer: { broadcastUpdate() {} },
  });

  const message = { from: "controller", content: "sync please", taskId: null };

  // Correct provisioning-record token: the worker accepts the injection.
  const paired = await bootWorkerServer({ role: "dev", port: 19545, securityToken: "record-token" });
  try {
    await messageDeliveryMod.deliverMessageToWorker(workerInfo(paired.baseUrl), message, depsFor(stateWithRecord("record-token")));
    // deliverMessageToWorker resolves only on a 2xx - reaching here means the
    // header was presented AND accepted by the real worker gate.
    const wrongState = stateWithRecord("not-the-token");
    await assert.rejects(
      () => messageDeliveryMod.deliverMessageToWorker(workerInfo(paired.baseUrl), message, depsFor(wrongState)),
      /responded with 401/,
      "a wrong dispatch token surfaces as the worker's 401 at the call site",
    );
    // L0 worker: the header is sent (record known) but must not be required.
    const open = await bootWorkerServer({ role: "dev", port: 19546 });
    try {
      await messageDeliveryMod.deliverMessageToWorker(workerInfo(open.baseUrl), message, depsFor(stateWithRecord("record-token")));
    } finally {
      await open.close();
    }
  } finally {
    await paired.close();
  }

  // cancelTaskExecution: the canceller runs only when the worker accepts the
  // token-bearing cancel call (200), never on the 401 path. The worker is
  // resolved FROM TEAM STATE here, so the state's worker URL must point at
  // the booted server.
  const cancelWorker = await bootWorkerServer({ role: "dev", port: 19547, securityToken: "record-token" });
  try {
    const cancelState = stateWithRecord("record-token");
    cancelState.workers["provisioned-dev-1"] = workerInfo(cancelWorker.baseUrl);
    cancelState.tasks = { "task-cancel-1": { id: "task-cancel-1", title: "T", status: "in_progress" } };
    await taskExecutionMod.cancelTaskExecution("task-cancel-1", "provisioned-dev-1", "reassignment", depsFor(cancelState));
    assert.deepEqual(cancelWorker.cancelled, ["task-cancel-1"], "cancel with the correct dispatch token reaches the worker canceller");

    cancelWorker.cancelled.length = 0;
    const badCancelState = stateWithRecord("not-the-token");
    badCancelState.workers["provisioned-dev-1"] = workerInfo(cancelWorker.baseUrl);
    badCancelState.tasks = { "task-cancel-2": { id: "task-cancel-2", title: "T", status: "in_progress" } };
    await taskExecutionMod.cancelTaskExecution("task-cancel-2", "provisioned-dev-1", "reassignment", depsFor(badCancelState));
    assert.deepEqual(cancelWorker.cancelled, [], "cancel with a wrong dispatch token is refused by the worker (canceller never runs)");
  } finally {
    await cancelWorker.close();
  }
}

// ===========================================================================
// 4. Tunnel start origin matrix (issue #222 item 2)
// ===========================================================================
function fakeTunnelManager() {
  const calls = { start: 0, startQuick: 0, startSelfHosted: 0 };
  return {
    calls,
    status: () => ({ active: false }),
    start: () => { calls.start += 1; return { launched: true }; },
    startSelfHosted: () => { calls.startSelfHosted += 1; return { launched: true }; },
    startQuick: () => { calls.startQuick += 1; return { launched: true }; },
    isTunnelRequest: () => false,
    gateAllows: () => false,
  };
}

function fakeRes() {
  const out = { status: 0, body: "", headers: {} };
  const res = {
    setHeader() {},
    getHeader() { return undefined; },
    writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers ?? {}); },
    end(body) { out.body = String(body ?? ""); },
  };
  return { res, out };
}

function fakeReq(remoteAddress) {
  return {
    method: "POST",
    headers: { host: "127.0.0.1:19527" },
    url: "/api/v1/tunnel/start-quick",
    socket: remoteAddress === undefined ? {} : { remoteAddress },
    async *[Symbol.asyncIterator]() { /* empty body */ },
  };
}

async function dispatchTunnelRoute(deps, pathname, remoteAddress) {
  const manager = fakeTunnelManager();
  const routes = routeTableMod.createTunnelManagementRoutes(manager, deps);
  const route = routes.find((r) => r.method === "POST" && r.path === pathname);
  assert.ok(route, `route ${pathname} exists`);
  const { res, out } = fakeRes();
  const req = fakeReq(remoteAddress);
  req.url = pathname;
  await route.handler({
    req,
    res,
    requestUrl: new URL(`http://127.0.0.1${pathname}`),
    pathname,
    deps,
    currentState: null,
  });
  return { out, manager };
}

{
  const config = typesMod.parsePluginConfig({ mode: "controller", teamName: "Tunnel Gate Team", port: 19527, gitEnabled: false });
  const l0Deps = { config, logger, getTeamState: () => ({ workers: {}, tasks: {}, provisioning: { workers: {} } }) };

  // Allowed origins in L0: loopback + LAN (RFC1918/ULA/link-local), both
  // plain and IPv4-mapped forms.
  for (const allowed of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "192.168.1.23", "10.1.2.3", "172.20.0.9", "::ffff:10.1.2.3", "fe80::1", "fd00::5"]) {
    const { out, manager } = await dispatchTunnelRoute(l0Deps, "/api/v1/tunnel/start-quick", allowed);
    assert.equal(out.status, 202, `L0: start-quick from ${allowed} (loopback/LAN) reaches the tunnel manager`);
    assert.equal(manager.calls.startQuick, 1, `L0: ${allowed} actually launched`);
  }

  // Public / unknown origins in L0: refused with the operate-locally hint,
  // on ALL THREE creation endpoints; the manager never runs.
  for (const refused of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "11.0.0.1", "2001:db8::1", "2606:4700::1", undefined]) {
    for (const pathname of ["/api/v1/tunnel/start-quick", "/api/v1/tunnel/start", "/api/v1/tunnel/start-self-hosted"]) {
      const { out, manager } = await dispatchTunnelRoute(l0Deps, pathname, refused);
      assert.equal(out.status, 403, `L0: ${pathname} from ${refused ?? "unknown socket"} is 403`);
      const body = JSON.parse(out.body);
      assert.equal(body.error, "forbidden", `${pathname}: refusal error code`);
      assert.match(body.hint, /controller host|device pairing/, `${pathname}: hint tells the caller to operate from the controller host / pair a device`);
      assert.equal(manager.calls.start + manager.calls.startQuick + manager.calls.startSelfHosted, 0,
        `${pathname}: the tunnel manager never runs for ${refused ?? "unknown"}`);
    }
  }

  // start-quick vs start-self-hosted divergence for allowed origins proves
  // the guard passes them THROUGH to the endpoint's own validation.
  const selfHostedLocal = await dispatchTunnelRoute(l0Deps, "/api/v1/tunnel/start-self-hosted", "127.0.0.1");
  assert.equal(selfHostedLocal.out.status, 400, "L0 loopback start-self-hosted passes the origin gate and hits its own token validation");
  assert.match(JSON.parse(selfHostedLocal.out.body).error, /connector token required/, "the 400 is the connector-token error, not the origin refusal");
  const githubStartLocal = await dispatchTunnelRoute(l0Deps, "/api/v1/tunnel/start", "127.0.0.1");
  assert.equal(githubStartLocal.out.status, 401, "L0 loopback /tunnel/start passes the origin gate and hits the GitHub-login requirement");
  assert.match(JSON.parse(githubStartLocal.out.body).error, /GitHub login required/, "the 401 is the GitHub-login error, not the origin refusal");

  // Protection ON: the device gate (#23) is the governing rule - the origin
  // restriction must NOT pile on top of it for paired remote devices.
  const protectedDeps = {
    config,
    logger,
    getTeamState: () => ({
      workers: {},
      tasks: {},
      provisioning: { workers: {} },
      security: { enabledAt: Date.now(), devices: [{ id: "dev-1", name: "Web", kind: "web", tokenHash: "a".repeat(64), createdAt: Date.now() }] },
    }),
  };
  const remotePaired = await dispatchTunnelRoute(protectedDeps, "/api/v1/tunnel/start-quick", "8.8.8.8");
  assert.equal(remotePaired.out.status, 202, "protection on: a (gate-authenticated) remote device keeps the ability to share - origin rule steps aside");
  assert.equal(remotePaired.manager.calls.startQuick, 1, "protection on: the manager launched for the remote paired caller");
}

// --- 4b. Real-server pass: the guard inside the full http pipeline ----------
{
  const httpMod = await dist("controller/http-server.js");
  const { TaskRouter } = await dist("controller/task-router.js");
  const { MessageRouter } = await dist("controller/message-router.js");
  const { TeamWebSocketServer } = await dist("controller/websocket.js");
  const loaderMod = await dist("profile-loader.js");

  loaderMod.setActiveProfileId("software-rd");
  const config = typesMod.parsePluginConfig({ mode: "controller", teamName: "Tunnel E2E Team", port: 19528, gitEnabled: false });
  let teamState = {
    version: 2, profileId: "software-rd", teamName: "Tunnel E2E Team",
    workers: {}, tasks: {}, controllerRuns: {}, projects: {}, messages: [], clarifications: {},
    provisioning: { workers: {} }, createdAt: Date.now() - 1000, updatedAt: Date.now(),
  };
  const deps = {
    config, logger, runtime: {},
    getTeamState: () => teamState,
    updateTeamState: (updater) => { updater(teamState); void stateMod.saveTeamState(teamState); return teamState; },
    taskRouter: new TaskRouter(logger),
    messageRouter: new MessageRouter(logger),
    wsServer: new TeamWebSocketServer(logger),
  };
  const server = httpMod.createControllerHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = (method, pathname, body, headers = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({
    status: res.status,
    headers: res.headers,
    json: await res.json().catch(() => null),
    text: await res.text().catch(() => ""),
  }));
  // Same via-tunnel simulation as test-security-pairing.mjs: undici's fetch
  // ignores Host overrides, so go through node:http where it is settable.
  const callViaTunnelHost = (method, pathname, body) => new Promise((resolve, reject) => {
    const req = http.request(baseUrl, {
      method,
      path: pathname,
      headers: { Host: "attacker.apps.teamclaw.dev", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

  try {
    // L0 + loopback: reaches the handler (GitHub-login 401), not the 403.
    const loopbackStart = await call("POST", "/api/v1/tunnel/start", {});
    assert.equal(loopbackStart.status, 401, "L0 loopback /tunnel/start passes the origin gate (GitHub-login 401 is the next check)");
    assert.match(loopbackStart.json.error, /GitHub login required/, "the refusal is the GitHub gate, proving the origin rule let loopback through");

    // L0 + tunnel source: the tunnel gate stops it before the management
    // table - a public/tunneled origin can never create tunnels in L0.
    const tunneledQuick = await callViaTunnelHost("POST", "/api/v1/tunnel/start-quick", {});
    assert.equal(tunneledQuick.status, 403, "via-tunnel start-quick is blocked (tunnel gate page)");
    assert.match(tunneledQuick.text, /TeamClaw Tunnel/, "the 403 is the tunnel gate page, not a tunnel creation");

    // Protection on: enable from loopback, then the paired device's request
    // still reaches the handler (origin rule does not stack on device auth).
    const enable = await call("POST", "/api/v1/security/enable", {});
    assert.equal(enable.status, 201, "loopback enable for the protected leg");
    const webToken = /teamclaw_session=([^;]+)/.exec(enable.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(webToken, "enable produced a device credential (session cookie)");
    const unauthStart = await call("POST", "/api/v1/tunnel/start", {});
    assert.equal(unauthStart.status, 401, "protection on: tokenless tunnel start is 401 (device gate)");
    const authStart = await call("POST", "/api/v1/tunnel/start", {}, { Authorization: `Bearer ${webToken}` });
    assert.equal(authStart.status, 401, "protection on: paired device passes the device gate AND the origin rule (GitHub-login 401 is next)");
    assert.match(authStart.json.error, /GitHub login required/, "the paired device's refusal is the GitHub gate, not the origin rule");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    deps.wsServer.close();
  }
}

console.log("Worker auth + tunnel origin smoke passed.");
