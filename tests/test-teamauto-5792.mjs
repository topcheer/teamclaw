#!/usr/bin/env node
// Regression test for ggcode #5792 (teamclaw write-back pipeline).
//
// Live incident (2026-11-19 00:12, post-3b1a175 deploy): every task created
// after the 23:26:44 restart lost its write-back registration between the
// sweep and the first delivery window - "created 2/2" logged, writebacks[]
// empty on disk, ZERO ladder rows, orphan-result alarms ~10min after each
// completion, no restart involved. The prReview leg (527570e0, a REQUEST
// CHANGES verdict on PR #5789) had no direct-send surface either, so the
// review body was lost outright.
//
// Root cause under test:
//  A. runSweep captured its store handle (ensureStore) BEFORE the unlocked
//     network phase; the 20s reconcile pass reassigns the closure `store`
//     from disk on every pass. When a pass loaded during sweepRepo,
//     registerWritebackUnlocked (inside the sweep's locked tx) pushed+saved
//     the entry onto the NEW closure object while the tx tail re-saved the
//     OLD handle - erasing the registration from disk. The deploy restart
//     re-based the 20s tick grid onto the sweep window (fetch retries
//     stretched sweepRepo across a tick), taking the race from rare to 100%.
//     Fix: the sweep tx (and every capture-outside/save-inside section)
//     rebinds ONE fresh handle under the lock (reloadStoreUnlocked).
//  B. Self-heal: the orphan audit no longer ONLY alarms - it re-registers
//     the missing write-back entry from the parsed target so the ladder
//     re-delivers the stranded result (issue's requested
//     "completed-but-unregistered" rescue; prReview bodies have no
//     direct-send surface).
//
// Part 1 pins source contracts (no build required). Part 2 runs behavioral
// scenarios against the built dist (scheduler-audit harness v2: scratch
// OPENCLAW_STATE_DIR per scenario, globalThis.fetch stubbed; stub routing
// PREFIX-matches because the client appends query params - #5781 gotcha).

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const failures = [];
async function section(name, fn) {
  try {
    await fn();
    console.log(`  ok: ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const schedulerSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "scheduler.ts"), "utf8");

  console.log("Part 1: source contracts (no build required)");
  await section("1a one fresh handle per locked transaction exists", () => {
    assert.match(schedulerSrc, /async function reloadStoreUnlocked/, "#5792: reloadStoreUnlocked helper must exist - it re-syncs the closure from disk UNDER the lock");
    const calls = schedulerSrc.match(/await reloadStoreUnlocked()/g) ?? [];
    assert.ok(calls.length >= 6, `#5792: expected >=6 reloadStoreUnlocked call sites (sweep tx, sweep catch, registerWriteback, 2 claim paths, GC), found ${calls.length}`);
  });
  await section("1b sweep transaction rebinds under the lock", () => {
    assert.match(schedulerSrc, /const s = await reloadStoreUnlocked\(\);\s*\n\s*const repo = s\.repos\.find\(\(r\) => r\.id === repoOuterId\) \?\? repoOuter;/, "#5792: the sweep tx must bind ONE fresh store handle + repo node under the lock (stale outer handle erased registrations)");
    assert.match(schedulerSrc, /sweepSummary = repo.lastSweepSummary;/, "#5792: post-commit readers must use the tx-scoped repo's summary");
  });
  await section("1c orphan audit self-heal re-registers before alarming", () => {
    assert.match(schedulerSrc, /orphan self-heal: re-registered/, "#5792: the self-heal activity line must exist");
    assert.match(schedulerSrc, /await registerWritebackUnlocked\(task\.id, prNumMatch \? "prComment" : "issueComment", repoMatch\[1\], healTargetNum\)/, "#5792: the audit must re-register from the parsed target so the ladder re-delivers");
  });

  const distScheduler = path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js");
  const distStore = path.join(projectRoot, "src", "dist", "src", "teamauto", "store.js");
  if (!fs.existsSync(distScheduler) || !fs.existsSync(distStore)) {
    console.log("test-teamauto-5792: Part 1 done; dist not built - skipping behavioral scenarios");
    if (failures.length) throw failures[0]?.err;
    console.log("test-teamauto-5792: ok (source contracts)");
    return;
  }
  const schedMod = await import(pathToFileURL(distScheduler).href);
  const storeMod = await import(pathToFileURL(distStore).href);
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const realFetch = globalThis.fetch;

  const mkScenario = async (label) => {
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), `tc5792-${label}-`));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");
    return { stateDir, storeFile };
  };
  const writeFixture = (storeFile, over) => fsp.writeFile(storeFile, JSON.stringify({
    version: 1,
    repos: [{ id: "topcheer/ggcode", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true }],
    writebacks: [],
    activity: [],
    deliveredResultsInit: true,
    budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-19" },
    ...over,
  }), "utf8");
  const mkScheduler = (teamState) => schedMod.createTeamAutoScheduler({
    logger: noopLogger,
    auth: { getAuthHeaders: async () => ({}) },
    getTeamState: () => teamState,
    updateTeamState: (fn) => { fn(teamState); return teamState; },
    onTasksCreated: async () => {},
  });
  const readStore = async (f) => JSON.parse(await fsp.readFile(f, "utf8"));
  const activityTexts = async (f) => (await readStore(f)).activity.map((a) => a.text);
  const jsonResponse = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload });

  console.log("Part 2: behavioral scenarios (dist)");
  // 2A: the root cause - a reconcile pass loads the store from disk DURING
  // the sweep's network phase; the sweep tx must still persist the
  // registration it creates afterwards.
  await section("2A sweep registration survives a mid-sweep store reload (the #5792 zero-fire shape)", async () => {
    const { stateDir, storeFile } = await mkScenario("a");
    const teamState = { tasks: {} };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile);
    const issue = {
      number: 5792,
      title: "obs: writeback pipeline zero-fire after deploy",
      body: "post-deploy tasks lose their wb entries",
      state: "open",
      assignees: [],
      labels: [],
      updated_at: new Date().toISOString(),
      user: { login: "observer" },
      html_url: "https://github.com/topcheer/ggcode/issues/5792",
    };
    let sched;
    let issuesCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/repos/topcheer/ggcode/issues?")) {
        issuesCalls += 1;
        if (issuesCalls === 1) {
          // The kill shot: a full reconcile pass completes while the sweep
          // is parked on its (unlocked) network phase. The pass re-reads
          // the store from disk - exactly the 20s-tick-during-sweepRepo
          // interleaving of the live incident.
          await sched.reconcileWritebacks();
        }
        return jsonResponse([issue]);
      }
      if (target.includes("/repos/topcheer/ggcode/pulls?")) { return jsonResponse([]); }
      if (target.includes("/repos/topcheer/ggcode/commits?")) { return jsonResponse([]); }
      return jsonResponse([]);
    };
    try {
      sched = mkScheduler(teamState);
      const summary = await sched.runSweepNow("topcheer/ggcode", true);
      assert.ok(/created \d+\/\d+/.test(summary), `sweep summary should report creations, got: ${summary}`);
      const own = Object.values(teamState.tasks).find((t) => String(t.title).includes("Take ownership of issue #5792"));
      assert.ok(own, "the takeOwnership task for issue #5792 must be enqueued");
      const disk = await readStore(storeFile);
      const entry = (disk.writebacks ?? []).find((w) => w.taskId === own.id);
      assert.ok(entry, "THE #5792 REGRESSION: the write-back registration was persisted by the sweep tx but then erased by its own stale tail-save (zero-fire; ladder never sees the entry)");
      assert.equal(entry.action, "issueComment");
      assert.equal(entry.targetId, 5792);
      assert.equal(entry.doneAt, null);
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 2B: self-heal - a completed prReview task whose registration was lost
  // gets re-registered by the orphan audit and delivered by the ladder in
  // the same pass (the 527570e0 REQUEST CHANGES rescue shape).
  await section("2B orphan self-heal re-registers and re-delivers a lost prReview body", async () => {
    const { stateDir, storeFile } = await mkScenario("b");
    const task = {
      id: "teamauto-mwmb4w6v-527570e0",
      title: "[prReview] Review PR #5789: test(restart): normalize all time fields",
      description: "TeamAuto autonomous work for topcheer/ggcode.\nIdempotency-Key: topcheer/ggcode#pr-5789:prReview",
      status: "completed",
      result: "REQUEST CHANGES: TestIssue5753ArmRecordRoundTrip still fails 10/10 at head under CI semantics.",
      writeMode: "read-only",
      assignedRole: "qa",
      completedAt: Date.now() - 20 * 60_000,
      createdAt: Date.now() - 40 * 60_000,
    };
    const teamState = { tasks: { [task.id]: task } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile);
    const posted = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.includes("/pulls/5789/reviews") && init && String(init.method ?? "GET").toUpperCase() === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return jsonResponse({ id: 1 });
      }
      if (target.includes("/pulls/5789/reviews")) { return jsonResponse([]); }
      if (target.includes("/pulls/5789/comments")) { return jsonResponse([]); }
      return jsonResponse([]);
    };
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      const texts = await activityTexts(storeFile);
      assert.ok(texts.some((t) => t.includes("orphan self-heal") && t.includes("prComment #5789")), "the audit must record the self-heal re-registration");
      assert.ok(!texts.some((t) => t.includes("orphan result alarm")), "no orphan alarm once the self-heal owns the rescue");
      assert.equal(posted.length, 1, "the ladder must post the review body exactly once");
      assert.ok(String(posted[0]?.body ?? "").includes("REQUEST CHANGES"), "the posted review carries the stranded verdict");
      assert.match(String(posted[0]?.body ?? ""), /\[teamclaw:qa\]/, "the posted review carries the marker footer");
      const disk = await readStore(storeFile);
      assert.ok(disk.deliveredResults?.[task.id], "delivery must be stamped into the durable ledger");
      assert.ok(!(disk.writebacks ?? []).some((w) => w.taskId === task.id && !w.doneAt), "no dangling open entry after delivery");
      // Pass 2: delivered + ledgered - must neither re-heal, re-post, nor alarm.
      await sched.reconcileWritebacks();
      const texts2 = await activityTexts(storeFile);
      assert.ok(!texts2.some((t) => t.includes("orphan result alarm")), "ledgered delivery keeps the audit silent");
      assert.equal(posted.length, 1, "no duplicate review post on the next pass");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 2C: the alarm fallback survives - a completed orphan whose target cannot
  // be parsed still alarms (once), instead of crashing or self-healing blind.
  await section("2C unparseable orphan still alarms (fallback intact)", async () => {
    const { stateDir, storeFile } = await mkScenario("c");
    const task = {
      id: "teamauto-orphan-0001",
      title: "[issueReview] Something odd in the logs",
      description: "TeamAuto autonomous work for topcheer/ggcode.\nIdempotency-Key: topcheer/ggcode#issue-0001:issueReview",
      status: "completed",
      result: "triage: could not correlate the artifact",
      writeMode: "read-only",
      assignedRole: "qa",
      completedAt: Date.now() - 20 * 60_000,
      createdAt: Date.now() - 40 * 60_000,
    };
    const teamState = { tasks: { [task.id]: task } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile);
    globalThis.fetch = async () => jsonResponse([]);
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      const disk = await readStore(storeFile);
      assert.ok(disk.orphanResultAlarms?.[task.id], "the once-per-task alarm gate must be stamped");
      const texts = await activityTexts(storeFile);
      assert.ok(texts.some((t) => t.includes("orphan result alarm")), "the orphan alarm must fire for unparseable targets");
      assert.ok(!texts.some((t) => t.includes("orphan self-heal")), "no self-heal without a parseable target");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  if (failures.length) {
    console.error(`test-teamauto-5792: ${failures.length} section(s) failed`);
    throw failures[0]?.err;
  }
  console.log("test-teamauto-5792: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
