#!/usr/bin/env node
// Regression test for ggcode #5785 (teamclaw write-back ladder).
//
// Live incident (2026-11-18 22:26, task 49f0a882 / ggcode #5781 leg): a
// completed WRITE task's write-back registration never entered the ladder -
// writebacks [] across a 10m42s three-probe window, the task branch pushed
// to the remote, createPR never fired, and the orphan-result audit stayed
// SILENT because the worker's issue-face direct-post back-filled
// deliveredResults (comment-shaped evidence cannot see the PR face).
//
// Two-part fix under test:
//  A. registerWritebackUnlocked no longer silently drops a DIFFERENT task's
//     registration just because a pending entry aims at the same target +
//     action (the enqueue-side per-target skip assumed "the pending
//     original still delivers the content", but content is per-task).
//  B. The settle audit grows an undelivered-PR face: a completed WRITE task
//     must own a write-back entry, a durable prDeliveries record, or a PR
//     (any state) whose head is its task branch - otherwise ONE
//     "undelivered-PR alarm" line, gated once per task.
//
// Part 1 pins source contracts (no build required). Part 2 runs behavioral
// scenarios against the built dist (scheduler-audit harness v2: scratch
// OPENCLAW_STATE_DIR per scenario, globalThis.fetch stubbed).
// GOTCHA (learned on #5781): the client appends query params, so stub
// routing must PREFIX-match - an exact === on the bare path silently
// returns empty and inverts the verdict.

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
  const storeSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "store.ts"), "utf8");
  const schedulerSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "scheduler.ts"), "utf8");
  const clientSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "github-client.ts"), "utf8");

  console.log("Part 1: source contracts (no build required)");
  await section("1a loader copies prDeliveries + undeliveredPrAlarms (#5736 discipline)", () => {
    const loaderStart = storeSrc.indexOf("export async function loadTeamAutoStore");
    const loaderEnd = storeSrc.indexOf("export async function saveTeamAutoStore");
    assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, "loadTeamAutoStore bounds not found");
    const loaderBody = storeSrc.slice(loaderStart, loaderEnd);
    assert.match(loaderBody, /store\.prDeliveries\s*=\s*parsed\.prDeliveries/, "#5785: prDeliveries missing from the loader copy list - it would be dropped on EVERY 20s settle reload (healthy pruned tasks re-probe GitHub)");
    assert.match(loaderBody, /store\.undeliveredPrAlarms\s*=\s*parsed\.undeliveredPrAlarms/, "#5785: undeliveredPrAlarms missing from the loader copy list - the once-per-task gate would reset every reload and one incident re-alarms every pass");
    assert.match(storeSrc, /prDeliveries:\s*\{\}/, "emptyStore must scaffold prDeliveries");
    assert.match(storeSrc, /undeliveredPrAlarms:\s*\{\}/, "emptyStore must scaffold undeliveredPrAlarms");
  });
  await section("1b the enqueue-side per-target skip is gone", () => {
    assert.doesNotMatch(schedulerSrc, /per-target dedupe \(enqueue side\)/, "#5785: the silent per-target skip must not come back - it swallowed a fresh task's registration while another task's entry was pending");
    assert.match(schedulerSrc, /co-target write-back registered/, "#5785: co-target registration must be observable in the activity ring");
  });
  await section("1c undelivered-PR audit anchors", () => {
    assert.match(schedulerSrc, /undelivered-PR alarm/, "#5785: the alarm line must exist");
    assert.match(schedulerSrc, /listPullsByHead/, "#5785: the PR-face surface check must exist");
    assert.match(schedulerSrc, /s\.prDeliveries\[w\.taskId\]\s*=\s*w\.prUrl/, "#5785: PR-face delivery must be stamped into the durable ledger BEFORE the done-entry prune");
    assert.match(schedulerSrc, /prAlarmedThisPass >= 1/, "#5785: storm cap - at most ONE undelivered-PR alarm per settle pass");
    assert.match(clientSrc, /listPullsByHead/, "#5785: github client must expose the pulls?head= surface");
  });

  const distScheduler = path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js");
  const distStore = path.join(projectRoot, "src", "dist", "src", "teamauto", "store.js");
  if (!fs.existsSync(distScheduler) || !fs.existsSync(distStore)) {
    console.log("test-teamauto-5785: Part 1 done; dist not built - skipping behavioral scenarios");
    if (failures.length) throw failures[0]?.err;
    console.log("test-teamauto-5785: ok (source contracts)");
    return;
  }
  const schedMod = await import(pathToFileURL(distScheduler).href);
  const storeMod = await import(pathToFileURL(distStore).href);
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const realFetch = globalThis.fetch;

  const mkScenario = async (label) => {
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), `tc5785-${label}-`));
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
    budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-18" },
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

  const completedWriteTask = (id, minutesAgo) => ({
    id,
    title: "[takeOwnership] Take ownership of issue #5781: channel-family",
    description: "TeamAuto autonomous work for topcheer/ggcode.\nIdempotency-Key: topcheer/ggcode#issue-5781:takeOwnership",
    status: "completed",
    result: "residual delivered: regression pin + channel-naming fix",
    writeMode: "write",
    assignedRole: "developer",
    projectDir: "projects/teamauto/topcheer__teamclaw__task-" + id,
    completedAt: Date.now() - minutesAgo * 60_000,
    createdAt: Date.now() - (minutesAgo + 60) * 60_000,
  });

  console.log("Part 2: behavioral scenarios (dist)");
  // A: the live shape - issue-face evidence present (masking), no entry, no PR.
  await section("2A undelivered-PR alarm fires under issue-face masking, once per task", async () => {
    const { stateDir, storeFile } = await mkScenario("a");
    const t1 = completedWriteTask("teamauto-mwm6ukoy-49f0a882", 20);
    const t2 = completedWriteTask("teamauto-grace-leg-0001", 5); // inside the 10min grace
    const teamState = { tasks: { [t1.id]: t1, [t2.id]: t2 } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile, {
      deliveredResults: { [t1.id]: t1.completedAt + 60_000 }, // non-artifact issue-face back-fill shape
    });
    let headCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/pulls?head=")) {
        headCalls += 1;
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
    };
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      assert.equal(headCalls, 1, "exactly one pulls?head probe (grace task is not judged)");
      const texts = await activityTexts(storeFile);
      const alarms = texts.filter((t) => t.includes("undelivered-PR alarm"));
      assert.equal(alarms.length, 1, "one undelivered-PR alarm line");
      assert.ok(alarms[0].includes("teamclaw/task-teamauto-mwm6ukoy-49f0a882"), "alarm names the task branch");
      assert.ok(!texts.some((t) => t.includes("orphan result alarm")), "the orphan audit stays silent under issue-face masking - the #5785 diagnosis");
      const s1 = await readStore(storeFile);
      assert.ok(s1.undeliveredPrAlarms?.[t1.id], "gate stamped for the alarmed task");
      assert.ok(!s1.undeliveredPrAlarms?.[t2.id], "grace task not gated");
      await sched.reconcileWritebacks();
      assert.equal(headCalls, 1, "gated task is not re-probed on the next pass");
      const texts2 = await activityTexts(storeFile);
      assert.equal(texts2.filter((t) => t.includes("undelivered-PR alarm")).length, 1, "no repeat alarm (once per task)");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // B: PR exists through another path -> pardon + durable prDeliveries stamp.
  await section("2B PR face verified through another path pardons the task", async () => {
    const { stateDir, storeFile } = await mkScenario("b");
    const t1 = completedWriteTask("teamauto-manual-pr-leg-01", 20);
    const teamState = { tasks: { [t1.id]: t1 } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile, {});
    const prUrl = "https://github.com/topcheer/ggcode/pull/5790";
    let headCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/pulls?head=")) {
        headCalls += 1;
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ number: 5790, state: "open", html_url: prUrl }]), json: async () => [{ number: 5790, state: "open", html_url: prUrl }] };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
    };
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      const texts = await activityTexts(storeFile);
      assert.ok(texts.some((t) => t.includes("PR face verified") && t.includes(prUrl)), "pardon line carries the PR url");
      assert.ok(!texts.some((t) => t.includes("undelivered-PR alarm")), "no alarm when the PR face exists");
      const s1 = await readStore(storeFile);
      assert.equal(s1.prDeliveries?.[t1.id], prUrl, "pardon stamps the durable PR-face ledger");
      assert.ok(s1.undeliveredPrAlarms?.[t1.id], "gate stamped (surface check runs at most once)");
      await sched.reconcileWritebacks();
      assert.equal(headCalls, 1, "pardoned task is not re-probed");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // C: the ladder still owns the PR face (entry present) -> audit silent.
  await section("2C a task that still owns a write-back entry is left to the ladder", async () => {
    const { stateDir, storeFile } = await mkScenario("c");
    const t1 = completedWriteTask("teamauto-owned-leg-000001", 20);
    const teamState = { tasks: { [t1.id]: t1 } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile, {
      writebacks: [{ taskId: t1.id, action: "issueComment", repoId: "topcheer/ggcode", targetId: 5781, doneAt: null, prUrl: null, error: null, inFlightAt: Date.now() }],
    });
    let headCalls = 0;
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] });
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      assert.equal(headCalls, 0, "no PR-face probe while the ladder owns the entry");
      const texts = await activityTexts(storeFile);
      assert.ok(!texts.some((t) => t.includes("undelivered-PR alarm")), "no alarm - the ladder owns the PR face");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // D: the registration fix - a different task on the same target registers.
  await section("2D co-target registration is no longer silently dropped", async () => {
    const { stateDir, storeFile } = await mkScenario("d");
    const teamState = { tasks: {} };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile, {});
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] });
    try {
      const sched = mkScheduler(teamState);
      await sched.registerWriteback("teamauto-leg1-0000000001", "issueComment", "topcheer/ggcode", 5781);
      await sched.registerWriteback("teamauto-leg2-0000000002", "issueComment", "topcheer/ggcode", 5781); // pre-#5785: silently dropped
      await sched.registerWriteback("teamauto-leg2-0000000002", "issueComment", "topcheer/ggcode", 5781); // same task: idempotent
      const s1 = await readStore(storeFile);
      const ids = s1.writebacks.map((w) => w.taskId).sort();
      assert.deepEqual(ids, ["teamauto-leg1-0000000001", "teamauto-leg2-0000000002"], "both co-target tasks own ladder rows (pre-fix: leg2 was dropped)");
      assert.ok(s1.activity.some((a) => a.text.includes("co-target write-back registered")), "co-target registration is observable");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // E: prune-time durable stamp of PR-face delivery. The prune block only
  // runs on a pass that had pending work, so a deliverable pending row rides
  // along (matches production shape: done rows are stamped by the next
  // active pass, not by an empty one).
  await section("2E prUrl survives the done-entry prune via prDeliveries", async () => {
    const { stateDir, storeFile } = await mkScenario("e");
    const teamState = { tasks: { "teamauto-deliver-now-001": { id: "teamauto-deliver-now-001", title: "[issueReview] x", description: "TeamAuto autonomous work for topcheer/ggcode.", status: "completed", result: "review body", writeMode: "read-only", assignedRole: "qa" } } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    const prUrl = "https://github.com/topcheer/ggcode/pull/77";
    await writeFixture(storeFile, {
      writebacks: [
        { taskId: "teamauto-old-pr-00000001", action: "issueComment", repoId: "topcheer/ggcode", targetId: 5781, doneAt: 1730000000000, prUrl, error: null },
        { taskId: "teamauto-deliver-now-001", action: "issueComment", repoId: "topcheer/ggcode", targetId: 42, doneAt: null, prUrl: null, error: null },
      ],
    });
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.includes("/issues/42/comments")) {
        if (init?.method === "POST") {
          return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 1 }), json: async () => ({ id: 1 }) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
    };
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      const s1 = await readStore(storeFile);
      assert.equal(s1.writebacks.length, 0, "done entry pruned");
      assert.equal(s1.prDeliveries?.["teamauto-old-pr-00000001"], prUrl, "PR face recorded durably at prune time");
      assert.equal(s1.deliveredResults?.["teamauto-old-pr-00000001"], 1730000000000, "comment face ledger intact (#5736)");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // F: fetch failure must not gate the check permanently (retry next pass).
  await section("2F a failed PR-face probe defers judgement instead of gating", async () => {
    const { stateDir, storeFile } = await mkScenario("f");
    const t1 = completedWriteTask("teamauto-blip-leg-000001", 20);
    const teamState = { tasks: { [t1.id]: t1 } };
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await writeFixture(storeFile, {});
    let broken = true;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/pulls?head=") && broken) {
        return { ok: false, status: 503, headers: { get: () => null }, text: async () => JSON.stringify({ message: "boom" }), json: async () => ({ message: "boom" }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "[]", json: async () => [] };
    };
    try {
      const sched = mkScheduler(teamState);
      await sched.reconcileWritebacks();
      let s1 = await readStore(storeFile);
      assert.ok(!s1.undeliveredPrAlarms?.[t1.id], "fetch failure must not stamp the gate");
      assert.ok(!(await activityTexts(storeFile)).some((t) => t.includes("undelivered-PR alarm")), "no alarm on a failed probe");
      broken = false;
      await sched.reconcileWritebacks();
      s1 = await readStore(storeFile);
      assert.ok(s1.undeliveredPrAlarms?.[t1.id], "the retried probe alarms on definitive emptiness");
    } finally {
      globalThis.fetch = realFetch;
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // G: save -> load round-trip for the new tables (#5736 discipline).
  await section("2G prDeliveries + undeliveredPrAlarms survive a 20s-reload round-trip", async () => {
    const { stateDir } = await mkScenario("g");
    const s = await storeMod.loadTeamAutoStore();
    s.prDeliveries = { "teamauto-rt-0000000001": "https://github.com/topcheer/ggcode/pull/9" };
    s.undeliveredPrAlarms = { "teamauto-rt-0000000002": 1730000001000 };
    await storeMod.saveTeamAutoStore(s);
    const reloaded = await storeMod.loadTeamAutoStore();
    assert.equal(reloaded.prDeliveries?.["teamauto-rt-0000000001"], "https://github.com/topcheer/ggcode/pull/9", "prDeliveries must survive the settle reload");
    assert.equal(reloaded.undeliveredPrAlarms?.["teamauto-rt-0000000002"], 1730000001000, "undeliveredPrAlarms must survive the settle reload");
    await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  if (failures.length) {
    throw new Error(`${failures.length} scenario(s) failed: ${failures.map((f) => f.name).join("; ")}`);
  }
  console.log("test-teamauto-5785: ok");
}

main().catch((err) => {
  console.error("test-teamauto-5785 failed:", err);
  process.exit(1);
});
