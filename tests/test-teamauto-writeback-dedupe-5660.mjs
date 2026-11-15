// Regression test for issue #5660 (ggcode): a prReview worker posted its
// PR review DIRECTLY during the execution window; when the task completed,
// the write-back ladder delivered the IDENTICAL body 20s later - readers
// got the same 2510-byte review twice (05:50:20Z / 05:50:40Z on PR #5658).
// Fix under test (teamclaw 7d4ddf9b5): before a prComment delivery, the
// ladder fetches the target PR's existing feedback bodies (reviews AND
// issue-style comments, whitespace-normalized) - an exact match means the
// worker-direct channel already delivered, so the ladder marks the entry
// done, records a "dedupe-skipped" activity line, and NEVER posts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5660-"));
process.env.OPENCLAW_STATE_DIR = stateDir; // isolate the store path from the real HOME
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const WORKER_RESULT = "Verdict: GO\n\nThe fix is correct and verified: anchors live at main, targeted and full suites pass, pre-fix pin reproduces the filed markers at the parent commit.";
// scheduler.ts: let body = `${task.result.trim()}\n${MARKER_FOOTER(role)}`;
// scheduler.ts:42: MARKER_FOOTER = (role) => `\n---\n[teamclaw:${role}] autonomous via TeamClaw`
const role = "qa";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const workerDirectBody = `${WORKER_RESULT}\n\n---\n[teamclaw:${role}] autonomous via TeamClaw`;

const teamState = {
  tasks: {
    "task-5660": {
      id: "task-5660",
      title: "[prReview] Review PR #5658",
      description: "d",
      status: "completed",
      result: WORKER_RESULT,
      writeMode: "read-only",
      assignedRole: role,
    },
  },
};

await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
await fs.promises.writeFile(storeFile, JSON.stringify({
  version: 1,
  repos: [{ id: "acme/widget", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true }],
  writebacks: [
    // The prComment entry the ladder would deliver after task completion -
    // exactly the #5660 shape: the worker ALREADY posted this body directly.
    { taskId: "task-5660", action: "prComment", repoId: "acme/widget", targetId: 5658, doneAt: null, prUrl: null, error: null },
  ],
  activity: [],
  budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-15" },
}), "utf8");

const readStore = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));

const scheduler = schedMod.createTeamAutoScheduler({
  logger: noopLogger,
  auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
  getTeamState: () => teamState,
  updateTeamState: (fn) => { fn(teamState); return teamState; },
  onTasksCreated: async () => {},
});

const realFetch = globalThis.fetch;
let reviewPosts = 0;
let feedbackGets = 0;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const method = init?.method ?? "GET";
  // The ladder's dedupe probe: the PR already carries the worker-direct review.
  if (method === "GET" && /\/repos\/acme\/widget\/pulls\/5658\/reviews/.test(target)) {
    feedbackGets += 1;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 1, body: workerDirectBody }]) };
  }
  if (method === "GET" && /\/repos\/acme\/widget\/issues\/5658\/comments/.test(target)) {
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
  }
  // THE regression probe: a duplicate prComment POST must never happen.
  if (method === "POST" && /\/repos\/acme\/widget\/pulls\/5658\/reviews/.test(target)) {
    reviewPosts += 1;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
};

try {
  await scheduler.reconcileWritebacks();

  // Contract 1 (the filed bug): the identical body was already on the PR -
  // the ladder must NOT deliver a second copy.
  assert.equal(reviewPosts, 0, "#5660: identical review body already on the PR - ladder must skip the duplicate post");

  // Contract 2: the probe actually ran (the skip is grounded in a fetch,
  // not an accidental fall-through).
  assert.ok(feedbackGets >= 1, "the ladder consulted the PR's existing feedback before deciding");

  // Contract 3: the entry still completes - dedupe means "already
  // delivered", so the queue drains rather than retrying forever.
  const end = await readStore();
  assert.equal((end.writebacks || []).length, 0, "deduped entry is marked done and exits the writeback queue");

  // Contract 4: the skip is visible in the activity log with the
  // dedupe-skipped marker (the audit trail distinguishes this from a
  // normal delivery).
  const dedupeLine = (end.activity || []).find((a) => String(a.text || "").includes("dedupe-skipped"));
  assert.ok(dedupeLine, "activity records the dedupe skip");
  assert.ok(String(dedupeLine.text).includes("PR #5658"), "the activity line names the target PR");

  // ── Contract 5 (whitespace normalization): the worker-direct post and
  // the ladder body differ only in footer spacing - still a duplicate.
  const spacedBody = WORKER_RESULT + "\n\n\n---\n\n[teamclaw:qa] autonomous via TeamClaw\n\n";
  teamState.tasks["task-5660b"] = { ...teamState.tasks["task-5660"], id: "task-5660b" };
  await fs.promises.writeFile(storeFile, JSON.stringify({
    ...end,
    writebacks: [
      { taskId: "task-5660b", action: "prComment", repoId: "acme/widget", targetId: 5658, doneAt: null, prUrl: null, error: null },
    ],
  }), "utf8");
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/repos\/acme\/widget\/pulls\/5658\/reviews/.test(target)) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 1, body: spacedBody }]) };
    }
    if (method === "POST" && /\/repos\/acme\/widget\/pulls\/5658\/reviews/.test(target)) {
      reviewPosts += 1;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
  };
  const scheduler2 = schedMod.createTeamAutoScheduler({
    logger: noopLogger,
    auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
    getTeamState: () => teamState,
    updateTeamState: (fn) => { fn(teamState); return teamState; },
    onTasksCreated: async () => {},
  });
  await scheduler2.reconcileWritebacks();
  assert.equal(reviewPosts, 0, "#5660: whitespace-only differences (footer spacing) still dedupe");

  // ── Contract 6 (different content still delivers - no over-dedupe): a
  // genuinely new body (no existing feedback matches) must still POST.
  let freshPosts = 0;
  teamState.tasks["task-5660c"] = { ...teamState.tasks["task-5660"], id: "task-5660c", result: "A brand-new complementary verdict body that differs from anything already on the PR." };
  const end2 = await readStore();
  await fs.promises.writeFile(storeFile, JSON.stringify({
    ...end2,
    writebacks: [
      { taskId: "task-5660c", action: "prComment", repoId: "acme/widget", targetId: 5658, doneAt: null, prUrl: null, error: null },
    ],
  }), "utf8");
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/repos\/acme\/widget\/pulls\/5658\/reviews/.test(target)) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 1, body: workerDirectBody }]) };
    }
    if (method === "POST" && /\/repos\/acme\/widget\/pulls\/5658\/reviews/.test(target)) {
      freshPosts += 1;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
  };
  const scheduler3 = schedMod.createTeamAutoScheduler({
    logger: noopLogger,
    auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
    getTeamState: () => teamState,
    updateTeamState: (fn) => { fn(teamState); return teamState; },
    onTasksCreated: async () => {},
  });
  await scheduler3.reconcileWritebacks();
  assert.equal(freshPosts, 1, "a genuinely different body still delivers (dedupe must not over-fire)");
  assert.equal((await readStore()).writebacks.length, 0, "delivered entry exits the queue");

  console.log("test-teamauto-writeback-dedupe-5660: all assertions passed");
} finally {
  globalThis.fetch = realFetch;
  await fs.promises.rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
