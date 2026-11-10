#!/usr/bin/env node
// Design 2.4 workflows backend (vertical-team-profiles-design.md section
// 2.4) end-to-end contract tests, run against the built dist modules (run
// `npm --prefix src run build` first). No TEAMCLAW_EXTRA_PROFILES_DIR: the
// banking pack itself carries the credit-approval template since 0.1.2.
//
// Covers:
//   1. Loader fatal pipeline: banking.json (workflows included) passes
//      validateProfilePackage under the tightened schema; mutated copies
//      with a dangling on-target / foreign step role / dangling inputs key /
//      on-key outside the conclusion enum / schema-level missing role are
//      ALL rejected (design 2.2: corrupt profile = refuse to start).
//   2. Profile exposure: GET /api/v1/team/profile serializes the banking
//      workflows verbatim (the UI wave's button group reads this).
//   3. POST /api/v1/workflows/{id}/start: 201 creates ONLY the first step
//      task (role/title from the template, initial context + conclusion
//      instruction folded into the description, TaskWorkflowContext present,
//      createdBy "workflow"); unknown id 404; non-string context 400;
//      software-rd (no workflows) 404; 503 + Retry-After during a profile
//      switch transition.
//   4. Runtime conclusion routing (the task-completion hook): completing
//      step 0 with 「材料齐全」 spawns the step-1 risk-review task with the
//      upstream dueDiligenceReport excerpt embedded (design 2.4 outputKey
//      passing); 「退回补充材料」 re-creates step 0 with the return reason;
//      「通过」 reaches step 2 with BOTH inputs embedded; step 2 completing
//      (no conclusion enum) ends the chain (numeric spine never leaks into
//      the committee branch step); 「超权限上会」 routes to the committee
//      branch step; the committee step is a leaf (chain ends).
//   5. Idempotency + loop guard: the routing latch makes re-invoking the
//      continuation on the same completed task a no-op; repeated return
//      edges stop at MAX_WORKFLOW_STEP_VISITS with a guard event.
//   6. Golden adjacency: workflows ride ONLY on the profile JSON - the
//      software-rd prompt surface is untouched (asserted by the dedicated
//      golden tests; here we pin that software-rd ships no workflows).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ---------------------
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-workflows-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-workflows-ws-"));
const stateDir = path.join(stateRoot, "plugins", "teamclaw");
fs.mkdirSync(stateDir, { recursive: true });

const stateMod = await dist("state.js");
const httpMod = await dist("controller/http-server.js");
const workflowMod = await dist("controller/workflow-routes.js");
const { TaskRouter } = await dist("controller/task-router.js");
const { MessageRouter } = await dist("controller/message-router.js");
const { TeamWebSocketServer } = await dist("controller/websocket.js");
const { parsePluginConfig } = await dist("types.js");
const loaderMod = await dist("profile-loader.js");

// ---------------------------------------------------------------------------
// 1. Loader fatal pipeline (validateProfilePackage: schema subset + cross
//    validation; production runs it at module init over every built-in pack).
// ---------------------------------------------------------------------------
const SOURCE_PROFILES_DIR = path.join(projectRoot, "src", "src", "profiles");
const schema = JSON.parse(await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, "schema.json"), "utf8"));
const bankingRaw = JSON.parse(await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, "banking.json"), "utf8"));

assert.equal(bankingRaw.version, "0.1.2", "banking must be version-bumped for the workflows addition");
assert.ok(loaderMod.BUILTIN_PROFILES.has("banking"), "banking stays a built-in pack");
// The dist copy the module init validated carries the workflows too (stale-dist guard).
assert.equal(loaderMod.getActiveProfileId(), "software-rd", "active profile defaults to software-rd");
loaderMod.setActiveProfileId("banking");
const activeWorkflows = loaderMod.getActiveWorkflows();
assert.equal(activeWorkflows.length, 1);
assert.equal(activeWorkflows[0].id, "credit-approval");
assert.equal(activeWorkflows[0].steps.length, 4);

// Positive: the shipped package passes the full pipeline as-is.
loaderMod.validateProfilePackage(bankingRaw, schema, "banking.json");

const clone = () => JSON.parse(JSON.stringify(bankingRaw));
const expectFatal = (label, mutate) => {
  const pack = clone();
  mutate(pack);
  assert.throws(
    () => loaderMod.validateProfilePackage(pack, schema, `banking-${label}.json`),
    undefined,
    `mutated banking (${label}) must be a FATAL load error`,
  );
};
expectFatal("dangling-on-target", (p) => { p.workflows[0].steps[1].on.通过 = 9; });
expectFatal("foreign-step-role", (p) => { p.workflows[0].steps[1].role = "architect"; });
expectFatal("dangling-input-key", (p) => { p.workflows[0].steps[2].inputs.push("nopeReport"); });
expectFatal("on-key-outside-conclusion", (p) => { p.workflows[0].steps[0].on = { 未列举的结论: 1 }; });
expectFatal("schema-missing-step-role", (p) => { delete p.workflows[0].steps[2].role; });
expectFatal("schema-bad-workflow-id", (p) => { p.workflows[0].id = "Credit Approval"; });
expectFatal("duplicate-step-id", (p) => { p.workflows[0].steps[3].id = 2; });
expectFatal("duplicate-output-key", (p) => {
  p.workflows[0].steps[2].outputs.push({ key: "dueDiligenceReport", name: "重复" });
});
// #251 M2: two steps mutually jumping via explicit on edges form a static
// cycle (0 -> 1 via 需补充材料, 1 -> 0 via the existing 退回补充材料) - load must
// reject it instead of waiting for the runtime visit cap to burn LLM calls.
expectFatal("on-jump-cycle", (p) => { p.workflows[0].steps[0].on.需补充材料 = 1; });
// #251 L7: steps[0] must sit on the numeric spine - a branch-only string id
// first step would end the run instantly (no next spine edge to follow). The
// back-reference is repointed so ONLY the new red line fires.
expectFatal("first-step-not-numeric-spine", (p) => {
  p.workflows[0].steps[0].id = "intake";
  p.workflows[0].steps[1].on.退回补充材料 = "intake";
});
console.log("✅ loader fatal pipeline: banking passes, 10 mutated variants rejected (incl. on-jump cycle, non-numeric first step)");

// software-rd carries no workflows (prompt surface untouched, golden tests hold).
const softwareRd = JSON.parse(await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, "software-rd.json"), "utf8"));
assert.equal(softwareRd.workflows, undefined, "software-rd must not ship workflows");

// ---------------------------------------------------------------------------
// HTTP harness (same boot shape as tests/test-capability-gates.mjs).
// ---------------------------------------------------------------------------
const logger = {
  info() {}, warn() {}, error() {}, debug() {},
};
const now = Date.now();

function bankingState(overrides = {}) {
  return {
    version: 2,
    profileId: "banking",
    teamName: "Banking Credit Team",
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

async function bootScenario({ initialState } = {}) {
  loaderMod.setActiveProfileId("banking");
  const config = parsePluginConfig({
    mode: "controller",
    teamName: "Banking Credit Team",
    port: 19529,
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
    deps, server, call, getTeamState,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      wsServer.close();
    },
  };
}

/** Polls the task list until a task matching the predicate appears (the completion hook routes async). */
async function waitForTask(scenario, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tasks = Object.values(scenario.getTeamState()?.tasks ?? {});
    const hit = tasks.find(predicate);
    if (hit) {
      return hit;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for task: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function completeStep(scenario, task, resultText) {
  const res = await scenario.call("POST", `/api/v1/tasks/${task.id}/result`, { result: resultText });
  assert.equal(res.status, 200, `task result submission for ${task.id} must succeed`);
  return res.json.task;
}

const DUE_DILIGENCE_TEXT = "尽调摘要：借款人经营正常，流水与纳税记录匹配，押品为市区商业用房。结论：材料齐全";

// ---------------------------------------------------------------------------
// 2 + 3. Profile exposure + start endpoint.
// ---------------------------------------------------------------------------
const scenario = await bootScenario({ initialState: bankingState() });
try {
  const profileRes = await scenario.call("GET", "/api/v1/team/profile");
  assert.equal(profileRes.status, 200);
  assert.equal(profileRes.json.profileId, "banking");
  const workflows = profileRes.json.profile.workflows;
  assert.ok(Array.isArray(workflows) && workflows.length === 1,
    "GET /team/profile must serialize the banking workflows (UI button group source)");
  assert.equal(workflows[0].id, "credit-approval");
  assert.equal(workflows[0].name, "信贷审批流（对公）");
  assert.deepEqual(
    workflows[0].steps.map((step) => step.id),
    [0, 1, 2, "committee"],
  );
  assert.deepEqual(workflows[0].steps[1].on, { 退回补充材料: 0, 超权限上会: "committee", 通过: 2 });

  // unknown workflow -> 404 naming what is available.
  const unknown = await scenario.call("POST", "/api/v1/workflows/nope/start", {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /unknown workflow "nope"/);
  assert.match(unknown.json.error, /credit-approval/);

  // non-string context -> 400.
  const badContext = await scenario.call("POST", "/api/v1/workflows/credit-approval/start", { context: 42 });
  assert.equal(badContext.status, 400);
  assert.match(badContext.json.error, /"context" must be a string/);

  // transition in flight -> 503 + Retry-After (handler-level transition matrix).
  scenario.deps.updateTeamState((s) => {
    s.transition = { phase: "draining", targetProfileId: "software-rd", startedAt: Date.now() };
  });
  const duringSwitch = await scenario.call("POST", "/api/v1/workflows/credit-approval/start", {});
  assert.equal(duringSwitch.status, 503, "workflow start during a profile switch must be 503");
  assert.equal(duringSwitch.headers.get("retry-after") !== null, true, "503 carries a Retry-After header");
  assert.equal(duringSwitch.json.retryAfterSeconds > 0, true);
  assert.equal(duringSwitch.json.transition.targetProfileId, "software-rd");
  scenario.deps.updateTeamState((s) => {
    delete s.transition;
  });

  // happy path start.
  const start = await scenario.call("POST", "/api/v1/workflows/credit-approval/start", {
    context: "借款人：某制造企业（脱敏编号 C-2026-114），申请流动资金贷款额度 800 万元，期限 1 年。",
  });
  assert.equal(start.status, 201);
  assert.equal(start.json.workflowId, "credit-approval");
  assert.equal(start.json.stepCount, 4);
  assert.equal(start.json.step.role, "credit-officer");
  assert.equal(typeof start.json.runId, "string");

  const firstTask = start.json.task;
  assert.equal(firstTask.title, "受理与尽调");
  assert.equal(firstTask.assignedRole, "credit-officer");
  assert.equal(firstTask.createdBy, "workflow", "workflow tasks are createdBy 'workflow' (disjoint from the controller LLM follow-up path)");
  assert.equal(firstTask.status, "pending");
  assert.equal(firstTask.workflow.workflowId, "credit-approval");
  assert.equal(firstTask.workflow.stepKey, "0");
  assert.equal(firstTask.workflow.runId, start.json.runId);
  assert.match(firstTask.description, /信贷审批流（对公）/);
  assert.match(firstTask.description, /C-2026-114/, "initial context rides into the first step description");
  assert.match(firstTask.description, /「材料齐全」 \/ 「需补充材料」/, "conclusion instruction names the enum phrases");

  // Only ONE task exists - the chain is built step-by-step, not up front.
  assert.equal(Object.keys(scenario.getTeamState().tasks).length, 1);
  console.log("✅ start endpoint: 201 first-step task, 404/400/503 error ladder");

  // -----------------------------------------------------------------------
  // 4. Runtime conclusion routing.
  // -----------------------------------------------------------------------
  // 4a. step 0 「材料齐全」 -> step 1 risk review with the DD report embedded.
  await completeStep(scenario, firstTask, DUE_DILIGENCE_TEXT);
  const step1Task = await waitForTask(
    scenario,
    (t) => t.workflow?.stepKey === "1",
    "step-1 risk-review task after 「材料齐全」",
  );
  assert.equal(step1Task.assignedRole, "risk-reviewer");
  assert.equal(step1Task.title, "风险审查");
  assert.equal(step1Task.workflow.runId, start.json.runId, "the chain keeps one runId");
  assert.match(step1Task.description, /dueDiligenceReport/, "step-1 description references the upstream output key");
  assert.match(step1Task.description, /尽调摘要：借款人经营正常/, "the upstream result excerpt is embedded (design 2.4 outputKey passing)");
  assert.match(step1Task.description, /「通过」 \/ 「退回补充材料」 \/ 「超权限上会」/);

  const completedFirst = scenario.getTeamState().tasks[firstTask.id];
  assert.equal(completedFirst.status, "completed");
  assert.equal(completedFirst.workflow.routedToStepKey, "1");
  assert.equal(completedFirst.workflow.routedConclusion, "材料齐全");
  assert.ok(completedFirst.workflow.routedAt > 0);
  console.log("✅ conclusion routing: 「材料齐全」 -> step 1 with embedded dueDiligenceReport");

  // 4b. step 1 「退回补充材料」 -> NEW step-0 task carrying the return reason.
  await completeStep(scenario, step1Task, "风险审查意见：近三年审计报告缺失，无法核实营收口径。结论：退回补充材料");
  const step0Again = await waitForTask(
    scenario,
    (t) => t.workflow?.stepKey === "0" && t.id !== firstTask.id,
    "re-created step-0 task after 「退回补充材料」",
  );
  assert.equal(step0Again.assignedRole, "credit-officer");
  assert.equal(step0Again.title, "受理与尽调");
  assert.equal(step0Again.workflow.visitCounts["0"], 2, "the re-entry increments the visit counter (loop guard input)");
  assert.match(step0Again.description, /退回意见/, "the return edge embeds the returning step's opinion");
  assert.match(step0Again.description, /近三年审计报告缺失/, "the return reason excerpt is embedded");
  assert.equal(scenario.getTeamState().tasks[step1Task.id].workflow.routedToStepKey, "0");
  console.log("✅ conclusion routing: 「退回补充材料」 -> new step-0 task with return reason");

  // 4c. recover: 「材料齐全」 -> step 1 again, then 「通过」 -> step 2 with BOTH inputs.
  await completeStep(scenario, step0Again, `${DUE_DILIGENCE_TEXT}（已补充近三年审计报告）`);
  const step1Again = await waitForTask(
    scenario,
    (t) => t.workflow?.stepKey === "1" && t.id !== step1Task.id,
    "second step-1 task after the return round",
  );
  await completeStep(scenario, step1Again, "风险审查意见：额度、期限与押品覆盖率均符合口径。结论：通过");
  const step2Task = await waitForTask(
    scenario,
    (t) => t.workflow?.stepKey === "2",
    "step-2 approval task after 「通过」",
  );
  assert.equal(step2Task.assignedRole, "approver");
  assert.equal(step2Task.title, "审批决策");
  assert.match(step2Task.description, /dueDiligenceReport/);
  assert.match(step2Task.description, /reviewOpinion/);
  assert.match(step2Task.description, /额度、期限与押品覆盖率均符合口径/, "the step-1 opinion excerpt is embedded");
  // The embedded DD excerpt is the LATEST completed step-0 task (the returned round).
  assert.match(step2Task.description, /已补充近三年审计报告/);
  assert.doesNotMatch(step2Task.description, /「通过」/, "step 2 has no conclusion enum - no conclusion instruction is appended");
  console.log("✅ conclusion routing: 「通过」 -> step 2 with both inputs embedded");

  // 4d. step 2 (no conclusion enum, last spine step) -> chain ENDS (the
  // committee branch step declared after it is never a default next).
  await completeStep(scenario, step2Task, "审批结论：同意授信 800 万元/1 年，条件：落实押品抵押登记。");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const tasksAtEnd = Object.values(scenario.getTeamState().tasks);
  assert.equal(
    tasksAtEnd.filter((t) => t.workflow?.runId === start.json.runId).length,
    5,
    "run ends after step 2 (0, 1, 0-again, 1-again, 2) - no committee leak",
  );
  assert.equal(scenario.getTeamState().tasks[step2Task.id].workflow.routedToStepKey, "", "empty routedToStepKey marks the chain end");
  const committeeLeak = tasksAtEnd.find((t) => t.workflow?.stepKey === "committee");
  assert.equal(committeeLeak, undefined, "the branch step is reachable ONLY via an explicit on jump");
  console.log("✅ chain end: step-2 completion ends the run (no committee leak)");

  // 4e. committee branch: fresh run, 「超权限上会」 at step 1.
  const start2 = await scenario.call("POST", "/api/v1/workflows/credit-approval/start", { context: "金额超分行权限，需上会。" });
  assert.equal(start2.status, 201);
  await completeStep(scenario, start2.json.task, DUE_DILIGENCE_TEXT);
  const s1 = await waitForTask(scenario, (t) => t.workflow?.runId === start2.json.runId && t.workflow?.stepKey === "1", "run2 step-1");
  await completeStep(scenario, s1, "风险审查意见：金额超出授权，建议提交贷审会。结论：超权限上会");
  const committeeTask = await waitForTask(
    scenario,
    (t) => t.workflow?.stepKey === "committee",
    "committee branch task after 「超权限上会」",
  );
  assert.equal(committeeTask.assignedRole, "approver");
  assert.equal(committeeTask.title, "贷审会（超权限）");
  assert.match(committeeTask.description, /dueDiligenceReport/);
  assert.match(committeeTask.description, /reviewOpinion/);
  // committee is a leaf: completing it ends the run.
  await completeStep(scenario, committeeTask, "贷审会纪要式结论：同意上报总行审批。");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    scenario.getTeamState().tasks[committeeTask.id].workflow.routedToStepKey,
    "",
    "branch leaf completion ends the chain",
  );
  console.log("✅ committee branch: 「超权限上会」 -> committee step with both inputs, leaf ends run");

  // -----------------------------------------------------------------------
  // 5. Idempotency latch + loop guard.
  // -----------------------------------------------------------------------
  const before = Object.keys(scenario.getTeamState().tasks).length;
  await workflowMod.continueWorkflowAfterTaskCompletion(
    scenario.getTeamState().tasks[firstTask.id],
    scenario.deps,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    Object.keys(scenario.getTeamState().tasks).length,
    before,
    "re-invoking the continuation on an already-routed task is a no-op (routed* latch)",
  );

  // Loop guard: drive 退回补充材料 round trips until the visit cap trips.
  const start3 = await scenario.call("POST", "/api/v1/workflows/credit-approval/start", { context: "loop-guard probe" });
  assert.equal(start3.status, 201);
  const runId3 = start3.json.runId;
  const runTasksOf = (stepKey) => Object.values(scenario.getTeamState().tasks)
    .filter((t) => t.workflow?.runId === runId3 && t.workflow?.stepKey === stepKey);
  const seenStep1Ids = new Set();
  const nextStep1Task = () => waitForTask(
    scenario,
    (t) => t.workflow?.runId === runId3 && t.workflow?.stepKey === "1" && !seenStep1Ids.has(t.id),
    "guard run step-1 task",
  );
  const RETURN_TEXT = "风险审查意见：材料仍不足。结论：退回补充材料";
  let currentStep0 = start3.json.task;
  let returnEdges = 0;
  for (;;) {
    await completeStep(scenario, currentStep0, DUE_DILIGENCE_TEXT);
    const s1task = await nextStep1Task();
    seenStep1Ids.add(s1task.id);
    await completeStep(scenario, s1task, RETURN_TEXT);
    returnEdges += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const step0Tasks = runTasksOf("0");
    assert.ok(step0Tasks.length <= workflowMod.MAX_WORKFLOW_STEP_VISITS,
      `the loop guard must cap step-0 visits at ${workflowMod.MAX_WORKFLOW_STEP_VISITS} (saw ${step0Tasks.length})`);
    if (step0Tasks.length < workflowMod.MAX_WORKFLOW_STEP_VISITS) {
      currentStep0 = step0Tasks[step0Tasks.length - 1];
      if (returnEdges > 6) {
        assert.fail("loop-guard probe did not converge");
      }
      continue;
    }
    // Cap reached: the NEXT return edge must trip the guard and stop the chain.
    currentStep0 = step0Tasks[step0Tasks.length - 1];
    await completeStep(scenario, currentStep0, DUE_DILIGENCE_TEXT);
    const lastS1 = await nextStep1Task();
    seenStep1Ids.add(lastS1.id);
    await completeStep(scenario, lastS1, RETURN_TEXT);
    returnEdges += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(runTasksOf("0").length, workflowMod.MAX_WORKFLOW_STEP_VISITS,
      `the guard stopped the run at ${workflowMod.MAX_WORKFLOW_STEP_VISITS} step-0 visits`);
    const guardedTask = scenario.getTeamState().tasks[lastS1.id];
    assert.equal(guardedTask.workflow.routedToStepKey, "", "the guard latches the routing decision (chain stop)");
    const guardEvent = (guardedTask.execution?.events ?? []).some((event) => event.phase === "workflow_step_routed");
    assert.equal(guardEvent, true, "the routing decision is visible as a workflow_step_routed execution event");
    break;
  }
  console.log(`✅ loop guard: run stopped after ${returnEdges} return edges (cap ${workflowMod.MAX_WORKFLOW_STEP_VISITS} visits/step)`);

  // The workflow chain never triggered a controller LLM follow-up run.
  assert.equal(
    Object.keys(scenario.getTeamState().controllerRuns).length,
    0,
    "workflow chains create no controller runs (deterministic routing replaces the LLM follow-up)",
  );
} finally {
  await scenario.close();
}

// ---------------------------------------------------------------------------
// software-rd: no workflows -> start is a 404 (route exists for every
// profile; the workflow itself is profile-scoped).
// ---------------------------------------------------------------------------
const softwareRdScenario = await bootScenario({ initialState: bankingState({ profileId: "software-rd", teamName: "Software Team" }) });
try {
  loaderMod.setActiveProfileId("software-rd");
  const res = await softwareRdScenario.call("POST", "/api/v1/workflows/credit-approval/start", {});
  assert.equal(res.status, 404, "software-rd carries no workflows - start must 404");
  assert.match(res.json.error, /available: none/);
} finally {
  await softwareRdScenario.close();
}

console.log("\n🎉 All design-2.4 workflows backend tests passed!");
