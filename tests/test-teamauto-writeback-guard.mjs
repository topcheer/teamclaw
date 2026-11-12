// Regression test for issue #269: reconcileWritebacks had no concurrency
// guard, and a slow delivery (>20s in prod; simulated here) let the next
// 20s tick re-read the same pending entry before doneAt landed - the same
// issue comment was delivered twice (ggcode#5480, byte-identical pair).
// Fix under test: (1) a pass-in-progress guard serializes reconcile calls,
// (2) intent-first inFlightAt is persisted BEFORE dispatch so even a
// guard-bypassing caller filters the entry out.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-269-"));
process.env.OPENCLAW_STATE_DIR = stateDir; // isolate the store path from the real HOME
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const teamState = {
  tasks: {
    "task-dbl": { id: "task-dbl", title: "[takeOwnership] x", description: "d", status: "completed", result: "final state body", writeMode: "read-only", assignedRole: "owner" },
  },
};

await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
await fs.promises.writeFile(storeFile, JSON.stringify({
  version: 1,
  repos: [{ id: "acme/widget", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true }],
  writebacks: [
    { taskId: "task-dbl", action: "issueComment", repoId: "acme/widget", targetId: 42, doneAt: null, prUrl: null, error: null },
  ],
  activity: [],
  budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-12" },
}), "utf8");

const scheduler = schedMod.createTeamAutoScheduler({
  logger: noopLogger,
  auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
  getTeamState: () => teamState,
  updateTeamState: (fn) => { fn(teamState); return teamState; },
  onTasksCreated: async () => {},
});

const readStore = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));

// Slow POST stub: 150ms latency simulates the >20s prod delivery window.
const realFetch = globalThis.fetch;
let postCalls = 0;
let slowResolve;
const slowGate = new Promise((r) => { slowResolve = r; });
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.endsWith("/repos/acme/widget/issues/42/comments")) {
    postCalls += 1;
    await slowGate; // hold the delivery open until the test releases it
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 555 }), json: async () => ({ id: 555 }) };
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([]), json: async () => [] };
};

try {
  // First pass starts; the delivery is parked inside the slow POST.
  const first = scheduler.reconcileWritebacks();
  await new Promise((r) => setTimeout(r, 60)); // let it reach the POST

  // Contract 1 (intent-first): the dispatch intent is already persisted -
  // an overlapping reader sees inFlightAt, not a naked pending entry.
  const mid = await readStore();
  assert.ok(mid.writebacks[0].inFlightAt, "inFlightAt must be persisted before the delivery POST");

  // Contract 2 (guard): a concurrent reconcile call is a no-op while the
  // first pass is still delivering - the 20s tick scenario from #269.
  await scheduler.reconcileWritebacks();
  assert.equal(postCalls, 1, "concurrent reconcile must not start a second delivery");

  // Release the slow POST and let the first pass finish.
  slowResolve();
  await first;

  const end = await readStore();
  assert.equal(postCalls, 1, "exactly one comment POST for the whole overlap window");
  // Delivered entries leave the queue entirely (scheduler drops doneAt rows,
  // keep-last-500): an EMPTY writebacks array is the success end-state.
  assert.equal((end.writebacks || []).length, 0, "delivered entry exits the writeback queue (doneAt rows are dropped)");
  // ── Contract 3 (per-target dedupe, delivery side, #269): two pending rows
  // aimed at the SAME issue burst at most ONE comment per reconcile pass;
  // the deferred row rides the next pass. The rows go into the fixture file
  // BEFORE a fresh scheduler instance loads it (the scheduler caches the
  // store after its first ensureStore, so external edits are invisible to
  // the instance above - pre-fix residue is simulated at load time).
  postCalls = 0;
  teamState.tasks["task-dbl2"] = { ...teamState.tasks["task-dbl"], id: "task-dbl2" };
  teamState.tasks["task-dbl3"] = { ...teamState.tasks["task-dbl"], id: "task-dbl3" };
  await fs.promises.writeFile(storeFile, JSON.stringify({
    ...end,
    writebacks: [
      { taskId: "task-dbl2", action: "issueComment", repoId: "acme/widget", targetId: 42, doneAt: null, prUrl: null, error: null },
      { taskId: "task-dbl3", action: "issueComment", repoId: "acme/widget", targetId: 42, doneAt: null, prUrl: null, error: null },
    ],
  }), "utf8");
  const scheduler2 = schedMod.createTeamAutoScheduler({
    logger: noopLogger,
    auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
    getTeamState: () => teamState,
    updateTeamState: (fn) => { fn(teamState); return teamState; },
    onTasksCreated: async () => {},
  });
  await scheduler2.reconcileWritebacks();
  assert.equal(postCalls, 1, "same-target pending rows deliver at most one comment per pass");
  const midB = await readStore();
  assert.equal(midB.writebacks.length, 1, "one deferred same-target row remains for the next pass");
  postCalls = 0;
  await scheduler2.reconcileWritebacks();
  assert.equal(postCalls, 1, "the deferred row delivers on the NEXT pass");
  assert.equal((await readStore()).writebacks.length, 0, "queue drains after the second pass");

  // ── Contract 4 (per-target dedupe, enqueue side, #269): re-registering
  // the same target+action while undelivered is skipped; a different target
  // still enqueues.
  scheduler2.registerWriteback("task-enq-a", "issueComment", "acme/widget", 42);
  scheduler2.registerWriteback("task-enq-b", "issueComment", "acme/widget", 42); // duplicate target+action
  scheduler2.registerWriteback("task-enq-c", "issueComment", "acme/widget", 43); // distinct target
  await new Promise((r) => setTimeout(r, 150)); // registerWriteback persists async
  const enq = await readStore();
  const enqTaskIds = enq.writebacks.map((w) => w.taskId).sort();
  assert.deepEqual(enqTaskIds, ["task-enq-a", "task-enq-c"], "enqueue dedupes same target+action; distinct target enqueues");

  console.log("test-teamauto-writeback-guard: all assertions passed");
} finally {
  globalThis.fetch = realFetch;
  await fs.promises.rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
