#!/usr/bin/env node
// Issue #226 W4 + W2 convergence pins (source-level, no dist needed).
//
//   Section 1 - W4 single write entry: the set of saveTeamState CALL sites
//   across src/src must equal exactly { the updateTeamState implementation
//   inside controller-service.ts } + { the explicitly registered write-face
//   exemptions (startup-early / timer sweeps, each carrying an in-code
//   "W4 write-face exemption" justification) }. A new direct save that is
//   not registered here turns the suite RED - adding one requires updating
//   this registry, which is the registration.
//
//   Section 2 - W2 move pins (pin 三连): for every handler body carved out
//   of route-table.ts, the new home defines it (verbatim body anchor), the
//   old home no longer defines it, and the route table still binds it by
//   name - so a body cannot silently reappear inline nor a route drop off.
//
// Requires nothing but the repository sources.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src", "src");
const read = (rel) => fs.readFileSync(path.join(srcRoot, rel), "utf8");

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// ===========================================================================
// Section 1: W4 - the saveTeamState call-site census.
// ===========================================================================
{
  const CALL_RE = /\bsaveTeamState\(/g;
  // Every call site, keyed by repo-relative path. The definition in state.ts
  // (`async function saveTeamState(`) is excluded by the leading
  // `function ` anchor; the export-list entry in state.ts has no `(`.
  const callsByFile = new Map();
  for (const file of listTsFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file);
    const text = fs.readFileSync(file, "utf8");
    const sites = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue; // block-comment prose (e.g. contract docs)
      }
      const stripped = line.replace(/\/\/.*$/, "");
      if (/\bfunction saveTeamState\(/.test(stripped)) {
        continue; // the implementation itself
      }
      if (CALL_RE.test(stripped)) {
        sites.push(line.trim());
      }
      CALL_RE.lastIndex = 0;
    }
    if (sites.length > 0) {
      callsByFile.set(rel, sites);
    }
  }

  // The registry: updateTeamState implementation (2 branches) + 5 registered
  // exemptions, all in controller-service.ts. NOTHING else may call
  // saveTeamState directly.
  const EXPECTED = new Map([
    ["controller/controller-service.ts", 7],
  ]);
  assert.deepEqual(
    [...callsByFile.entries()].map(([rel, sites]) => [rel, sites.length]).sort(),
    [...EXPECTED.entries()].sort(),
    `saveTeamState call-site census must equal the registered write face exactly (got ${JSON.stringify([...callsByFile.entries()].map(([r, s]) => [r, s.length]))}); ` +
    "a new direct save must either go through deps.updateTeamState or be registered here AND annotated with a W4 write-face exemption comment",
  );

  const service = read("controller/controller-service.ts");

  // The two implementation call sites live inside the single entry.
  assert.match(
    service,
    /const updateState = \(\(updater[^]*?options\.persist === "awaited"[^]*?let persisted = saveTeamState\(state\);[^]*?void saveTeamState\(state\);/,
    "updateState must own both persistence branches (awaited durability handle + historical fire-and-forget)",
  );
  assert.match(
    service,
    /let persisted = saveTeamState\(state\);[^]*?options\.broadcast[^]*?wsServer\.broadcastUpdate\(event\);[^]*?void saveTeamState\(state\);[^]*?wsServer\.broadcastUpdate\(event\);/,
    "broadcast events must ride the entry: after the save fulfills on the awaited path, synchronously after the save on the background path",
  );

  // The 5 exemptions are exactly the annotated ones (the anchor includes the
  // issue ref so the contract-block prose mention does not count).
  const exemptionCount = (service.match(/W4 write-face exemption \(#226\)/g) ?? []).length;
  assert.equal(
    exemptionCount,
    5,
    "exactly five registered W4 write-face exemptions (first-boot creation, startup sync barrier, startup orphan sweep, timer worker sweep, timer orphan sweep) - each must carry an in-code justification",
  );

  // The former parallel write tracks are gone: no call and no import of
  // saveTeamState in either migrated home (prose mentions in doc comments
  // are fine - the machine check is on calls and imports).
  const routeTable = read("controller/route-table.ts");
  const statusRoutes = read("controller/status-routes.ts");
  const profileSwitch = read("controller/profile-switch.ts");
  assert.doesNotMatch(routeTable, /\bsaveTeamState\(/, "route-table.ts must not call saveTeamState (the W4 flagship track)");
  assert.doesNotMatch(routeTable, /saveTeamState/, "route-table.ts must not even import saveTeamState");
  assert.doesNotMatch(profileSwitch, /\bsaveTeamState\(/, "profile-switch.ts must not call saveTeamState (independent-save track migrated)");
  assert.doesNotMatch(
    profileSwitch.match(/import \{[^}]*\} from "\.\.\/state\.js";/)?.[0] ?? "",
    /saveTeamState/,
    "profile-switch.ts's state.js import must not carry saveTeamState",
  );
  for (const [name, source] of [["status-routes (switch step 1)", statusRoutes], ["profile-switch", profileSwitch]]) {
    assert.match(
      source,
      /persist: "awaited"/,
      `${name} must use the awaited-durability variant of the single write entry`,
    );
  }
  // The transition path keeps the crash-resume contract: persisted BEFORE
  // broadcast (broadcast rides the save's fulfillment), rollback on failure.
  assert.match(
    statusRoutes,
    /persist: "awaited",\s*broadcast: \[\{ type: "team\.switch_started"/,
    "switch step 1 must broadcast switch_started from the awaited save's fulfillment",
  );
  assert.match(
    statusRoutes,
    /await persisted;[^]*?catch \(err\) {[^]*?Durability failed: roll the in-memory transition back/,
    "switch step 1 must roll the transition back when persistence fails",
  );
  assert.match(
    profileSwitch,
    /broadcast: \[\{ type: "team\.switch_completed", data: \{ profileId: target\.id \} \}\],\s*\}\);\s*await settled\.persisted;/,
    "switch step 6 must announce completion only after the settle save fulfills (event order locked)",
  );
  assert.match(
    profileSwitch,
    /void cleared\.persisted\.catch\(\(\) => undefined\);/,
    "the failure-path unwedging persists best-effort through the entry (swallowed, as before)",
  );

  // loadTeamState (the read side) stays a state.ts export consumed by
  // controller-service/index - unchanged by W4.
  assert.match(read("state.ts"), /async function loadTeamState\(/, "loadTeamState stays implemented in state.ts");
}

// ===========================================================================
// Section 2: W2 move pins - new home hits, old home exit, table binding.
// ===========================================================================
{
  const routeTable = read("controller/route-table.ts");
  const homes = {
    "webui-routes.ts": read("controller/webui-routes.ts"),
    "auth-routes.ts": read("controller/auth-routes.ts"),
    "workspace-routes.ts": read("controller/workspace-routes.ts"),
    "controller-routes.ts": read("controller/controller-routes.ts"),
    "status-routes.ts": read("controller/status-routes.ts"),
    "report-routes.ts": read("controller/report-routes.ts"),
    "repo-routes.ts": read("controller/repo-routes.ts"),
    "tunnel-routes.ts": read("controller/tunnel-routes.ts"),
  };

  // [home, handler name, distinctive verbatim body anchor]
  const MOVED = [
    ["webui-routes.ts", "webUiIndexRoute", /serveVersionedHtml\(res, path\.join\(uiPath, "index\.html"\)\);/],
    ["webui-routes.ts", "webUiAssetsRoute", /const file = pathname\.slice\(4\); \/\/ remove "\/ui\/"/],
    ["auth-routes.ts", "githubAuthLoginRoute", /authorizeUrl: loginPageUrl, \.\.\.start/],
    ["auth-routes.ts", "githubAuthCallbackRoute", /GitHub 登录成功，可关闭本页返回 TeamClaw/],
    ["auth-routes.ts", "githubAuthStatusRoute", /getStatus\(resolveRequestOrigin\(req, config\)\)/],
    ["workspace-routes.ts", "workspaceChangeDirRoute", /restartRequired: true,/],
    ["workspace-routes.ts", "workspaceRawFileRoute", /"X-Content-Type-Options": "nosniff",/],
    ["workspace-routes.ts", "modelsConfigPutRoute", /restartNote: "Config changes hot-reload/],
    ["controller-routes.ts", "controllerManifestRoute", /manifest_recorded/],
    ["controller-routes.ts", "controllerIntakeRoute", /errorMessage\.includes\("timed out"\) \? 504 : 500/],
    ["controller-routes.ts", "controllerRunDeleteRoute", /Planning run cleanup could not be confirmed/],
    ["status-routes.ts", "teamStatusRoute", /pendingClarificationCount: clarifications\.filter\(\(item\) => item\.status === "pending"\)\.length,/],
    ["status-routes.ts", "teamRolesRoute", /sendJson\(res, 200, \{ roles: getActiveRoles\(\), defaultRole: getActiveDefaultRole\(\) \}\);/],
    ["status-routes.ts", "teamProfileSwitchRoute", /startTeamProfileSwitch\(deps, state, profileId, previousProfileId\);/],
    ["status-routes.ts", "archivedTeamsRoute", /const archives = await listArchivedTeams\(\);/],
    ["report-routes.ts", "reportsSessionRoute", /No report found for this session/],
    ["report-routes.ts", "healthRoute", /provisioningReadiness: readiness,/],
    ["repo-routes.ts", "repoImportRoute", /alreadyUpToDate: imported\.alreadyUpToDate,/],
    ["tunnel-routes.ts", "createTunnelGateRoutes", /__tunnel_gate\/verify/],
    ["tunnel-routes.ts", "createTunnelManagementRoutes", /Creating a public tunnel exposes this controller to the internet/],
  ];

  for (const [home, name, anchor] of MOVED) {
    const source = homes[home];
    // (1) new home defines it, with the verbatim body anchor.
    assert.match(
      source,
      new RegExp(`function ${name}\\(`),
      `${name} must be defined in controller/${home} (W2 new home)`,
    );
    assert.match(
      source,
      anchor,
      `${name}'s verbatim body anchor must exist in controller/${home}`,
    );
    // (2) the old home no longer defines it (pure table + dispatcher).
    assert.doesNotMatch(
      routeTable,
      new RegExp(`function ${name}\\(`),
      `route-table.ts must no longer define ${name} (moved to controller/${home})`,
    );
    // (3) the route table still binds it by name (route preserved).
    if (name !== "createTunnelGateRoutes" && name !== "createTunnelManagementRoutes") {
      assert.match(
        routeTable,
        new RegExp(`handler: ${name}`),
        `the route table must still bind ${name} (dispatch unchanged)`,
      );
    }
  }

  // Helpers moved with their consumers; route-table keeps none of them.
  for (const helper of [
    "shellEscapeSingleQuotes",
    "buildExternalWorkerInstallInfo",
    "computeTeamStats",
    "sendGithubCallbackHtml",
    "escapeHtmlText",
    "resolveRequestOrigin",
    "workspaceRequestErrorStatus",
    "readFormBody",
  ]) {
    assert.doesNotMatch(
      routeTable,
      new RegExp(`function ${helper}\\(`),
      `route-table.ts must no longer define helper ${helper} (it moved with its consumers)`,
    );
  }
  assert.match(homes["status-routes.ts"], /function shellEscapeSingleQuotes\(/, "shellEscapeSingleQuotes lives in status-routes.ts with its consumer");
  assert.match(homes["auth-routes.ts"], /function sendGithubCallbackHtml\(/, "the GitHub callback HTML renderer lives in auth-routes.ts with its consumers");
  assert.match(homes["tunnel-routes.ts"], /function readFormBody\(/, "the tunnel form reader lives in tunnel-routes.ts with its consumers");

  // The W2 size target: route-table is the pure table + dispatcher.
  const lineCount = routeTable.split("\n").length;
  assert.ok(
    lineCount <= 700,
    `route-table.ts must stay a pure table + dispatcher at <= 700 lines (got ${lineCount})`,
  );

  // The tunnel factories and the retry-hint constant stay importable from
  // route-table (http-server.ts imports are unchanged).
  assert.match(routeTable, /export \{ createTunnelGateRoutes, createTunnelManagementRoutes \} from "\.\/tunnel-routes\.js";/,
    "route-table re-exports the tunnel table factories for http-server.ts");
  assert.match(routeTable, /export \{ SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS \} from "\.\/controller-routes\.js";/,
    "route-table re-exports the retry hint for http-server.ts's gates");

  // Acyclic discipline: the new domain modules import route-table as TYPE
  // ONLY (RouteContext/RouteDef), exactly like security.ts.
  for (const [home, source] of Object.entries(homes)) {
    const runtimeImport = source.match(/(?:^|\n)import \{[^}]*\} from "\.\/route-table\.js"/);
    assert.equal(runtimeImport, null, `${home} must not import route-table.js at runtime`);
    assert.match(source, /import type \{[^}]*\} from "\.\/route-table\.js"/, `${home} imports route-table.js as TYPE ONLY`);
  }
}

console.log(
  "test-teamstate-writes: all assertions passed " +
  "(W4: saveTeamState call-site census == updateTeamState implementation + 5 registered exemptions; " +
  "parallel write tracks gone, awaited durability + broadcast order locked; " +
  "W2: 20 moved handlers pinned new-home-hit && old-home-exit && table-bound, helpers followed consumers, " +
  "route-table <= 700 lines, type-only back-imports)",
);
