#!/usr/bin/env node
// ClawHub security review 2026.11.7 - second-round findings (dist-level):
//   1. self-hosted tunnel traffic (Cloudflare edge headers, custom hostname)
//      must authenticate with a device token, never inherit loopback trust
//   2. preview proxy must not forward controller credentials to the preview
//      subprocess (nor plant its cookies on the controller origin); preview
//      HTML runs under a sandbox CSP
//   3. browser WebSocket upgrades carry an Origin that must match the host
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-r2-state-"));
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");

const securityMod = await dist("controller/security.js");
const previewMod = await dist("controller/preview-proxy.js");

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeRes() {
  const out = { status: 0, body: null, headers: {}, chunks: [] };
  return {
    out,
    getHeader: (n) => out.headers[String(n).toLowerCase()],
    setHeader: (n, v) => { out.headers[String(n).toLowerCase()] = v; },
    writeHead(status, headers) {
      out.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) out.headers[String(k).toLowerCase()] = v;
    },
    end(chunk) {
      if (chunk) {
        out.chunks.push(String(chunk));
        try { out.body = JSON.parse(String(chunk)); } catch { /* html */ }
      }
    },
    // preview proxy passthrough branch pipes into res
    write(chunk, _enc, cb) { out.chunks.push(Buffer.from(chunk).toString("utf8")); if (cb) cb(); return true; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
    get headersSent() { return out.status !== 0; },
  };
}

function stateWithDevice(tokenHash = "a".repeat(64)) {
  return {
    teamName: "t", profileId: "software-rd", version: 1,
    workers: {}, tasks: {}, controllerRuns: {}, projects: {}, messages: [],
    clarifications: {}, previews: {}, reports: {}, createdAt: 0, updatedAt: 0,
    security: { enabledAt: Date.now(), devices: [{ id: "dev-1", name: "Web", kind: "web", tokenHash, createdAt: Date.now() }] },
  };
}

function middlewareDeps(state, tunnelMode) {
  return {
    config: { security: { autoPair: false } },
    logger,
    getTeamState: () => state,
    updateTeamState: (fn) => fn(state),
    ...(tunnelMode ? { tunnelMode: () => tunnelMode } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Cloudflare edge header detection (unit)
// ---------------------------------------------------------------------------
{
  assert.equal(securityMod.hasCloudflareEdgeHeaders({ headers: {} }), false, "no CF headers -> not tunnel traffic");
  assert.equal(securityMod.hasCloudflareEdgeHeaders({ headers: { "cf-connecting-ip": "203.0.113.9" } }), true, "cf-connecting-ip marks edge traffic");
  assert.equal(securityMod.hasCloudflareEdgeHeaders({ headers: { "cf-ray": "abc" } }), true, "cf-ray marks edge traffic");
  assert.equal(securityMod.hasCloudflareEdgeHeaders({ headers: { "cf-worker": "x" } }), true, "cf-worker marks edge traffic");
  assert.equal(securityMod.hasCloudflareEdgeHeaders({ headers: { "x-forwarded-for": "1.2.3.4" } }), false, "plain forwarding headers are client-controlled and must NOT count");
}

// ---------------------------------------------------------------------------
// 2. WebSocket Origin policy (unit)
// ---------------------------------------------------------------------------
{
  const ok = (origin) => securityMod.isAllowedWebSocketOrigin({ headers: { host: "127.0.0.1:9527", ...(origin ? { origin } : {}) } });
  assert.equal(ok(undefined), true, "no Origin (non-browser client) is allowed");
  assert.equal(ok("http://127.0.0.1:9527"), true, "same host http origin is allowed");
  assert.equal(ok("http://127.0.0.1:9527/anything"), true, "origin path is irrelevant, only scheme+host matter");
  assert.equal(ok("https://team.example.dev"), false, "cross-site origin is rejected");
  assert.equal(ok("http://127.0.0.1:9528"), false, "same hostname but different port is a different origin");
  assert.equal(ok("null"), false, "opaque origin string is rejected");
  assert.equal(securityMod.isAllowedWebSocketOrigin({ headers: { origin: "http://x" } }), false, "Origin without a Host header is rejected");
}

// ---------------------------------------------------------------------------
// 3. Device gate: self-hosted tunnel visitors need a device token
// ---------------------------------------------------------------------------
{
  const token = "b".repeat(64);
  const state = stateWithDevice(securityMod.hashToken(token));
  const peerViaTunnel = { ip: "127.0.0.1", viaTunnel: true, loopback: false, lan: false };
  const req = (tok) => ({ method: "GET", url: "/api/v1/tasks", headers: tok ? { authorization: `Bearer ${tok}` } : {}, socket: { remoteAddress: "127.0.0.1" } });

  // self-hosted: no token -> 401 (was: loopback/viaTunnel exemption returned true)
  const gateSelf = securityMod.createSecurityMiddleware(middlewareDeps(state, "self-hosted"));
  const denied = fakeRes();
  assert.equal(gateSelf(req(null), denied, "/api/v1/tasks", peerViaTunnel), false, "self-hosted tunnel visitor WITHOUT a device token is rejected by the device gate (finding 1)");
  assert.equal(denied.out.status, 401, "the rejection is a 401 pointing at pairing");
  const allowed = fakeRes();
  assert.equal(gateSelf(req(token), allowed, "/api/v1/tasks", peerViaTunnel), true, "self-hosted tunnel visitor WITH a valid device token passes");
  assert.equal(allowed.out.status, 0, "an allowed request writes nothing");

  // managed tunnel (gate cookie governs) keeps the viaTunnel exemption
  const gateManaged = securityMod.createSecurityMiddleware(middlewareDeps(state, "managed"));
  const managed = fakeRes();
  assert.equal(gateManaged(req(null), managed, "/api/v1/tasks", peerViaTunnel), true, "managed-tunnel visitors stay exempt here (the gate cookie governs them downstream)");

  // self-hosted but protection OFF: unchanged L0 open door
  const l0 = securityMod.createSecurityMiddleware(middlewareDeps({ ...state, security: undefined }, "self-hosted"));
  assert.equal(l0(req(null), fakeRes(), "/api/v1/tasks", peerViaTunnel), true, "protection off keeps L0 for self-hosted as well");
}

// ---------------------------------------------------------------------------
// 4. WS guard: self-hosted requires a device token; cross-site Origin rejected
// ---------------------------------------------------------------------------
{
  const token = "c".repeat(64);
  const state = stateWithDevice(securityMod.hashToken(token));
  const deps = (mode) => ({
    ...middlewareDeps(state, mode),
    isTunnelHost: () => false,
    viaTunnelRequest: (r) => securityMod.hasCloudflareEdgeHeaders(r),
    gateAllows: () => false,
  });
  const upgrade = (tok, extraHeaders = {}) => ({
    url: "/ws",
    headers: { host: "custom.example.dev", "cf-connecting-ip": "203.0.113.9", ...(tok ? { cookie: `teamclaw_session=${tok}` } : {}), ...extraHeaders },
    socket: { remoteAddress: "127.0.0.1" },
  });

  const guardSelf = securityMod.createWebSocketUpgradeGuard(deps("self-hosted"));
  assert.equal(guardSelf(upgrade(null)), false, "self-hosted WS upgrade without a device token is rejected (finding 1)");
  assert.equal(guardSelf(upgrade(token)), true, "self-hosted WS upgrade with the session cookie succeeds");
  assert.equal(guardSelf(upgrade(token, { origin: "https://evil.example.net" })), false, "cross-site Origin is rejected before any token check (finding 3)");
  assert.equal(guardSelf(upgrade(token, { origin: "https://custom.example.dev" })), true, "same-host Origin (the tunnel hostname) passes the Origin policy");

  // managed tunnel: gate cookie governs, Origin still enforced
  const guardManaged = securityMod.createWebSocketUpgradeGuard(deps("managed"));
  assert.equal(guardManaged(upgrade(null)), false, "managed-tunnel WS without gate cookie is still rejected");
  assert.equal(guardManaged(upgrade(null, { origin: "https://evil.example.net" })), false, "managed-tunnel WS with cross-site Origin is rejected (finding 3)");
  assert.equal(guardManaged(upgrade(null, { origin: "https://custom.example.dev" })), false, "same-host Origin does not bypass the gate cookie");
}

// ---------------------------------------------------------------------------
// 5. Preview proxy: credential stripping + sandbox CSP (real upstream echo)
// ---------------------------------------------------------------------------
{
  const seen = { headers: null };
  const upstream = http.createServer((req, res) => {
    seen.headers = req.headers;
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "preview_sid=abc; Path=/" });
      res.end("<html><a href=\"/x\">x</a></html>");
    } else if (req.url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "preview_sid=abc; Path=/" });
      res.end("{\"ok\":true}");
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  try {
    const state = { ...stateWithDevice(), previews: { pv1: { id: "pv1", status: "healthy", targetPort: port } } };
    const deps = { logger, getTeamState: () => state };
    const mkReq = (headers) => {
      const req = new PassThrough();
      req.headers = headers;
      req.method = "GET";
      req.socket = { remoteAddress: "127.0.0.1" };
      return req;
    };
    const run = (urlPath, headers) => new Promise((resolve) => {
      const res = fakeRes();
      // the proxy pipes the upstream body for non-HTML responses
      res.pipe = (src) => { src.on("data", (c) => res.out.chunks.push(c.toString("utf8"))); src.on("end", () => resolve(res)); return res; };
      res.end = ((orig) => (chunk) => { orig(chunk); resolve(res); })(res.end.bind(res));
      const req = mkReq(headers);
      previewMod.handlePreviewProxyRequest(deps, req, res, new URL(`http://127.0.0.1${urlPath}`), `/api/v1/previews/pv1${urlPath}`);
      // a PassThrough never ends on its own; the proxy forwards via req.pipe,
      // so the empty request body must be terminated explicitly.
      req.end();
      setTimeout(() => resolve(res), 3000);
    });

    const credentialHeaders = {
      host: "127.0.0.1:9527",
      cookie: "teamclaw_session=OWNER-SESSION; other=1",
      authorization: "Bearer OWNER-TOKEN",
      "x-teamclaw-token": "OWNER-LAUNCH-TOKEN",
      "x-forwarded-for": "9.9.9.9",
      accept: "text/html",
    };
    const html = await run("/page", credentialHeaders);
    assert.equal(seen.headers.cookie, undefined, "finding 2: the controller session cookie never reaches the preview subprocess");
    assert.equal(seen.headers.authorization, undefined, "finding 2: Authorization bearer never reaches the preview subprocess");
    assert.equal(seen.headers["x-teamclaw-token"], undefined, "finding 2: X-TeamClaw-Token never reaches the preview subprocess");
    assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1", "x-forwarded-for is re-derived from the real socket peer, not forwarded from the client");
    assert.equal(seen.headers["x-forwarded-host"], "127.0.0.1:9527", "x-forwarded-host carries the original host for the preview's information");
    assert.equal(seen.headers.accept, "text/html", "ordinary headers still pass through");
    assert.equal(html.out.status, 200, "preview HTML is served");
    assert.match(html.out.chunks.join(""), /href="\/api\/v1\/previews\/pv1\/x"/, "the existing absolute-path rewrite is intact");
    assert.equal(html.out.headers["content-security-policy"], "sandbox allow-scripts allow-forms", "finding 2: preview HTML carries the sandbox CSP (opaque origin under the controller host)");
    assert.equal(html.out.headers["set-cookie"], undefined, "finding 2: the preview's Set-Cookie is not planted on the controller origin");

    const json = await run("/api/data", credentialHeaders);
    assert.equal(seen.headers.cookie, undefined, "finding 2: non-HTML proxied requests are stripped too");
    assert.equal(json.out.headers["set-cookie"], undefined, "finding 2: non-HTML proxied responses drop Set-Cookie too");
    assert.equal(json.out.headers["content-security-policy"], undefined, "non-HTML responses carry no CSP (unchanged)");
    assert.equal(json.out.chunks.join(""), "{\"ok\":true}", "non-HTML bodies stream through unchanged");

    // Every stripped header that is NOT re-derived by the proxy must be absent
    // (host / x-forwarded-* / accept-encoding are set again by the proxy itself).
    const rederived = new Set(["host", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "accept-encoding", "connection"]);
    for (const name of previewMod.STRIPPED_PREVIEW_REQUEST_HEADERS) {
      if (rederived.has(name)) continue;
      assert.equal(seen.headers[name], undefined, `stripped header "${name}" is absent from the upstream request`);
    }
    assert.equal(seen.headers["accept-encoding"], "identity", "accept-encoding is re-set to identity by the proxy");
    // `connection` is stripped from the client set and then re-emitted by Node's
    // own http client (keep-alive) - never the caller's value.
    assert.notEqual(seen.headers.connection, "close-upgrade", "a client-supplied Connection header is not forwarded verbatim");
  } finally {
    await new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve); });
  }
}

console.log("test-security-clawhub-r2: ok (self-hosted device auth, WS origin policy, preview credential stripping + CSP)");
process.exit(0);
