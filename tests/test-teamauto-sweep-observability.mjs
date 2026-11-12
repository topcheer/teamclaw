#!/usr/bin/env node
// Issue #267 re-verification: the merged observability trio (352c7c1) had two
// defects that its source-regex pins could not catch. This file pins the
// BEHAVIOR that the original 8 pins only gestured at.
//
// a. isAutoPause vs class-tagged reasons: runSweep writes
//    `sweep failed[class]: msg` but isAutoPause matched only
//    startsWith("sweep failed:") - so the recovery cleanup (success path)
//    and the backoff retry gate (scheduleRepo) never fired for class-tagged
//    pauses: every failed sweep paused its repo FOREVER. Pinned here by
//    driving a real runSweep failure via fetch stubs and then a success.
// b. etag304Hits inversion: the client counted `hits` on non-304 2xx (cache
//    MISSES); real 304s were recorded nowhere. Pinned by driving sweeps with
//    steerable 304 responses and asserting the recorded per-sweep delta.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// Contained state dir so the scheduler never touches a real teamclaw store.
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-sweep-obs-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

// ── Contract a: isAutoPause accepts both forms (unit level) ────────────────
{
  assert.equal(schedMod.isAutoPause("sweep failed: fetch failed"), true, "legacy reason matches");
  for (const cls of ["auth", "ratelimited", "network"]) {
    assert.equal(schedMod.isAutoPause(`sweep failed[${cls}]: boom`), true, `class-tagged reason (${cls}) matches`);
  }
  assert.equal(schedMod.isAutoPause("disabled by user"), false, "user pauses are never auto-cleared");
  assert.equal(schedMod.isAutoPause(null), false, "null pause is healthy");
}

// ── Fixture: store + fetch stub ────────────────────────────────────────────
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const teamState = { tasks: {} };

await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
await fs.promises.writeFile(storeFile, JSON.stringify({
  version: 1,
  repos: [{
    id: "acme/widget",
    enabled: true,
    schedule: "*/30 * * * *",
    addedAt: 1,
    lastSweepAt: 0,
    lastSweepSummary: null,
    pausedReason: null,
    dryRunDone: true, // skip the observing pass; we want acting sweeps
    sweeps: [],
    cursors: { lastIssueSince: 0, lastPrSince: 0, lastCommitSha: "", lastFullReviewAt: 0, seen: {}, etags: {} },
  }],
  writebacks: [],
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
const repoOf = (store) => store.repos.find((r) => r.id === "acme/widget");

// Fetch steering: mode "fail" makes every GET a network-ish 503 with a
// status-bearing error; mode "ok" serves empty feeds; mode "304" serves
// 304 for the second-and-later conditional GETs of each URL once an etag
// was seen (mirrors GitHub's If-None-Match flow).
let mode = "ok";
const etagSeen = new Map(); // url -> etag issued
const requestLog = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  requestLog.push(target);
  const headers = {
    get: (name) => (name.toLowerCase() === "etag" && etagSeen.has(target) ? etagSeen.get(target) : null),
  };
  if (mode === "fail") {
    return { ok: false, status: 503, headers, text: async () => JSON.stringify({ message: "service unavailable" }), json: async () => ({ message: "service unavailable" }) };
  }
  if (mode === "304") {
    const sentIfNoneMatch = Object.entries(init?.headers ?? {}).some(([k, v]) => k.toLowerCase() === "if-none-match" && v);
    if (sentIfNoneMatch && etagSeen.has(target)) {
      return { ok: false, status: 304, headers, text: async () => "", json: async () => ({}), notModified: true };
    }
    etagSeen.set(target, `W/"${target.length}"`);
    return {
      ok: true, status: 200, headers,
      text: async () => JSON.stringify([]),
      json: async () => [],
    };
  }
  // mode "ok": fresh empty feeds.
  return { ok: true, status: 200, headers, text: async () => JSON.stringify([]), json: async () => [] };
};

try {
  // ── Contract b: failed sweep writes class-tagged reason AND record ──────
  mode = "fail";
  const failSummary = await scheduler.runSweepNow("acme/widget");
  {
    assert.ok(failSummary.startsWith("error:"), `failure summary reflects the error (got: ${failSummary})`);
    const store = await readStore();
    const repo = repoOf(store);
    assert.ok(repo.pausedReason, "failed sweep sets pausedReason");
    assert.match(repo.pausedReason, /^sweep failed\[(auth|ratelimited|network)\]: /,
      "pausedReason is class-tagged");
    // The regression: this exact reason must be recognized as auto-pause.
    assert.equal(schedMod.isAutoPause(repo.pausedReason), true,
      "the class-tagged reason actually written by runSweep IS an auto-pause (regression)");
    assert.equal(repo.sweepFailures, 1, "sweepFailures incremented");
    assert.ok(repo.lastSweepErrorAt > 0, "lastSweepErrorAt recorded");
    const rec = repo.sweeps.at(-1);
    assert.ok(rec && rec.ok === false, "failure recorded in the sweep ring");
    assert.equal(rec.failClass, "network", "503 without cause.status maps to network class");
    assert.match(rec.summary, /^sweep failed\[network\]: /, "record summary carries the class");
    assert.ok(rec.etagCalls >= 1, "failure record still attributes etag calls");
    // Retry gate math: the cooldown must actually re-arm for this reason.
    const due = schedMod.sweepRetryDueAt(repo.sweepFailures, repo.lastSweepErrorAt);
    assert.ok(due > repo.lastSweepErrorAt, "retry due time is after the failure");
  }

  // ── Contract c: success clears the class-tagged auto-pause ──────────────
  mode = "ok";
  await scheduler.runSweepNow("acme/widget");
  {
    const store = await readStore();
    const repo = repoOf(store);
    assert.equal(repo.pausedReason, null, "successful sweep clears a class-tagged auto-pause (regression)");
    assert.equal(repo.sweepFailures, 0, "sweepFailures reset on recovery");
    const rec = repo.sweeps.at(-1);
    assert.ok(rec && rec.ok === true, "recovery recorded in the sweep ring");
    assert.equal(rec.etag304Hits, 0, "fresh 2xx fetches never count as 304 hits (regression)");
    assert.ok(rec.etagCalls >= 1, "success record attributes etag calls");
  }

  // ── Contract d: real 304s count as etag304Hits ──────────────────────────
  // Two sweeps in "304" mode: the first stores etags (all 200s), the second
  // sends If-None-Match and receives 304s - those must land in etag304Hits.
  mode = "304";
  await scheduler.runSweepNow("acme/widget"); // primes etagSeen per URL
  const storePrime = await readStore();
  const primeRec = repoOf(storePrime).sweeps.at(-1);
  assert.equal(primeRec.etag304Hits, 0, "priming sweep (all 200s) records zero 304 hits");
  await scheduler.runSweepNow("acme/widget"); // now conditional GETs -> 304
  {
    const store = await readStore();
    const rec = repoOf(store).sweeps.at(-1);
    assert.ok(rec && rec.ok === true, "conditional sweep succeeds");
    assert.ok(rec.etag304Hits >= 1, `real 304 responses land in etag304Hits (got ${rec.etag304Hits})`);
    assert.ok(rec.etagCalls >= rec.etag304Hits, "calls is a superset of hits");
  }

  console.log("test-teamauto-sweep-observability: all contracts passed");
} finally {
  globalThis.fetch = realFetch;
  await fs.promises.rm(stateDir, { recursive: true, force: true });
}
