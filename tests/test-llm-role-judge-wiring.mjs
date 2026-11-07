#!/usr/bin/env node
// Phase 2.5 follow-up (design 2.3 "LLM 兜底"): the resolveTaskRoleWithLlmFallback
// seam (kickoff-orchestrator) had fake-driven tests but no production caller.
// This test pins the PRODUCTION WIRING that landed with it:
//
// a. TaskRouter (dist-level, fake judge - no real LLM): unassigned tasks the
//    bilingual token fast path refuses to decide escalate to the injected
//    llmRoleJudge exactly ONCE per task (cached across dispatch rounds), and
//    the judged role routes to that role's idle worker.
// b. The judged role is a routing HINT, not an assignment: when the judged
//    role has no idle worker, the router degrades to the legacy matcher
//    instead of stranding the task (same semantics as a confident inference).
// c. A judge that answers outside the active profile, or throws, degrades to
//    the profile defaultRole via the resolver - dispatch still proceeds.
// d. No judge wired: behavior identical to pre-wiring (legacy routing, no
//    escalation); the judge path is skipped for confident tasks either way.
// e. Source anchors: controller-service constructs the TaskRouter with the
//    real controller-LLM judge (guarded on runtime.subagent, one-shot
//    dedicated session - never the intake conversation), and http-server
//    awaits the now-async router dispatch call.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const routerMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "task-router.js")
).catch(() => null);
assert.ok(routerMod, "task-router module must be built (run npm --prefix src run build first)");
const { TaskRouter } = routerMod;
assert.equal(typeof TaskRouter, "function", "TaskRouter must stay exported");

const inferenceMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "role-inference.js")
).catch(() => null);
const { inferTaskRole } = inferenceMod;

const logger = { info() {}, warn() {}, debug() {} };

function makeTask(id, title, description = "") {
  return {
    id,
    title,
    description,
    status: "pending",
    priority: "medium",
    createdBy: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeWorker(id, role) {
  return {
    id,
    role,
    label: id,
    status: "idle",
    transport: "http",
    url: `http://127.0.0.1:1/${id}`,
    lastHeartbeat: Date.now(),
    capabilities: [],
    registeredAt: Date.now(),
  };
}

// Pure-Chinese title with no English tokens: the software-rd fast path
// refuses to decide (precondition self-check below).
const UNCONFIDENT_TITLE = "整理今日跨部门会议纪要并归档";

// ── Contract a: unconfident task escalates once, judged role routes ─────────
{
  assert.equal(inferTaskRole({ assignedRole: undefined, title: UNCONFIDENT_TITLE, description: "" }), null,
    "precondition: the fixture task must be unconfident under software-rd");

  let judgeCalls = 0;
  const router = new TaskRouter(logger, {
    llmRoleJudge: async () => {
      judgeCalls += 1;
      return "qa";
    },
  });
  const tasks = { t1: makeTask("t1", UNCONFIDENT_TITLE) };
  const workers = {
    "w-dev": makeWorker("w-dev", "developer"),
    "w-qa": makeWorker("w-qa", "qa"),
  };

  const pairs = await router.autoAssignPendingTasks(tasks, workers);
  assert.equal(judgeCalls, 1, "unconfident task must escalate to the judge exactly once");
  assert.equal(pairs.length, 1, "one candidate pair expected");
  assert.equal(pairs[0].worker.id, "w-qa", "judged role must route to that role's idle worker");

  // Second dispatch round (e.g. after a revert): cached verdict, no new LLM call.
  tasks.t1.status = "pending";
  tasks.t1.assignedWorkerId = undefined;
  const pairs2 = await router.autoAssignPendingTasks(tasks, workers);
  assert.equal(judgeCalls, 1, "judged verdict is cached per task across dispatch rounds");
  assert.equal(pairs2[0].worker.id, "w-qa", "cached judged role keeps routing to the qa worker");
}

// ── Contract b: judged role is a hint - degrade, never strand ───────────────
{
  const router = new TaskRouter(logger, { llmRoleJudge: async () => "qa" });
  const tasks = { t1: makeTask("t1", UNCONFIDENT_TITLE) };
  const workers = { "w-dev": makeWorker("w-dev", "developer") }; // no idle qa

  const pairs = await router.autoAssignPendingTasks(tasks, workers);
  assert.equal(pairs.length, 1, "task must not strand when the judged role has no idle worker");
  assert.equal(pairs[0].worker.id, "w-dev", "router degrades to the legacy matcher for the judged-role hint");
}

// ── Contract c: bad judge answers degrade to the profile defaultRole ────────
{
  // c1: judge names a role outside the active profile.
  {
    const router = new TaskRouter(logger, { llmRoleJudge: async () => "credit-officer" });
    const tasks = { t1: makeTask("t1", UNCONFIDENT_TITLE) };
    const workers = {
      "w-dev": makeWorker("w-dev", "developer"),
      "w-qa": makeWorker("w-qa", "qa"),
    };
    const pairs = await router.autoAssignPendingTasks(tasks, workers);
    assert.equal(pairs[0].worker.id, "w-dev",
      "invalid judge answer must degrade to the software-rd defaultRole (developer) hint");
  }
  // c2: judge throws (LLM unavailable).
  {
    const router = new TaskRouter(logger, {
      llmRoleJudge: async () => {
        throw new Error("llm down");
      },
    });
    const tasks = { t1: makeTask("t1", UNCONFIDENT_TITLE) };
    const workers = { "w-dev": makeWorker("w-dev", "developer") };
    const pairs = await router.autoAssignPendingTasks(tasks, workers);
    assert.equal(pairs.length, 1, "judge failure must not break dispatch");
    assert.equal(pairs[0].worker.id, "w-dev", "judge failure degrades to the defaultRole hint");
  }
}

// ── Contract d: no judge wired => pre-wiring behavior; confident tasks skip ──
{
  // d1: unconfident task without a judge keeps the legacy path (any idle).
  const router = new TaskRouter(logger);
  const tasks = { t1: makeTask("t1", UNCONFIDENT_TITLE) };
  const workers = {
    "w-qa": makeWorker("w-qa", "qa"),
    "w-dev": makeWorker("w-dev", "developer"),
  };
  const result = router.autoAssignPendingTasks(tasks, workers);
  assert.ok(result instanceof Promise, "router autoAssignPendingTasks is async since the judge wiring (http-server awaits it)");
  const pairs = await result;
  assert.equal(pairs.length, 1, "unconfident task still routes via the legacy path without a judge");
  assert.equal(pairs[0].worker.id, "w-qa", "legacy any-idle keeps insertion order (pre-wiring behavior)");

  // d2: confident tasks never escalate even when a judge is wired.
  const CONFIDENT_TITLE = "Fix the failing login test";
  assert.notEqual(inferTaskRole({ assignedRole: undefined, title: CONFIDENT_TITLE, description: "" }), null,
    "precondition: the confident fixture must be confidently inferred");
  let judgeCalls = 0;
  const router2 = new TaskRouter(logger, {
    llmRoleJudge: async () => {
      judgeCalls += 1;
      return "developer";
    },
  });
  const confidentTask = makeTask("t2", CONFIDENT_TITLE);
  const pairs2 = await router2.autoAssignPendingTasks(
    { t2: confidentTask },
    { "w-dev": makeWorker("w-dev", "developer"), "w-qa": makeWorker("w-qa", "qa") },
  );
  assert.equal(judgeCalls, 0, "confident tasks stay on the token fast path - no LLM call");
  assert.equal(pairs2[0].worker.id, "w-qa", "confident inference routes to the inferred role's worker");
}

// ── Contract e: production assembly source anchors ──────────────────────────
{
  const readSource = (rel) => fs.promises.readFile(path.join(projectRoot, rel), "utf8");

  const serviceSource = await readSource(path.join("src", "src", "controller", "controller-service.ts"));
  assert.match(serviceSource, /new TaskRouter\(logger, llmRoleJudge \? \{ llmRoleJudge \} : undefined\)/,
    "controller-service must construct the TaskRouter with the real LLM judge when the runtime provides a subagent");
  assert.match(serviceSource, /function createControllerLlmRoleJudge/,
    "the production judge factory must live in the controller assembly (controller-service)");
  assert.match(serviceSource, /typeof subagent\.run !== "function"/,
    "the judge factory must guard on runtime.subagent capability and stay unwired otherwise");
  assert.match(serviceSource, /teamclaw-role-judge:/,
    "the judge must run on a dedicated one-shot session prefix, never the intake conversation");

  const httpServerSource = await readSource(path.join("src", "src", "controller", "http-server.ts"));
  assert.match(httpServerSource, /await taskRouter\s*\.autoAssignPendingTasks|await taskRouter\s*\n\s*\.autoAssignPendingTasks/,
    "http-server dispatch loop must await the (now-async) router candidate call");
}

console.log("test-llm-role-judge-wiring: all assertions passed (Phase 2.5 production wiring: judge seam live in dispatch, fake-injected, safe degradation)");
