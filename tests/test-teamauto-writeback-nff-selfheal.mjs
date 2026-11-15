#!/usr/bin/env node
// Regression test for ggcode issue #5651 (fixed in teamclaw 8e2eee4): a
// deterministic non-fast-forward push rejection was retried through the
// generic 6-attempt write-back ladder (~25min of doomed retries, #5268
// family; live case #5637 burned 4 attempts on byte-identical errors).
//
// The fix has two layers, both pinned here against REAL git (no mocks on
// the git layer):
// 1. pushBranch self-heal: when the remote task branch has diverged (it
//    carries a parallel delivery - the ancestor/alreadyDelivered check
//    from #stale-base does not apply), the blind push rejects
//    non-fast-forward; pushBranch now rebases onto FETCH_HEAD and pushes
//    ONCE more. The task branch is exclusively ours, so the rebase is the
//    correct integration.
// 2. Terminal dead-letter: when that rebase CONFLICTS (base rewritten
//    underneath us), pushBranch aborts the rebase (clean tree) and throws
//    the distinct signature "push rejected (non-fast-forward) and rebase
//    self-heal failed"; markWritebackFailure treats the signature as
//    terminal - failedAt at attempts=1, no ladder, never retried.
//
// Fixture mechanism: repo-sync talks to `https://x-access-token:<token>@
// github.com/<owner>/<repo>.git` (token inlined per invocation). run()
// spreads process.env into every git child, so GIT_CONFIG_COUNT/
// GIT_CONFIG_KEY_0=url.<bare>.insteadOf/GIT_CONFIG_VALUE_0=<authed url>
// redirects those one-shot URLs to a local bare repository - the pushes,
// fetches, and rebase all execute against real git semantics, fully
// offline. Identity for the rebase's replayed commit comes from the base
// clone's repo-local config (worktrees inherit it), matching how the
// prod worktree sees the machine's git identity.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// Contained roots: plugin store, TeamClaw workspace (repo checkouts +
// task worktrees), and the "GitHub" bare all live under one tmp dir.
const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5651-nff-"));
const stateDir = path.join(fixtureRoot, "state");
const wsDir = path.join(fixtureRoot, "ws");
const bareDir = path.join(fixtureRoot, "origin.git");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.TEAMCLAW_WORKSPACE_DIR = wsDir;
const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");
const repoId = "acme/widget";
const cloneUrl = "https://github.com/acme/widget.git";
const fakeToken = "nff-test-token";
const authedUrl = `https://x-access-token:${fakeToken}@github.com/acme/widget.git`;
const defaultBranch = "main";
const taskA = "5651a"; // scenario A: diverged, rebase self-heal succeeds
const taskB = "5651b"; // scenario B: rebase conflicts -> terminal dead-letter
const branchA = `teamclaw/task-${taskA}`;
const branchB = `teamclaw/task-${taskB}`;

// Redirect every authed one-shot URL repo-sync builds to the local bare.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = `url.${bareDir}.insteadOf`;
process.env.GIT_CONFIG_VALUE_0 = authedUrl;

const schedMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js")
).catch(() => null);
assert.ok(schedMod, "scheduler module must be built (run npm --prefix src run build first)");

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).toString();
const gitOk = (args, cwd) => { try { git(args, cwd); return true; } catch { return false; } };

// ── Seed the "remote": main, plus diverged task branches ───────────────────
// A's remote side touches remote-only.txt (no overlap with the local side's
// local-only.txt -> rebase replays cleanly). B's remote side edits the SAME
// shared.txt the local side edits -> rebase conflicts.
fs.mkdirSync(bareDir, { recursive: true });
git(["init", "--bare", "-q", "-b", defaultBranch, bareDir], fixtureRoot);
const seedDir = path.join(fixtureRoot, "seed");
fs.mkdirSync(seedDir, { recursive: true });
git(["init", "-q", "-b", defaultBranch], seedDir);
const commitIn = (cwd, msg) => git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg], cwd);
const writeFile = (cwd, rel, content) => fs.writeFileSync(path.join(cwd, rel), content);
git(["remote", "add", "origin", bareDir], seedDir);
writeFile(seedDir, "shared.txt", "base\n");
writeFile(seedDir, "readme.md", "# widget\n");
git(["add", "-A"], seedDir);
commitIn(seedDir, "base: main");
git(["push", "-q", "origin", defaultBranch], seedDir);
// scenario A remote side (parallel delivery)
git(["checkout", "-q", "-b", branchA], seedDir);
writeFile(seedDir, "remote-only.txt", "remote work\n");
git(["add", "-A"], seedDir);
commitIn(seedDir, "remote side A");
const remoteTipA = git(["rev-parse", "HEAD"], seedDir).trim();
git(["push", "-q", "origin", branchA], seedDir);
// scenario B remote side (same file as the local side will edit)
git(["checkout", "-q", defaultBranch], seedDir);
git(["checkout", "-q", "-b", branchB], seedDir);
writeFile(seedDir, "shared.txt", "remote edit\n");
git(["add", "-A"], seedDir);
commitIn(seedDir, "remote side B");
const remoteTipB = git(["rev-parse", "HEAD"], seedDir).trim();
git(["push", "-q", "origin", branchB], seedDir);

// ── Seed the local checkout + task worktrees exactly where repo-sync
// looks for them: <ws>/projects/teamauto/<owner__repo> plus the sibling
// <owner__repo>__task-<id> worktrees (pre-existing = resume path keeps
// their commits, which is how a diverged local branch arises in prod).
const reposRoot = path.join(wsDir, "projects", "teamauto");
const baseDir = path.join(reposRoot, "acme__widget");
fs.mkdirSync(reposRoot, { recursive: true });
git(["clone", "-q", bareDir, baseDir], fixtureRoot);
// Repo-local identity: the fix's `git rebase FETCH_HEAD` runs without -c
// identity flags, and worktrees inherit the base clone's config.
git(["config", "user.name", "tc-test"], baseDir);
git(["config", "user.email", "tc-test@test.invalid"], baseDir);
const seedWorktree = (taskId, files) => {
  const wtPath = path.join(reposRoot, `acme__widget__task-${taskId}`);
  git(["worktree", "add", "-q", "-b", `teamclaw/task-${taskId}`, wtPath, "HEAD"], baseDir);
  for (const [rel, content] of Object.entries(files)) {
    writeFile(wtPath, rel, content);
  }
  git(["add", "-A"], wtPath);
  commitIn(wtPath, `local side ${taskId}`);
  return wtPath;
};
const wtA = seedWorktree(taskA, { "local-only.txt": "local work\n" });
const wtB = seedWorktree(taskB, { "shared.txt": "local edit\n" });

// ── Store + team state: two completed WRITE tasks whose write-backs are
// pending issueComments (the write path commits/pushes/PRs first).
await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
await fs.promises.writeFile(storeFile, JSON.stringify({
  version: 1,
  repos: [{ id: repoId, enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true }],
  writebacks: [
    { taskId: taskA, action: "issueComment", repoId, targetId: 42, doneAt: null, prUrl: null, error: null },
    { taskId: taskB, action: "issueComment", repoId, targetId: 43, doneAt: null, prUrl: null, error: null },
  ],
  activity: [],
  budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-15" },
}), "utf8");

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const teamState = {
  tasks: {
    [taskA]: { id: taskA, title: "[takeOwnership] A", description: "d", status: "completed", result: "result A", writeMode: "write", projectDir: `teamauto/acme__widget__task-${taskA}`, assignedRole: "developer" },
    [taskB]: { id: taskB, title: "[takeOwnership] B", description: "d", status: "completed", result: "result B", writeMode: "write", projectDir: `teamauto/acme__widget__task-${taskB}`, assignedRole: "developer" },
  },
};

const scheduler = schedMod.createTeamAutoScheduler({
  logger: noopLogger,
  auth: {
  getAuthHeaders: async () => ({ Authorization: "Bearer test" }),
  getAccessToken: async () => fakeToken,
  },
  getTeamState: () => teamState,
  updateTeamState: (fn) => { fn(teamState); return teamState; },
  onTasksCreated: async () => {},
});

const readStore = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));
const entryOf = (store, taskId) => store.writebacks.find((w) => w.taskId === taskId);

// GitHub API stub: repo info + PR creation succeed; per-target comment
// counters observe that B's comment is never posted (PR step failed first).
const realFetch = globalThis.fetch;
const commentCalls = { "42": 0, "43": 0 };
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const json = (obj, status = 200) => ({
    ok: status < 400, status, headers: { get: () => null },
    text: async () => JSON.stringify(obj), json: async () => obj,
  });
  if (target === "https://api.github.com/repos/acme/widget") {
    return json({ full_name: repoId, default_branch: defaultBranch, clone_url: cloneUrl, permissions: { push: true, pull: true } });
  }
  if (target === "https://api.github.com/repos/acme/widget/pulls" && init.method === "POST") {
    return json({ number: 7, html_url: "https://github.com/acme/widget/pull/7" }, 201);
  }
  for (const number of ["42", "43"]) {
    if (target.endsWith(`/repos/acme/widget/issues/${number}/comments`)) {
      commentCalls[number] += 1;
      return json({ id: 555 }, 201);
    }
  }
  return json({});
};

try {
  // One reconcile pass delivers both scenarios in order.
  await scheduler.reconcileWritebacks();

  // ── Contract A: diverged branch self-heals via rebase, delivery completes
  {
    assert.equal(commentCalls["42"], 1, "task A's issue comment delivered after self-heal");
    const store = await readStore();
    const a = entryOf(store, taskA);
    assert.ok(!a || a.doneAt, "task A delivered (doneAt set / entry retired)");
    // Remote branch now carries BOTH sides: the rebase replayed the local
    // commit on top of the remote's parallel delivery.
    const merged = git(["show", `${branchA}:local-only.txt`], bareDir);
    assert.ok(merged.includes("local work"), "local side reachable from the remote branch tip");
    const mergedRemote = git(["show", `${branchA}:remote-only.txt`], bareDir);
    assert.ok(mergedRemote.includes("remote work"), "remote side retained under the rebased tip");
    const activity = await scheduler.getActivity();
    assert.ok(activity.some((e) => e.kind === "writeback" && /PR opened: /.test(e.text)), "PR opening recorded in activity");
  }

  // ── Contract B: rebase conflict -> terminal dead-letter at attempt 1
  {
    assert.equal(commentCalls["43"], 0, "task B's comment must NOT post - the PR step failed atomically (#269)");
    const store = await readStore();
    const b = entryOf(store, taskB);
    assert.ok(b, "terminal entry stays persisted for visibility");
    assert.ok(b.failedAt > 0, "rebase-self-heal failure is TERMINAL immediately (#5651) - no retry ladder");
    assert.equal(b.attempts, 1, "dead-lettered on the FIRST attempt, not after 6 doomed pushes");
    assert.match(String(b.error), /push rejected \(non-fast-forward\) and rebase self-heal failed/, "distinct terminal signature preserved");
    assert.match(String(b.error), /conflict/i, "the underlying rebase conflict is surfaced");

    const status = await scheduler.getStatus();
    assert.equal(status.writebacks.failed, 1, "terminal failure visible in getStatus stats");
    assert.equal(status.writebacks.lastError.taskId, taskB, "lastError names the dead-lettered entry");
    assert.equal(status.writebacks.lastError.terminal, true, "lastError flagged terminal");
    assert.equal(status.writebacks.lastError.attempts, 1, "attempts=1 - the ladder never armed");

    const activity = await scheduler.getActivity();
    assert.ok(
      activity.some((e) => e.kind === "writeback" && /failed permanently after 1 attempt/.test(e.text)),
      "terminal give-up exposed in the activity feed",
    );
    assert.ok(
      !activity.some((e) => e.kind === "writeback" && /failed \(attempt 1\/6/.test(e.text) && /5651b/.test(e.text)),
      "no ladder-style failure row for the terminal entry",
    );

    // The worktree is left clean: the aborted rebase did not strand state.
    assert.equal(git(["status", "--porcelain"], wtB).trim(), "", "rebase aborted - worktree clean for the next pass");
    assert.equal(git(["rev-parse", "HEAD"], wtB).trim(), git(["rev-parse", `teamclaw/task-${taskB}`], wtB).trim(), "HEAD unchanged after the aborted rebase");
    // The remote branch was NOT force-updated by the failed self-heal.
    assert.equal(git(["rev-parse", branchB], bareDir).trim(), remoteTipB, "remote tip untouched (no force push)");

    // Terminal entries are never retried, however far time advances.
    await scheduler.reconcileWritebacks();
    await scheduler.reconcileWritebacks();
    const after = await readStore();
    const b2 = entryOf(after, taskB);
    assert.equal(b2.attempts, 1, "terminal entry consumes no further attempts");
    assert.equal(git(["rev-parse", branchB], bareDir).trim(), remoteTipB, "no further pushes against the remote");
  }

  await scheduler.stop();
} finally {
  globalThis.fetch = realFetch;
  // Worktree admin lives under the fixture root; remove it wholesale.
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("test-teamauto-writeback-nff-selfheal: all assertions passed (issue #5651 diverged non-fast-forward -> rebase self-heal delivers; conflict -> terminal dead-letter at attempt 1)");
