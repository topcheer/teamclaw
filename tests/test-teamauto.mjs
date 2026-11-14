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
// PR-D of issue #204: the declarative route table (and with it every route
// shell) moved from http-server.ts's if chain into controller/route-table.ts.
const routeTableSrc = path.join(projectRoot, "src", "src", "controller", "route-table.ts");
const teamAutoRoutesSrc = path.join(projectRoot, "src", "src", "controller", "teamauto-routes.ts");
const serviceSrc = path.join(projectRoot, "src", "src", "controller", "controller-service.ts");
const pagePath = path.join(projectRoot, "src", "src", "ui", "teamauto.html");
const uiHtmlPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const uiAppSrcPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const desktopHtmlPath = path.join(projectRoot, "desktop", "renderer", "index.html");
const desktopAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");
const desktopI18nPath = path.join(projectRoot, "desktop", "renderer", "i18n.js");

async function sourceContracts() {
  const [scheduler, scanner, store, client, sync, norms, httpServer, routeTable, teamAutoRoutes, taskAssignment, service, page, uiHtml, desktopHtml, desktopApp, desktopI18n, uiAppSrc] = await Promise.all([
    fs.readFile(schedulerSrc, "utf8"),
    fs.readFile(scannerSrc, "utf8"),
    fs.readFile(storeSrc, "utf8"),
    fs.readFile(clientSrc, "utf8"),
    fs.readFile(syncSrc, "utf8"),
    fs.readFile(normsSrc, "utf8"),
    fs.readFile(httpServerSrc, "utf8"),
    fs.readFile(routeTableSrc, "utf8"),
    fs.readFile(teamAutoRoutesSrc, "utf8"),
    // PR-C of issue #204: the auto-assign loop and the write-worktree
    // dispatch moved from http-server.ts into controller/task-assignment.ts.
    fs.readFile(path.join(projectRoot, "src", "src", "controller", "task-assignment.ts"), "utf8"),
    fs.readFile(serviceSrc, "utf8"),
    fs.readFile(pagePath, "utf8").catch(() => null),
    fs.readFile(uiHtmlPath, "utf8"),
    fs.readFile(desktopHtmlPath, "utf8"),
    fs.readFile(desktopAppPath, "utf8"),
    fs.readFile(desktopI18nPath, "utf8"),
    fs.readFile(uiAppSrcPath, "utf8"),
  ]);

  // Wiring: scheduler lifecycle is mounted in the controller service.
  assert.match(service, /createTeamAutoScheduler\(/, "controller service must create the TeamAuto scheduler");
  assert.match(service, /getTeamAutoScheduler: \(\) => teamAutoSchedulerRef/, "HTTP deps must expose the scheduler");
  assert.match(service, /await teamAutoSchedulerRef\?\.stop\(\)/, "scheduler must stop with the service");

  // API surface.
  // PR-D of issue #204: the shells moved into controller/route-table.ts's
  // declarative table - pin the new home with the same method+path content.
  for (const route of ["/api/v1/teamauto/repos", "/api/v1/teamauto/repo-candidates"]) {
    assert.ok(routeTable.includes(`path: "${route}"`), `controller must route ${route}`);
  }
  assert.ok(routeTable.includes('"/api/v1/teamauto/repos/"'), "controller must route per-repo teamauto actions");
  assert.ok(!httpServer.includes('"/ui/teamauto"') && !routeTable.includes('"/ui/teamauto"'), "the standalone teamauto page route must be gone (tabbed UI)");
  // PR-B of issue #204: the teamauto handler bodies moved from http-server.ts
  // into controller/teamauto-routes.ts - pin the new home so the extraction
  // cannot silently drop scheduler behavior.
  assert.match(teamAutoRoutes, /handleTeamAutoActivityRequest/, "activity handler lives in teamauto-routes.ts (extracted from http-server)");
  assert.match(teamAutoRoutes, /handleTeamAutoReposListRequest/, "repos list handler lives in teamauto-routes.ts");
  assert.match(teamAutoRoutes, /createGithubClient\(auth\)\.listUserRepos\(\)/, "repo-candidates still lists the logged-in account's repos");
  assert.match(teamAutoRoutes, /teamAuto\.addRepo\(repo, \{/, "repo bind still calls the scheduler");
  assert.match(teamAutoRoutes, /teamAuto\.runSweepNow\(repoId, true\)/, "sweep-now still calls the scheduler's manual sweep");

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
  assert.match(scheduler, /Idempotency-Key: \$\{candidate\.key\}:\$\{candidate\.kind\}/, "tasks must embed the kind-scoped dedup marker in their description");
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

  // #268: takeOwnership claims must be visible on the issue itself.
  assert.match(scheduler, /claimIssue\(repo, candidate\); \/\/ #268: visible claim at enqueue time/,
    "takeOwnership tasks fire claimIssue at enqueue (claim = placeholder declaration, not completion artifact)");
  assert.match(scheduler, /const fresh = await client\.getIssue\(owner, name, candidate\.number\);/,
    "claim re-checks fresh issue state (scan-time assignee snapshot is stale by enqueue)");
  assert.match(scheduler, /repo\.policy\.skipAssignedToHumans && fresh\.assignees\.length > 0/,
    "claim is skipped when the issue gained an assignee since scan (never claim over humans)");
  assert.match(scheduler, /freshRepo\.cursors\.seen\[candidate\.key\] = Date\.now\(\) \+ 60_000;/,
    "claim stamps seen with a +60s guard (our own write bumps updated_at; bare stamp re-candidates the claimed issue)");
  assert.match(scheduler, /await client\.postIssueComment\(owner, name, candidate\.number, `TeamClaw \(teamclaw\/developer/,
    "claim falls back to a visible marker comment when the assign surface fails");

  // #267-1: sweep failures carry a root-cause class (auth/ratelimited/network).
  assert.match(scheduler, /const failClass = classifySweepError\(err\);/,
    "failure path classifies the error before writing reason/activity");
  assert.match(scheduler, /repo\.pausedReason = `sweep failed\[\$\{failClass\}\]: /,
    "pausedReason carries the class while keeping the isAutoPause 'sweep failed:' prefix");

  // #267-2: bounded per-repo sweep ring on both outcomes.
  assert.match(scheduler, /pushSweepRecord\(repo, \{ at: Date\.now\(\), ok: true,/, "success sweeps are recorded per-repo");
  assert.match(scheduler, /pushSweepRecord\(repo, \{ at: Date\.now\(\), ok: false,/, "failure sweeps are recorded per-repo (with failClass)");
  assert.match(store, /repo\.sweeps = repo\.sweeps\.slice\(repo\.sweeps\.length - 20\);/,
    "sweep ring is capped at 20 (same slice pattern as the activity log)");

  // #267-3: etag counters + per-sweep delta attribution.
  assert.match(client, /etagStats\(\): \{ calls: number; hits: number \}/, "client exposes cumulative etag counters");
  assert.match(scheduler, /const etagBefore = client\.etagStats\(\);/, "runSweep snapshots etag counters for delta attribution");

  // #266: both sweep outcomes must stamp lastAttemptAt so success-scoped
  // fields (lastSweepAt/lastSweepSummary) never have to be read as attempt
  // evidence next to pausedReason.
  assert.match(scheduler, /repo\.sweepFailures = 0;\s*\n\s*repo\.lastAttemptAt = Date\.now\(\);/, "success path stamps lastAttemptAt");
  assert.match(scheduler, /repo\.lastSweepErrorAt = Date\.now\(\);\s*\n\s*repo\.lastAttemptAt = repo\.lastSweepErrorAt;/, "failure path stamps lastAttemptAt");

  // Activity persistence: bounded log recorded at bind/provision/sweep/task/writeback.
  assert.match(store, /pushTeamAutoActivity/, "store must export the activity recorder");
  assert.match(store, /Array\.isArray\(parsed\.activity\)/, "loadTeamAutoStore must carry persisted activity across restarts (the whitelist rebuild silently dropped it)");
  assert.match(store, /TEAMAUTO_ACTIVITY_LIMIT = 100/, "activity log must be bounded");
  assert.match(scheduler, /kind: "sweep"/, "sweeps must be recorded");
  assert.match(scheduler, /kind: "writeback"/, "write-backs must be recorded");
  assert.match(scheduler, /kind: "bind"/, "binds must be recorded");
  // Joint review roles: explicit shared resolver derived from the ACTIVE
  // profile (Phase 2.3 debt item 4 replaced the hardcoded role-id literal
  // list + software-only role union; software-rd keeps the architect/qa/
  // security-engineer trio, asserted in unitTests below).
  assert.match(scanner, /resolveJointReviewSections\(\)/, "joint review roles must derive from the active profile via the shared resolver");
  assert.match(scanner, /getActiveProfile\(\)/, "the scanner must read the joint-review role set from the active profile");

  // Collaboration contract: read/write classification, worktree+PR delivery, write serialization.
  assert.match(scanner, /writeMode: "write",/, "takeOwnership candidates must be classified as write tasks");
  assert.match(scanner, /writeMode: "read-only" as const/, "review candidates must be classified read-only");
  assert.match(scheduler, /READ-ONLY TASK \(collaboration contract\)/, "read-only tasks must carry the no-write mandate");
  assert.match(scheduler, /Base your review on the committed HEAD state/, "read-only mandate must anchor reviews on committed state");
  assert.match(scheduler, /WRITE TASK \(collaboration contract\)/, "write tasks must be told they run in a worktree");
  assert.match(scheduler, /ensureTaskWorktree/, "scheduler must expose worktree setup");
  assert.match(scheduler, /createPullRequest/, "write delivery must open a PR from the task branch");
  assert.match(scheduler, /Delivered as PR:/, "the task reply must link the delivery PR");
  assert.match(scheduler, /removeTaskWorktree/, "worktrees must be cleaned up after delivery");
  // Worktree GC (2026-11-07: 31 leaked __task- worktrees / 3GB observed):
  // terminal tasks and boot reconciliation must reclaim worktrees, but only
  // when the work is provably safe (pushed tip or no own commits).
  assert.match(scheduler, /safeRemoveTaskWorktree/, "terminal write tasks (failed / no result) must safety-clean their worktree");
  assert.match(scheduler, /gcTaskWorktrees/, "scheduler start must reconcile leftover task worktrees");
  assert.match(scheduler, /worktree GC removed/, "GC outcome must be logged + recorded as activity");
  assert.match(sync, /safeRemoveTaskWorktree/, "repo-sync must expose safety-checked removal");
  assert.match(sync, /local branch ahead of pushed tip/, "unpushed work must never be silently destroyed");
  assert.match(sync, /no own commits, branch never pushed/, "empty never-pushed worktrees must be reclaimed");
  assert.match(sync, /worktree", "prune"/, "cleanup must survive unregistered (stale) worktree dirs");
  assert.match(taskAssignment, /activeWriteRoots/, "auto-assign must serialize write tasks per repo checkout");
  assert.match(taskAssignment, /ensureWriteWorktree/, "dispatch must place write tasks in a task-scoped worktree");

  // Worktree GC follow-ups (#173): 4 MINORs from the #167 cross-review plus
  // the squash-merge retention re-leak. Behavioral coverage lives in
  // tests/test-worktree-gc-behavior.mjs; these anchors pin the contracts.
  assert.match(sync, /retained: dirty worktree \(uncommitted changes\)/, "the dirty guard must cover BOTH removal paths incl. tip-match (#173 item 1)");
  assert.match(sync, /in use by live process/, "an in-use pid sentinel must block removal (#173 item 2)");
  assert.match(sync, /teamclaw-task-lock\.json/, "the task lock must live in the git admin dir (never dirties the tree)");
  assert.match(sync, /writeTaskLock\(wtPath\)/, "ensureTaskWorktree must (re)write the sentinel on create AND resume");
  assert.match(scheduler, /worktree GC skipped \(team state unavailable\)/, "boot GC must early-return on null team state instead of treating everything as terminal (#173 item 3)");
  assert.match(scheduler, /retainedDetails/, "per-task retain reasons must reach the GC activity line, not just the log (#173 item 4)");
  assert.match(scheduler, /worktree removed \(\$\{r\.reason\}\)/, "terminal cleanup must log positive removals too (#173 item 4)");
  assert.match(scheduler, /squashDeliveryOracle/, "the scheduler must wire the squash-merge delivery oracle into all GC paths (#173 item 5)");
  assert.match(client, /prHeadDelivered/, "github client exposes the merged-PR-with-exact-head-tip oracle (#173 item 5)");
  assert.match(sync, /delivered via merged PR \(squash-merge, head tip matches\)/, "squash-merged + branch-deleted worktrees are reclaimable with positive proof (#173 item 5)");
  assert.match(sync, /TaskDeliveryOracle/, "repo-sync types the optional GC delivery oracle (fail-toward-keep when absent)");
  assert.match(sync, /for-each-ref/, "GC must also enumerate branch-only leaks (dir gone, stale branch survives)");
  assert.match(scheduler, /cycleKey/, "write-backs must carry the joint review cycle key");
  assert.match(scheduler, /Joint full review/, "same-cycle sections must converge into one umbrella issue");
  assert.ok(
    scheduler.includes("const capped = [...fullReviews, ...regular];"),
    "full reviews must bypass the per-sweep cap (busy repos starved them)",
  );
  assert.match(scheduler, /candidates\.filter\(\(c\) => c\.kind === "fullReview"\)/, "cap split must separate full reviews from regular candidates");
  assert.match(scheduler, /dropping dead write-back/, "reconcile must drop undeliverable write-backs (task missing / failed without result)");
  // PR-D of issue #204: the activity route shell lives in route-table.ts now.
  assert.match(routeTable, /\/api\/v1\/teamauto\/activity/, "controller must expose the activity endpoint");
  assert.match(uiAppSrc, /teamauto-activity/, "web UI must render the activity feed");
  assert.match(desktopApp, /ta-activity/, "desktop must render the activity feed");
  assert.match(scheduler, /provisioning failed \(\$\{repo\.provision\.message\}\)/, "sweeps must report failed provisioning instead of running");

  // Bind overlay: staged progress in both desktop and web UI.
  assert.match(desktopHtml, /ta-bind-overlay/, "desktop must render the bind stage overlay");
  assert.match(uiHtml, /teamauto-bind-overlay/, "web UI must render the bind stage overlay");
  for (const src of [desktopApp, uiAppSrc]) {
    const isDesktop = src === desktopApp;
    assert.match(src, isDesktop ? /taRunBindWithOverlay/ : /teamAutoBindWithOverlay/, "bind click must drive the stage overlay");
    if (isDesktop) {
      // Desktop localized stage labels via data-i18n + bilingual catalogs
      // (#146-155); the literal moved from app.js into i18n.js.
      assert.match(desktopHtml, /data-i18n="teamauto\.bindStageVerify"/, "stage labels must be localized (data-i18n)");
      assert.match(desktopI18n, /"teamauto\.bindStageVerify": "Verifying access"/, "stage label catalog must exist (en)");
      assert.match(desktopI18n, /"teamauto\.bindStageVerify": "验证访问权限"/, "stage label catalog must exist (zh)");
    } else {
      assert.match(src, /bindStageVerify/, "stage labels must be localized");
    }
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

  // Dead-letter helpers: task history doubles as the attempt log.
  const schedMod2 = await import(path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js"));
  assert.equal(typeof schedMod2.failedAttemptCount, "function", "failedAttemptCount must be exported");
  assert.equal(schedMod2.idempotencyMarker({ key: "r#issue-12", kind: "issueReview" }), "Idempotency-Key: r#issue-12:issueReview");
  assert.equal(schedMod2.TEAMAUTO_DEAD_LETTER_ATTEMPTS, 3, "dead-letter threshold is 3 failed attempts");
  const markerState = (n) => {
    const tasks = {};
    for (let i = 0; i < n; i++) tasks[`failed${i}`] = { description: "pre\nIdempotency-Key: r#issue-12:issueReview\npost", status: "failed" };
    tasks.active = { description: "Idempotency-Key: r#issue-12:issueReview", status: "in_progress" };
    tasks.completed = { description: "Idempotency-Key: r#issue-12:issueReview", status: "completed" };
    tasks.other = { description: "Idempotency-Key: r#issue-99:issueReview", status: "failed" };
    return { tasks };
  };
  assert.equal(schedMod2.failedAttemptCount(markerState(2), { key: "r#issue-12", kind: "issueReview" }), 2, "counts only failed attempts for the exact marker");
  assert.equal(schedMod2.failedAttemptCount(markerState(3), { key: "r#issue-12", kind: "issueReview" }), 3, "3 failures reaches the dead-letter threshold");
  // Transient failures get a wider allowance than hard failures.
  assert.equal(typeof schedMod2.hardAttemptCount, "function", "hardAttemptCount must be exported");
  assert.equal(schedMod2.TEAMAUTO_DEAD_LETTER_TRANSIENT_ATTEMPTS, 6, "transient allowance is 6 total attempts");
  const transientState = (n, hardN) => {
    const tasks = {};
    for (let i = 0; i < n; i++) tasks[`transient${i}`] = { description: "Idempotency-Key: r#issue-12:issueReview", status: "failed", error: "⚠️ The AI service needs a short break. Please try again in a few minutes." };
    for (let i = 0; i < hardN; i++) tasks[`hard${i}`] = { description: "Idempotency-Key: r#issue-12:issueReview", status: "failed", error: "resumed 3 times without completing" };
    return { tasks };
  };
  assert.equal(schedMod2.hardAttemptCount(transientState(4, 0), { key: "r#issue-12", kind: "issueReview" }), 0, "transient failures (rate limit) are not hard failures");
  assert.equal(schedMod2.hardAttemptCount(transientState(4, 2), { key: "r#issue-12", kind: "issueReview" }), 2, "hard failures count toward the tight cap");
  assert.ok(schedMod2.TRANSIENT_FAILURE_RE.test("Workspace filesystem changed while preparing state for /x; retry"), "workspace race is transient");
  assert.ok(schedMod2.TRANSIENT_FAILURE_RE.test("Gateway request entry is closed"), "gateway race is transient");
  assert.ok(!schedMod2.TRANSIENT_FAILURE_RE.test("resumed 3 times without completing"), "resume-cap exhaustion is a hard failure");
  // Repo auto-pause is a cooldown with exponential backoff, not a life sentence.
  assert.equal(typeof schedMod2.sweepBackoffMinutes, "function", "sweepBackoffMinutes must be exported");
  assert.equal(schedMod2.sweepBackoffMinutes(1), 30, "first failure retries after 30 minutes");
  assert.equal(schedMod2.sweepBackoffMinutes(2), 60, "second failure backs off to 60 minutes");
  assert.equal(schedMod2.sweepBackoffMinutes(3), 120, "third failure backs off to 120 minutes");
  assert.equal(schedMod2.sweepBackoffMinutes(9), 240, "backoff caps at 240 minutes");
  assert.equal(schedMod2.sweepRetryDueAt(1, 1_000_000, "ratelimited"), 1_000_000 + 30 * 60_000, "ratelimited retry due = last error + slow backoff");
  assert.equal(schedMod2.isAutoPause("sweep failed: fetch failed"), true, "sweep failures are auto-pauses");
  assert.equal(schedMod2.sweepRetryDueAt(2, 1_000_000, "ratelimited"), 1_000_000 + 60 * 60_000, "slow ladder table stays consistent");
  // Network-class failures (transient "fetch failed") get the fast ladder:
  // 1m, 2m, 4m... capped at 15m - a blip must not cost 30m of repo idle.
  assert.equal(typeof schedMod2.sweepNetworkBackoffMinutes, "function", "sweepNetworkBackoffMinutes must be exported");
  assert.equal(schedMod2.sweepNetworkBackoffMinutes(1), 1, "first network failure retries after 1 minute");
  assert.equal(schedMod2.sweepNetworkBackoffMinutes(2), 2, "second network failure backs off to 2 minutes");
  assert.equal(schedMod2.sweepNetworkBackoffMinutes(4), 8, "fourth network failure backs off to 8 minutes");
  assert.equal(schedMod2.sweepNetworkBackoffMinutes(9), 15, "network backoff caps at 15 minutes");
  assert.equal(schedMod2.sweepBackoffMinutesFor("network", 1), 1, "network class routes to the fast ladder");
  assert.equal(schedMod2.sweepBackoffMinutesFor("auth", 1), 30, "auth class keeps the slow ladder");
  assert.equal(schedMod2.sweepBackoffMinutesFor("ratelimited", 1), 30, "ratelimited class keeps the slow ladder");
  assert.equal(schedMod2.sweepRetryDueAt(1, 1_000_000), 1_000_000 + 60_000, "default class is network (fast ladder)");
  assert.equal(schedMod2.failClassFromPauseReason("sweep failed[network]: fetch failed"), "network", "pause reason roundtrips the network class");
  assert.equal(schedMod2.failClassFromPauseReason("sweep failed[auth]: 401"), "auth", "pause reason roundtrips the auth class");
  assert.equal(schedMod2.failClassFromPauseReason("sweep failed[unknown]: legacy"), "network", "unparsed classes default to network");
  assert.equal(schedMod2.failClassFromPauseReason("sweep failed: legacy"), "network", "legacy unparsed reasons default to network");
  assert.equal(schedMod2.failClassFromPauseReason(null), "network", "null reason defaults to network");
  const schedTxt = await fs.readFile(schedulerSrc, "utf8");
  assert.match(schedTxt, /isAutoPause\(repo\.pausedReason\) && repo\.lastSweepErrorAt/, "auto-paused repos re-arm the timer on the retry ladder, not the regular schedule");
  // In-place network retries: a transient blip retries inside the sweep
  // invocation 10 times (3s..30s ladder) before the failure path records it.
  assert.equal(schedMod2.SWEEP_INPLACE_RETRIES, 10, "network failures retry in place 10 times before failing");
  assert.equal(schedMod2.sweepInplaceDelayMs(1), 3_000, "first in-place retry after 3s");
  assert.equal(schedMod2.sweepInplaceDelayMs(4), 24_000, "ladder doubles per attempt");
  assert.equal(schedMod2.sweepInplaceDelayMs(9), 30_000, "in-place delay caps at 30s");
  assert.match(schedTxt, /for \(let attempt = 1; attempt <= SWEEP_INPLACE_RETRIES; attempt\+\+\)/, "sweepRepo call is wrapped in the in-place retry loop");
  assert.match(schedTxt, /classifySweepError\(err\) !== "network"[\s\S]{0,80}throw err/, "non-network classes never retry in place");
  assert.equal(schedMod2.isAutoPause("disabled by user"), false, "user pauses are never auto-cleared");
  // #claim-recovery: a failed task that claimed an issue must re-open it for
  // the next sweep instead of orphaning it (seen stamp cleared + bot
  // self-assignment removed).
  assert.equal(typeof schedMod2.parseClaimMarker, "function", "parseClaimMarker must be exported");
  const cm = schedMod2.parseClaimMarker("desc\nIdempotency-Key: topcheer/ggcode#issue-5403:takeOwnership\nmore");
  assert.deepEqual(cm, { repoId: "topcheer/ggcode", number: 5403, kind: "takeOwnership", key: "topcheer/ggcode#issue-5403" }, "marker parses repo/number/kind/key");
  assert.equal(schedMod2.parseClaimMarker("no marker here"), null, "non-marker descriptions parse to null");
  assert.match(schedTxt, /failedClaimRecovery\[taskId\] = Date\.now\(\)/, "each failed task is recovered exactly once (per-taskId guard)");
  assert.match(schedTxt, /delete repo\.cursors\.seen\[parsed\.key\]/, "recovery clears the seen stamp so the next sweep re-candidates");
  assert.match(schedTxt, /removeIssueAssignees/, "takeOwnership failure removes the bot self-assignment");
  assert.equal(schedMod2.isAutoPause(null), false, "null pause is healthy");
  // Agent-facing TeamAuto surface: scheduler method + tool contract + prompt injection.
  const manifestRaw = await fs.readFile(path.join(projectRoot, "src", "openclaw.plugin.json"), "utf8");
  for (const tool of ["teamclaw_teamauto_status", "teamclaw_teamauto_sweep", "teamclaw_teamauto_propose"]) {
    assert.ok(manifestRaw.includes(`"${tool}"`), `${tool} must be declared in the plugin tool contract`);
  }
  const toolsDist = await fs.readFile(path.join(projectRoot, "src", "dist", "src", "controller", "controller-tools.js"), "utf8");
  for (const tool of ["teamclaw_teamauto_status", "teamclaw_teamauto_sweep", "teamclaw_teamauto_propose"]) {
    assert.ok(toolsDist.includes(tool), `${tool} must be implemented in controller-tools dist`);
  }
  const policyDist = await fs.readFile(path.join(projectRoot, "src", "dist", "src", "prompt-policy.js"), "utf8");
  assert.ok(policyDist.includes("teamclaw_teamauto_status"), "controller prompt rules must mention the teamauto status tool");
  assert.ok(policyDist.includes("prefer over teamclaw_create_task"), "prompt rules must route teamauto repos to the governed pipeline");

  // nextFireMs cadence parsing: wall-clock aligned, restart-safe, strictly future.
  const schedMod = await import(path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js"));
  const at = (h, m, sec = 0, ms = 0) => new Date(2026, 10, 2, h, m, sec, ms).getTime();
  const atDay = (day, h, m) => new Date(2026, 10, day, h, m, 0, 0).getTime();
  // 17:23:58 -> the next */30 boundary is 17:30. The old interval semantics
  // chained 30min from "now" (17:53) and never survived a gateway restart.
  assert.equal(schedMod.nextFireMs("*/30 * * * *", at(17, 23, 58, 250)), at(17, 30) - at(17, 23, 58, 250));
  // Exactly on a boundary means the NEXT boundary, never zero delay.
  assert.equal(schedMod.nextFireMs("*/30 * * * *", at(17, 30)), 30 * 60_000);
  assert.equal(schedMod.nextFireMs("@hourly", at(17, 23)), at(18, 0) - at(17, 23));
  assert.equal(schedMod.nextFireMs("@daily", at(17, 23)), atDay(3, 0, 0) - at(17, 23));
  // "0 */6 * * *" used to silently degrade to a 1-minute cadence.
  assert.equal(schedMod.nextFireMs("0 */6 * * *", at(17, 23)), at(18, 0) - at(17, 23));
  // "0 9 * * *" used to sweep every minute; now it is tomorrow 09:00 local.
  assert.equal(schedMod.nextFireMs("0 9 * * *", at(17, 23)), atDay(3, 9, 0) - at(17, 23));
  assert.equal(schedMod.nextFireMs("45 8 * * *", at(9, 0)), atDay(3, 8, 45) - at(9, 0));
  assert.equal(schedMod.nextFireMs("5 * * * *", at(17, 6)), at(18, 5) - at(17, 6));
  // Unsupported expressions must fail loudly instead of guessing a cadence.
  assert.throws(() => schedMod.nextFireMs("weird"), /unsupported schedule/u);
  assert.throws(() => schedMod.nextFireMs("30 4 * * 1"), /unsupported schedule/u);
  assert.throws(() => schedMod.nextFireMs("0 25 * * *"), /unsupported schedule/u);

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
  assert.equal(first.candidates.length, 5, "first sweep surfaces the filtered backlog (#269 6th case: issue #1 collapses to ownership-only, PR #9 review, plus 3 joint fullReview sections)");
  const firstKinds = first.candidates.map((c) => c.kind).sort().join(",");
  assert.match(firstKinds, /takeOwnership/, "ownership wins over issueReview for the same open issue");
  assert.doesNotMatch(firstKinds, /issueReview/, "no duplicate triage task for an issue already taken over");
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
  assert.deepEqual(kinds, ["prReview#9", "takeOwnership#1"], `unexpected candidates: ${kinds.join(",")} (#269 6th case: no issueReview alongside ownership)`);

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
