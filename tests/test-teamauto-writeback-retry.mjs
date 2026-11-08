#!/usr/bin/env node
// Issue #24: failed TeamAuto write-backs were permanently stuck with no
// visibility. Original report: reconcileWritebacks filtered pending entries
// with !w.error, set entry.error on failure, and nothing ever retried,
// reset, or surfaced errored entries (one warn log line was the only trace).
//
// Current-state note (verified before fixing): a later Wave already added a
// completed-task self-heal that clears w.error and a 20s reconcile interval,
// so transient failures WERE retried - but with no backoff (hammering GitHub
// every 20s forever on hard failures), no terminal state, and still zero
// visibility (no activity entry, no stats in getStatus).
//
// Contracts pinned here (issue fix directions 1 + 2):
// a. Pure helpers: write-back backoff 1m doubling capped at 2h; retry due
//    math; max attempts constant.
// b. Failure path: a failed delivery persists attempts/lastErrorAt/
//    nextAttemptAt, records an activity entry, and shows up in
//    getStatus().writebacks (errored count + lastError).
// c. Backoff gate: an errored entry is NOT retried before nextAttemptAt
//    (no more 20s hammering).
// d. Retry-after-due -> success: once due, the entry retries; on success it
//    is delivered (doneAt), the failure state is cleared, and the success
//    activity records the attempt history.
// e. Terminal give-up: after TEAMAUTO_WRITEBACK_MAX_ATTEMPTS the entry gets
//    failedAt, is never retried again (frozen POST count), and is exposed as
//    a terminal failure in stats and activity.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// Contained state dir so the scheduler never touches a real teamclaw store.
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-writeback-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

// ── Contract a: pure backoff helpers ────────────────────────────────────────
{
  assert.equal(schedMod.TEAMAUTO_WRITEBACK_MAX_ATTEMPTS, 6, "write-back attempts cap is 6 (issue #24)");
  assert.equal(typeof schedMod.writebackBackoffMs, "function", "writebackBackoffMs must be exported");
  assert.equal(schedMod.writebackBackoffMs(1), 60_000, "first failure retries after 1 minute");
  assert.equal(schedMod.writebackBackoffMs(2), 120_000, "second failure backs off 2 minutes");
  assert.equal(schedMod.writebackBackoffMs(3), 240_000, "third failure backs off 4 minutes");
  assert.equal(schedMod.writebackBackoffMs(8), 7_200_000, "backoff caps at 2 hours");
  assert.equal(schedMod.writebackRetryDueAt(1, 1_000_000), 1_000_000 + 60_000, "retry due = last error + backoff");
}

// ── Fixture: store + completed tasks + fetch stub + fake clock ─────────────
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const teamState = {
  tasks: {
    "task-retry": { id: "task-retry", title: "[issueReview] x", description: "d", status: "completed", result: "review result body", writeMode: "read-only", assignedRole: "qa" },
    "task-stuck": { id: "task-stuck", title: "[issueReview] y", description: "d", status: "completed", result: "review result body 2", writeMode: "read-only", assignedRole: "qa" },
  },
};

await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
await fs.promises.writeFile(storeFile, JSON.stringify({
  version: 1,
  repos: [{ id: "acme/widget", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true }],
  writebacks: [
    { taskId: "task-retry", action: "issueComment", repoId: "acme/widget", targetId: 42, doneAt: null, prUrl: null, error: null },
    { taskId: "task-stuck", action: "issueComment", repoId: "acme/widget", targetId: 43, doneAt: null, prUrl: null, error: null },
  ],
  activity: [],
  budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-08" },
}), "utf8");

const scheduler = schedMod.createTeamAutoScheduler({
  logger: noopLogger,
  auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
  getTeamState: () => teamState,
  updateTeamState: (fn) => { fn(teamState); return teamState; },
  onTasksCreated: async () => {},
});

const readStore = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));
const entryOf = (store, taskId) => store.writebacks.find((w) => w.taskId === taskId);

// Fake clock: reconcileWritebacks gates retries on Date.now().
const realNow = Date.now;
let now = 1_700_000_000_000;
Date.now = () => now;

// Fetch stub: POSTs to the two issue-comment endpoints are steerable, with
// per-issue counters so the two seeded entries can be tracked independently.
const realFetch = globalThis.fetch;
const postCalls = { "42": 0, "43": 0 };
let succeedNumber = null; // only this issue's POST succeeds; others fail 503
globalThis.fetch = async (url) => {
  const target = String(url);
  for (const number of ["42", "43"]) {
    if (target.endsWith(`/repos/acme/widget/issues/${number}/comments`)) {
      postCalls[number] += 1;
      if (number !== succeedNumber) {
        return { ok: false, status: 503, headers: { get: () => null }, text: async () => JSON.stringify({ message: "secondary rate limit" }), json: async () => ({ message: "secondary rate limit" }) };
      }
      return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 555 }), json: async () => ({ id: 555 }) };
    }
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
};

try {
  // ── Contract b: failure persists + becomes visible ──────────────────────
  await scheduler.reconcileWritebacks();
  {
    assert.equal(postCalls["42"], 1, "task-retry attempted once");
    assert.equal(postCalls["43"], 1, "task-stuck attempted once");
    const store = await readStore();
    const entry = entryOf(store, "task-retry");
    assert.ok(entry.error.includes("secondary rate limit"), "failure message persisted on the entry");
    assert.equal(entry.attempts, 1, "first failure records attempts=1");
    assert.equal(entry.lastErrorAt, now, "lastErrorAt recorded");
    assert.equal(entry.nextAttemptAt, now + 60_000, "next retry due after the 1-minute backoff");
    assert.equal(entry.failedAt ?? null, null, "not terminal after one failure");

    const status = await scheduler.getStatus();
    assert.equal(status.writebacks.errored, 2, "both errored write-backs visible in getStatus stats");
    assert.equal(status.writebacks.failed, 0, "no terminal failure yet");
    assert.equal(status.writebacks.lastError.attempts, 1, "lastError carries the attempt count");
    assert.equal(status.writebacks.lastError.terminal, false, "lastError not terminal yet");
    assert.ok(status.writebacks.lastError.message.includes("secondary rate limit"), "lastError carries the message");

    const activity = await scheduler.getActivity();
    assert.ok(
      activity.some((e) => e.kind === "writeback" && /failed \(attempt 1\/6/.test(e.text) && /secondary rate limit/.test(e.text)),
      "write-back failure must be exposed in the activity feed (issue #24 visibility)",
    );
  }

  // ── Contract c: no retry before the backoff is due ───────────────────────
  now += 30_000; // still inside the 1-minute backoff window
  await scheduler.reconcileWritebacks();
  assert.equal(postCalls["42"], 1, "errored write-back must NOT retry before nextAttemptAt (pre-fix: 20s hammer)");
  assert.equal(postCalls["43"], 1, "backoff gate applies to every errored entry");
  {
    const store = await readStore();
    assert.equal(entryOf(store, "task-retry").attempts, 1, "attempts frozen while backing off");
  }

  // ── Contract d: due retry succeeds -> delivered + state cleared ─────────
  now += 31_000; // past nextAttemptAt for both entries
  succeedNumber = "42"; // only task-retry's target recovers
  await scheduler.reconcileWritebacks();
  {
    assert.equal(postCalls["42"], 2, "due entry retried exactly once");
    const store = await readStore();
    assert.equal(entryOf(store, "task-retry"), undefined, "delivered entry leaves the open write-back set (doneAt retention)");
    // task-stuck retried in the same pass and failed again (attempts=2).
    const stuck = entryOf(store, "task-stuck");
    assert.equal(stuck.attempts, 2, "task-stuck consumed its second attempt in the same pass");
    const status = await scheduler.getStatus();
    assert.equal(status.writebacks.errored, 1, "only the still-failing entry stays errored after successful delivery");
    assert.equal(status.writebacks.lastError.taskId, "task-stuck", "lastError now reflects the remaining failure");
    const activity = await scheduler.getActivity();
    assert.ok(
      activity.some((e) => e.kind === "writeback" && /issueComment #42 ok \(task-retry, after 1 failed attempt/.test(e.text)),
      "successful retry records the delivery with its attempt history",
    );
  }

  // ── Contract e: terminal give-up after max attempts ─────────────────────
  // task-stuck fails every time; walk the backoff ladder until failedAt.
  succeedNumber = null;
  let guard = 0;
  for (;;) {
    const store = await readStore();
    const entry = entryOf(store, "task-stuck");
    assert.ok(entry, "stuck entry must remain persisted while retrying");
    if (entry.failedAt) {
      assert.equal(entry.attempts, schedMod.TEAMAUTO_WRITEBACK_MAX_ATTEMPTS, "terminal entry exhausted the attempt ladder");
      break;
    }
    guard += 1;
    assert.ok(guard < 15, "retry ladder must terminate within the max attempts");
    now = Math.max(now, entry.nextAttemptAt) + 1_000;
    await scheduler.reconcileWritebacks();
  }
  {
    const callsAtTerminal = postCalls;
    const storeBefore = await readStore();
    const terminal = entryOf(storeBefore, "task-stuck");
    assert.ok(terminal.failedAt > 0, "failedAt set on the terminal entry");
    assert.ok(terminal.error, "last error message retained for visibility");

    const status = await scheduler.getStatus();
    assert.equal(status.writebacks.failed, 1, "terminal failure visible in getStatus stats");
    assert.equal(status.writebacks.lastError.taskId, "task-stuck", "lastError names the stuck entry");
    assert.equal(status.writebacks.lastError.terminal, true, "lastError flagged terminal");
    assert.equal(status.writebacks.lastError.attempts, schedMod.TEAMAUTO_WRITEBACK_MAX_ATTEMPTS, "lastError carries full attempt count");

    const activity = await scheduler.getActivity();
    assert.ok(
      activity.some((e) => e.kind === "writeback" && /failed permanently after 6 attempt/.test(e.text)),
      "terminal give-up must be exposed in the activity feed",
    );

    // Terminal entries are never retried again, however far time advances.
    now += 24 * 60 * 60_000;
    await scheduler.reconcileWritebacks();
    await scheduler.reconcileWritebacks();
    assert.equal(postCalls, callsAtTerminal, "terminally failed write-back must never be retried again");
    const storeAfter = await readStore();
    assert.ok(entryOf(storeAfter, "task-stuck"), "terminal entry stays persisted for visibility (bounded by the 500 cap)");
  }

  await scheduler.stop();
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log("test-teamauto-writeback-retry: all assertions passed (issue #24 failure -> backoff -> retry -> success/terminal, visible in activity + status)");
