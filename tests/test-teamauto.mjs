#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const schedulerSrc = path.join(projectRoot, "src", "src", "teamauto", "scheduler.ts");
const scannerSrc = path.join(projectRoot, "src", "src", "teamauto", "scanner.ts");
const storeSrc = path.join(projectRoot, "src", "src", "teamauto", "store.ts");
const clientSrc = path.join(projectRoot, "src", "src", "teamauto", "github-client.ts");
const syncSrc = path.join(projectRoot, "src", "src", "teamauto", "repo-sync.ts");
const normsSrc = path.join(projectRoot, "src", "src", "teamauto", "norms.ts");
const httpServerSrc = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const serviceSrc = path.join(projectRoot, "src", "src", "controller", "controller-service.ts");
const pagePath = path.join(projectRoot, "src", "src", "ui", "teamauto.html");
const uiHtmlPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const uiAppSrcPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const desktopHtmlPath = path.join(projectRoot, "desktop", "renderer", "index.html");
const desktopAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");

async function sourceContracts() {
  const [scheduler, scanner, store, client, sync, norms, httpServer, service, page, uiHtml, desktopHtml, desktopApp, uiAppSrc] = await Promise.all([
    fs.readFile(schedulerSrc, "utf8"),
    fs.readFile(scannerSrc, "utf8"),
    fs.readFile(storeSrc, "utf8"),
    fs.readFile(clientSrc, "utf8"),
    fs.readFile(syncSrc, "utf8"),
    fs.readFile(normsSrc, "utf8"),
    fs.readFile(httpServerSrc, "utf8"),
    fs.readFile(serviceSrc, "utf8"),
    fs.readFile(pagePath, "utf8").catch(() => null),
    fs.readFile(uiHtmlPath, "utf8"),
    fs.readFile(desktopHtmlPath, "utf8"),
    fs.readFile(desktopAppPath, "utf8"),
    fs.readFile(uiAppSrcPath, "utf8"),
  ]);

  // Wiring: scheduler lifecycle is mounted in the controller service.
  assert.match(service, /createTeamAutoScheduler\(/, "controller service must create the TeamAuto scheduler");
  assert.match(service, /getTeamAutoScheduler: \(\) => teamAutoSchedulerRef/, "HTTP deps must expose the scheduler");
  assert.match(service, /await teamAutoSchedulerRef\?\.stop\(\)/, "scheduler must stop with the service");

  // API surface.
  for (const route of ["/api/v1/teamauto/repos", "/api/v1/teamauto/repo-candidates"]) {
    assert.ok(httpServer.includes(`pathname === "${route}"`), `controller must route ${route}`);
  }
  assert.ok(httpServer.includes('"/api/v1/teamauto/repos/"'), "controller must route per-repo teamauto actions");
  assert.ok(!httpServer.includes('"/ui/teamauto"'), "the standalone teamauto page route must be gone (tabbed UI)");

  // Autonomous identity markers on every write-back.
  assert.match(scheduler, /\[teamclaw:\$\{role\}\]/, "write-backs must carry the [teamclaw:role] marker");

  // Git auth: token-in-URL basic auth (survives GitHub redirects), never on disk.
  assert.match(sync, /x-access-token:/, "git operations must authenticate via x-access-token basic auth");
  assert.doesNotMatch(sync, /["']http\.[^"']*extraheader/, "do not use extraheader injection (fails on redirect)");

  // Guardrails.
  assert.match(scanner, /skipAssignedToHumans/, "assigned-to-humans issues must be skippable");
  assert.match(scanner, /teamclaw\//, "own PRs (teamclaw branches) must be skipped in review");
  assert.match(store, /maxTasksPerDay/, "daily task budget must exist");
  assert.match(store, /firstSweepDryRun/, "first sweep must default to dry-run");
  assert.match(scheduler, /dry-run/, "dry-run path must be implemented");

  assert.match(store, /resolveTeamClawProjectsDir/, "teamauto clones must live under the workspace projects tree");
  assert.match(store, /legacyReposRoot/, "legacy clone location must be exposed for migration");
  assert.match(sync, /teamAutoProjectDir/, "repo-sync must expose the projectDir slug");
  assert.match(scheduler, /projectDir: teamAutoProjectDir/, "tasks must carry projectDir pointing at the repo checkout");
  assert.match(scheduler, /Idempotency-Key: \$\{candidate\.key\}/, "tasks must embed the dedup marker in their description");
  assert.match(scheduler, /description\.includes\(dedupMarker\)/, "in-flight dedup must match the description marker (title matching never worked)");
  assert.doesNotMatch(scheduler, /title\.includes\(candidate\.key\)/, "the broken title-based dedup must be gone");

  // Norms learning renders into worker prompts.
  assert.match(norms, /CONTRIBUTING/, "norms must read CONTRIBUTING.md");
  assert.match(scheduler, /renderNormsBlock/, "task descriptions must embed the repo norms block");

  // Bind must return fast: provisioning (clone + norms) runs in background.
  assert.match(scheduler, /provision\?: TeamAutoRepoProvision|provision\?/u, "repo type must carry provision state");
  assert.match(scheduler, /void provisionRepoInBackground\(normalized/, "addRepo must not await provisioning (bind returns immediately)");
  assert.match(scheduler, /status: "provisioning", message: "cloning repo"/, "bind starts with the cloning stage");
  assert.match(scheduler, /status: "ready", message: "ready", norms/, "provisioning completion persists learned norms");
  assert.match(scheduler, /status: "failed", message/, "provisioning failures must be recorded for UI display");
  assert.match(scheduler, /still provisioning/, "sweeps must be gated while provisioning");

  // Deadlock fix: no first-sweep candidate gate; dry-run flips unconditionally.
  assert.doesNotMatch(scanner, /const firstSweep|if \(firstSweep\)/, "the first-sweep candidate gate must be gone (it deadlocked dry-run repos with zero candidates)");
  assert.match(scheduler, /if \(dryRun\) \{[\s\S]{0,400}?repo\.dryRunDone = true;/u, "a completed dry-run sweep must flip dryRunDone even with zero candidates");
  assert.doesNotMatch(scheduler, /repo\.dryRunDone = true;\s*\n\s*repo\.lastSweepSummary = `dry-run/u, "dryRunDone must not depend on candidates existing");

  // Activity persistence: bounded log recorded at bind/provision/sweep/task/writeback.
  assert.match(store, /pushTeamAutoActivity/, "store must export the activity recorder");
  assert.match(store, /TEAMAUTO_ACTIVITY_LIMIT = 100/, "activity log must be bounded");
  assert.match(scheduler, /kind: "sweep"/, "sweeps must be recorded");
  assert.match(scheduler, /kind: "writeback"/, "write-backs must be recorded");
  assert.match(scheduler, /kind: "bind"/, "binds must be recorded");
  assert.match(scanner, /JOINT_REVIEW_ROLES/, "joint review roles must be an explicit shared constant");
  assert.match(scheduler, /cycleKey/, "write-backs must carry the joint review cycle key");
  assert.match(scheduler, /Joint full review/, "same-cycle sections must converge into one umbrella issue");
  assert.match(httpServer, /\/api\/v1\/teamauto\/activity/, "controller must expose the activity endpoint");
  assert.match(uiAppSrc, /teamauto-activity/, "web UI must render the activity feed");
  assert.match(desktopApp, /ta-activity/, "desktop must render the activity feed");
  assert.match(scheduler, /provisioning failed \(\$\{repo\.provision\.message\}\)/, "sweeps must report failed provisioning instead of running");

  // Bind overlay: staged progress in both desktop and web UI.
  assert.match(desktopHtml, /ta-bind-overlay/, "desktop must render the bind stage overlay");
  assert.match(uiHtml, /teamauto-bind-overlay/, "web UI must render the bind stage overlay");
  for (const src of [desktopApp, uiAppSrc]) {
    const isDesktop = src === desktopApp;
    assert.match(src, isDesktop ? /taRunBindWithOverlay/ : /teamAutoBindWithOverlay/, "bind click must drive the stage overlay");
    assert.match(src, /bindStageVerify/, "stage labels must be localized");
    assert.match(src, /provision\.status === "failed"/, "overlay must surface provision failures");
    assert.match(src, /provision\.status === "ready"/, "overlay must close on ready");
  }

  // Tabbed UI on both surfaces: repo picker, bound-repo list, closed-loop config.
  assert.match(uiHtml, /data-tab="teamauto"/, "web UI must have a TeamAuto tab");
  assert.match(uiHtml, /id="tab-teamauto"/, "web UI must render the TeamAuto panel");
  assert.match(uiHtml, /id="teamauto-repo-select"/, "web UI must offer a repo picker");
  assert.match(desktopHtml, /data-view="teamauto"/, "desktop must have a TeamAuto nav view");
  assert.match(desktopHtml, /id="view-teamauto"/, "desktop must render the TeamAuto view");
  assert.match(desktopHtml, /id="ta-repo-select"/, "desktop must offer a repo picker");
  for (const surface of [uiHtml, desktopHtml]) {
    void surface;
  }
  assert.match(uiAppSrc, /teamauto\/repo-candidates/, "web UI must load selectable repo candidates");
  assert.match(desktopApp, /teamauto\/repo-candidates/, "desktop must load selectable repo candidates");
  assert.match(desktopApp, /apiPatch\(`\/teamauto\/repos\/\$\{encoded\}`/, "desktop must support closed-loop config saves");
}

async function unitTests() {
  const storeMod = await import(path.join(projectRoot, "src", "dist", "src", "teamauto", "store.js")).catch(() => null);
  const scannerMod = await import(path.join(projectRoot, "src", "dist", "src", "teamauto", "scanner.js")).catch(() => null);
  assert.ok(storeMod && scannerMod, "teamauto modules must be built (run npm --prefix src run build first)");

  // nextFireMs cadence parsing.
  const schedMod = await import(path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js"));
  assert.equal(schedMod.nextFireMs("*/30 * * * *"), 30 * 60_000);
  assert.equal(schedMod.nextFireMs("@hourly"), 3600_000);
  assert.equal(schedMod.nextFireMs("@daily"), 24 * 3600_000);
  assert.equal(schedMod.nextFireMs("weird"), 30 * 60_000);

  // Daily budget with rollover.
  const store = storeMod.defaultPolicy ? { budget: { maxTasksPerDay: 2, tasksToday: 0, dayStamp: "2000-01-01", firstSweepDryRun: true } } : null;
  assert.ok(store, "store module shape");
  assert.equal(storeMod.consumeDailyBudget(store, 2), true);
  assert.equal(storeMod.consumeDailyBudget(store, 1), false, "budget must cap tasks per day");
  store.budget.dayStamp = "2001-01-01";
  assert.equal(storeMod.consumeDailyBudget(store, 1), true, "budget resets on date rollover");

  // Scanner with a stub client.
  const repo = {
    id: "acme/widget",
    enabled: true,
    schedule: "*/30 * * * *",
    policy: storeMod.defaultPolicy(),
    cursors: storeMod.defaultCursors(),
    dryRunDone: true,
  };
  const issues = [
    { number: 1, title: "Bug: crash on start", body: "steps...", state: "open", assignees: [], labels: [], updatedAt: "2026-11-01T10:00:00Z", user: "alice", htmlUrl: "u" },
    { number: 2, title: "Assigned to human", body: "", state: "open", assignees: ["bob"], labels: [], updatedAt: "2026-11-01T10:00:00Z", user: "alice", htmlUrl: "u" },
    { number: 3, title: "[teamclaw:pm] our own thread", body: "", state: "open", assignees: [], labels: [], updatedAt: "2026-11-01T10:00:00Z", user: "alice", htmlUrl: "u" },
    { number: 4, title: "Excluded label", body: "", state: "open", assignees: [], labels: ["wontfix"], updatedAt: "2026-11-01T10:00:00Z", user: "alice", htmlUrl: "u" },
  ];
  const pulls = [
    { number: 9, title: "Feature by human", body: "", state: "open", draft: false, updated_at: "2026-11-01T10:00:00Z", user: "carol", head: "feature/x", htmlUrl: "u" },
    { number: 10, title: "Our own PR", body: "", state: "open", draft: false, updated_at: "2026-11-01T10:00:00Z", user: "alice", head: "teamclaw/issue-1", htmlUrl: "u" },
  ];
  const stubClient = {
    listIssues: async () => issues,
    listPulls: async () => pulls,
    listCommits: async () => [],
  };

  // First sweep now surfaces backlog candidates directly (the old observe-only
  // gate deadlocked dry-run repos with zero candidates). Filtering still applies:
  // issue 2 (assigned), 3 (own thread), 4 (label) drop; PR 10 (ours) drops.
  const first = await scannerMod.sweepRepo(repo, stubClient);
  assert.equal(first.candidates.length, 6, "first sweep surfaces the filtered backlog (issue #1 review+ownership, PR #9 review, plus 3 joint fullReview sections)");
  const firstKinds = first.candidates.map((c) => c.kind).sort().join(",");
  assert.match(firstKinds, /issueReview/);
  assert.match(firstKinds, /takeOwnership/);
  assert.match(firstKinds, /prReview/);
  const jointRoles = first.candidates.filter((c) => c.kind === "fullReview").map((c) => c.role).sort().join(",");
  assert.equal(jointRoles, "architect,qa,security-engineer", "full review fans out one section per joint role");
  const cycles = new Set(first.candidates.filter((c) => c.kind === "fullReview").map((c) => c.cycle));
  assert.equal(cycles.size, 1, "all joint sections share one cycle id");
  scannerMod.advanceCursors(repo, first.issues, first.pulls);
  // After advancing cursors the same backlog must not re-surface.
  const drained = await scannerMod.sweepRepo(repo, stubClient);
  assert.equal(drained.candidates.filter((c) => c.kind !== "fullReview").length, 0, "advanced cursors suppress re-processing");

  // Between sweeps: only touched objects should act. Re-stamp issue 1 and PR 9.
  const bumpedIssues = issues.map((i) => (i.number === 1 ? { ...i, updatedAt: "2026-11-01T11:00:00Z" } : i));
  const bumpedPulls = pulls.map((p) => (p.number === 9 ? { ...p, updated_at: "2026-11-01T11:00:00Z" } : p));
  stubClient.listIssues = async () => bumpedIssues;
  stubClient.listPulls = async () => bumpedPulls;
  // Second sweep produces filtered candidates (suppress the weekly fullReview).
  repo.cursors.lastFullReviewAt = Date.now();
  const second = await scannerMod.sweepRepo(repo, stubClient);
  const kinds = second.candidates.map((c) => `${c.kind}#${c.number}`).sort();
  assert.deepEqual(kinds, ["issueReview#1", "prReview#9", "takeOwnership#1"], `unexpected candidates: ${kinds.join(",")}`);

  // Idempotency: advancing cursors again suppresses the same objects.
  scannerMod.advanceCursors(repo, second.issues, second.pulls);
  const third = await scannerMod.sweepRepo(repo, stubClient);
  assert.equal(third.candidates.filter((c) => c.kind !== "fullReview").length, 0, "unchanged objects must not re-enqueue");
}

(async () => {
  await sourceContracts();
  await unitTests();
  console.log("test-teamauto: ok");
})().catch((err) => {
  console.error("test-teamauto failed:", err);
  process.exit(1);
});
