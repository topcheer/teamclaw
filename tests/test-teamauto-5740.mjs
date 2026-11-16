#!/usr/bin/env node
// ggcode #5740 regression: claim-at-dequeue ELIGIBILITY-CHECK failure must
// revert the assignment SAFELY - cancel the already-dispatched execution,
// return the task to pending with an exponential assignment hold, and never
// let an orphaned run (or a bare PATCH) resurrect the illegal
// in_progress-without-claim state.
//
// Background: fix 3f5e60c split claimTaskAtDequeue into CHECK (network) and
// WRITE phases; a CHECK failure returns retryEligibility and the caller
// reverts the assignment. This suite pins that base contract plus the
// residual hardening delivered by the ownership seat on top of it:
//   a. eligibility failure -> worker execution CANCELLED (the dispatch
//      succeeded, unlike the #191 dispatch-failure path), task pending +
//      unassigned, 20s hold stamped, worker freed.
//   b. the hold blocks immediate re-candidacy (no assign/cancel churn).
//   c. after expiry the task retries; a conclusive claim outcome clears
//      the backoff.
//   d. consecutive failures grow the hold 20s -> 40s -> 80s -> 160s cap
//      (claimEligibilityHoldMs unit-pinned, incl. non-positive clamp).
//   e. WRITE-phase failure keeps continue-unclaimed semantics: task stays
//      assigned, NO cancel, NO hold (base 3f5e60c contract re-pinned).
//   f. PATCH /api/v1/tasks/:id guards: stale workerId -> 202 ignored; a
//      bare PATCH cannot flip pending+unassigned to in_progress while the
//      progress text still lands; the assigned worker's own PATCH flows.
//   g. source anchors: scheduler two-phase split + WRITE-failure audit
//      line, revert cancel + hold wiring, PATCH guards, worker identity
//      stamp, TaskInfo hold fields.
//
// No real network: global fetch is patched (assign + cancel endpoints).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const taskAssignmentMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "task-assignment.js")
).catch(() => null);
assert.ok(taskAssignmentMod, "task-assignment module must be built (run npm --prefix src run build first)");
const taskRoutesMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "task-routes.js")
).catch(() => null);
assert.ok(taskRoutesMod, "task-routes module must be built");
assert.equal(typeof taskAssignmentMod.autoAssignPendingTasks, "function", "autoAssignPendingTasks must stay exported");
assert.equal(typeof taskAssignmentMod.claimEligibilityHoldMs, "function", "#5740: claimEligibilityHoldMs must stay exported");
assert.equal(typeof taskAssignmentMod.clearAssignmentHold, "function", "#5740: clearAssignmentHold must stay exported");
assert.equal(typeof taskRoutesMod.handleTaskPatchRequest, "function", "handleTaskPatchRequest must stay exported");

const realFetch = globalThis.fetch;
let assignAttempts = 0;
let cancelCalls = 0;

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/api/v1/tasks/assign")) {
    assignAttempts += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (/\/api\/v1\/tasks\/[^/]+\/cancel$/.test(target)) {
    cancelCalls += 1;
    return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 });
  }
  return realFetch(url, init);
};

function makeTask(id) {
  return {
    id,
    title: `[takeOwnership] Own issue #1 for test ${id}`,
    description: `TeamAuto autonomous work for example/repo. work item ${id}`,
    status: "pending",
    priority: "medium",
    assignedRole: "developer",
    createdBy: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeWorker(id) {
  return {
    id,
    role: "developer",
    label: id,
    status: "idle",
    transport: "http",
    url: `http://127.0.0.1:1/worker/${id}`,
    lastHeartbeat: Date.now(),
    capabilities: [],
    registeredAt: Date.now(),
  };
}

function defaultAutoAssignPairs(taskMap, workerMap) {
  const pending = Object.values(taskMap).filter(
    (t) => t.status === "pending" || t.status === "assigned",
  );
  const idle = Object.values(workerMap).filter((w) => w.status === "idle");
  const pairs = [];
  for (const task of pending) {
    for (const worker of idle) {
      pairs.push({ task, worker });
    }
  }
  return pairs;
}

let claimResult = null;

function makeDeps({ tasks, workers, router }) {
  const state = {
    profileId: "software-rd",
    teamName: "t5740",
    workers,
    tasks,
    controllerRuns: {},
    projects: {},
    messages: [],
    clarifications: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const taskRouter = router ?? {
    autoAssignPendingTasks: defaultAutoAssignPairs,
  };
  return {
    deps: {
      config: { maxConcurrentTasks: 16 },
      logger: { info() {}, warn() {}, debug() {} },
      getTeamState: () => state,
      updateTeamState: (updater) => {
        updater(state);
        return state;
      },
      taskRouter,
      wsServer: { broadcastUpdate() {} },
      getTeamAutoScheduler: () => ({ claimTaskAtDequeue: async () => claimResult }),
    },
    state,
  };
}

const settle = async (ms = 80) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const expireHold = (state, id) => {
  const task = state.tasks[id];
  if (task?.assignmentHoldUntil) {
    task.assignmentHoldUntil = Date.now() - 1;
  }
};

async function patchTask(deps, taskId, body) {
  const req = new PassThrough();
  req.method = "PATCH";
  req.url = `/api/v1/tasks/${taskId}`;
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body));
  const res = {
    statusCode: 0,
    chunks: "",
    getHeader() { return undefined; },
    setHeader() {},
    writeHead(code) { this.statusCode = code; },
    end(chunk) { if (chunk) { this.chunks += String(chunk); } },
  };
  await taskRoutesMod.handleTaskPatchRequest(deps, req, res, `/api/v1/tasks/${taskId}`);
  return res;
}

let failed = false;
try {
  // ── Contract a: eligibility failure cancels the dispatched run + reverts with a hold ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps, state } = makeDeps({ tasks, workers });
    claimResult = { claimed: false, reason: "eligibility-check-failed", retryEligibility: true };
    assignAttempts = 0; cancelCalls = 0;

    const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assigned.length, 1, "task dispatches to the reachable worker first");
    assert.equal(assignAttempts, 1, "exactly one dispatch before the claim failure reverts");
    assert.equal(cancelCalls, 1, "#5740: the already-dispatched execution must be cancelled on revert");
    const task = state.tasks.t1;
    assert.equal(task.status, "pending", "reverted task returns to pending (never in_progress unclaimed)");
    assert.equal(task.assignedWorkerId, undefined, "reverted task has no assignee");
    assert.equal(task.assignmentHoldCount, 1, "first failure stamps hold count 1");
    const holdMs = task.assignmentHoldUntil - Date.now();
    assert.ok(holdMs > 18_000 && holdMs <= 20_000, `first hold must be ~20s, got ${holdMs}ms`);
    assert.equal(state.workers.w1.status, "idle", "worker freed by the revert");
    assert.equal(state.workers.w1.currentTaskId, undefined, "worker has no current task after revert");
  }

  // ── Contract b: the hold blocks immediate re-candidacy (churn guard) ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps } = makeDeps({ tasks, workers });
    claimResult = { claimed: false, reason: "eligibility-check-failed", retryEligibility: true };
    assignAttempts = 0; cancelCalls = 0;
    await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assignAttempts, 1, "cycle 1 dispatched once");
    // The revert's nested round AND explicit new rounds must all respect the hold.
    await taskAssignmentMod.autoAssignPendingTasks(deps);
    await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle(120);
    assert.equal(assignAttempts, 1, "no further dispatch while the assignment hold is active");
    assert.equal(cancelCalls, 1, "no cancel churn while the hold is active");
  }

  // ── Contract c: after expiry the task retries; a conclusive claim clears the backoff ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps, state } = makeDeps({ tasks, workers });
    claimResult = { claimed: false, reason: "eligibility-check-failed", retryEligibility: true };
    assignAttempts = 0; cancelCalls = 0;
    await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    expireHold(state, "t1");
    claimResult = { claimed: true };
    const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assigned.length, 1, "task re-enters candidacy after hold expiry");
    assert.equal(assignAttempts, 2, "retry dispatches exactly once more");
    const task = state.tasks.t1;
    assert.equal(task.status, "assigned", "successful claim keeps the task assigned");
    assert.equal(task.assignedWorkerId, "w1");
    assert.equal(task.assignmentHoldUntil, undefined, "conclusive claim outcome clears the hold");
    assert.equal(task.assignmentHoldCount, undefined, "conclusive claim outcome resets the counter");
    assert.equal(cancelCalls, 1, "no cancel on the successful path");
  }

  // ── Contract d: consecutive failures grow the hold to the 160s cap ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps, state } = makeDeps({ tasks, workers });
    claimResult = { claimed: false, reason: "eligibility-check-failed", retryEligibility: true };
    const expect = [20_000, 40_000, 80_000, 160_000, 160_000];
    for (let i = 0; i < expect.length; i += 1) {
      const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
      assert.equal(assigned.length, 1, `failure cycle ${i + 1} dispatches`);
      await settle();
      const holdMs = state.tasks.t1.assignmentHoldUntil - Date.now();
      assert.ok(holdMs > expect[i] - 2_000 && holdMs <= expect[i], `cycle ${i + 1} hold must be ~${expect[i]}ms, got ${holdMs}ms`);
      expireHold(state, "t1");
    }
    // Unit pin for the schedule itself.
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(1), 20_000);
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(2), 40_000);
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(3), 80_000);
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(4), 160_000);
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(5), 160_000, "hold caps at 160s");
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(0), 20_000, "schedule clamps non-positive input to the base hold");
    assert.equal(taskAssignmentMod.claimEligibilityHoldMs(-7), 20_000);
  }

  // ── Contract e: WRITE-phase failure keeps continue-unclaimed semantics ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps, state } = makeDeps({ tasks, workers });
    claimResult = { claimed: false, reason: "claim write failed" };
    assignAttempts = 0; cancelCalls = 0;
    const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assigned.length, 1);
    assert.equal(assignAttempts, 1);
    assert.equal(cancelCalls, 0, "write-phase failure must NOT cancel - the eligibility checks passed (2026-11-15 semantics)");
    const task = state.tasks.t1;
    assert.equal(task.status, "assigned", "write-phase failure continues unclaimed");
    assert.equal(task.assignedWorkerId, "w1");
    assert.equal(task.assignmentHoldUntil, undefined, "no hold on the write-failure path");
  }

  // ── Contract f: PATCH resurrection guards ──
  {
    // f1: a stale worker's PATCH is ignored wholesale (202 stale-worker-update).
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps, state } = makeDeps({ tasks, workers });
    state.tasks.t1.status = "assigned";
    state.tasks.t1.assignedWorkerId = "w1";
    const res1 = await patchTask(deps, "t1", { workerId: "w0-orphan", status: "in_progress", progress: "orphan heartbeat" });
    assert.equal(res1.statusCode, 202, "stale worker patch is ignored");
    assert.match(res1.chunks, /stale-worker-update/);
    assert.equal(state.tasks.t1.status, "assigned", "stale worker cannot flip status");
    assert.equal(state.tasks.t1.progress, undefined, "stale worker patch applies nothing");

    // f2: a bare PATCH cannot flip pending+unassigned to in_progress, but the progress text lands.
    const tasks2 = { t2: makeTask("t2") };
    const { deps: deps2, state: state2 } = makeDeps({ tasks: tasks2, workers: { w1: makeWorker("w1") } });
    const res2 = await patchTask(deps2, "t2", { status: "in_progress", progress: "orphan heartbeat" });
    assert.equal(res2.statusCode, 200);
    assert.equal(state2.tasks.t2.status, "pending", "bare PATCH must not resurrect a pending unassigned task to in_progress (#5740 illegal state)");
    assert.equal(state2.tasks.t2.progress, "orphan heartbeat", "progress text still applies");

    // f3: the assigned worker's own PATCH flows normally.
    state2.tasks.t2.status = "assigned";
    state2.tasks.t2.assignedWorkerId = "w1";
    const res3 = await patchTask(deps2, "t2", { workerId: "w1", status: "in_progress", progress: "legit start" });
    assert.equal(res3.statusCode, 200);
    assert.equal(state2.tasks.t2.status, "in_progress", "assigned worker still reports in_progress");
  }

  // ── Contract g: source anchors (substring form - no regex escaping) ──
  {
    const read = (rel) => fs.readFileSync(path.join(projectRoot, "src", "src", rel), "utf8");
    const scheduler = read("teamauto/scheduler.ts");
    assert.ok(scheduler.includes("claim-at-dequeue ELIGIBILITY CHECK failed"), "base 3f5e60c contract: eligibility-check audit line");
    assert.ok(scheduler.includes('reason: "eligibility-check-failed", retryEligibility: true'), "base 3f5e60c contract: retryEligibility returned to the caller");
    assert.ok(scheduler.includes("- continuing unclaimed"), "#5740: write-phase failure audit line restored");
    assert.ok(scheduler.includes("claim-at-dequeue WRITE failed for issue #"), "#5740: write-phase failure audit line restored (prefix)");
    const ta = read("controller/task-assignment.ts");
    assert.ok(ta.includes('cancelTaskExecution(updatedTask.id, nextAssignment.worker.id, "claim eligibility retry (#5740)", deps)'), "#5740: revert cancels the dispatched execution");
    assert.ok(ta.includes("claimEligibilityHoldMs(failures)"), "#5740: revert stamps the exponential hold");
    assert.ok(ta.includes('assignmentHoldUntil === "number" && task.assignmentHoldUntil > Date.now()'), "#5740: candidacy filter respects the hold");
    assert.ok(ta.includes("clearAssignmentHold(updatedTask.id, deps)"), "#5740: conclusive claim outcome clears the hold");
    const tr = read("controller/task-routes.ts");
    assert.ok(tr.includes("stale-worker-update"), "#5740: PATCH stale-worker guard");
    assert.ok(tr.includes('body.status === "in_progress"'), "#5740: PATCH resurrection guard (status half)");
    assert.ok(tr.includes('task.status === "pending"'), "#5740: PATCH resurrection guard (pending half)");
    assert.ok(tr.includes("!task.assignedWorkerId"), "#5740: PATCH resurrection guard (unassigned half)");
    assert.ok(tr.includes("delete body.status"), "#5740: PATCH resurrection guard rejects the flip");
    const tools = read("worker/tools.ts");
    assert.ok(tools.includes("patch.workerId = identity.workerId"), "#5740: worker PATCH carries its identity");
    const types = read("types.ts");
    assert.ok(types.includes("assignmentHoldUntil?: number"), "#5740: TaskInfo hold fields");
    assert.ok(types.includes("assignmentHoldCount?: number"), "#5740: TaskInfo hold count field");
  }

  console.log("test-teamauto-5740: all assertions passed (claim-eligibility revert: cancel + pending + exponential hold; PATCH resurrection guards; write-phase continue-unclaimed)");
} catch (err) {
  failed = true;
  console.error("test-teamauto-5740 FAILED:", err);
} finally {
  globalThis.fetch = realFetch;
}

if (failed) {
  process.exit(1);
}
