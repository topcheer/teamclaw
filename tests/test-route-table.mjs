#!/usr/bin/env node
// PR-D of issue #204: declarative route table + dispatcher parity.
//
// http-server.ts's serial if/startsWith dispatch chain became the ordered
// `controllerRouteTable` in src/src/controller/route-table.ts. This test
// proves the conversion is behavior-preserving one route at a time:
//
//   Section 1  dispatcher unit semantics (method "*" / array whitelist,
//              exact/regex/prefix paths, handler `false` fall-through,
//              exhausted table => caller 404).
//   Section 2  the 68-entry table matches the hand-transcribed expectation
//              (order, method, path shape; shared handlers on the /ui and
//              /ui/auth/github pairs).
//   Section 3  the expectation matches the PRE-refactor if chain extracted
//              from git (the most recent commit where http-server.ts did
//              not yet reference route-table.js - i.e. the merge base of
//              PR-D), so old-chain order == table order is machine-checked,
//              not just reviewed. Skips loudly (never silently) when git
//              history is unavailable.
//   Section 4  tunnel-side tables (gate page + management API) parity.
//   Section 5  dispatch-order probes against a real dist HTTP server:
//              exact-before-prefix (teamauto), per-repo decline fall-through
//              to the FINAL 404, preview prefix answering 503 instead of the
//              final 404, reports exact-vs-prefix, transition-matrix gate
//              running BEFORE the table.
//   Section 6  structural pins: no residual if-pathname dispatch shells in
//              http-server.ts (the only pathname comparisons left are the
//              two documented gate sites), route-table.ts imports
//              http-server.js as TYPE ONLY (no runtime cycle).
//
// Requires the dist build first: npm --prefix src run build

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const httpServerSource = fs.readFileSync(path.join(projectRoot, "src", "src", "controller", "http-server.ts"), "utf8");
const routeTableSource = fs.readFileSync(path.join(projectRoot, "src", "src", "controller", "route-table.ts"), "utf8");

// --- env must be in place before the first dist import ---------------------
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-route-table-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-route-table-ws-"));
const stateDir = path.join(stateRoot, "plugins", "teamclaw");
fs.mkdirSync(stateDir, { recursive: true });

const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));
const routeTableMod = await dist("controller/route-table.js");
assert.ok(routeTableMod, "route-table module must be built (run npm --prefix src run build first)");
assert.equal(typeof routeTableMod.dispatchRoutes, "function", "dispatchRoutes must be exported");
assert.ok(Array.isArray(routeTableMod.controllerRouteTable), "controllerRouteTable must be exported as an array");

// ===========================================================================
// Section 1: dispatcher unit semantics
// ===========================================================================
{
  const calls = [];
  const mkRes = () => ({ statusCode: 0, headers: {}, end() { calls.push("end"); } });
  const ctx = (method, pathname) => ({
    req: { method },
    res: mkRes(),
    requestUrl: new URL(`http://x${pathname}`),
    pathname,
    deps: {},
    currentState: null,
  });

  // handler `false` declines and matching continues to the next entry.
  const declineTable = [
    { method: "*", path: "/decline/", prefix: true, handler: () => { calls.push("declined"); return false; } },
    { method: "GET", path: "/decline/exact", handler: () => { calls.push("second"); } },
  ];
  assert.equal(await routeTableMod.dispatchRoutes(declineTable, ctx("PUT", "/decline/exact")), false,
    "a declined route followed by a method-mismatched route exhausts the table (dispatcher returns false => caller 404)");
  assert.deepEqual(calls, ["declined"], "the declining handler runs exactly once");

  calls.length = 0;
  assert.equal(await routeTableMod.dispatchRoutes(declineTable, ctx("GET", "/decline/exact")), true,
    "after a decline the next matching entry handles the request");
  assert.deepEqual(calls, ["declined", "second"], "decline falls through to the second entry");

  // method "*" matches any method (teamauto per-repo contract).
  assert.equal(await routeTableMod.dispatchRoutes(
    [{ method: "*", path: "/any", handler: () => {} }], ctx("PROPFIND", "/any")), true,
    "method \"*\" matches any method");

  // method array whitelist (preview proxy's 5 methods).
  const previewMethods = ["GET", "HEAD", "POST", "PUT", "DELETE"];
  const previewTable = [{ method: previewMethods, path: "/api/v1/previews/", prefix: true, handler: () => {} }];
  for (const m of previewMethods) {
    assert.equal(await routeTableMod.dispatchRoutes(previewTable, ctx(m, "/api/v1/previews/x/y")), true,
      `preview method whitelist accepts ${m}`);
  }
  assert.equal(await routeTableMod.dispatchRoutes(previewTable, ctx("PATCH", "/api/v1/previews/x/y")), false,
    "preview method whitelist rejects PATCH (no match => fall to the final 404)");

  // exact string vs prefix regex distinction.
  const exactTable = [{ method: "GET", path: "/api/v1/reports", handler: () => {} }];
  assert.equal(await routeTableMod.dispatchRoutes(exactTable, ctx("GET", "/api/v1/reports/session-1")), false,
    "exact string paths never match longer pathnames (the reports/:sessionKey prefix is a separate entry)");
}

// ===========================================================================
// Section 2: the table vs the hand-transcribed expectation (one entry per
// pre-PR-D if/startsWith shell, in the original order; "old" line numbers
// refer to http-server.ts at the PR-D merge base e223767).
// ===========================================================================
const EXPECTED_ROUTES = [
  // Web UI (old lines 588-625)
  ["GET", "exact", "/"],
  ["GET", "exact", "/ui"],
  ["GET", "exact", "/ui/"],
  ["GET", "exact", "/ui/auth/github"],
  ["GET", "exact", "/ui/auth/github/"],
  ["GET", "prefix", "/ui/"],
  // TeamAuto (old lines 631-654)
  ["GET", "exact", "/api/v1/teamauto/activity"],
  ["GET", "exact", "/api/v1/teamauto/repos"],
  ["GET", "exact", "/api/v1/teamauto/repo-candidates"],
  ["POST", "exact", "/api/v1/teamauto/repos"],
  ["*", "prefix", "/api/v1/teamauto/repos/"],
  // GitHub Auth (old lines 658-753)
  ["GET", "exact", "/api/v1/auth/github/status"],
  ["POST", "exact", "/api/v1/auth/github/login"],
  ["GET", "exact", "/api/v1/auth/github/callback"],
  ["POST", "exact", "/api/v1/auth/github/logout"],
  ["POST", "exact", "/api/v1/auth/github/refresh"],
  // Workspace browser + model config (old lines 757-931)
  ["GET", "exact", "/api/v1/workspace/status"],
  ["POST", "exact", "/api/v1/workspace/change-dir"],
  ["GET", "exact", "/api/v1/models/config"],
  ["PUT", "exact", "/api/v1/models/config"],
  ["GET", "exact", "/api/v1/workspace/tree"],
  ["GET", "exact", "/api/v1/workspace/subtree"],
  ["GET", "exact", "/api/v1/workspace/file"],
  ["GET", "exact", "/api/v1/workspace/project-path"],
  ["GET", "prefix", "/api/v1/workspace/raw/"],
  // Worker management (old lines 939-960)
  ["POST", "exact", "/api/v1/workers/register"],
  ["DELETE", "regex", "^\\/api\\/v1\\/workers\\/[^/]+$"],
  ["GET", "exact", "/api/v1/workers"],
  ["POST", "regex", "^\\/api\\/v1\\/workers\\/[^/]+\\/heartbeat$"],
  // Task management (old lines 968-1100)
  ["POST", "exact", "/api/v1/tasks"],
  ["GET", "exact", "/api/v1/tasks"],
  ["GET", "exact", "/api/v1/stats"],
  ["GET", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+$"],
  ["DELETE", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+$"],
  ["GET", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/execution$"],
  ["PATCH", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/assign$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/handoff$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/checkpoint$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/result-contract$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/result$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/execution$"],
  ["POST", "regex", "^\\/api\\/v1\\/tasks\\/[^/]+\\/parallel-help$"],
  // Controller runs / projects / intake (old lines 1109-1289)
  ["POST", "exact", "/api/v1/controller/manifest"],
  ["GET", "exact", "/api/v1/controller/runs"],
  ["DELETE", "regex", "^\\/api\\/v1\\/projects\\/[^/]+$"],
  ["DELETE", "regex", "^\\/api\\/v1\\/controller\\/runs\\/[^/]+$"],
  ["POST", "exact", "/api/v1/controller/intake"],
  // Messages (old lines 1292-1313)
  ["POST", "exact", "/api/v1/messages/direct"],
  ["POST", "exact", "/api/v1/messages/broadcast"],
  ["POST", "exact", "/api/v1/messages/review-request"],
  ["GET", "exact", "/api/v1/messages"],
  // Clarifications (old lines 1318-1333)
  ["POST", "exact", "/api/v1/clarifications"],
  ["GET", "exact", "/api/v1/clarifications"],
  ["POST", "regex", "^\\/api\\/v1\\/clarifications\\/[^/]+\\/answer$"],
  // Git collaboration (old lines 1342-1412)
  ["GET", "exact", "/api/v1/repo"],
  ["GET", "exact", "/api/v1/repo/bundle"],
  ["POST", "exact", "/api/v1/repo/import"],
  // Team info / profiles (old lines 1417-1576)
  ["GET", "exact", "/api/v1/team/status"],
  ["GET", "exact", "/api/v1/roles"],
  ["GET", "exact", "/api/v1/profiles"],
  ["GET", "exact", "/api/v1/team/profile"],
  ["POST", "exact", "/api/v1/team/profile"],
  ["GET", "exact", "/api/v1/archived-teams"],
  // Previews / reports / health (old lines 1580-1633)
  [["GET", "HEAD", "POST", "PUT", "DELETE"], "prefix", "/api/v1/previews/"],
  ["GET", "exact", "/api/v1/reports"],
  ["GET", "prefix", "/api/v1/reports/"],
  ["GET", "exact", "/api/v1/health"],
];

// Issue #23 (backend wave): the device-pairing security routes, appended
// AFTER the historical table (no path overlaps with any pre-issue route,
// so the append cannot reorder historical matching). These have no
// pre-PR-D if-chain counterpart - the git cross-check in Section 3
// therefore compares only the historical EXPECTED_ROUTES prefix, and this
// list is pinned separately as the table's stable suffix.
const SECURITY_ROUTES = [
  ["POST", "exact", "/api/v1/security/enable"],
  ["POST", "exact", "/api/v1/security/pair/start"],
  ["POST", "exact", "/api/v1/security/pair"],
  ["POST", "exact", "/api/v1/security/pair-auto"],
  ["GET", "exact", "/api/v1/security"],
  ["DELETE", "regex", "^\\/api\\/v1\\/security\\/devices\\/[^/]+$"],
  ["POST", "exact", "/api/v1/security/reset"],
];

/** Normalizes a live RouteDef into {method, kind, value} for comparison. */
function routeToSpec(route, index) {
  assert.equal(typeof route.handler, "function", `route #${index} must bind a handler function`);
  if (typeof route.path === "string") {
    return route.prefix === true
      ? { method: route.method, kind: "prefix", value: route.path }
      : { method: route.method, kind: "exact", value: route.path };
  }
  const pattern = String(route.path); // e.g. "/^\/api\/v1\/workers\/[^/]+$/"
  const inner = pattern.slice(1, -1);
  assert.ok(inner.startsWith("^") && inner.endsWith("$"),
    `regex route #${index} must be fully anchored (got ${pattern})`);
  return { method: route.method, kind: "regex", value: inner };
}

const tableSpecs = routeTableMod.controllerRouteTable.map(routeToSpec);
assert.equal(tableSpecs.length, EXPECTED_ROUTES.length + SECURITY_ROUTES.length,
  `controllerRouteTable must have exactly ${EXPECTED_ROUTES.length} historical + ${SECURITY_ROUTES.length} security entries in order (got ${tableSpecs.length})`);
const FULL_EXPECTED_ROUTES = [...EXPECTED_ROUTES, ...SECURITY_ROUTES];
FULL_EXPECTED_ROUTES.forEach(([method, kind, value], i) => {
  const actual = tableSpecs[i];
  const methodMatches = Array.isArray(method)
    ? Array.isArray(actual.method) && method.join("|") === actual.method.join("|")
    : actual.method === method;
  assert.ok(methodMatches, `route #${i} method: expected ${JSON.stringify(method)}, got ${JSON.stringify(actual.method)}`);
  assert.equal(actual.kind, kind, `route #${i} (${method} ${value}) path kind`);
  assert.equal(actual.value, value, `route #${i} (${method}) path value`);
});

// The two exact-pair shells share one handler, exactly like the old
// `pathname === "/ui" || pathname === "/ui/"` single-branch shells.
assert.equal(routeTableMod.controllerRouteTable[1].handler, routeTableMod.controllerRouteTable[2].handler,
  "GET /ui and GET /ui/ share the same handler (one old shell)");
assert.equal(routeTableMod.controllerRouteTable[3].handler, routeTableMod.controllerRouteTable[4].handler,
  "GET /ui/auth/github and /ui/auth/github/ share the same handler (one old shell)");

// ===========================================================================
// Section 3: machine cross-check against the PRE-refactor if chain from git.
// ===========================================================================
{
  const chain = extractOldChainFromGit();
  if (!chain.available) {
    console.log(`test-route-table: NOTE - git history unavailable (${chain.reason}); ` +
      "relying on the hardcoded EXPECTED_ROUTES transcription (Section 2).");
  } else {
    assert.equal(chain.specs.length, EXPECTED_ROUTES.length,
      `pre-PR-D if chain at ${chain.commit.slice(0, 8)} must expose ${EXPECTED_ROUTES.length} route shells (got ${chain.specs.length})`);
    for (let i = 0; i < EXPECTED_ROUTES.length; i++) {
      const [method, kind, value] = EXPECTED_ROUTES[i];
      const old = chain.specs[i];
      const methodMatches = Array.isArray(method)
        ? Array.isArray(old.method) && method.join("|") === old.method.join("|")
        : old.method === method;
      assert.ok(methodMatches,
        `old-chain entry #${i}: expected method ${JSON.stringify(method)}, extracted ${JSON.stringify(old.method)} (${chain.commit.slice(0, 8)})`);
      assert.equal(old.kind, kind, `old-chain entry #${i} kind (git ${chain.commit.slice(0, 8)})`);
      assert.equal(old.value, value, `old-chain entry #${i} (${method}) path value (git ${chain.commit.slice(0, 8)})`);
    }
    // table == old chain, transitively table == expectation == old chain.
    // (Issue #23: only the historical PREFIX - the security routes appended
    // after /api/v1/health have no pre-PR-D counterpart by construction.)
    assert.deepEqual(tableSpecs.slice(0, EXPECTED_ROUTES.length).map(s => JSON.stringify([s.method, s.kind, s.value])),
      chain.specs.map(s => JSON.stringify([s.method, s.kind, s.value])),
      "the historical prefix of the live route table must equal the extracted pre-PR-D if chain entry by entry, in order");
    console.log(`test-route-table: git cross-check passed against ${chain.commit.slice(0, 8)} (pre-PR-D http-server.ts).`);
  }
}

function extractOldChainFromGit() {
  const file = "src/src/controller/http-server.ts";
  const git = (args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  let commits;
  try {
    commits = git(["log", "--format=%H", "-n", "80", "--", file]).split("\n").filter(Boolean);
  } catch (err) {
    return { available: false, reason: `git log failed: ${String(err.message ?? err)}` };
  }
  for (const commit of commits) {
    let src;
    try {
      src = git(["show", `${commit}:${file}`]);
    } catch {
      continue; // commit that did not have the file (rename boundary)
    }
    // The pre-PR-D chain: handleRequest exists, route-table not yet referenced.
    if (src.includes("async function handleRequest") && !src.includes("route-table.js")) {
      return { available: true, commit, specs: parseOldChain(src) };
    }
  }
  return { available: false, reason: "no pre-route-table http-server.ts commit found in the last 80 commits touching it" };
}

/** Parses the ordered route shells out of a pre-PR-D handleRequest body. */
function parseOldChain(src) {
  const fnStart = src.indexOf("async function handleRequest");
  assert.ok(fnStart >= 0, "pre-PR-D http-server.ts must contain handleRequest");
  // The route chain starts after the two gate sections (transition matrix +
  // capability gates); the transition guard's `req.method === "POST" &&
  // pathname === "/api/v1/repo/import"` is a GATE, not a route shell, so the
  // slice begins at the first route section banner.
  const chainStart = src.indexOf("==================== Web UI", fnStart);
  assert.ok(chainStart > 0, "pre-PR-D handleRequest must carry the Web UI section banner (first route section)");
  const fnEnd = src.indexOf('sendError(res, 404, "Not found")', chainStart);
  const body = src.slice(chainStart, fnEnd > 0 ? fnEnd : undefined);

  // The six shell forms of the old chain. Forms are mutually exclusive
  // textually (form 1 requires `&& pathname === "`, form 2 `&& (pathname`,
  // form 3 `&& pathname.startsWith(`, form 4 a bare `if (pathname.startsWith(`
  // with a string literal, form 5 `&& pathname.match(/`, form 6 the preview
  // 5-method || block), so one combined left-to-right scan preserves order.
  const shellForms = [
    // if (req.method === "GET" && pathname === "/x")
    { re: /req\.method === "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)" && pathname === "([^"]+)"/,
      emit: (g) => specs.push({ method: g[0], kind: "exact", value: g[1] }) },
    // if (req.method === "GET" && (pathname === "/ui" || pathname === "/ui/"))
    { re: /req\.method === "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)" && \(pathname === "([^"]+)" \|\| pathname === "([^"]+)"\)/,
      emit: (g) => { specs.push({ method: g[0], kind: "exact", value: g[1] }); specs.push({ method: g[0], kind: "exact", value: g[2] }); } },
    // if (req.method === "GET" && pathname.startsWith("/ui/"))
    { re: /req\.method === "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)" && pathname\.startsWith\("([^"]+)"\)/,
      emit: (g) => specs.push({ method: g[0], kind: "prefix", value: g[1] }) },
    // if (pathname.startsWith("/api/v1/teamauto/repos/"))   <- method-less
    { re: /\n\s*if \(pathname\.startsWith\("([^"]+)"\)\) \{/,
      emit: (g) => specs.push({ method: "*", kind: "prefix", value: g[0] }) },
    // if (req.method === "DELETE" && pathname.match(/^\/api\/v1\/workers\/[^/]+$/))
    // (non-greedy up to the closing `/)`; the old regex literals contain no
    // bare `/)` inside because every inner slash is escaped as `\/`)
    { re: /req\.method === "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)" && pathname\.match\(\/(.+?)\/\)/,
      emit: (g) => specs.push({ method: g[0], kind: "regex", value: g[1] }) },
    // the preview proxy 5-method whitelist + prefix block
    { re: /req\.method === "GET" \|\| req\.method === "HEAD" \|\| req\.method === "POST" \|\| req\.method === "PUT" \|\| req\.method === "DELETE"\) \{\s*const previewPrefix = "([^"]+)";\s*if \(pathname\.startsWith\(previewPrefix\)\)/,
      emit: (g) => specs.push({ method: ["GET", "HEAD", "POST", "PUT", "DELETE"], kind: "prefix", value: g[0] }) },
  ];
  const specs = [];

  // Precompute each form's wrap-group index inside the combined regex.
  const groupCountOf = (re) => new RegExp(`${re.source}|`).exec("").length - 1;
  const wrapIndex = [];
  let cursor = 1;
  for (const form of shellForms) {
    wrapIndex.push(cursor);
    cursor += groupCountOf(form.re) + 1;
  }
  const combined = new RegExp(shellForms.map((f) => `(${f.re.source})`).join("|"), "g");
  for (const m of body.matchAll(combined)) {
    for (let f = 0; f < shellForms.length; f++) {
      if (m[wrapIndex[f]] !== undefined) {
        shellForms[f].emit(m.slice(wrapIndex[f] + 1, wrapIndex[f] + 1 + groupCountOf(shellForms[f].re)));
        break;
      }
    }
  }
  return specs;
}

// ===========================================================================
// Section 4: tunnel-side tables (pre-PR-D outer-callback tunnel branch).
// ===========================================================================
{
  const gate = routeTableMod.createTunnelGateRoutes({ status: () => ({}) });
  const mgmt = routeTableMod.createTunnelManagementRoutes({ status: () => ({}) }, { config: { port: 1 }, logger: { info() {} } });
  const gateSpecs = gate.map(routeToSpec);
  const mgmtSpecs = mgmt.map(routeToSpec);
  assert.deepEqual(gateSpecs, [
    { method: "GET", kind: "exact", value: "/__tunnel_gate" },
    { method: "GET", kind: "exact", value: "/" },
    { method: "POST", kind: "exact", value: "/__tunnel_gate/verify" },
  ], "tunnel gate routes (old outer callback lines 348-373)");
  assert.deepEqual(mgmtSpecs, [
    { method: "GET", kind: "exact", value: "/api/v1/tunnel/status" },
    { method: "POST", kind: "exact", value: "/api/v1/tunnel/start" },
    { method: "POST", kind: "exact", value: "/api/v1/tunnel/start-self-hosted" },
    { method: "POST", kind: "exact", value: "/api/v1/tunnel/start-quick" },
    { method: "POST", kind: "exact", value: "/api/v1/tunnel/stop" },
    { method: "POST", kind: "exact", value: "/api/v1/tunnel/install-cloudflared" },
  ], "tunnel management routes (old outer callback lines 380-432)");
}

// ===========================================================================
// Section 5: dispatch-order probes against a real dist HTTP server.
// ===========================================================================
{
  const stateMod = await dist("state.js");
  const httpMod = await dist("controller/http-server.js");
  const { TaskRouter } = await dist("controller/task-router.js");
  const { MessageRouter } = await dist("controller/message-router.js");
  const { TeamWebSocketServer } = await dist("controller/websocket.js");
  const { parsePluginConfig } = await dist("types.js");

  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const now = Date.now();
  const baseState = () => ({
    version: 2,
    profileId: "software-rd",
    teamName: "Route Table Team",
    workers: {},
    tasks: {},
    controllerRuns: {},
    projects: {},
    messages: [],
    clarifications: {},
    provisioning: { workers: {} },
    createdAt: now - 1000,
    updatedAt: now,
  });
  let teamState = baseState();
  const deps = {
    config: parsePluginConfig({ mode: "controller", teamName: "Route Table Team", port: 19537, gitEnabled: false }),
    logger,
    runtime: {},
    getTeamState: () => teamState,
    updateTeamState: (updater) => { updater(teamState); void stateMod.saveTeamState(teamState); return teamState; },
    taskRouter: new TaskRouter(logger),
    messageRouter: new MessageRouter(logger),
    wsServer: new TeamWebSocketServer(logger),
    // Minimal scheduler stub: enough for the exact repos list (getStatus) and
    // the per-repo DELETE (removeRepo); GET per-repo must DECLINE (false).
    getTeamAutoScheduler: () => ({
      getStatus: async () => ({ repos: [] }),
      removeRepo: async () => ({}),
    }),
  };
  const server = httpMod.createControllerHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, json };
  };

  try {
    // 5.1 Final-404 fall-through semantics: unknown path AND known path with
    // an unowned method both exhaust the table.
    const unknown = await call("GET", "/api/v1/definitely-not-a-route");
    assert.equal(unknown.status, 404, "unknown API path answers 404");
    assert.equal(unknown.json?.error, "Not found", "the final 404 keeps the exact pre-PR-D body");
    const badMethod = await call("PUT", "/api/v1/tasks");
    assert.equal(badMethod.status, 404, "PUT /api/v1/tasks has no route (method fall-through) and answers the final 404");

    // 5.2 Exact-before-prefix on the teamauto family: the exact repos-list
    // route answers 200 via the stub scheduler; the per-repo prefix entry
    // never sees GET .../repos (and would decline anyway).
    const exactList = await call("GET", "/api/v1/teamauto/repos");
    assert.equal(exactList.status, 200, "GET /api/v1/teamauto/repos hits the exact list route (stub scheduler getStatus)");
    assert.deepEqual(exactList.json?.repos, [], "exact list route returns the stub status");

    // 5.3 Per-repo prefix DECLINE (GET is not owned) falls through the rest
    // of the table and reaches the FINAL 404 - not the scheduler's 503.
    const declined = await call("GET", "/api/v1/teamauto/repos/some-repo");
    assert.equal(declined.status, 404, "GET /api/v1/teamauto/repos/:id declines and falls to the final 404");
    assert.equal(declined.json?.error, "Not found", "decline reaches the terminal 404 body (handler-false fall-through preserved)");

    // 5.4 The same prefix route handles the methods it owns (DELETE unbind).
    const unbind = await call("DELETE", "/api/v1/teamauto/repos/some-repo");
    assert.equal(unbind.status, 200, "DELETE /api/v1/teamauto/repos/:id routes into the per-repo handler");
    assert.equal(unbind.json?.ok, true, "per-repo handler completes (stub removeRepo)");

    // 5.5 Preview prefix answers with the proxy's own 503 (no healthy
    // preview) instead of the final 404: the prefix route sits after the
    // exact /api/v1 routes and still claims its family.
    const preview = await call("GET", "/api/v1/previews/nope/index.html");
    assert.equal(preview.status, 503, "GET /api/v1/previews/... reaches the preview proxy (503 unavailable)");
    assert.equal(preview.json?.error, "Preview not available", "the 503 comes from the proxy route, not the final 404");

    // 5.6 Reports exact-vs-prefix pair: distinct routes, distinct misses.
    const reportsList = await call("GET", "/api/v1/reports");
    assert.equal(reportsList.status, 200, "GET /api/v1/reports hits the exact list route");
    assert.deepEqual(reportsList.json?.reports, [], "exact reports list answers { reports: [] }");
    const reportMiss = await call("GET", "/api/v1/reports/no-such-session");
    assert.equal(reportMiss.status, 404, "GET /api/v1/reports/:sessionKey hits the prefix route (its own 404)");
    assert.equal(reportMiss.json?.error, "No report found for this session",
      "the prefix route's 404 body differs from the final fall-through 404");

    // 5.7 Transition-matrix gate runs BEFORE the route table: a seeded
    // transition turns POST /api/v1/tasks into 503 + Retry-After.
    teamState = baseState();
    teamState.transition = { phase: "draining", targetProfileId: "minimal-bank", startedAt: Date.now() };
    const gated = await call("POST", "/api/v1/tasks", { title: "blocked" });
    assert.equal(gated.status, 503, "transition gate short-circuits POST /api/v1/tasks before any route");
    assert.equal(gated.json?.retryAfterSeconds, 5, "transition gate body keeps the shared retry hint");
    assert.equal(gated.headers.get("retry-after"), "5", "transition gate sets the Retry-After header");
    teamState = baseState();

    // 5.8 Web UI pair still routes (cheap smoke that the head of the table
    // survived the move).
    const rootRes = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(rootRes.status, 302, "GET / redirects to the UI");
    assert.equal(rootRes.headers.get("location"), "/ui", "GET / redirect target unchanged");
    const health = await call("GET", "/api/v1/health");
    assert.ok(health.status === 200 || health.status === 503, "GET /api/v1/health routes (readiness-dependent status)");
    assert.equal(health.json?.mode, "controller", "health body shape unchanged");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    deps.wsServer.close();
  }
}

// ===========================================================================
// Section 6: structural pins - no residual if-pathname dispatch in the
// composition root; type-only back-import (no runtime cycle).
// ===========================================================================
{
  // The dispatcher is wired and owns the tail of handleRequest.
  assert.match(httpServerSource, /await dispatchRoutes\(controllerRouteTable/,
    "handleRequest must dispatch through the declarative controllerRouteTable");
  assert.match(httpServerSource, /sendError\(res, 404, "Not found"\)/,
    "the final fall-through 404 stays in http-server.ts");

  // No dispatch shells left. The ONLY pathname comparisons allowed in the
  // composition root are the two documented gate sites:
  //   - disabledCapabilityForPath (capability prefix/exact gates)
  //   - the transition-matrix repo-import literal
  assert.equal((httpServerSource.match(/pathname\.match\(/g) ?? []).length, 0,
    "no pathname.match() dispatch shells remain in http-server.ts");
  const startsWithUses = httpServerSource.match(/pathname\.startsWith\(/g) ?? [];
  assert.equal(startsWithUses.length, 1,
    "exactly one pathname.startsWith() remains (the capability-gate prefix loop)");
  const gateFn = httpServerSource.match(/function disabledCapabilityForPath[\s\S]*?\n\}/);
  assert.ok(gateFn, "disabledCapabilityForPath must stay defined in http-server.ts");
  assert.equal((gateFn[0].match(/pathname\.startsWith\(/g) ?? []).length, 1,
    "the single remaining startsWith lives inside disabledCapabilityForPath");
  const pathLiteralUses = httpServerSource.match(/pathname === "/g) ?? [];
  assert.equal(pathLiteralUses.length, 1,
    'exactly one `pathname === "..."` literal remains (the transition repo-import gate)');
  assert.match(httpServerSource, /req\.method === "POST" && pathname === "\/api\/v1\/repo\/import"/,
    "the surviving pathname literal is the transition-matrix repo-import gate");
  const methodChecks = httpServerSource.match(/req\.method === /g) ?? [];
  assert.equal(methodChecks.length, 4,
    "exactly four req.method checks remain: CORS preflight + the three transition-gate conditions");

  // No runtime import cycle: route-table imports http-server as TYPE ONLY.
  assert.match(routeTableSource, /import type \{ ControllerHttpDeps \} from "\.\/http-server\.js"/,
    "route-table.ts must import ControllerHttpDeps as a type-only import");
  assert.doesNotMatch(routeTableSource, /(?:^|\n)import \{[^}]*\} from "\.\/http-server\.js"/,
    "route-table.ts must not import http-server.js at runtime (acyclic module graph)");
  assert.equal((routeTableSource.match(/from "\.\/http-server\.js"/g) ?? []).length, 1,
    "route-table.ts references http-server.js exactly once (the type-only import)");

  // Guard-layer constants survived the split (they gate BEFORE the table).
  assert.match(httpServerSource, /TRANSITION_BLOCKED_TASK_POST_PATHS/, "transition gate constant stays in the root");
  assert.match(httpServerSource, /CAPABILITY_GATE_PREFIXES/, "capability gate table stays in the root");
}

console.log("test-route-table: all assertions passed (PR-D declarative route table parity: dispatcher semantics, " +
  `${EXPECTED_ROUTES.length}-entry ordered historical table + ${SECURITY_ROUTES.length} security routes (issue #23), ` +
  "git cross-check, tunnel tables, dist-server order probes, structural pins)");
