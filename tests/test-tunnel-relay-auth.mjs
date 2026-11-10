#!/usr/bin/env node
// Issue #231: tunnel-server relay github_user ownership verification +
// wildcard-CORS removal, with the controller side sending the proof.
//
//   1. Relay source pins (deploy/tunnel-server/src/index.ts + wrangler.toml):
//      - create verifies ownership via one GET api.github.com/user with the
//        caller's Bearer token (login === github_user, case-folded);
//      - the ACCEPT_LEGACY_CREATE grey-window flag exists, defaults to
//        "false" in wrangler.toml (grey window closed 2026-11-10 by #245,
//        after a `wrangler tail` window observed zero legacy warns), and
//        its headerless branch warns (legacy traffic observable) while
//        "false" 401s;
//      - ordering: the 10/h/IP create rate limit runs BEFORE the GitHub
//        verification call, and verification runs BEFORE any Cloudflare API
//        work (no 409/watermark/CF-call leakage to unauthenticated probers);
//      - wildcard CORS is gone: no Access-Control-Allow-* headers anywhere,
//        OPTIONS stays a bare 204 (preflight fails closed).
//   2. Relay dist-level behavior: the Worker TS is compiled with the
//      project's typescript (same compiler the src build uses) and its
//      default fetch handler is exercised with a mocked global fetch -
//      valid token + matching login -> 201; matching-host create chain
//      mocked on the Cloudflare side; mismatched login -> 403; GitHub-side
//      failure -> 401 (fail-closed); no header + flag unset -> 201 with a
//      console.warn; no header + flag "false" -> 401; rate-limited calls
//      never reach the GitHub mock (limit-before-verify, behaviorally);
//      no CORS header on any response, OPTIONS -> 204 without ACAO.
//   3. Controller source pins (src/src/controller/tunnel-manager.ts): the
//      create call resolves the GitHub OAuth token via the shared auth
//      manager and sends Authorization: Bearer when one exists, omits the
//      header (legacy, commented) when none does; DELETE calls keep using
//      only the HMAC delete token (no Authorization anywhere else).
//
// Relay compile requires the src toolchain: npm --prefix src ci (typescript
// is the same devDependency `npm --prefix src run build` uses).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

const worker = readSource(path.join("deploy", "tunnel-server", "src", "index.ts"));
const wrangler = readSource(path.join("deploy", "tunnel-server", "wrangler.toml"));
const mgr = readSource(path.join("src", "src", "controller", "tunnel-manager.ts"));

// ===========================================================================
// 1. Relay source pins
// ===========================================================================
{
  // Ownership verification exists and asks GitHub who owns the token.
  assert.match(worker, /api\.github\.com\/user/, "create must verify ownership via GET api.github.com/user (#231)");
  assert.match(
    worker,
    /gh\.login\.toLowerCase\(\) !== user/,
    "the GitHub login from /user must be compared (case-folded) against github_user (#231)",
  );
  assert.match(worker, /Bearer/, "the caller's Authorization: Bearer token is forwarded to GitHub /user");

  // Fail-closed shape: GitHub-side failure is a 401 (not 502), mismatch is 403.
  assert.match(
    worker,
    /if \(!gh\.ok\) return json\(401, \{ error: "github_user ownership verification failed"/,
    "GitHub-side failure must fail closed as 401 with a distinguishable detail in logs (#231)",
  );
  assert.match(
    worker,
    /return json\(403, \{ error: `github_user "\$\{user\}" does not belong/,
    "login mismatch must be a 403 ownership rejection (#231)",
  );

  // Grey window: flag consulted, default closed since #245 (wrangler.toml
  // pins "false"), unset still warns via the legacy branch, "false" 401s.
  assert.match(worker, /ACCEPT_LEGACY_CREATE/, "relay reads ACCEPT_LEGACY_CREATE (#231)");
  assert.match(
    worker,
    /env\.ACCEPT_LEGACY_CREATE === "false"/,
    "the flag tightens only on the explicit string \"false\" (unset/true stays legacy-open, #231)",
  );
  assert.match(
    worker,
    /console\.warn\("tunnel create without Authorization header/,
    "headerless creates under the open flag must console.warn so convergence is observable (#231)",
  );
  assert.doesNotMatch(worker, /console\.log/, "no console.log in the worker (token hygiene, pre-existing pin)");
  assert.match(wrangler, /ACCEPT_LEGACY_CREATE = "false"/, "wrangler.toml pins ACCEPT_LEGACY_CREATE=false (grey window closed by #245, config reality is tightened)");

  // Ordering: rate limit strictly before the GitHub verification call,
  // verification strictly before the first Cloudflare API work / 409 signal.
  const rateLimitAt = worker.indexOf('rateLimited(req, 10, 3600_000)');
  const verifyAt = worker.indexOf("githubLoginFor(bearer");
  const liveConflictAt = worker.indexOf("an active tunnel already exists");
  assert.ok(rateLimitAt >= 0 && verifyAt > rateLimitAt, "the 10/h/IP create rate limit must run before the GitHub /user verification (else verification is an unthrottled DoS amplifier, #231)");
  assert.ok(liveConflictAt > verifyAt, "ownership verification must run before the Cloudflare live-tunnel/409 checks (probers must not learn tunnel state, #231)");

  // CORS: the wildcard is gone entirely; OPTIONS stays a bare 204.
  assert.doesNotMatch(worker, /Access-Control-Allow-Origin/, "no Access-Control-Allow-Origin header may remain anywhere in the relay (#231)");
  assert.doesNotMatch(worker, /Access-Control-Allow-Methods/, "no Access-Control-Allow-Methods header may remain (#231)");
  assert.doesNotMatch(worker, /const CORS/, "the wildcard CORS header block must be deleted, not narrowed (#231)");
  assert.match(
    worker,
    /req\.method === "OPTIONS"\) return new Response\(null, \{ status: 204 \}\)/,
    "OPTIONS stays a bare 204 with no ACAO (preflight answered, fails closed) (#231)",
  );
}

// ===========================================================================
// 2. Relay dist-level behavior (compiled worker + mocked fetch)
// ===========================================================================
const tscBin = path.join(projectRoot, "src", "node_modules", "typescript", "bin", "tsc");
assert.ok(
  fs.existsSync(tscBin),
  "typescript toolchain missing - run `npm --prefix src ci` (same devDependency the src build uses)",
);
const relayOut = fs.mkdtempSync(path.join(os.tmpdir(), "tc-relay-auth-"));
execFileSync(process.execPath, [
  tscBin,
  "--target", "es2022",
  "--module", "es2022",
  "--moduleResolution", "bundler",
  "--strict",
  "--outDir", relayOut,
  path.join(projectRoot, "deploy", "tunnel-server", "src", "index.ts"),
], { stdio: "pipe" });
fs.writeFileSync(path.join(relayOut, "package.json"), JSON.stringify({ type: "module" }));
const relay = (await import(pathToFileURL(path.join(relayOut, "index.js")).href)).default;
assert.equal(typeof relay.fetch, "function", "compiled relay exports the Workers fetch handler");

const ENV = { CF_API_TOKEN: "cf-token", CF_ACCOUNT_ID: "acc", CF_ZONE_ID: "zone", WORKER_SIGNING_KEY: "k" };
// The worker is routed at apps.teamclaw.dev/api/* and matches on the FULL
// pathname (e.g. "/api/tunnels"), so paths below are relative to /api.
const relayCall = (env, { method = "POST", path = "/tunnels", body, headers = {} } = {}) =>
  relay.fetch(
    new Request(`https://apps.teamclaw.dev/api${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
    }),
    env,
  );

// Mock fetch: api.github.com answers from a per-test script; the Cloudflare
// side replays a successful create chain (list -> create -> config -> dns).
let githubCalls = 0;
let githubScript = () => ({ status: 200, login: "alice" });
const cfReply = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === "https://api.github.com/user") {
    githubCalls += 1;
    const answer = githubScript();
    if (answer.status !== 200) return new Response(JSON.stringify({ message: "nope" }), { status: answer.status });
    return new Response(JSON.stringify({ login: answer.login }), { status: 200 });
  }
  if (u.startsWith("https://api.cloudflare.com/client/v4")) {
    if (u.includes("/cfd_tunnel?")) return cfReply([]);
    if (u.endsWith("/cfd_tunnel") && init.method === "POST") return cfReply({ id: "tun-1", token: "connector-secret" });
    if (u.includes("/configurations")) return cfReply(null);
    if (u.includes("/dns_records")) return cfReply({ id: "rec-1" });
    return cfReply(null);
  }
  return realFetch(url, init);
};

const warnLog = [];
const realWarn = console.warn;
console.warn = (m) => warnLog.push(String(m));

try {
  // (a) Valid token + matching login -> 201 (full CF chain mocked).
  githubScript = () => ({ status: 200, login: "alice" });
  let res = await relayCall({ ...ENV }, { body: { github_user: "alice" }, headers: { authorization: "Bearer ghodev-a" } });
  assert.equal(res.status, 201, "valid Bearer + matching login must create");
  assert.equal(githubCalls, 1, "exactly one GET /user per authenticated create");
  assert.equal(warnLog.length, 0, "authenticated creates do not warn");
  const created = await res.json();
  assert.equal(created.hostname, "team-alice.teamclaw.dev");

  // Case-folding: GitHub logins preserve case; ownership is case-insensitive.
  githubScript = () => ({ status: 200, login: "Alice" });
  res = await relayCall({ ...ENV }, { body: { github_user: "alice" }, headers: { authorization: "Bearer x" } });
  assert.equal(res.status, 201, "login comparison must be case-insensitive (GitHub logins are)");

  // (b) Valid token + mismatched login -> 403, no CF side effects expected.
  githubScript = () => ({ status: 200, login: "mallory" });
  res = await relayCall({ ...ENV }, { body: { github_user: "alice" }, headers: { authorization: "Bearer x" } });
  assert.equal(res.status, 403, "token belonging to another login must be rejected as 403");

  // (c) GitHub-side failure (timeout/5xx/bad token) -> 401 fail-closed.
  githubScript = () => ({ status: 500 });
  res = await relayCall({ ...ENV }, { body: { github_user: "alice" }, headers: { authorization: "Bearer x" } });
  assert.equal(res.status, 401, "GitHub-side failure must fail closed as 401 (not 502)");
  assert.match((await res.json()).error, /ownership verification failed/);
  githubScript = () => ({ status: 401 });
  res = await relayCall({ ...ENV }, { body: { github_user: "alice" }, headers: { authorization: "Bearer bogus" } });
  assert.equal(res.status, 401, "a token GitHub rejects fails closed as 401");

  // (d) No header, flag unset -> legacy pass with a warn (grey window open).
  githubScript = () => ({ status: 200, login: "alice" });
  const ghBefore = githubCalls;
  res = await relayCall({ ...ENV }, { body: { github_user: "alice" } });
  assert.equal(res.status, 201, "headerless create passes while the grey window is open (flag unset)");
  assert.equal(githubCalls, ghBefore, "headerless legacy creates must not spend a GitHub API call");
  assert.ok(warnLog.some((m) => m.includes("without Authorization header")), "legacy pass must console.warn for convergence tracking");

  // (e) No header, flag "false" -> 401 (tightened).
  res = await relayCall({ ...ENV, ACCEPT_LEGACY_CREATE: "false" }, { body: { github_user: "alice" } });
  assert.equal(res.status, 401, "headerless create must 401 once ACCEPT_LEGACY_CREATE=\"false\"");
  assert.equal(githubCalls, ghBefore, "the 401 branch must not call GitHub (no header to verify)");

  // (f) Rate limit before verification, behaviorally: a 429'd create never
  // reaches the GitHub mock. Bucket state is per-isolate, so burn the
  // 10/h budget from one IP and watch the 11th call.
  githubScript = () => ({ status: 200, login: "alice" });
  const burnerEnv = { ...ENV };
  let saw429 = false;
  for (let i = 0; i < 12 && !saw429; i++) {
    res = await relayCall(burnerEnv, { body: { github_user: "alice" }, headers: { authorization: "Bearer x", "cf-connecting-ip": "198.51.100.9" } });
    saw429 = res.status === 429;
  }
  assert.ok(saw429, "the 11th create from one IP must be rate limited (429)");
  const ghAfterBurn = githubCalls;
  res = await relayCall(burnerEnv, { body: { github_user: "alice" }, headers: { authorization: "Bearer x", "cf-connecting-ip": "198.51.100.9" } });
  assert.equal(res.status, 429, "subsequent creates from the burned IP stay 429");
  assert.equal(githubCalls, ghAfterBurn, "a rate-limited create must never trigger the GitHub /user call (limit runs first)");

  // (g) CORS: no ACAO on any response; OPTIONS is a bare 204.
  res = await relayCall({ ...ENV }, { method: "GET", path: "/health" });
  assert.equal(res.headers.get("access-control-allow-origin"), null, "responses carry no Access-Control-Allow-Origin (#231)");
  res = await relayCall({ ...ENV }, { method: "OPTIONS" });
  assert.equal(res.status, 204, "OPTIONS answers 204");
  assert.equal(res.headers.get("access-control-allow-origin"), null, "OPTIONS grants no CORS (preflight fails closed)");
} finally {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
  fs.rmSync(relayOut, { recursive: true, force: true });
}

// ===========================================================================
// 3. Controller source pins
// ===========================================================================
{
  assert.match(mgr, /import \{ getGithubAuthManager \} from "\.\/github-auth\.js"/, "tunnel-manager pulls the token from the shared auth manager (#231)");
  assert.match(
    mgr,
    /await getGithubAuthManager\(\{\}, logger\)\.getAccessToken\(\)/,
    "create resolves the OAuth token via getGithubAuthManager({}).getAccessToken() (#231)",
  );
  assert.match(
    mgr,
    /githubToken \? \{ Authorization: `Bearer \$\{githubToken\}` \} : undefined/,
    "the create call sends Authorization: Bearer <token> when one resolves (#231)",
  );
  assert.match(
    mgr,
    /legacy headerless create/,
    "the no-token path is documented as the legacy-compatible omission (#231)",
  );
  // The Bearer proof belongs to create only: DELETEs keep authenticating via
  // the HMAC delete token, so Authorization must appear exactly once.
  assert.equal(mgr.split("Authorization").length - 1, 1, "exactly one Authorization header in tunnel-manager (the create proof; DELETE stays HMAC-token based)");
}

console.log("test-tunnel-relay-auth: ok");
