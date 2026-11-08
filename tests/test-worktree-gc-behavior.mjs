#!/usr/bin/env node
// Behavioral test for the worktree GC safety contract (PR #167 + #173 follow-ups).
// Builds a synthetic git fixture (local bare origin + base checkout + 4 task
// worktrees in the real naming scheme) under an isolated OPENCLAW_STATE_DIR,
// then drives the ACTUAL dist build of repo-sync.gcTaskWorktrees /
// safeRemoveTaskWorktree and asserts the removal/retention outcomes.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-gc-test-"));
// Isolate ALL path resolution BEFORE importing the module under test.
process.env.OPENCLAW_STATE_DIR = path.join(tmp, "state");
process.env.OPENCLAW_HOME = path.join(tmp, "state");
process.env.HOME = path.join(tmp, "state");
// Issue #204 (P1 test isolation): repoDir() -> resolveTeamAutoPaths() ->
// resolveTeamClawProjectsDir() reads the HOST openclaw.json via the inherited
// OPENCLAW_CONFIG_PATH when no explicit workspace override is set, landing
// fixtures in the real shared workspace and colliding across runs.
// TEAMCLAW_WORKSPACE_DIR has top precedence over any config file - set it.
process.env.TEAMCLAW_WORKSPACE_DIR = path.join(tmp, "workspace");
fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.TEAMCLAW_WORKSPACE_DIR, { recursive: true });

const root = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(root, "src", "dist", "src", "teamauto", "repo-sync.js"));
assert.equal(typeof mod.createRepoSync, "function", "dist build must exist (npm --prefix src run build)");

const REPO = "fixture/owner__repo";
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

const logger = { warn: () => {}, info: () => {} };
const auth = { getAccessToken: async () => "x" }; // not used by the GC path
const sync = mod.createRepoSync(auth, logger);

// --- fixture: bare origin + base checkout at the resolved reposRoot ---
const base = await sync.repoDir(REPO);
fs.mkdirSync(path.dirname(base), { recursive: true });
const bare = path.join(tmp, "origin.git");
execFileSync("git", ["init", "--bare", "-b", "main", bare]);
execFileSync("git", ["init", "-b", "main", base]);
git(["config", "user.email", "t@t"], base);
git(["config", "user.name", "t"], base);
git(["remote", "add", "origin", bare], base);
fs.writeFileSync(path.join(base, "f.txt"), "base\n");
git(["add", "-A"], base);
git(["commit", "-m", "base"], base);
git(["push", "origin", "main"], base);
git(["fetch", "origin"], base);

// --- 4 task worktrees via the REAL dir naming ---
const mkTask = async (taskId, kind) => {
  const rel = sync.taskWorktreeRelDir(REPO, taskId); // teamauto/<slug>__task-<id>
  const wt = path.join(path.dirname(base), path.basename(rel));
  git(["worktree", "add", "-b", `teamclaw/task-${taskId}`, wt, "HEAD"], base);
  if (kind === "delivered" || kind === "ahead") {
    fs.writeFileSync(path.join(wt, "work1.txt"), "w1\n");
    git(["add", "-A"], wt); git(["config", "user.email", "t@t"], wt); git(["config", "user.name", "t"], wt);
    git(["commit", "-m", "c1"], wt);
    git(["push", "origin", `HEAD:refs/heads/teamclaw/task-${taskId}`], wt);
  }
  if (kind === "ahead") {
    fs.writeFileSync(path.join(wt, "work2.txt"), "w2\n");
    git(["add", "-A"], wt); git(["commit", "-m", "c2"], wt); // local-only: ahead of pushed tip
  }
  if (kind === "dirty") {
    fs.writeFileSync(path.join(wt, "uncommitted.txt"), "unmerged work\n"); // never committed, never pushed
  }
  return wt;
};
const wtDelivered = await mkTask("aaaa-delivered", "delivered");
const wtEmpty = await mkTask("bbbb-empty", "empty");
const wtAhead = await mkTask("cccc-ahead", "ahead");
const wtDirty = await mkTask("dddd-dirty", "dirty");

// --- GC pass 1: all tasks terminal ---
const r1 = await sync.gcTaskWorktrees(REPO, () => true);
assert.deepEqual([...r1.removed].sort(), ["aaaa-delivered", "bbbb-empty"], "only delivered + empty are reclaimed");
assert.equal(r1.retained.length, 2, "ahead + dirty are retained");
const reasons = r1.retained.map((x) => x.reason).join("\n");
assert.match(reasons, /ahead of pushed tip/, "ahead case carries its reason");
assert.match(reasons, /dirty worktree/, "dirty case carries its reason (uncommitted work is never destroyed)");
assert.ok(!fs.existsSync(wtDelivered) && !fs.existsSync(wtEmpty), "reclaimed worktree dirs are gone");
assert.ok(fs.existsSync(wtAhead) && fs.existsSync(wtDirty), "retained worktree dirs survive");

// --- GC pass 2: task not terminal -> nothing touched ---
const r2 = await sync.gcTaskWorktrees(REPO, () => false);
assert.equal(r2.removed.length, 0, "non-terminal tasks keep their worktrees (resume state)");

// --- single-task safety removal for a terminal-but-committed worktree ---
const single = await sync.safeRemoveTaskWorktree(REPO, "cccc-ahead");
assert.equal(single.removed, false, "ahead task stays via single-task path too");

// ===========================================================================
// #173 follow-ups: dirty-guard hoist, in-use sentinel, squash-merge oracle,
// stale-branch observability. Each fixture is fully dropped after its block so
// the disk state returns to {cccc-ahead, dddd-dirty} for the final pass.
// ===========================================================================
const wtOf = (taskId) => path.join(path.dirname(base), path.basename(sync.taskWorktreeRelDir(REPO, taskId)));
const mkWt = (taskId) => {
  const wt = wtOf(taskId);
  git(["worktree", "add", "-b", `teamclaw/task-${taskId}`, wt, "HEAD"], base);
  return wt;
};
const commitFile = (wt, name, content = "x\n") => {
  fs.writeFileSync(path.join(wt, name), content);
  git(["add", "-A"], wt); git(["config", "user.email", "t@t"], wt); git(["config", "user.name", "t"], wt);
  git(["commit", "-m", `c:${name}`], wt);
};
const pushTask = (wt, taskId) => git(["push", "origin", `HEAD:refs/heads/teamclaw/task-${taskId}`], wt);
const dropTask = (taskId, wt) => {
  fs.rmSync(wt, { recursive: true, force: true });
  git(["worktree", "prune"], base);
  try { git(["branch", "-D", `teamclaw/task-${taskId}`], base); } catch { /* already gone */ }
  try { git(["push", "origin", "--delete", `refs/heads/teamclaw/task-${taskId}`], base); } catch { /* never pushed */ }
};

// --- #173 item 1: the tip-match removal path must also refuse a dirty tree ---
{
  const taskId = "eeee-dirtytip";
  const wt = mkWt(taskId);
  commitFile(wt, "d1.txt");
  pushTask(wt, taskId); // branch tip on remote - previously removed WITHOUT a dirty check
  fs.writeFileSync(path.join(wt, "post-delivery.txt"), "late worker edit\n");
  const r = await sync.safeRemoveTaskWorktree(REPO, taskId);
  assert.equal(r.removed, false, "tip-match removal is blocked by a dirty tree (#173 item 1)");
  assert.match(r.reason, /dirty worktree/, "dirty-delivered reason is reported");
  assert.ok(fs.existsSync(wt), "dirty-delivered worktree survives");
  dropTask(taskId, wt);
}

// --- #173 item 5: squash-merge + branch deletion must not retain forever ---
{
  const taskId = "ffff-squash";
  const wt = mkWt(taskId);
  commitFile(wt, "sq.txt", "sq\n");
  pushTask(wt, taskId);
  // Squash-merge on the origin side + branch auto-delete: the exact re-leak
  // shape from the issue (shas unreachable from main, content merged).
  git(["merge", "--squash", `teamclaw/task-${taskId}`], base);
  git(["commit", "-m", `squash(${taskId})`], base);
  git(["push", "origin", "main"], base);
  git(["push", "origin", "--delete", `refs/heads/teamclaw/task-${taskId}`], base);
  git(["fetch", "origin"], base);
  const headTip = git(["rev-parse", "HEAD"], wt).trim();
  // Without an oracle: retained forever (the pre-fix leak, fails toward keep).
  const rNo = await sync.safeRemoveTaskWorktree(REPO, taskId);
  assert.equal(rNo.removed, false, "no oracle -> squash-leaked worktree is retained (fail toward keep)");
  assert.match(rNo.reason, /unpushed own commit/, "retention reason names the unreachability");
  // Oracle without positive proof (e.g. closed-unmerged PR, or head-tip
  // mismatch because the worker committed after the push): still retained.
  const rUnproven = await sync.safeRemoveTaskWorktree(REPO, taskId, async () => false);
  assert.equal(rUnproven.removed, false, "unproven oracle retains the worktree");
  // Positive proof - a merged PR whose head tip is EXACTLY this HEAD - reclaims.
  const oracleYes = async (rid, tid, tip) => rid === REPO && tid === taskId && tip === headTip;
  const rYes = await sync.safeRemoveTaskWorktree(REPO, taskId, oracleYes);
  assert.equal(rYes.removed, true, "merged-PR oracle reclaims the squash-leaked worktree (#173 item 5)");
  assert.match(rYes.reason, /merged PR/, "removal reason credits the squash delivery");
  assert.ok(!fs.existsSync(wt), "squash-delivered worktree dir is gone");
  dropTask(taskId, wt);
}

// --- #173 item 2: in-use sentinel (pid lock in the git admin dir) ---
{
  const taskId = "gggg-busy";
  const wt = mkWt(taskId);
  commitFile(wt, "busy.txt");
  pushTask(wt, taskId); // delivered tip: ONLY the sentinel can hold removal here
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const gitDir = path.resolve(wt, git(["rev-parse", "--git-dir"], wt).trim());
    fs.writeFileSync(path.join(gitDir, "teamclaw-task-lock.json"), JSON.stringify({ pid: sleeper.pid, at: Date.now() }));
    const r = await sync.safeRemoveTaskWorktree(REPO, taskId);
    assert.equal(r.removed, false, "live foreign pid in the task lock blocks removal (#173 item 2)");
    assert.match(r.reason, /in use by live process/, "retention reason names the live pid");
    assert.ok(fs.existsSync(wt), "in-use worktree survives");
  } finally {
    sleeper.kill("SIGKILL");
    await new Promise((res) => sleeper.on("exit", res));
  }
  // The controller crashed (pid dead): the sentinel no longer blocks GC.
  const r2 = await sync.safeRemoveTaskWorktree(REPO, taskId);
  assert.equal(r2.removed, true, "dead pid in the task lock does not block the delivered-tip removal");
  assert.match(r2.reason, /branch tip on remote/);
  dropTask(taskId, wt);
}

// --- #173 item 2 (writer side): ensureTaskWorktree maintains the sentinel ---
{
  const taskId = "hhhh-ensure";
  const wt = await sync.ensureTaskWorktree(REPO, taskId);
  assert.ok(fs.existsSync(wt), "ensureTaskWorktree creates the worktree");
  const gitDir = path.resolve(wt, git(["rev-parse", "--git-dir"], wt).trim());
  const lockPath = path.join(gitDir, "teamclaw-task-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(lock.pid, process.pid, "ensureTaskWorktree writes its own pid as the in-use sentinel");
  // The lock lives OUTSIDE the worktree tree: the tree stays clean and the
  // own-pid sentinel must not block our own GC (empty never-pushed -> removed).
  const r = await sync.safeRemoveTaskWorktree(REPO, taskId);
  assert.equal(r.removed, true, "own-pid lock + clean tree -> empty worktree reclaimed");
  assert.match(r.reason, /no own commits/);
}

// --- #173 QA finding: dir-gone entries are counted as stale, not invisible ---
{
  const taskId = "iiii-stale";
  const wt = mkWt(taskId); // no commits, never pushed
  fs.rmSync(wt, { recursive: true, force: true }); // dir gone, local branch survives
  git(["worktree", "prune"], base);
  const r = await sync.gcTaskWorktrees(REPO, () => true);
  assert.equal(r.stale, 1, "dir-gone entry is surfaced as stale (previously invisible)");
  assert.equal(r.removed.length, 0, "nothing new is reclaimed in this pass");
  assert.deepEqual(r.retained.map((x) => x.taskId).sort(), ["cccc-ahead", "dddd-dirty"], "only the two standing retains remain");
  git(["branch", "-D", `teamclaw/task-${taskId}`], base);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-worktree-gc-behavior: ok (4-case safety contract + #173 follow-ups enforced end-to-end)");
