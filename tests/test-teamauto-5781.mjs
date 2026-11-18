#!/usr/bin/env node
// Regression anchors for ggcode #5781 (teamclaw channel-aware evidence).
//
// Third false-orphan family, orthogonal to #5777 (timing: slow worker
// direct-send) and #5780 (predicate: narrative delivery bodies): CHANNEL.
// A prReview task's deliverable is a PR review (plus PR conversation
// comments) - getIssueCommentBodies structurally cannot see either surface.
// Live: d7152fe0 shipped two COMMENTED reviews on PR #5778 (21:20, dup 0),
// the issue-surface evidence check matched zero, and the audit false-alarmed
// at grace expiry 11min05s after completion (gate stamped, ledger empty).
// Fix 5922bd0 routes verification by target type:
//   - title carries "PR #N"    -> getPullFeedbackBodies (PR review bodies +
//     PR conversation comments - both halves of the delivery surface)
//   - title carries "issue #N" -> getIssueCommentBodies (unchanged)
//
// Part 1 pins the routing as source contracts (runs without a build).
// Part 2 drives the built dist through reconcileWritebacks with a stubbed
// GitHub fetch:
//   a. prReview task, evidence ONLY in review bodies -> ledger back-fill,
//      no alarm, reviews URL consulted
//   b. prReview task, evidence ONLY in PR conversation comments -> back-fill
//      (feedback surface covers both halves)
//   c. issue task, evidence as an issue comment -> back-fill AND no /pulls/
//      URL is ever requested (routing direction pin)
//   d. prReview task with a bare PR (no evidence on either surface) ->
//      still alarms (channel-awareness must not silence genuine orphans)
// Pre-fix discrimination (5922bd0^ = 5c3adda): a "PR #N" title yields no
// `issue #N` match, so the old code consulted NO GitHub surface at all for
// prReview tasks and scenario (a) alarmed instead of back-filling.

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const schedulerSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "scheduler.ts"), "utf8");
  const clientSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "github-client.ts"), "utf8");

  // --- Part 1: source contracts (no build required) ---

  assert.ok(
    schedulerSrc.includes('const prNumMatch = /(?:PR|pull request) #(\\d+)/i.exec(`${task.title}`);'),
    "#5781: prReview routing anchor - PR number regex on the task title",
  );
  assert.ok(
    schedulerSrc.includes("const numMatch = prNumMatch ?? /issue #(\\d+)/.exec(`${task.title}`);"),
    "#5781: PR match takes precedence; issue fallback stays for issue-shaped tasks",
  );
  assert.ok(
    schedulerSrc.includes("? await ghClient.getPullFeedbackBodies(o, n, targetNum).catch(() => [] as string[])"),
    "#5781: PR-routed tasks verify via getPullFeedbackBodies (reviews + PR conversation comments)",
  );
  assert.ok(
    schedulerSrc.includes(": await ghClient.getIssueCommentBodies(o, n, targetNum).catch(() => [] as string[])"),
    "#5781: issue-routed tasks keep the issue-comment surface",
  );
  assert.ok(
    schedulerSrc.includes('const ghEvidence = bodies.some((b) => /\\[teamclaw[:\\]]/i.test(b) || /teamclaw|teamauto/i.test(b) || /teamclaw\\/task-/.test(b));'),
    "#5780: the three-way evidence predicate stays broad - the channel fix must not narrow it",
  );
  assert.ok(
    schedulerSrc.includes('direct-send delivery verified on ${prNumMatch ? "PR" : "issue"} #'),
    "#5781 residual: the back-fill activity line names the channel that was actually verified",
  );

  // getPullFeedbackBodies must keep covering BOTH halves of the PR delivery
  // surface: review bodies AND PR conversation comments.
  const fpStart = clientSrc.indexOf("async getPullFeedbackBodies(");
  assert.ok(fpStart >= 0, "getPullFeedbackBodies must exist in github-client.ts");
  const fpNext = clientSrc.indexOf("async ", fpStart + 10);
  const fpBody = clientSrc.slice(fpStart, fpNext > fpStart ? fpNext : undefined);
  assert.ok(
    fpBody.includes("/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=30"),
    "#5781: the feedback surface includes PR review bodies",
  );
  assert.ok(
    fpBody.includes("/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=30"),
    "#5781: the feedback surface includes PR conversation comments (issues/N/comments for the PR number)",
  );

  // --- Part 2: behavioral scenarios through the built dist ---

  const distDir = path.join(projectRoot, "src", "dist", "src", "teamauto");
  if (!fs.existsSync(path.join(distDir, "scheduler.js"))) {
    console.log("test-teamauto-5781: ok (source contracts; dist not built - skipping behavioral)");
    return;
  }
  const schedulerMod = await import(pathToFileURL(path.join(distDir, "scheduler.js")).href);
  const storeMod = await import(pathToFileURL(path.join(distDir, "store.js")).href);
  assert.equal(typeof schedulerMod.createTeamAutoScheduler, "function", "createTeamAutoScheduler must stay exported");

  const realFetch = globalThis.fetch;
  const requestedPaths = [];
  let reviewsPayload = [];
  let prConversationPayload = [];
  let issueCommentsPayload = [];
  const jsonResponse = (payload) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (!target.startsWith("https://api.github.com/")) {
      return realFetch(url, init);
    }
    const p = target.slice("https://api.github.com".length);
    requestedPaths.push(p);
    if (p.startsWith("/repos/topcheer/ggcode/pulls/5778/reviews")) return jsonResponse(reviewsPayload);
    if (p.startsWith("/repos/topcheer/ggcode/issues/5778/comments")) return jsonResponse(prConversationPayload);
    if (p.startsWith("/repos/topcheer/ggcode/issues/5781/comments")) return jsonResponse(issueCommentsPayload);
    return jsonResponse([]);
  };

  let currentState = null;
  const deps = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    auth: { getAuthHeaders: async () => ({}) },
    getTeamState: () => currentState,
    updateTeamState: (updater) => { updater(currentState); return currentState; },
    onTasksCreated: async () => {},
  };
  // Construct under a scratch state dir so factory-time path resolution never
  // touches the real ~/.openclaw store, whatever it resolves eagerly.
  const setupDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tc5781-setup-"));
  process.env.OPENCLAW_STATE_DIR = setupDir;
  const scheduler = schedulerMod.createTeamAutoScheduler(deps);

  const GRACE_MIN = 11; // past the 10-min direct-send grace (#5777), inside the 6h window (#5772)
  const makePrReviewTask = (id) => ({
    id,
    title: "[prReview] Review PR #5778: fix(#5775,#5776): rune-safe truncation and excerpt windows for CJK-mixed strings",
    description: "TeamAuto autonomous work for topcheer/ggcode.\nIdempotency-Key: topcheer/ggcode#pr-5778:prReview",
    status: "completed",
    result: "QA review of PR #5778 delivered as a GitHub review.",
    createdAt: Date.now() - 40 * 60_000,
    updatedAt: Date.now() - GRACE_MIN * 60_000,
    completedAt: Date.now() - GRACE_MIN * 60_000,
  });
  const makeIssueTask = (id) => ({
    id,
    title: "[takeOwnership] Take ownership of issue #5781: channel-aware evidence verification",
    description: "TeamAuto autonomous work for topcheer/ggcode.\nIdempotency-Key: topcheer/ggcode#issue-5781:takeOwnership",
    status: "completed",
    result: "Owner verification delivered as an issue comment.",
    createdAt: Date.now() - 40 * 60_000,
    updatedAt: Date.now() - GRACE_MIN * 60_000,
    completedAt: Date.now() - GRACE_MIN * 60_000,
  });

  async function runScenario({ tasks, reviews = [], prConversation = [], issueComments = [] }) {
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tc5781-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const s = await storeMod.loadTeamAutoStore();
    s.deliveredResultsInit = true; // block the #5738 one-time pardon migration - scenarios must reach judgement
    await storeMod.saveTeamAutoStore(s);
    requestedPaths.length = 0;
    reviewsPayload = reviews;
    prConversationPayload = prConversation;
    issueCommentsPayload = issueComments;
    currentState = {
      profileId: "software-rd",
      teamName: "t5781",
      workers: {},
      tasks,
      controllerRuns: {},
      projects: {},
      messages: [],
      clarifications: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await scheduler.reconcileWritebacks();
    const after = await storeMod.loadTeamAutoStore();
    const result = {
      requestedPaths: [...requestedPaths],
      delivered: after.deliveredResults ?? {},
      alarms: after.orphanResultAlarms ?? {},
      activity: (after.activity ?? []).map((a) => a.text),
    };
    await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    return result;
  }

  // ── Scenario a: review-body evidence on the PR surface back-fills, no alarm ──
  {
    const a = await runScenario({
      tasks: { t: makePrReviewTask("teamauto-5781-a") },
      reviews: [{ body: "QA review of PR #5778: REQUEST CHANGES - excerpt cut still byte-slices; delivered via TeamClaw autonomous" }],
    });
    assert.ok(
      a.requestedPaths.some((p) => p.startsWith("/repos/topcheer/ggcode/pulls/5778/reviews")),
      "a: the PR reviews surface must be consulted for a PR-number task",
    );
    assert.ok(a.delivered["teamauto-5781-a"] !== undefined, "a: review-body evidence back-fills the ledger (#5781 core fix)");
    assert.equal(Object.keys(a.alarms).length, 0, "a: no false orphan for a prReview task delivered on the review surface");
    assert.ok(
      a.activity.some((t) => t.includes("ledger back-filled from GitHub evidence")),
      "a: the back-fill is visible in the activity feed",
    );
    assert.ok(
      a.activity.some((t) => t.includes("verified on PR #5778")),
      "a/#5781 residual: the back-fill line names the PR channel that was verified",
    );
  }

  // ── Scenario b: PR conversation comments are the same delivery surface ──
  {
    const b = await runScenario({
      tasks: { t: makePrReviewTask("teamauto-5781-b") },
      reviews: [],
      prConversation: [{ body: "[teamclaw:qa] autonomous via TeamClaw" }],
    });
    assert.ok(b.delivered["teamauto-5781-b"] !== undefined, "b: PR-conversation-comment evidence also back-fills (getPullFeedbackBodies covers both halves)");
    assert.equal(Object.keys(b.alarms).length, 0, "b: no false orphan");
  }

  // ── Scenario c: issue-routed tasks keep the issue surface (direction pin) ──
  {
    const c = await runScenario({
      tasks: { t: makeIssueTask("teamauto-5781-c") },
      issueComments: [{ body: "Owner verification: fixed by teamclaw@5922bd0; branch teamclaw/task-x rebased on main." }],
    });
    assert.ok(
      c.requestedPaths.some((p) => p.startsWith("/repos/topcheer/ggcode/issues/5781/comments")),
      "c: the issue-comment surface is consulted for an issue-number task",
    );
    assert.ok(
      !c.requestedPaths.some((p) => p.includes("/pulls/")),
      "c: issue-routed tasks must not consult the PR surface (routing direction)",
    );
    assert.ok(c.delivered["teamauto-5781-c"] !== undefined, "c: issue-comment evidence back-fills");
    assert.equal(Object.keys(c.alarms).length, 0, "c: no false orphan");
  }

  // ── Scenario d: a genuinely bare PR still alarms ──
  {
    const d = await runScenario({
      tasks: { t: makePrReviewTask("teamauto-5781-d") },
      reviews: [],
      prConversation: [],
    });
    assert.ok(d.alarms["teamauto-5781-d"] !== undefined, "d: channel-awareness must not silence genuine orphans");
    assert.ok(d.delivered["teamauto-5781-d"] === undefined, "d: no ledger stamp without evidence");
    assert.ok(
      d.activity.some((t) => t.includes("orphan result alarm")),
      "d: the alarm stays visible in the activity feed",
    );
  }

  await fsp.rm(setupDir, { recursive: true, force: true }).catch(() => {});
  globalThis.fetch = realFetch;
  console.log("test-teamauto-5781: all assertions passed (channel-aware evidence: PR surface routing, both feedback halves, issue direction, bare-PR alarm)");
}

main().catch((err) => {
  console.error("test-teamauto-5781 FAILED:", err);
  process.exit(1);
});
