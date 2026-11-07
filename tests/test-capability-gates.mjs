#!/usr/bin/env node
// Phase 2.3 capability gates + Phase 2.6 labelZh fallback
// (vertical-team-profiles-design.md sections 2.3/4 and the Phase 2 table
// rows 2.3/2.6), run against the built dist modules (run
// `npm --prefix src run build` first).
//
// Covers:
//   1. Steady-state 404 short-circuit: with the all-off fixture profile
//      (minimal-bank) active, every /teamauto/* route, the preview proxy
//      family, the delivery-report + orchestration-manifest routes, and the
//      repo write/export routes answer 404 (never 403) with the owning
//      `capability` key in the error body. GET /api/v1/repo degrades
//      gracefully ({ enabled: false }) WITHOUT stamping repo state even when
//      the legacy config knob gitEnabled=true is on (the profile switch is
//      the truth).
//   2. software-rd zero change: the same routes keep their pre-2.3 behavior
//      (503 scheduler-not-running / 400 bad body / 503 preview-unavailable /
//      200 empty reports / 404 session-miss) and none of those bodies carry
//      a `capability` field.
//   3. Transition overlay: while a switch transition is in flight the
//      503/409 transition semantics win over the steady-state 404 for the
//      overlapping write routes (repo import), while capability-gated reads
//      stay 404; once the transition clears, the 404 returns.
//   4. UI contract (design section 4): GET /api/v1/team/profile exposes the
//      capabilities object with exactly the four boolean switches.
//   5. Debt item 4: the teamauto scanner derives its joint-review role set
//      from the active profile (trio under software-rd, none under
//      minimal-bank).
//   6. Phase 2.6 labelZh fallback: the loader's resolveRoleDisplayName
//      implements labelZh ?? label, /roles passes raw roles through, and a
//      present-but-empty labelZh is a load-time schema error.
//
// The dist modules resolve the extra fixture profile directory from
// TEAMCLAW_EXTRA_PROFILES_DIR and the state directory from OPENCLAW_STATE_DIR
// at module init (set before the first dist import), mirroring
// tests/test-profile-switch.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ---------------------
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-capability-gates-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
const stateDir = path.join(stateRoot, "plugins", "teamclaw");
fs.mkdirSync(stateDir, { recursive: true });

const stateMod = await dist("state.js");
const httpMod = await dist("controller/http-server.js");
const { TaskRouter } = await dist("controller/task-router.js");
const { MessageRouter } = await dist("controller/message-router.js");
const { TeamWebSocketServer } = await dist("controller/websocket.js");
const { parsePluginConfig } = await dist("types.js");
const loaderMod = await dist("profile-loader.js");
const scannerMod = await dist("teamauto/scanner.js");

assert.equal(loaderMod.hasProfile("minimal-bank"), true, "fixture profile must be merged via TEAMCLAW_EXTRA_PROFILES_DIR");

const logger = {
  infos: [],
  warns: [],
  errors: [],
  info(entry) { this.infos.push(entry); },
  warn(entry) { this.warns.push(entry); },
  error(entry) { this.errors.push(entry); },
  debug() {},
};

const now = Date.now();

function minimalBankState(overrides = {}) {
  return {
    version: 2,
    profileId: "minimal-bank",
    teamName: "Minimal Bank Team",
    workers: {},
    tasks: {},
    controllerRuns: {},
    projects: {},
    messages: [],
    clarifications: {},
    provisioning: { workers: {} },
    createdAt: now - 1000,
    updatedAt: now,
    ...overrides,
  };
}

function softwareRdState(overrides = {}) {
  return minimalBankState({
    profileId: "software-rd",
    teamName: "Capability Gates Team",
    repo: {
      enabled: true,
      mode: "shared",
      defaultBranch: "main",
      remoteReady: false,
      headCommit: "abc123",
      dirty: false,
      lastPreparedAt: now,
    },
    ...overrides,
  });
}

async function bootScenario({ initialState, profileId, gitEnabled = false, workspaceDir } = {}) {
  loaderMod.setActiveProfileId(profileId ?? "software-rd");
  process.env.TEAMCLAW_WORKSPACE_DIR = workspaceDir
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "tc-cap-gates-workspace-"));

  const config = parsePluginConfig({
    mode: "controller",
    teamName: "Capability Gates Team",
    port: 19528,
    gitEnabled,
  });

  let teamState = initialState ?? null;
  if (teamState) {
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

  const call = async (method, pathname, body) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, json };
  };

  return {
    deps, server, call,
    getTeamState,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      wsServer.close();
    },
  };
}

const ALL_CAPABILITY_KEYS = ["deliveryReview", "git", "runnablePreview", "teamauto"];

// ---------------------------------------------------------------------------
// Scenario 1: all-off profile (minimal-bank) steady state - 404 short-circuit.
// ---------------------------------------------------------------------------
{
  // gitEnabled: true on purpose - the PROFILE capability must outrank the
  // legacy config knob for repo existence (no repo stamping on a git-less
  // profile, design 2.3 "banking keeps no repo initialization").
  const scenario = await bootScenario({ initialState: minimalBankState(), profileId: "minimal-bank", gitEnabled: true });
  try {
    // UI contract (design section 4): capabilities shape on /team/profile.
    const profileRes = await scenario.call("GET", "/api/v1/team/profile");
    assert.equal(profileRes.status, 200);
    assert.equal(profileRes.json.profileId, "minimal-bank");
    assert.deepEqual(
      Object.keys(profileRes.json.profile.capabilities).sort(),
      ALL_CAPABILITY_KEYS,
      "capabilities carries exactly the four switches",
    );
    assert.deepEqual(
      profileRes.json.profile.capabilities,
      { git: false, teamauto: false, runnablePreview: false, deliveryReview: false },
      "all-off fixture profile advertises every capability as false",
    );

    // teamauto=false -> the whole /teamauto/* family is 404 + capability field.
    const teamautoRoutes = [
      ["GET", "/api/v1/teamauto/activity"],
      ["GET", "/api/v1/teamauto/repos"],
      ["GET", "/api/v1/teamauto/repo-candidates"],
      ["POST", "/api/v1/teamauto/repos", { repo: "acme/widget" }],
      ["DELETE", "/api/v1/teamauto/repos/acme%2Fwidget"],
      ["PATCH", "/api/v1/teamauto/repos/acme%2Fwidget", { schedule: "@hourly" }],
      ["POST", "/api/v1/teamauto/repos/acme%2Fwidget/sweep"],
    ];
    for (const [method, pathname, body] of teamautoRoutes) {
      const res = await scenario.call(method, pathname, body);
      assert.equal(res.status, 404, `${method} ${pathname} must be 404 (not 403) under teamauto=false`);
      assert.equal(res.json.capability, "teamauto", `${method} ${pathname} error body names the owning capability`);
      assert.equal(res.json.profileId, "minimal-bank");
      assert.match(res.json.error, /has the "teamauto" capability disabled/, "error message explains the capability gate");
    }

    // runnablePreview=false -> preview proxy family 404.
    for (const [method, pathname] of [
      ["GET", "/api/v1/previews/preview-1/"],
      ["GET", "/api/v1/previews/preview-1/some/sub/path"],
      ["POST", "/api/v1/previews/preview-1/api/action"],
    ]) {
      const res = await scenario.call(method, pathname);
      assert.equal(res.status, 404, `${method} ${pathname} must be 404 under runnablePreview=false`);
      assert.equal(res.json.capability, "runnablePreview");
    }

    // deliveryReview=false -> delivery reports + orchestration manifest 404.
    for (const [method, pathname, body] of [
      ["GET", "/api/v1/reports"],
      ["GET", "/api/v1/reports/session-1"],
      ["POST", "/api/v1/controller/manifest", { sessionKey: "session-1", manifest: { requirementSummary: "x" } }],
    ]) {
      const res = await scenario.call(method, pathname, body);
      assert.equal(res.status, 404, `${method} ${pathname} must be 404 under deliveryReview=false`);
      assert.equal(res.json.capability, "deliveryReview");
    }

    // git=false -> repo write/export routes 404 (the read stays graceful).
    const importRes = await scenario.call("POST", "/api/v1/repo/import", {});
    assert.equal(importRes.status, 404, "POST /repo/import must be 404 under git=false");
    assert.equal(importRes.json.capability, "git");

    const bundleRes = await scenario.call("GET", "/api/v1/repo/bundle");
    assert.equal(bundleRes.status, 404, "GET /repo/bundle must be 404 under git=false (no repo exists to export)");
    assert.equal(bundleRes.json.capability, "git");

    // Graceful read: { enabled: false } and NO repo stamping even though the
    // legacy config knob gitEnabled=true is on.
    const repoStatusRes = await scenario.call("GET", "/api/v1/repo");
    assert.equal(repoStatusRes.status, 200, "GET /repo stays a graceful read for every profile");
    assert.deepEqual(repoStatusRes.json, { enabled: false });
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8"));
    assert.ok(!("repo" in persisted), "the git=false profile must not gain a repo field via the status refresh");

    // /roles is capability-agnostic: raw roles pass through untouched.
    const rolesRes = await scenario.call("GET", "/api/v1/roles");
    assert.equal(rolesRes.status, 200);
    const rolesById = Object.fromEntries(rolesRes.json.roles.map((role) => [role.id, role]));
    assert.equal(rolesById["credit-officer"].labelZh, "客户经理", "labeled roles keep their labelZh");
    assert.equal(rolesById["aml-analyst"].labelZh, undefined, "the labelZh-less fixture role stays labelZh-free in the payload");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: software-rd (all capabilities on) - identical routing, no
// capability fields in any body. These are the pre-2.3 behaviors asserted
// without a running scheduler/preview manager (same harness shape as
// tests/test-profile-switch.mjs).
// ---------------------------------------------------------------------------
{
  const scenario = await bootScenario({ initialState: softwareRdState(), profileId: "software-rd" });
  try {
    const profileRes = await scenario.call("GET", "/api/v1/team/profile");
    assert.deepEqual(
      profileRes.json.profile.capabilities,
      { git: true, teamauto: true, runnablePreview: true, deliveryReview: true },
      "software-rd advertises every capability as true",
    );

    // teamauto routes keep the pre-existing scheduler-not-running 503.
    for (const pathname of ["/api/v1/teamauto/activity", "/api/v1/teamauto/repos"]) {
      const res = await scenario.call("GET", pathname);
      assert.equal(res.status, 503, `GET ${pathname} keeps its pre-2.3 503 (no scheduler in this harness)`);
      assert.equal(res.json.capability, undefined, "no capability field may appear when the capability is on");
    }
    const bindRes = await scenario.call("POST", "/api/v1/teamauto/repos", { repo: "acme/widget" });
    assert.equal(bindRes.status, 503, "POST /teamauto/repos keeps its pre-2.3 503");
    assert.equal(bindRes.json.capability, undefined);

    // Delivery routes: 200 empty list / session-miss 404 / 400 manifest.
    const reportsRes = await scenario.call("GET", "/api/v1/reports");
    assert.equal(reportsRes.status, 200);
    assert.deepEqual(reportsRes.json, { reports: [] });
    assert.equal(reportsRes.json.capability, undefined);

    const reportMissRes = await scenario.call("GET", "/api/v1/reports/no-such-session");
    assert.equal(reportMissRes.status, 404, "session-miss keeps its own 404 semantics");
    assert.match(reportMissRes.json.error, /No report found/, "session-miss 404 is NOT the capability 404");
    assert.equal(reportMissRes.json.capability, undefined);

    const manifestRes = await scenario.call("POST", "/api/v1/controller/manifest", {});
    assert.equal(manifestRes.status, 400, "POST /controller/manifest keeps its 400 validation path");
    assert.equal(manifestRes.json.capability, undefined);

    // Preview proxy keeps its unavailable-preview 503.
    const previewRes = await scenario.call("GET", "/api/v1/previews/none/");
    assert.equal(previewRes.status, 503, "GET /previews/:id keeps its pre-2.3 unavailable 503");
    assert.equal(previewRes.json.capability, undefined);

    // Repo routes keep their validation/export paths (git-enabled config off
    // in this harness: a `{}` body is non-empty, so import proceeds into the
    // disabled-git failure; bundle export hits the same wall - both
    // pre-existing behaviors, neither a capability 404).
    const importRes = await scenario.call("POST", "/api/v1/repo/import", {});
    assert.equal(importRes.status, 500, "POST /repo/import keeps its disabled-git 500 (pre-2.3 behavior)");
    assert.match(importRes.json.error, /git collaboration is disabled/);
    assert.equal(importRes.json.capability, undefined);
    const bundleRes = await scenario.call("GET", "/api/v1/repo/bundle");
    assert.equal(bundleRes.status, 503, "GET /repo/bundle keeps its disabled 503");
    assert.match(bundleRes.json.error, /git collaboration is disabled/);
    assert.equal(bundleRes.json.capability, undefined);
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: transition x capability overlay - transition semantics win for
// the overlapping write routes; capability 404 still owns non-transitioned
// routes; both revert to the steady state when the transition clears.
// The seeded shape is the real warming-phase state of a switch TO minimal-bank
// (step 4 has flipped the active profile; the transition is not yet cleared).
// ---------------------------------------------------------------------------
{
  const initial = minimalBankState({
    transition: { phase: "warming", targetProfileId: "minimal-bank", startedAt: now - 500 },
  });
  const scenario = await bootScenario({ initialState: initial, profileId: "minimal-bank" });
  try {
    // Overlay: repo import is BOTH transition-blocked (503) and
    // capability-gated (404) - the transition 503 must win.
    const importDuring = await scenario.call("POST", "/api/v1/repo/import", {});
    assert.equal(importDuring.status, 503, "during a transition the 503 wins over the capability 404");
    assert.equal(importDuring.headers.get("retry-after"), "5");
    assert.match(importDuring.json.error, /profile switch to "minimal-bank" is in progress/);
    assert.equal(importDuring.json.capability, undefined, "the transition body must not claim a capability reason");

    // Task submission stays 503 during the transition (P2.1 matrix).
    const taskDuring = await scenario.call("POST", "/api/v1/tasks", { title: "overlay task" });
    assert.equal(taskDuring.status, 503);

    // Reads (and non-submission writes) not covered by the transition matrix
    // keep the capability 404.
    const activityDuring = await scenario.call("GET", "/api/v1/teamauto/activity");
    assert.equal(activityDuring.status, 404, "capability-gated reads stay 404 during a transition");
    assert.equal(activityDuring.json.capability, "teamauto");
    const bindDuring = await scenario.call("POST", "/api/v1/teamauto/repos", { repo: "acme/widget" });
    assert.equal(bindDuring.status, 404, "POST /teamauto/repos is not transition-blocked, so the capability 404 applies");
    assert.equal(bindDuring.json.capability, "teamauto");
    // POST /controller/manifest IS a transition-blocked submission entry
    // (P2.1 matrix), so during the switch it reports 503, not the capability 404.
    const manifestDuring = await scenario.call("POST", "/api/v1/controller/manifest", { manifest: { requirementSummary: "x" } });
    assert.equal(manifestDuring.status, 503, "POST /controller/manifest is transition-blocked: 503 wins over the capability 404");

    // Transition cleared -> the steady-state 404 is the only gate left.
    scenario.deps.updateTeamState((s) => { delete s.transition; });
    const importAfter = await scenario.call("POST", "/api/v1/repo/import", {});
    assert.equal(importAfter.status, 404, "once the transition clears, repo import is the steady-state capability 404");
    assert.equal(importAfter.json.capability, "git");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: debt item 4 - scanner joint-review roles derive from the
// active profile (type-level software-role union is gone).
// ---------------------------------------------------------------------------
{
  loaderMod.setActiveProfileId("software-rd");
  assert.deepEqual(
    scannerMod.resolveJointReviewSections().map((section) => section.id),
    ["architect", "qa", "security-engineer"],
    "software-rd keeps the architect/qa/security-engineer joint trio (behavior unchanged)",
  );
  loaderMod.setActiveProfileId("minimal-bank");
  assert.deepEqual(
    scannerMod.resolveJointReviewSections(),
    [],
    "a profile without the section roles schedules no joint full review (no hardcoded fallback)",
  );
  // Every section carries its focus prose (the fan-out context depends on it).
  loaderMod.setActiveProfileId("software-rd");
  for (const section of scannerMod.resolveJointReviewSections()) {
    assert.ok(section.focus.length > 20, `section ${section.id} keeps its focus text`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: Phase 2.6 labelZh fallback.
// ---------------------------------------------------------------------------
{
  loaderMod.setActiveProfileId("minimal-bank");
  const roles = loaderMod.getActiveRoles();
  const byId = Object.fromEntries(roles.map((role) => [role.id, role]));
  assert.ok(byId["aml-analyst"], "fixture carries the labelZh-less role");
  assert.equal(byId["aml-analyst"].labelZh, undefined);
  assert.equal(byId["credit-officer"].labelZh, "客户经理");

  // The fallback rule lives in the loader (single backend source of truth).
  assert.equal(
    loaderMod.resolveRoleDisplayName(byId["credit-officer"]),
    "客户经理",
    "zh rendering uses labelZh when present",
  );
  assert.equal(
    loaderMod.resolveRoleDisplayName(byId["aml-analyst"]),
    "AML Analyst",
    "zh rendering falls back to label when labelZh is absent (Phase 2.6)",
  );
  assert.equal(
    loaderMod.resolveRoleDisplayName(byId["credit-officer"], "en"),
    "Credit Officer",
    "en rendering always uses label",
  );
  assert.equal(
    loaderMod.resolveRoleDisplayName(byId["aml-analyst"], "en"),
    "AML Analyst",
    "en rendering uses label for labelZh-less roles too",
  );

  // Load-validation side: present-but-empty labelZh is fatal (a blank string
  // must never compete with the fallback).
  const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, "src", "dist", "src", "profiles", "schema.json"), "utf8"));
  const fixturePackage = JSON.parse(JSON.stringify(loaderMod.BUILTIN_PROFILES.get("minimal-bank")));
  assert.equal(fixturePackage.roles.length, 4, "fixture package holds 4 roles");
  fixturePackage.roles[0].labelZh = "";
  assert.throws(
    () => loaderMod.validateProfilePackage(fixturePackage, schema, "empty-labelZh.json"),
    /labelZh[\s\S]*shorter than minLength 1/,
    "an empty labelZh must fail load validation (design 2.6)",
  );
}

console.log("Team capability gates + labelZh fallback smoke passed.");
