#!/usr/bin/env node
// Issue #191 regression: nested autoAssignPendingTasks spawn-on-revert must
// stay LINEAR when a worker is unreachable.
//
// Mechanism under test (src/src/controller/http-server.ts): a failed dispatch
// reverts the assignment and fires `void autoAssignPendingTasks(deps)`. Before
// the fix every nested call ran concurrently with its OWN attemptedPairs set,
// so it re-attempted the pair that had just failed, reverted again, and
// spawned another nested round - a 2^n retry tree that OOM'd (4GB) the test
// process when seeded with an offline worker. The fix is a per-deps
// re-entrancy gate: one round in flight, nested triggers deferred to a single
// follow-up round that shares the failed pairs, so every task:worker pair is
// attempted at most once per storm.
//
// Contracts pinned here:
// a. Worker-unreachable storm is linear: with T pending tasks x W idle
//    unreachable workers, exactly T*W dispatch attempts happen and the count
//    does not grow afterwards (pre-fix it grew without bound).
// b. Normal path is unchanged: a reachable worker gets the task assigned in
//    one attempt.
// c. Recovery semantics: once the storm settles, the failed pairs are
//    forgotten - a later round (worker recovered) attempts and assigns them.
// d. The deferred follow-up round carries the nested trigger's
//    preferredWorkerId (worker register/heartbeat hint) instead of dropping
//    it - it biases which candidate dispatches first.
// e. One gate per deps object: two concurrent triggers on the SAME deps run
//    a single round (the loser defers), and the TeamAuto onTasksCreated hook
//    passes the very same httpDeps object as the HTTP call sites (source
//    pin) so TeamAuto-triggered and HTTP-triggered rounds share that gate.
//
// No real network: global fetch is patched. The taskRouter dep is replaced
// with a deterministic fake that proposes every pending-task x idle-worker
// pair, which is the maximal fan-out shape of the real router.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// PR-C of issue #204: the gated auto-assign loop moved from http-server.ts
// into controller/task-assignment.ts - import the new home (dist build).
const taskAssignmentMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "task-assignment.js")
).catch(() => null);
assert.ok(taskAssignmentMod, "task-assignment module must be built (run npm --prefix src run build first)");
assert.equal(typeof taskAssignmentMod.autoAssignPendingTasks, "function", "autoAssignPendingTasks must stay exported (issue #191 test)");

const realFetch = globalThis.fetch;
let assignAttempts = 0;
let assignSucceeds = false;
// Worker URLs in /api/v1/tasks/assign dispatch order (per scenario) so tests
// can observe WHICH candidate a round attempts first.
let assignOrder = [];

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/api/v1/tasks/assign")) {
    assignAttempts += 1;
    assignOrder.push(target);
    if (!assignSucceeds) {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1 (simulated unreachable worker)");
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return realFetch(url, init);
};

function makeTask(id) {
  return {
    id,
    title: `task ${id}`,
    description: `work item ${id}`,
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

// Deterministic worst-case router: proposes every pending task x idle worker
// pair on every call, so a nested round without shared state would re-attempt
// ALL pairs (the #191 blowup shape).
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

function makeDeps({ tasks, workers, router }) {
  const state = {
    profileId: "software-rd",
    teamName: "backoff-test",
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
    },
    state,
  };
}

const settle = async (ms = 60) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

// Shared hanging-router harness for the queued-hint contracts (f/g): the
// first router call hangs until released so round 1 stays in flight.
let releaseHangingRouter = () => {};
function hangOnceRouter() {
  releaseHangingRouter = () => {};
  let first = true;
  return {
    autoAssignPendingTasks(taskMap, workerMap) {
      // Snapshot pairs at CALL time (contract-d semantics): round 1 sees the
      // empty task set it started with; the deferred follow-up re-snapshots.
      const pairs = defaultAutoAssignPairs(taskMap, workerMap);
      if (!first) return pairs;
      first = false;
      return new Promise((resolve) => { releaseHangingRouter = () => resolve(pairs); });
    },
  };
}

let failed = false;
try {
  // ── Contract a: unreachable-worker storm is linear (T*W attempts) ──────
  {
    const tasks = Object.fromEntries(["t1", "t2", "t3"].map((id) => [id, makeTask(id)]));
    const workers = Object.fromEntries(["w1", "w2"].map((id) => [id, makeWorker(id)]));
    const { deps, state } = makeDeps({ tasks, workers });
    assignAttempts = 0;
    assignSucceeds = false;

    const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
    assert.equal(assigned.length, 0, "no task can be assigned while every worker is unreachable");

    await settle();
    const firstSample = assignAttempts;
    await settle(200);
    assert.equal(
      assignAttempts,
      firstSample,
      "dispatch attempts must stop growing once the storm settles (issue #191: pre-fix retry tree never stopped)",
    );
    const expectedPairs = 3 * 2;
    assert.equal(
      firstSample,
      expectedPairs,
      `worker-unreachable dispatch must be linear: expected exactly ${expectedPairs} attempts (3 tasks x 2 workers, each pair once), got ${firstSample}`,
    );

    for (const task of Object.values(state.tasks)) {
      assert.equal(task.status, "pending", `task ${task.id} must return to pending after revert`);
      assert.equal(task.assignedWorkerId, undefined, `task ${task.id} must not keep a worker`);
    }
  }

  // ── Contract b: normal path unchanged (reachable worker, one attempt) ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps } = makeDeps({ tasks, workers });
    assignAttempts = 0;
    assignSucceeds = true;

    const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assigned.length, 1, "reachable worker must receive the task");
    assert.equal(assigned[0].status, "assigned", "task must be assigned on the normal path");
    assert.equal(assignAttempts, 1, "successful dispatch needs exactly one attempt (normal path unchanged)");
  }

  // ── Contract c: recovery - failed pairs are forgotten after the storm ──
  {
    const tasks = { t1: makeTask("t1") };
    const workers = { w1: makeWorker("w1") };
    const { deps } = makeDeps({ tasks, workers });
    assignAttempts = 0;
    assignSucceeds = false;

    await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assignAttempts, 1, "first round attempts the pair once");
    assert.equal(deps.getTeamState().tasks.t1.status, "pending", "task reverts to pending");

    // Worker recovers; a fresh trigger (e.g. heartbeat) must be able to
    // re-attempt the pair - the shared attemptedPairs set must not leak
    // across settled rounds.
    assignSucceeds = true;
    const assigned = await taskAssignmentMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assigned.length, 1, "recovered worker must receive the task on the next round");
    assert.equal(assignAttempts, 2, "recovery round re-attempts the pair exactly once more");
  }

  // ── Contract d: deferred round carries the nested trigger's hint ────────
  {
    // Round 1 is in flight with NO work to do (its router call hangs until
    // released and snapshots the empty task set). While it hangs, a task
    // lands AND a worker-register-shaped trigger arrives with
    // preferredWorkerId=w2 (production: the register/heartbeat paths call
    // autoAssignPendingTasks(deps, workerId)). The deferred follow-up must
    // carry that hint: it attempts w2 first even though w1 sorts ahead in
    // the router's candidate order. Pre-fix the follow-up dropped the hint
    // and dispatched to w1.
    let releaseRouter;
    const routerGate = new Promise((resolve) => { releaseRouter = resolve; });
    let routerCalls = 0;
    const hangingRouter = {
      autoAssignPendingTasks(taskMap, workerMap) {
        routerCalls += 1;
        const pairs = defaultAutoAssignPairs(taskMap, workerMap);
        return routerCalls === 1 ? routerGate.then(() => pairs) : pairs;
      },
    };
    const { deps, state } = makeDeps({ tasks: {}, workers: { w1: makeWorker("w1"), w2: makeWorker("w2") }, router: hangingRouter });
    assignAttempts = 0;
    assignSucceeds = true;
    assignOrder = [];

    const round1 = taskAssignmentMod.autoAssignPendingTasks(deps);
    // While round 1 hangs: a task lands, then the register-shaped trigger.
    state.tasks.t1 = makeTask("t1");
    const nested = await taskAssignmentMod.autoAssignPendingTasks(deps, "w2");
    assert.deepEqual(nested, [], "nested trigger must defer (queue), never run a parallel round");
    releaseRouter();
    await round1;
    await settle(120);

    assert.equal(assignAttempts, 1, "hinted follow-up round needs exactly one dispatch");
    assert.match(
      assignOrder[0] || "",
      /\/worker\/w2/,
      "deferred round must dispatch to the nested trigger's preferredWorkerId first (not the router's first candidate w1)",
    );
    assert.equal(state.tasks.t1.assignedWorkerId, "w2", "task lands on the hinted worker");
    assert.equal(state.tasks.t1.status, "assigned");
  }

  // ── Contract f: a no-id trigger never erases a queued hint ──────────────
  {
    // Production: revertTaskAssignment fires autoAssignPendingTasks(deps)
    // with no preferredWorkerId while a register-shaped trigger's hint is
    // already queued. The queued w2 hint must survive (Wave-12 review note:
    // this path was declared but untested).
    const { deps, state } = makeDeps({ tasks: {}, workers: { w1: makeWorker("w1"), w2: makeWorker("w2") }, router: hangOnceRouter() });
    assignAttempts = 0; assignSucceeds = true; assignOrder = [];
    const round1 = taskAssignmentMod.autoAssignPendingTasks(deps);
    state.tasks.t1 = makeTask("t1");
    const hinted = await taskAssignmentMod.autoAssignPendingTasks(deps, "w2");
    const hintless = await taskAssignmentMod.autoAssignPendingTasks(deps);
    assert.deepEqual(hinted, [], "hinted trigger defers");
    assert.deepEqual(hintless, [], "no-id trigger also defers (round 1 still in flight)");
    releaseHangingRouter();
    await round1; await settle(120);
    assert.equal(assignAttempts, 1);
    assert.match(assignOrder[0] || "", /\/worker\/w2/, "queued w2 hint must survive the later no-id trigger");
    assert.equal(state.tasks.t1.assignedWorkerId, "w2");
  }

  // ── Contract g: a newer id-trigger updates the queued hint ──────────────
  {
    // Production: w2 registers (hint queued), then w3 registers before the
    // deferred round starts. Latest capacity signal wins.
    const { deps, state } = makeDeps({ tasks: {}, workers: { w1: makeWorker("w1"), w2: makeWorker("w2"), w3: makeWorker("w3") }, router: hangOnceRouter() });
    assignAttempts = 0; assignSucceeds = true; assignOrder = [];
    const round1 = taskAssignmentMod.autoAssignPendingTasks(deps);
    state.tasks.t1 = makeTask("t1");
    await taskAssignmentMod.autoAssignPendingTasks(deps, "w2");
    await taskAssignmentMod.autoAssignPendingTasks(deps, "w3");
    releaseHangingRouter();
    await round1; await settle(120);
    assert.equal(assignAttempts, 1);
    assert.match(assignOrder[0] || "", /\/worker\/w3/, "newer register hint (w3) must replace the queued w2 hint");
    assert.equal(state.tasks.t1.assignedWorkerId, "w3");
  }

  // ── Contract e: one gate per deps - concurrent triggers run ONE round ───
  {
    // Production shape after the controller-service unification: TeamAuto's
    // onTasksCreated and any HTTP endpoint both call autoAssignPendingTasks
    // on the SAME deps object. Two triggers racing must not run two parallel
    // rounds with separate attemptedPairs sets: T*W attempts total, not
    // 2*T*W.
    const tasks = Object.fromEntries(["t1", "t2"].map((id) => [id, makeTask(id)]));
    const workers = Object.fromEntries(["w1"].map((id) => [id, makeWorker(id)]));
    const { deps } = makeDeps({ tasks, workers });
    assignAttempts = 0;
    assignSucceeds = false;

    const [first, second] = await Promise.all([
      taskAssignmentMod.autoAssignPendingTasks(deps),
      taskAssignmentMod.autoAssignPendingTasks(deps),
    ]);
    assert.deepEqual(second, [], "the losing concurrent trigger must defer, not start a second round");
    assert.equal(first.length, 0, "unreachable worker assigns nothing");
    await settle(200);
    assert.equal(
      assignAttempts,
      2 * 1,
      "two concurrent triggers on one deps object stay linear: exactly T*W attempts (2 tasks x 1 worker), not 2*T*W",
    );
  }

  // ── Contract e (source pin): TeamAuto hook shares the HTTP deps object ──
  {
    // The autoAssign re-entrancy gate is keyed per deps object identity
    // (WeakMap), so a separate ad-hoc object in the TeamAuto onTasksCreated
    // callback would silently open a SECOND gate (TeamAuto round and HTTP
    // round able to run concurrently with separate attemptedPairs sets -
    // the same-task double LLM-judge window). The callback must pass the
    // same httpDeps every HTTP call site uses.
    const controllerServiceSource = fs.readFileSync(
      path.join(projectRoot, "src", "src", "controller", "controller-service.ts"),
      "utf8",
    );
    assert.ok(
      !controllerServiceSource.includes("httpDepsForAutoAssign"),
      "controller-service must not build a second ad-hoc deps object for auto-assign",
    );
    assert.match(
      controllerServiceSource,
      /onTasksCreated:[\s\S]*?await autoAssignPendingTasks\(httpDeps\)/,
      "TeamAuto onTasksCreated must call autoAssignPendingTasks with the shared httpDeps (single gate for TeamAuto + HTTP triggers)",
    );
  }

  console.log("test-autoassign-backoff: all assertions passed (issue #191 linear dispatch, normal path, recovery, deferred-round hint, single shared gate)");
} catch (err) {
  failed = true;
  console.error("test-autoassign-backoff FAILED:", err);
} finally {
  globalThis.fetch = realFetch;
}

if (failed) {
  process.exit(1);
}
