#!/usr/bin/env node
// Issue #5685 (ggcode, 2026-11-16): "fullReview legs completed but write-back
// delivery stayed silent for ~9 minutes" - the loss claim itself was a
// mis-sized observation window (both legs delivered; see the issue erratum),
// but the report led to two REAL write-back ladder defects:
//
// (a) Sticky inFlightAt wedge: the pending loop stamped entry.inFlightAt and
//     `continue`d for still-running tasks. pendingAll then filtered the entry
//     out until the 600s stale reset, so a completed task's write-back was
//     deliverable in exactly ONE 20s window every ~10 minutes. Live: the
//     02:30 fullReview legs delivered 8m42s-9m51s after completion, and every
//     earlier "slow release" precedent (c4623c6e, 8m32s) fits the same
//     0-10min wedge distribution.
// (b) Umbrella amnesia: same-cycle fullReview sections must share ONE
//     umbrella issue, but the peer lookup only consulted the in-store
//     write-back list whose done entries are pruned at end-of-pass - each
//     section delivering in a later pass minted its own duplicate umbrella
//     (live: cycle 20772 -> ggcode issues #5686/#5687/#5688, zero section
//     comments on the first umbrella).
//
// Contracts pinned here:
// 1. A pass over a RUNNING task leaves NO sticky inFlightAt on its entry.
// 2. Once the task completes, the very NEXT pass delivers it (no 10min wedge).
// 3. The first same-cycle section creates the umbrella and the durable cycle
//    map records it (the done entry itself is pruned, as in production).
// 4. A LATER pass delivering the second section COMMENTS on the umbrella -
//    it must never create a second issue.
// 5. The third section (yet another later pass) also comments.
// 6. Crash-retry shape: an entry whose createIssue + umbrella-map write
//    persisted but whose doneAt did not re-completes silently - no duplicate
//    section post, no duplicate umbrella.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// Contained state dir so the scheduler never touches a real teamclaw store.
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5685-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Mutable team state - the scheduler re-reads it every pass, so flipping a
// task to completed between passes is exactly the production shape.
const teamState = {
  tasks: {
    "task-wedge": { id: "task-wedge", title: "[takeOwnership] x", description: "d", status: "running", result: null, writeMode: "read-only", assignedRole: "developer" },
    "task-arch": { id: "task-arch", title: "[fullReview] a", description: "d", status: "completed", result: "architect findings body", writeMode: "read-only", assignedRole: "architect" },
    "task-qa": { id: "task-qa", title: "[fullReview] q", description: "d", status: "running", result: null, writeMode: "read-only", assignedRole: "qa" },
    "task-sec": { id: "task-sec", title: "[fullReview] s", description: "d", status: "running", result: null, writeMode: "read-only", assignedRole: "security-engineer" },
  },
};

const baseStore = {
  version: 1,
  repos: [{ id: "acme/widget", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true, policy: { maxTasksPerSweep: 5, actions: { issueReview: true, takeOwnership: true, prReview: true, createPR: true, fullReview: "weekly" }, skipAssignedToHumans: true, labelFilter: { include: [], exclude: [] }, keywordFilter: { include: [], exclude: [] } }, cursors: { lastIssueSince: 0, lastPrSince: 0, lastCommitSha: "", lastFullReviewAt: 0, seen: {}, etags: {} }, norms: null }],
  writebacks: [
    { taskId: "task-wedge", action: "issueComment", repoId: "acme/widget", targetId: 42, doneAt: null, prUrl: null, error: null },
    { taskId: "task-arch", action: "createIssue", repoId: "acme/widget", targetId: null, doneAt: null, prUrl: null, error: null, cycleKey: "20777" },
    { taskId: "task-qa", action: "createIssue", repoId: "acme/widget", targetId: null, doneAt: null, prUrl: null, error: null, cycleKey: "20777" },
    { taskId: "task-sec", action: "createIssue", repoId: "acme/widget", targetId: null, doneAt: null, prUrl: null, error: null, cycleKey: "20777" },
  ],
  activity: [],
  budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-16" },
};

await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
await fs.promises.writeFile(storeFile, JSON.stringify(baseStore), "utf8");

const scheduler = schedMod.createTeamAutoScheduler({
  logger: noopLogger,
  auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
  getTeamState: () => teamState,
  updateTeamState: (fn) => { fn(teamState); return teamState; },
  onTasksCreated: async () => {},
});

const readStore = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));
const entryOf = (store, taskId) => store.writebacks.find((w) => w.taskId === taskId);
const complete = (taskId, result) => {
  teamState.tasks[taskId].status = "completed";
  teamState.tasks[taskId].result = result;
};

const realFetch = globalThis.fetch;
const calls = { wedgeComment: 0, umbrellaCreate: 0, umbrellaComment: 0 };
const commentBodies = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/repos/acme/widget/issues/42/comments")) {
    calls.wedgeComment += 1;
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 1 }), json: async () => ({ id: 1 }) };
  }
  if (/\/repos\/acme\/widget\/issues\/9001\/comments$/.test(target)) {
    calls.umbrellaComment += 1;
    try { commentBodies.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); } catch { commentBodies.push(""); }
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 2 }), json: async () => ({ id: 2 }) };
  }
  if (/\/repos\/acme\/widget\/issues$/.test(target) && String(init?.method ?? "").toUpperCase() === "POST") {
    calls.umbrellaCreate += 1;
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ number: 9001 }), json: async () => ({ number: 9001 }) };
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
};

try {
  // ── Pass 1: only task-arch completed; wedge/qa/sec still running ─────────
  await scheduler.reconcileWritebacks();
  {
    assert.equal(calls.umbrellaCreate, 1, "pass 1: the completed architect section creates the umbrella issue");
    const store = await readStore();
    assert.equal(store.fullReviewUmbrellas?.["acme/widget|20777"], 9001, "contract 3: the umbrella number is durably recorded in the cycle map");
    assert.equal(entryOf(store, "task-arch"), undefined, "contract 3: the delivered entry is pruned, as in production (the pointer must live in the map)");
    assert.equal(calls.wedgeComment, 0, "pass 1: the still-running wedge task delivers nothing");
    assert.equal(entryOf(store, "task-wedge").inFlightAt, undefined, "contract 1: a pass over a RUNNING task must not leave a sticky inFlightAt (#5685 wedge)");
    assert.equal(entryOf(store, "task-qa").inFlightAt, undefined, "contract 1: running fullReview sections stay unstamped too");
    assert.equal(calls.umbrellaCreate, 1, "pass 1: running sections created nothing");
  }

  // ── Pass 2: wedge task + qa section now completed ────────────────────────
  complete("task-wedge", "wedge deliverable body");
  complete("task-qa", "qa findings body");
  await scheduler.reconcileWritebacks();
  {
    assert.equal(calls.wedgeComment, 1, "contract 2: a task completed after the previous pass delivers on the VERY NEXT pass (no 10-minute wedge)");
    assert.equal(calls.umbrellaCreate, 1, "contract 4: the second section must NOT mint a second umbrella issue");
    assert.equal(calls.umbrellaComment, 1, "contract 4: the second section posts a COMMENT on the existing umbrella");
    assert.match(commentBodies[0] ?? "", /### qa section/, "contract 4: the comment carries the qa section header");
    const store = await readStore();
    assert.equal(entryOf(store, "task-wedge"), undefined, "contract 2: delivered wedge entry pruned");
    assert.equal(entryOf(store, "task-qa"), undefined, "contract 4: delivered qa entry pruned");
  }

  // ── Pass 3: security section completed in yet another later pass ─────────
  complete("task-sec", "security findings body");
  await scheduler.reconcileWritebacks();
  {
    assert.equal(calls.umbrellaCreate, 1, "contract 5: still exactly one umbrella issue after the third section");
    assert.equal(calls.umbrellaComment, 2, "contract 5: the third section also comments on the umbrella");
    assert.match(commentBodies[1] ?? "", /### security-engineer section/, "contract 5: the comment carries the security-engineer section header");
    const store = await readStore();
    assert.equal(entryOf(store, "task-sec"), undefined, "contract 5: delivered security entry pruned");
    assert.equal(store.fullReviewUmbrellas?.["acme/widget|20777"], 9001, "cycle map still points at the one umbrella");
  }

  // ── Pass 4: crash-retry shape - create + map write persisted, doneAt did not
  teamState.tasks["task-crash"] = { id: "task-crash", title: "[fullReview] c", description: "d", status: "completed", result: "already-embedded section", writeMode: "read-only", assignedRole: "architect" };
  await fs.promises.writeFile(storeFile, JSON.stringify({
    ...baseStore,
    writebacks: [
      { taskId: "task-crash", action: "createIssue", repoId: "acme/widget", targetId: 9002, doneAt: null, prUrl: null, error: null, cycleKey: "20778" },
    ],
    fullReviewUmbrellas: { "acme/widget|20778": 9002 },
  }), "utf8");
  await scheduler.reconcileWritebacks();
  {
    assert.equal(calls.umbrellaCreate, 1, "contract 6: creator retry creates no second issue");
    assert.equal(calls.umbrellaComment, 2, "contract 6: creator retry does not re-post its section as a comment");
    const store = await readStore();
    assert.equal(entryOf(store, "task-crash"), undefined, "contract 6: the crashed creator entry completes silently");
    assert.equal(store.fullReviewUmbrellas?.["acme/widget|20778"], 9002, "contract 6: the map pointer is intact");
  }

  console.log("test-teamauto-writeback-5685: all 6 contracts PASS");
} finally {
  globalThis.fetch = realFetch;
  await fs.promises.rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
