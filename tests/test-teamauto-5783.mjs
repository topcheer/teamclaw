#!/usr/bin/env node
// Issue #5783 (ggcode, 2026-11-18): the prComment write-back leg posted BARE
// worker results - no MARKER_FOOTER - so the delivered review carried zero
// teamclaw identification (live: PR #5778, two COMMENTED reviews, both body_mk
// false). After #5781 routed the evidence check to the PR review surface, the
// predicate still matched nothing on prReview legs and the orphan audit kept
// false-alarming: the channel fix was hollowed out by the write-side gap.
// The base fix (db7848f) appended the footer, but the shared body construction
// at the top of the delivery ladder ALREADY appends MARKER_FOOTER for every
// channel, so the extra append shipped the marker TWICE; and
// getPullFeedbackBodies returns whitespace-COLLAPSED bodies, so db7848f's
// "\n---\n[teamclaw:" strip could never match the existing side and a footered
// worker direct-post still double-delivered.
//
// Contracts pinned here (write side, #5783):
// 1. A fresh prComment delivery posts a review body carrying EXACTLY ONE
//    marker footer (pre-fix 5922bd0 ships ZERO, db7848f ships TWO).
// 2. A footer the worker echoed into its own result is stripped before
//    posting - the posted body still carries exactly one footer.
// 3. A worker direct-post already on the PR (collapsed, BARE) dedupes the
//    ladder delivery - no second post.
// 4. A worker direct-post already on the PR in FOOTERED (collapsed) shape
//    also dedupes - the comparison is footer-agnostic AFTER collapsing
//    (the db7848f killer: "\n---\n[teamclaw:" never matches " --- [teamclaw:").
// 5. Read side closes the loop: the orphan audit's GitHub-evidence predicate
//    MATCHES a footered review body (ledger back-fill, no alarm) and still
//    MISSES a bare one (alarm) - the write-side footer is what makes the
//    #5777-#5781 evidence chain see its own prReview deliveries.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// Contained state dir so the scheduler never touches a real teamclaw store.
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5783-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const mkTask = (id, title, result, extra = {}) => ({
  id,
  title,
  description: "TeamAuto autonomous work for acme/widget.\n\nIdempotency-Key: acme/widget#x",
  status: "completed",
  result,
  writeMode: "read-only",
  assignedRole: "qa",
  ...extra,
});

// Mutable team state - the scheduler re-reads it every pass, so swapping the
// task set between passes is exactly the production shape.
const teamState = { tasks: {} };

const baseStore = (writebacks) => ({
  version: 1,
  repos: [{ id: "acme/widget", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true, policy: { maxTasksPerDay: 5, actions: { issueReview: true, takeOwnership: true, prReview: true, createPR: true, fullReview: "weekly" }, skipAssignedToHumans: true, labelFilter: { include: [], exclude: [] }, keywordFilter: { include: [], exclude: [] } }, cursors: { lastIssueSince: 0, lastPrSince: 0, lastCommitSha: "", lastFullReviewAt: 0, seen: {}, etags: {} }, norms: null }],
  writebacks,
  activity: [],
  deliveredResultsInit: true,
  deliveredResults: {},
  budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-18" },
});

const scheduler = schedMod.createTeamAutoScheduler({
  logger: noopLogger,
  auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
  getTeamState: () => teamState,
  updateTeamState: (fn) => { fn(teamState); return teamState; },
  onTasksCreated: async () => {},
});

const readStore = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));
const writeStore = async (writebacks) => {
  await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
  await fs.promises.writeFile(storeFile, JSON.stringify(baseStore(writebacks)), "utf8");
};

// ── fetch stub ─────────────────────────────────────────────────────────────
// GOTCHA (#5781 harness): the client appends ?per_page=30 to listing GETs -
// route by substring, never by exact URL equality.
const realFetch = globalThis.fetch;
const posted = []; // captured POST /pulls/:n/reviews -> { pr, event, body }
const feedback = { // pr -> RAW review bodies the listing returns (the client
  // whitespace-collapses them, which is the shape that defeated db7848f)
  100: ["worker posted this review directly during its window (bare, no marker)"],
  101: ["done: shipped\n---\n[teamclaw:qa] autonomous via TeamClaw"],
  200: ["shipped the fix\n---\n[teamclaw:developer] autonomous via TeamClaw"],
  201: ["manual human review: looks fine to me"],
};
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const method = String(init?.method ?? "GET").toUpperCase();
  const prReviews = /\/repos\/acme\/widget\/pulls\/(\d+)\/reviews/.exec(target);
  if (prReviews) {
    const pr = Number(prReviews[1]);
    if (method !== "GET") {
      let payload = {};
      try { payload = JSON.parse(String(init?.body ?? "{}")); } catch { }
      posted.push({ pr, event: payload.event, body: String(payload.body ?? "") });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 1 }), json: async () => ({ id: 1 }) };
    }
    const rows = (feedback[pr] ?? []).map((body, i) => ({ id: i, body }));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(rows), json: async () => rows };
  }
  const prComments = /\/repos\/acme\/widget\/issues\/(\d+)\/comments/.exec(target);
  if (prComments) {
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([]), json: async () => [] };
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({}), json: async () => ({}) };
};

const entry = (taskId, pr) => ({ taskId, action: "prComment", repoId: "acme/widget", targetId: pr, doneAt: null, prUrl: null, error: null });
const markerCount = (t) => t.split("[teamclaw:").length - 1;

try {
  // ── Contract 1: fresh prComment delivery carries EXACTLY ONE footer ──────
  teamState.tasks = {
    "teamauto-5783-post": mkTask("teamauto-5783-post", "[prReview] Review PR #77: marker footer", "review deliverable body\n\nsecond line of findings"),
  };
  await writeStore([entry("teamauto-5783-post", 77)]);
  await scheduler.reconcileWritebacks();
  {
    const mine = posted.filter((p) => p.pr === 77);
    assert.equal(mine.length, 1, "contract 1: the ladder posts the review exactly once");
    const body = mine[0].body;
    assert.match(body, /\[teamclaw:qa\] autonomous via TeamClaw$/, "contract 1: the posted review body ends with the marker footer (5922bd0 posted it bare)");
    assert.equal(markerCount(body), 1, "contract 1: EXACTLY ONE marker (db7848f shipped two)");
    assert.equal(mine[0].event, "COMMENT", "contract 1: posted as a COMMENT review");
    assert.ok(body.startsWith("review deliverable body"), "contract 1: the worker result text is intact");
    const store = await readStore();
    const e = store.writebacks.find((w) => w.taskId === "teamauto-5783-post");
    assert.ok(!e || e.doneAt, "contract 1: the entry is completed (done or pruned)");
  }

  // ── Contract 2: a footer echoed by the worker is stripped, not doubled ───
  teamState.tasks = {
    "teamauto-5783-echo": mkTask("teamauto-5783-echo", "[prReview] Review PR #77: echoed footer", "report body the worker ended with its own marker\n---\n[teamclaw:qa] autonomous via TeamClaw"),
  };
  await writeStore([entry("teamauto-5783-echo", 77)]);
  await scheduler.reconcileWritebacks();
  {
    const mine = posted.filter((p) => p.pr === 77);
    assert.equal(mine.length, 2, "contract 2: the echoed-footer leg also posts (listing still empty for PR 77)");
    const body = mine[1].body;
    assert.equal(markerCount(body), 1, "contract 2: the echoed footer is stripped - exactly one marker ships");
    assert.match(body, /report body the worker ended with its own marker/, "contract 2: the result text survives the strip");
  }

  // ── Contract 3: bare worker direct-post on the PR dedupes ────────────────
  teamState.tasks = {
    "teamauto-5783-bare": mkTask("teamauto-5783-bare", "[prReview] Review PR #100: bare direct-post", "worker posted this review directly during its window (bare, no marker)"),
  };
  await writeStore([entry("teamauto-5783-bare", 100)]);
  await scheduler.reconcileWritebacks();
  {
    assert.equal(posted.filter((p) => p.pr === 100).length, 0, "contract 3: a bare worker direct-post on the PR dedupes the ladder delivery");
    const store = await readStore();
    const e = store.writebacks.find((w) => w.taskId === "teamauto-5783-bare");
    assert.ok(!e || e.doneAt, "contract 3: the entry completes via the dedupe-skip path");
    assert.ok((store.activity ?? []).some((a) => String(a.text).includes("dedupe-skipped") && String(a.text).includes("#100")), "contract 3: the skip is recorded in the activity ring");
  }

  // ── Contract 4: FOOTERED (collapsed) worker direct-post also dedupes ─────
  teamState.tasks = {
    "teamauto-5783-foot": mkTask("teamauto-5783-foot", "[prReview] Review PR #101: footered direct-post", "done: shipped"),
  };
  await writeStore([entry("teamauto-5783-foot", 101)]);
  await scheduler.reconcileWritebacks();
  {
    assert.equal(posted.filter((p) => p.pr === 101).length, 0, "contract 4: a FOOTERED worker direct-post (collapsed by the listing) still dedupes - db7848f re-posted this shape");
    const store = await readStore();
    const e = store.writebacks.find((w) => w.taskId === "teamauto-5783-foot");
    assert.ok(!e || e.doneAt, "contract 4: the entry completes via the dedupe-skip path");
  }

  // ── Contract 5a: footered review evidence back-fills the ledger ──────────
  teamState.tasks = {
    "teamauto-5783-audit-pos": mkTask("teamauto-5783-audit-pos", "[prReview] Review PR #200: ledger back-fill", "positive audit body", { completedAt: Date.now() - 11 * 60_000 }),
  };
  await writeStore([]); // registration lost - no entry, no ledger stamp
  await scheduler.reconcileWritebacks();
  {
    const store = await readStore();
    assert.ok(store.deliveredResults?.["teamauto-5783-audit-pos"], "contract 5a: a footered review on the PR surface back-fills the ledger (predicate hit)");
    assert.equal(store.orphanResultAlarms?.["teamauto-5783-audit-pos"], undefined, "contract 5a: no orphan alarm for the footered delivery");
  }

  // ── Contract 5b: bare review evidence still alarms (why the footer matters)
  teamState.tasks = {
    "teamauto-5783-audit-neg": mkTask("teamauto-5783-audit-neg", "[prReview] Review PR #201: bare surface", "negative audit body", { completedAt: Date.now() - 11 * 60_000 }),
  };
  await writeStore([]);
  await scheduler.reconcileWritebacks();
  {
    const store = await readStore();
    assert.ok(store.orphanResultAlarms?.["teamauto-5783-audit-neg"], "contract 5b: a BARE review body still false-alarms - the write-side footer is what the predicate reads");
  }

  console.log("test-teamauto-5783: all contracts PASS");
} finally {
  globalThis.fetch = realFetch;
  await fs.promises.rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
