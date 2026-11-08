#!/usr/bin/env node
// Behavioral test for the worktree GC safety contract (PR #167).
// Builds a synthetic git fixture (local bare origin + base checkout + 4 task
// worktrees in the real naming scheme) under an isolated OPENCLAW_STATE_DIR,
// then drives the ACTUAL dist build of repo-sync.gcTaskWorktrees /
// safeRemoveTaskWorktree and asserts the removal/retention outcomes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-worktree-gc-behavior: ok (4-case safety contract enforced end-to-end)");
