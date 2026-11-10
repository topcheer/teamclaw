#!/usr/bin/env node
// Phase 2.1 + 2.2 (vertical-team-profiles-design.md sections 2.3 and 4):
// persistence + HTTP contract tests for the team profile switch, run against
// the built dist modules (run `npm --prefix src run build` first).
//
// Covers:
//   1. Switch e2e software-rd -> minimal-bank (test fixture loaded via
//      TEAMCLAW_EXTRA_PROFILES_DIR): 202, team.switch_started/completed WS
//      events, whole-TeamState archive roundtrip (incl. roles snapshot and
//      profile metadata), /roles serving the new profile, persisted
//      profileId surviving a reload, capability omission (no repo/previews/
//      reports keys for an all-off profile).
//   2. Concurrency matrix (design 2.3): second switch POST -> 409; task
//      submission POSTs -> 503 + Retry-After; worker register/heartbeat ->
//      409 with retryAfterMs backoff hint.
//   3. Crash resume, both branches: archive already on disk (phase
//      archiving/warming) -> jump straight to the new team (no duplicate
//      archive); no archive (phase draining) -> re-drain, drain timeout
//      force-collects the in-flight task into the archive.
//   4. software-rd -> software-rd keeps capability-backed fields (repo
//      re-prepared, previews/reports present-but-empty).
//   5. Malformed persisted transition is dropped by the state migration
//      (switch aborts to the intact previous team).
//   6. Debt item 1: teamclaw_request_kickoff validates candidateRoles
//      against the ACTIVE profile (credit-officer passes, bogus ids drop).
//
// The dist modules resolve their state directory from OPENCLAW_STATE_DIR at
// module init (state.ts) and the extra fixture profile directory from
// TEAMCLAW_EXTRA_PROFILES_DIR (profile-loader.ts), so both env vars are set
// before the first dist import; all scenarios share one state directory and
// reset it between cases.

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
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-profile-switch-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
const stateDir = path.join(stateRoot, "plugins", "teamclaw");
fs.mkdirSync(stateDir, { recursive: true });

const stateMod = await dist("state.js");
const httpMod = await dist("controller/http-server.js");
// PR-A of issue #204: the switch state machine (incl. crash resume) moved
// from http-server.ts into controller/profile-switch.ts - pin the new home.
const profileSwitchMod = await dist("controller/profile-switch.js");
// PR-C of issue #204: the controller intake orchestration (incl. the
// switch-in-progress entry gate) moved from http-server.ts into
// controller/controller-intake.ts - pin the new home.
const controllerIntakeMod = await dist("controller/controller-intake.js");
const { TaskRouter } = await dist("controller/task-router.js");
const { MessageRouter } = await dist("controller/message-router.js");
const { TeamWebSocketServer } = await dist("controller/websocket.js");
const { parsePluginConfig } = await dist("types.js");
const loaderMod = await dist("profile-loader.js");
const controllerToolsMod = await dist("controller/controller-tools.js");

assert.equal(loaderMod.hasProfile("minimal-bank"), true, "fixture profile must be merged via TEAMCLAW_EXTRA_PROFILES_DIR");
assert.equal(loaderMod.getActiveProfileId(), "software-rd", "the test process boots on the software-rd baseline");

const logger = {
  infos: [],
  warns: [],
  errors: [],
  info(entry) { this.infos.push(entry); },
  warn(entry) { this.warns.push(entry); },
  error(entry) { this.errors.push(entry); },
  debug() {},
};

function softwareRdState(overrides = {}) {
  const now = Date.now();
  return {
    version: 2,
    profileId: "software-rd",
    teamName: "Switch Team",
    workers: {
      "w-dev": {
        id: "w-dev",
        role: "developer",
        label: "Developer",
        status: "idle",
        transport: "http",
        url: "http://127.0.0.1:9",
        lastHeartbeat: now,
        capabilities: ["coding"],
        registeredAt: now,
      },
    },
    tasks: {
      "task-pending": {
        id: "task-pending",
        title: "Pending software task",
        description: "Seeded pending task.",
        status: "pending",
        priority: "medium",
        assignedRole: "developer",
        createdBy: "boss",
        createdAt: now,
        updatedAt: now,
      },
      "task-done": {
        id: "task-done",
        title: "Completed software task",
        description: "Seeded completed task.",
        status: "completed",
        priority: "low",
        createdBy: "boss",
        createdAt: now - 1000,
        updatedAt: now,
        startedAt: now - 500,
        completedAt: now,
        result: "done",
      },
    },
    controllerRuns: {},
    projects: {},
    messages: [
      { id: "msg-1", from: "w-dev", type: "broadcast", content: "hello", createdAt: now },
    ],
    clarifications: {},
    repo: {
      enabled: true,
      mode: "shared",
      defaultBranch: "main",
      remoteReady: false,
      headCommit: "abc123",
      dirty: false,
      lastPreparedAt: now,
    },
    provisioning: { workers: {} },
    createdAt: now - 5000,
    updatedAt: now,
    ...overrides,
  };
}

async function bootScenario(options = {}) {
  loaderMod.setActiveProfileId("software-rd");
  // Fresh archive directory per scenario so "exactly one archive file" style
  // assertions are meaningful; the shared state module writes here.
  fs.rmSync(path.join(stateDir, "archived"), { recursive: true, force: true });
  process.env.TEAMCLAW_WORKSPACE_DIR = options.workspaceDir
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "tc-switch-workspace-"));

  const config = parsePluginConfig({
    mode: "controller",
    teamName: "Switch Team",
    port: 19527,
    gitEnabled: options.gitEnabled ?? false,
    ...(options.drainTimeoutMs ? { teamSwitchDrainTimeoutMs: options.drainTimeoutMs } : {}),
  });

  let teamState = options.initialState ?? null;
  if (teamState) {
    await stateMod.saveTeamState(teamState);
  }
  const getTeamState = () => teamState;
  // One-shot failure injection for the "archive landed, later step failed"
  // construction: the next updateTeamState that observes (phase "archiving"
  // + an archive file on disk) is exactly step 4's rebuild - throw there.
  let failNextUpdateAfterArchive = Boolean(options.failUpdateAfterArchive);
  // Issue #226 W4: the mock mirrors the real single-write-entry contract
  // (controller-service.ts updateState): sync updater on the shared object,
  // fire-and-forget save by default, awaited-durability handle + post-persist
  // broadcast replay when options.persist === "awaited".
  const updateTeamState = (updater, updateOptions) => {
    if (
      failNextUpdateAfterArchive
      && teamState?.transition?.phase === "archiving"
      && listArchiveFiles().length > 0
    ) {
      failNextUpdateAfterArchive = false;
      throw new Error("simulated post-archive failure (state rebuild)");
    }
    updater(teamState);
    const replayBroadcast = () => {
      for (const event of updateOptions?.broadcast ?? []) {
        wsServer.broadcastUpdate(event);
      }
    };
    if (updateOptions?.persist === "awaited") {
      let persisted = stateMod.saveTeamState(teamState);
      if ((updateOptions.broadcast ?? []).length > 0) {
        persisted = persisted.then(replayBroadcast);
      }
      return { state: teamState, persisted };
    }
    void stateMod.saveTeamState(teamState);
    replayBroadcast();
    return teamState;
  };

  const wsServer = new TeamWebSocketServer(logger);
  const wsEvents = [];
  // Snapshots the in-memory transition phase at each broadcast so tests can
  // prove event ordering (e.g. team.switch_failed must fire BEFORE the
  // failure path clears the transition).
  const wsTransitionPhaseAtBroadcast = [];
  wsServer.broadcastUpdate = (event) => {
    wsEvents.push(event);
    wsTransitionPhaseAtBroadcast.push(teamState?.transition ? teamState.transition.phase : null);
  };

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
    deps, server, call, wsEvents, wsTransitionPhaseAtBroadcast,
    getTeamState,
    setTeamState(next) { teamState = next; },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      wsServer.close();
    },
  };
}

function archivedDir() {
  return path.join(stateDir, "archived");
}

function listArchiveFiles() {
  return fs.existsSync(archivedDir()) ? fs.readdirSync(archivedDir()).sort() : [];
}

function readStateFile() {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8"));
}

async function waitForSwitchCompletion(call, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await call("GET", "/api/v1/team/profile");
    if (json && json.transition === null) {
      return json;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("profile switch did not complete within the timeout");
}

// ---------------------------------------------------------------------------
// Scenario 1: switch e2e software-rd -> minimal-bank.
// ---------------------------------------------------------------------------
{
  const scenario = await bootScenario({ initialState: softwareRdState(), gitEnabled: true });
  try {
    // Pre-switch sanity: endpoints of design section 4.
    const profilesRes = await scenario.call("GET", "/api/v1/profiles");
    assert.equal(profilesRes.status, 200);
    const byId = Object.fromEntries(profilesRes.json.profiles.map((entry) => [entry.id, entry]));
    assert.ok(byId["software-rd"], "software-rd must be listed");
    assert.ok(byId["minimal-bank"], "the fixture profile must be listed");
    assert.equal(byId["software-rd"].roleCount, 11, "software-rd roleCount is the 11-role baseline");
    assert.equal(byId["minimal-bank"].roleCount, 4, "fixture roleCount (3 labeled roles + the Phase 2.6 labelZh-less role)");
    assert.equal(byId["minimal-bank"].nameZh, "最小银行团队", "profiles listing carries nameZh");
    assert.ok(byId["minimal-bank"].icon && byId["minimal-bank"].industry && byId["minimal-bank"].version, "profiles listing carries icon/industry/version");
    // Phase 5 follow-up (#193): the listing carries each pack's capability
    // switches so the switcher confirm step can warn that off -> on flips
    // need a gateway restart to re-enable the subsystem.
    assert.deepEqual(
      byId["minimal-bank"].capabilities,
      { git: false, teamauto: false, runnablePreview: false, deliveryReview: false },
      "profiles listing carries the target pack's capability switches",
    );
    assert.deepEqual(
      byId["software-rd"].capabilities,
      { git: true, teamauto: true, runnablePreview: true, deliveryReview: true },
      "software-rd listing keeps its all-on capability switches",
    );

    const beforeRes = await scenario.call("GET", "/api/v1/team/profile");
    assert.equal(beforeRes.status, 200);
    assert.equal(beforeRes.json.profileId, "software-rd");
    assert.deepEqual(
      beforeRes.json.profile.capabilities,
      { git: true, teamauto: true, runnablePreview: true, deliveryReview: true },
      "GET /team/profile must expose capabilities (UI hides capability-gated entries with it)",
    );
    assert.equal(beforeRes.json.transition, null, "no transition before the switch");

    // Step 0: unknown profile id is a 404.
    const unknownRes = await scenario.call("POST", "/api/v1/team/profile", { profileId: "nope" });
    assert.equal(unknownRes.status, 404, "unknown profileId must be 404");

    // The switch itself.
    const switchRes = await scenario.call("POST", "/api/v1/team/profile", { profileId: "minimal-bank" });
    assert.equal(switchRes.status, 202, "switch must be accepted asynchronously (design section 4)");
    assert.equal(switchRes.json.status, "switching");
    assert.equal(switchRes.json.transition.phase, "draining");
    assert.equal(switchRes.json.transition.targetProfileId, "minimal-bank");

    const settled = await waitForSwitchCompletion(scenario.call);
    assert.equal(settled.profileId, "minimal-bank");
    assert.equal(settled.teamName, "Minimal Bank Team", "new teamName comes from the new profile");
    assert.equal(settled.profile.roles[0].id, "credit-officer");

    // WS event contract (Phase 2.2).
    const started = scenario.wsEvents.find((event) => event.type === "team.switch_started");
    const completed = scenario.wsEvents.find((event) => event.type === "team.switch_completed");
    assert.ok(started, "team.switch_started must be broadcast");
    assert.deepEqual(
      { profileId: started.data.profileId, previousProfileId: started.data.previousProfileId },
      { profileId: "minimal-bank", previousProfileId: "software-rd" },
      "team.switch_started payload",
    );
    assert.ok(completed, "team.switch_completed must be broadcast");
    assert.deepEqual(completed.data, { profileId: "minimal-bank" }, "team.switch_completed payload");

    // Archive: whole TeamState + roles snapshot + profile metadata, roundtrip.
    const files = listArchiveFiles();
    assert.equal(files.length, 1, "exactly one archive file for the switch");
    assert.match(files[0], /^software-rd-\d+-(?:[a-z0-9]{6})\.json$/, "archive file name is <profileId>-<timestamp>-<suffix>.json (#251 collision guard)");
    const envelope = JSON.parse(fs.readFileSync(path.join(archivedDir(), files[0]), "utf8"));
    assert.equal(envelope.profile.id, "software-rd", "archive embeds the profile id");
    assert.equal(envelope.profile.name, "Software R&D Team", "archive embeds the profile name");
    assert.ok(/^\d+\.\d+\.\d+$/.test(envelope.profile.version), "archive embeds the profile version");
    assert.equal(envelope.profile.roles.length, 11, "archive embeds the full roles snapshot");
    assert.ok(
      envelope.profile.roles.every((role) => typeof role.systemPrompt === "string" && role.systemPrompt.length > 0),
      "roles snapshot keeps systemPrompts (anti terminology-drift, design 2.2)",
    );
    assert.ok(envelope.team.tasks["task-pending"] && envelope.team.tasks["task-done"], "archived team keeps all tasks");
    assert.ok(envelope.team.messages.length === 1, "archived team keeps messages");
    assert.ok(envelope.team.repo?.enabled === true, "archived team keeps the repo state");

    // New TeamState: capability omission for an all-off profile.
    const persisted = readStateFile();
    assert.equal(persisted.profileId, "minimal-bank", "profileId persisted");
    assert.equal(persisted.teamName, "Minimal Bank Team");
    assert.equal(Object.keys(persisted.tasks).length, 0, "tasks cleared");
    assert.equal(Object.keys(persisted.workers).length, 0, "workers cleared");
    assert.equal(persisted.transition, undefined, "transition cleared after completion");
    assert.ok(!("repo" in persisted), "git=false profile omits repo");
    assert.ok(!("previews" in persisted), "runnablePreview=false profile omits previews");
    assert.ok(!("reports" in persisted), "deliveryReview=false profile omits reports");

    // /roles serves the new profile.
    const rolesRes = await scenario.call("GET", "/api/v1/roles");
    assert.equal(rolesRes.status, 200);
    assert.deepEqual(
      rolesRes.json.roles.map((role) => role.id),
      ["credit-officer", "risk-reviewer", "approver", "aml-analyst"],
      "/roles returns the active profile role set after the switch",
    );
    assert.equal(rolesRes.json.defaultRole, "credit-officer");

    // Archive metadata listing.
    const archivesRes = await scenario.call("GET", "/api/v1/archived-teams");
    assert.equal(archivesRes.status, 200);
    assert.equal(archivesRes.json.archives.length, 1);
    const summary = archivesRes.json.archives[0];
    assert.equal(summary.profileId, "software-rd");
    assert.equal(summary.teamName, "Switch Team");
    assert.equal(summary.taskCount, 2, "archive metadata carries the task count");
    assert.ok(typeof summary.archivedAt === "number" && summary.archivedAt > 0, "archive metadata carries the time");
    assert.equal(summary.file, files[0]);

    // profileId survives a reload (restart semantics).
    const reloaded = await stateMod.loadTeamState("Switch Team");
    assert.equal(reloaded.profileId, "minimal-bank", "persisted profileId survives a restart-shaped reload");

    // Debt item 1: kickoff tool candidate-role validation is active-profile
    // aware now that the loader is switched to minimal-bank.
    let handlerRoles = null;
    const tools = controllerToolsMod.createControllerTools({
      config: scenario.deps.config,
      controllerUrl: "http://127.0.0.1:1",
      getTeamState: () => scenario.getTeamState(),
      getKickoffHandler: () => async (roles) => {
        handlerRoles = roles;
        return { assessments: [], summary: "ok" };
      },
    });
    const kickoffTool = tools.find((tool) => tool.name === "teamclaw_request_kickoff");
    await kickoffTool.execute("t", { requirement: "review the credit file", candidateRoles: ["credit-officer", "bogus-role", "developer"], complexity: "simple" });
    assert.deepEqual(
      handlerRoles,
      ["credit-officer"],
      "kickoff candidate roles must validate against the ACTIVE profile (debt 1): banking role accepted, unknown + software roles dropped",
    );
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: concurrency matrix while a transition is in flight.
// ---------------------------------------------------------------------------
{
  // NOTE: the seeded worker is offline. An idle worker + pending tasks with
  // unreachable URLs would drive dispatch through the revert path; the
  // spawn-on-revert storm is fixed (issue #191, guarded by
  // tests/test-autoassign-backoff.mjs), but keeping the worker offline still
  // keeps this scenario free of dispatch side effects - the matrix semantics
  // do not depend on worker liveness.
  const matrixState = softwareRdState();
  matrixState.workers["w-dev"].status = "offline";
  const scenario = await bootScenario({ initialState: matrixState });
  try {
    scenario.deps.updateTeamState((s) => {
      s.transition = { phase: "draining", targetProfileId: "minimal-bank", startedAt: Date.now() };
    });

    // Second switch POST -> 409.
    const secondSwitch = await scenario.call("POST", "/api/v1/team/profile", { profileId: "minimal-bank" });
    assert.equal(secondSwitch.status, 409, "concurrent switch must be 409");
    assert.equal(secondSwitch.json.transition.targetProfileId, "minimal-bank");

    // Step-0 ordering: unknown id is reported even while a transition runs.
    const unknownDuring = await scenario.call("POST", "/api/v1/team/profile", { profileId: "nope" });
    assert.equal(unknownDuring.status, 404, "profileId existence check precedes the 409 transition check (design 2.3 step 0 order)");

    // Task submission -> 503 + Retry-After.
    const taskRes = await scenario.call("POST", "/api/v1/tasks", { title: "blocked task" });
    assert.equal(taskRes.status, 503, "task submission during a transition must be 503");
    assert.equal(taskRes.headers.get("retry-after"), "5", "503 must carry a Retry-After header");
    assert.ok(taskRes.json.retryAfterSeconds > 0, "503 body repeats the retry hint");

    const intakeRes = await scenario.call("POST", "/api/v1/controller/intake", { message: "do things" });
    assert.equal(intakeRes.status, 503, "controller intake during a transition must be 503");

    const manifestRes = await scenario.call("POST", "/api/v1/controller/manifest", { requirement: "x" });
    assert.equal(manifestRes.status, 503, "controller manifest during a transition must be 503");

    const assignRes = await scenario.call("POST", "/api/v1/tasks/task-pending/assign", { workerId: "w-dev" });
    assert.equal(assignRes.status, 503, "manual task assignment during a transition must be 503");

    // Review fix: parallel-help funnels into runControllerIntake and would
    // spawn new work for the outgoing team - gated like the other submission
    // entry points (task handoff intentionally stays open).
    const parallelHelpRes = await scenario.call("POST", "/api/v1/tasks/task-pending/parallel-help", {
      requestedBy: "w-dev", reason: "need more capacity",
    });
    assert.equal(parallelHelpRes.status, 503, "parallel-help during a transition must be 503");
    assert.equal(parallelHelpRes.headers.get("retry-after"), "5");

    // Review fix: repo import during a transition would stamp a repo field
    // onto the post-flip team even for git-disabled profiles.
    const repoImportRes = await scenario.call("POST", "/api/v1/repo/import", {});
    assert.equal(repoImportRes.status, 503, "repo import during a transition must be 503");
    assert.equal(repoImportRes.headers.get("retry-after"), "5");
    assert.match(repoImportRes.json.error, /repo import is temporarily unavailable/);

    // Worker register/heartbeat -> 409 with backoff hint.
    const registerRes = await scenario.call("POST", "/api/v1/workers/register", {
      workerId: "w-new", role: "credit-officer", label: "credit", url: "http://127.0.0.1:8",
    });
    assert.equal(registerRes.status, 409, "worker registration during a transition must be 409");
    assert.equal(registerRes.json.retryAfterMs, 5000, "409 body must carry the retryAfterMs backoff hint");
    assert.match(registerRes.json.error, /in progress/, "409 body explains the transition");

    const heartbeatRes = await scenario.call("POST", "/api/v1/workers/w-dev/heartbeat", { status: "idle" });
    assert.equal(heartbeatRes.status, 409, "worker heartbeat during a transition must be 409");
    assert.equal(heartbeatRes.json.retryAfterMs, 5000, "heartbeat 409 body carries the backoff hint");

    // Reads stay open (drain visibility for the UI).
    const rolesRes = await scenario.call("GET", "/api/v1/roles");
    assert.equal(rolesRes.status, 200, "GET /roles stays available during a transition");
    const profileRes = await scenario.call("GET", "/api/v1/team/profile");
    assert.equal(profileRes.status, 200);
    assert.equal(profileRes.json.transition.phase, "draining", "GET /team/profile exposes the transition");

    // Review fix: the runControllerIntake ENTRY rejects while a transition is
    // active - the single funnel covering URL submissions AND internal
    // callers (task-completion follow-ups, clarification resumes) that
    // bypass the URL gate. It must fail before any runtime/LLM work and
    // without matching the intake retry pattern (no silent retry into the
    // switched team).
    {
      const runtimeProbe = { subagent: { run: async () => { throw new Error("runtime must not be reached"); } } };
      const probeDeps = { ...scenario.deps, runtime: runtimeProbe };
      await assert.rejects(
        () => controllerIntakeMod.runControllerIntake("follow-up message", "teamclaw-controller-web:probe", probeDeps),
        (err) => err instanceof controllerIntakeMod.ControllerIntakeSwitchInProgressError
          && /profile switch to "minimal-bank" is in progress/.test(err.message)
          && err.transition.phase === "draining",
        "runControllerIntake must reject with the typed transition error before touching runtime",
      );
    }

    // Transition cleared -> the gate lifts.
    scenario.deps.updateTeamState((s) => { delete s.transition; });
    const afterRes = await scenario.call("POST", "/api/v1/tasks", { title: "allowed task" });
    assert.equal(afterRes.status, 201, "task submission works again once the transition is gone");
    {
      // Same funnel with the transition gone: the entry check passes and the
      // run proceeds into runtime (the probe marks how far it got).
      const runtimeProbe = { subagent: { run: async () => { throw new Error("runtime reached as expected"); } } };
      const probeDeps = { ...scenario.deps, runtime: runtimeProbe };
      await assert.rejects(
        () => controllerIntakeMod.runControllerIntake("hello", "teamclaw-controller-web:probe", probeDeps),
        /runtime reached as expected/,
        "with no transition the intake entry must let the run proceed to runtime",
      );
    }
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: crash resume, archive already on disk -> skip to the new team.
// ---------------------------------------------------------------------------
{
  const initial = softwareRdState();
  const startedAt = Date.now() - 2000;
  initial.transition = { phase: "archiving", targetProfileId: "minimal-bank", startedAt };
  const scenario = await bootScenario({ initialState: initial });
  try {
    // Simulate the crash window: phase flipped to "archiving" AND the archive
    // file already written, but the new TeamState never materialized.
    await stateMod.archiveTeamState(initial, {
      id: "software-rd",
      name: "Software R&D Team",
      version: "1.0.0",
      roles: (await dist("profile-loader.js")).getActiveProfile().roles,
    });
    assert.equal(listArchiveFiles().length, 1, "pre-seeded archive file for the crash construction");

    const resumed = await profileSwitchMod.resumeTeamProfileSwitch(scenario.deps);
    assert.equal(resumed, true, "resume reports that a transition was resumed");

    const state = scenario.getTeamState();
    assert.equal(state.profileId, "minimal-bank", "resume rebuilds the target team");
    assert.equal(state.teamName, "Minimal Bank Team");
    assert.equal(Object.keys(state.tasks).length, 0, "new team has no tasks");
    assert.equal(Object.keys(state.workers).length, 0, "new team has no workers");
    assert.equal(state.transition, undefined, "resume clears the transition");
    assert.equal(listArchiveFiles().length, 1, "resume must NOT write a duplicate archive (idempotent branch)");

    const rolesRes = await scenario.call("GET", "/api/v1/roles");
    assert.equal(rolesRes.json.roles[0].id, "credit-officer", "active profile switched by the resume");

    const again = await profileSwitchMod.resumeTeamProfileSwitch(scenario.deps);
    assert.equal(again, false, "resume without a pending transition is a no-op");

    assert.equal(readStateFile().profileId, "minimal-bank", "resumed state is persisted");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: crash resume, no archive -> re-drain from scratch; drain
// timeout force-collects the in-flight task into the archive.
// ---------------------------------------------------------------------------
{
  const initial = softwareRdState();
  const now = Date.now();
  initial.workers["w-busy"] = {
    id: "w-busy",
    role: "developer",
    label: "Busy Developer",
    status: "busy",
    transport: "http",
    url: "http://127.0.0.1:9",
    lastHeartbeat: now,
    capabilities: ["coding"],
    currentTaskId: "task-inflight",
    registeredAt: now,
  };
  initial.tasks["task-inflight"] = {
    id: "task-inflight",
    title: "In-flight software task",
    description: "Stuck in progress.",
    status: "in_progress",
    priority: "high",
    assignedRole: "developer",
    assignedWorkerId: "w-busy",
    createdBy: "boss",
    createdAt: now - 2000,
    updatedAt: now,
    startedAt: now - 1000,
  };
  initial.transition = { phase: "draining", targetProfileId: "minimal-bank", startedAt: now - 1000 };
  const scenario = await bootScenario({ initialState: initial, drainTimeoutMs: 400 });
  try {
    assert.equal(listArchiveFiles().length, 0, "no archive on disk for this branch");

    const resumed = await profileSwitchMod.resumeTeamProfileSwitch(scenario.deps);
    assert.equal(resumed, true);

    const files = listArchiveFiles();
    assert.equal(files.length, 1, "the re-drained switch archives the old team");
    const envelope = JSON.parse(fs.readFileSync(path.join(archivedDir(), files[0]), "utf8"));
    assert.equal(envelope.team.tasks["task-inflight"].status, "failed", "drain timeout force-collects the in-flight task");
    assert.match(envelope.team.tasks["task-inflight"].error, /force-collected/);
    assert.ok(envelope.team.tasks["task-pending"], "the pending task is archived too");

    const state = scenario.getTeamState();
    assert.equal(state.profileId, "minimal-bank", "re-drain resume completes into the target team");
    assert.equal(Object.keys(state.tasks).length, 0);
    assert.equal(state.transition, undefined, "transition cleared after the resumed switch");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: software-rd -> software-rd keeps capability-backed fields.
// ---------------------------------------------------------------------------
{
  const scenario = await bootScenario({ initialState: softwareRdState(), gitEnabled: true });
  try {
    const switchRes = await scenario.call("POST", "/api/v1/team/profile", { profileId: "software-rd" });
    assert.equal(switchRes.status, 202, "same-profile switch is permitted (archive + rebuild)");
    await waitForSwitchCompletion(scenario.call);

    const persisted = readStateFile();
    assert.equal(persisted.profileId, "software-rd");
    assert.ok(persisted.repo && persisted.repo.enabled === true, "git capability true keeps the repo field");
    assert.ok("previews" in persisted, "runnablePreview capability true keeps the (empty) previews field - nothing is omitted for software-rd");
    assert.ok("reports" in persisted, "deliveryReview capability true keeps the (empty) reports field - nothing is omitted for software-rd");
    assert.deepEqual(persisted.previews, {});
    assert.deepEqual(persisted.reports, {});
    assert.equal(listArchiveFiles().length, 1, "the previous software team is archived all the same");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(archivedDir(), listArchiveFiles()[0]), "utf8")).team.tasks["task-pending"].status,
      "pending",
      "software-rd -> software-rd has no in-flight work, nothing is force-collected",
    );
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 6: malformed persisted transition is dropped by state migration.
// ---------------------------------------------------------------------------
{
  fs.rmSync(path.join(stateDir, "archived"), { recursive: true, force: true });
  const broken = softwareRdState();
  broken.transition = { phase: "exploding", targetProfileId: 42, startedAt: "yesterday" };
  await stateMod.saveTeamState(broken);
  const loaded = await stateMod.loadTeamState("Switch Team");
  assert.equal(loaded.transition, undefined, "a malformed persisted transition must be dropped (switch aborts, previous team intact)");
  assert.equal(loaded.profileId, "software-rd");
}

// ---------------------------------------------------------------------------
// Scenario 7 (review fix): the (archiving, target) ghost-archive window.
// Crash point: the step-4 profileId flip reached disk, but the warming phase
// never persisted. On disk this reads as transition.phase = "archiving" with
// state.profileId = TARGET. The archive itself landed earlier under the
// SOURCE profile's name, so a resume that keyed the archive lookup off
// state.profileId would miss it, re-drain the already-emptied NEW team, and
// write a ghost archive (target-named, 0 tasks) polluting /archived-teams.
// ---------------------------------------------------------------------------
{
  const now = Date.now();
  const flippedState = softwareRdState({
    profileId: "minimal-bank",
    teamName: "Minimal Bank Team",
    workers: {},
    tasks: {},
    messages: [],
    createdAt: now - 1000,
  });
  delete flippedState.repo;
  flippedState.transition = { phase: "archiving", targetProfileId: "minimal-bank", startedAt: now - 2000 };
  const scenario = await bootScenario({ initialState: flippedState });
  try {
    // The real archive for this switch: written by step 3 under the SOURCE
    // profile's name, before the step-4 flip.
    const sourceSnapshot = softwareRdState();
    await stateMod.archiveTeamState(sourceSnapshot, {
      id: "software-rd",
      name: "Software R&D Team",
      version: "1.0.0",
      roles: loaderMod.getActiveProfile().roles,
    });
    assert.equal(listArchiveFiles().length, 1, "pre-seeded source archive for the crash construction");
    assert.match(listArchiveFiles()[0], /^software-rd-/);

    const resumed = await profileSwitchMod.resumeTeamProfileSwitch(scenario.deps);
    assert.equal(resumed, true, "the ghost-window combination still resumes");

    const files = listArchiveFiles();
    assert.equal(files.length, 1, "resume must not write an additional archive in the ghost window");
    assert.match(files[0], /^software-rd-\d+-(?:[a-z0-9]{6})\.json$/, "no minimal-bank-named ghost archive may appear");
    assert.doesNotMatch(files[0], /^minimal-bank-/);

    const state = scenario.getTeamState();
    assert.equal(state.profileId, "minimal-bank", "the resumed new team stays on the target profile");
    assert.equal(state.transition, undefined, "transition cleared");
    assert.equal(Object.keys(state.tasks).length, 0);
    assert.equal(readStateFile().profileId, "minimal-bank", "resumed state persisted");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario 8 (Phase 2 follow-up, #201 review): switch failure semantics.
// The failure path must broadcast team.switch_failed BEFORE clearing the
// transition (the web switcher's loading state is released by the event, not
// by the reconcile timeout), and the reason must be honest about the worst
// case once the archive write has landed.
// ---------------------------------------------------------------------------
async function waitForSwitchFailed(scenario, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = scenario.wsEvents.find((entry) => entry.type === "team.switch_failed");
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("team.switch_failed was not broadcast within the timeout");
}

{
  // 8a: the archive write itself fails (read-only archive dir). No archive
  // landed, so the reason is the raw error; the previous team survives and
  // keeps serving; the switch can be re-issued once the cause is fixed.
  const scenario = await bootScenario({ initialState: softwareRdState() });
  try {
    fs.mkdirSync(archivedDir(), { recursive: true });
    fs.chmodSync(archivedDir(), 0o555);
    const switchRes = await scenario.call("POST", "/api/v1/team/profile", { profileId: "minimal-bank" });
    assert.equal(switchRes.status, 202, "the switch still starts asynchronously before failing");

    const failed = await waitForSwitchFailed(scenario);
    assert.deepEqual(
      { previousProfileId: failed.data.previousProfileId, targetProfileId: failed.data.targetProfileId },
      { previousProfileId: "software-rd", targetProfileId: "minimal-bank" },
      "team.switch_failed payload names both sides of the failed switch",
    );
    assert.ok(typeof failed.data.reason === "string" && failed.data.reason.length > 0, "reason carries the underlying error");
    assert.doesNotMatch(
      failed.data.reason,
      /partially switched/,
      "no archive landed: the reason must not claim a partial switch",
    );
    const broadcastIdx = scenario.wsEvents.indexOf(failed);
    assert.equal(
      scenario.wsTransitionPhaseAtBroadcast[broadcastIdx],
      "archiving",
      "team.switch_failed must be broadcast while the transition is still set (before the failure path clears it)",
    );

    await waitForSwitchCompletion(scenario.call);
    const after = scenario.getTeamState();
    assert.equal(after.profileId, "software-rd", "the previous team keeps serving after the failure");
    assert.equal(after.transition, undefined, "the transition must be cleared so the team is not wedged");
    assert.equal(Object.keys(after.tasks).length, 2, "the previous team's tasks are intact");
    assert.equal(listArchiveFiles().length, 0, "no archive file was written");

    // Not wedged: with the archive dir writable again the switch re-issues.
    fs.chmodSync(archivedDir(), 0o755);
    const retry = await scenario.call("POST", "/api/v1/team/profile", { profileId: "minimal-bank" });
    assert.equal(retry.status, 202, "a failed switch must not wedge the transition gate");
    await waitForSwitchCompletion(scenario.call);
    assert.equal(scenario.getTeamState().profileId, "minimal-bank", "the re-issued switch completes");
    assert.equal(listArchiveFiles().length, 1, "the retry archives the previous team exactly once");
  } finally {
    fs.chmodSync(archivedDir(), 0o755);
    await scenario.close();
  }
}

{
  // 8b: the archive landed but a later step failed (state rebuild throws).
  // The reason must state the honest worst case: archive preserved, team may
  // be partially switched, restart recommended.
  const scenario = await bootScenario({ initialState: softwareRdState(), failUpdateAfterArchive: true });
  try {
    const switchRes = await scenario.call("POST", "/api/v1/team/profile", { profileId: "minimal-bank" });
    assert.equal(switchRes.status, 202);

    const failed = await waitForSwitchFailed(scenario);
    assert.equal(failed.data.previousProfileId, "software-rd");
    assert.equal(failed.data.targetProfileId, "minimal-bank");
    assert.match(
      failed.data.reason,
      /archive preserved, team state may be partially switched, restart recommended/,
      "post-archive failures must carry the honest partial-switch warning",
    );
    assert.match(failed.data.reason, /simulated post-archive failure/, "reason keeps the underlying error detail");

    await waitForSwitchCompletion(scenario.call);
    const after = scenario.getTeamState();
    assert.equal(after.transition, undefined, "transition cleared after the failure");
    assert.equal(after.profileId, "software-rd", "the pre-flip team identity is what survived");
    assert.equal(listArchiveFiles().length, 1, "the archive written before the failure is preserved");
  } finally {
    await scenario.close();
  }
}

console.log("Team profile switch smoke passed.");
