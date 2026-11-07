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
//
// No real network: global fetch is patched. The taskRouter dep is replaced
// with a deterministic fake that proposes every pending-task x idle-worker
// pair, which is the maximal fan-out shape of the real router.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const httpServerMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "http-server.js")
).catch(() => null);
assert.ok(httpServerMod, "http-server module must be built (run npm --prefix src run build first)");
assert.equal(typeof httpServerMod.autoAssignPendingTasks, "function", "autoAssignPendingTasks must stay exported (issue #191 test)");

const realFetch = globalThis.fetch;
let assignAttempts = 0;
let assignSucceeds = false;

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/api/v1/tasks/assign")) {
    assignAttempts += 1;
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

function makeDeps({ tasks, workers }) {
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
  // Deterministic worst-case router: proposes every pending task x idle
  // worker pair on every call, so a nested round without shared state would
  // re-attempt ALL pairs (the #191 blowup shape).
  const taskRouter = {
    autoAssignPendingTasks(taskMap, workerMap) {
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
    },
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

let failed = false;
try {
  // ── Contract a: unreachable-worker storm is linear (T*W attempts) ──────
  {
    const tasks = Object.fromEntries(["t1", "t2", "t3"].map((id) => [id, makeTask(id)]));
    const workers = Object.fromEntries(["w1", "w2"].map((id) => [id, makeWorker(id)]));
    const { deps, state } = makeDeps({ tasks, workers });
    assignAttempts = 0;
    assignSucceeds = false;

    const assigned = await httpServerMod.autoAssignPendingTasks(deps);
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

    const assigned = await httpServerMod.autoAssignPendingTasks(deps);
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

    await httpServerMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assignAttempts, 1, "first round attempts the pair once");
    assert.equal(deps.getTeamState().tasks.t1.status, "pending", "task reverts to pending");

    // Worker recovers; a fresh trigger (e.g. heartbeat) must be able to
    // re-attempt the pair - the shared attemptedPairs set must not leak
    // across settled rounds.
    assignSucceeds = true;
    const assigned = await httpServerMod.autoAssignPendingTasks(deps);
    await settle();
    assert.equal(assigned.length, 1, "recovered worker must receive the task on the next round");
    assert.equal(assignAttempts, 2, "recovery round re-attempts the pair exactly once more");
  }

  console.log("test-autoassign-backoff: all assertions passed (issue #191 linear dispatch, normal path, recovery)");
} catch (err) {
  failed = true;
  console.error("test-autoassign-backoff FAILED:", err);
} finally {
  globalThis.fetch = realFetch;
}

if (failed) {
  process.exit(1);
}
