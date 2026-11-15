#!/usr/bin/env node
// Issue #5654 (ggcode): the write-task completion gate probed
// `rev-list --count HEAD --not --remotes` - the UNPUSHED-commit count. A
// worker that pushes its branch BEFORE submitting (the encouraged flow since
// the #5651 rebase-delivery path) always drained to 0 after the push, so a
// substantive delivery got rejected as a no-op and the issue churned reopen
// (live case d4ddd1bd: delivered + pushed a3638d1da, gate said 0, task
// failed + write-back dead-lettered).
//
// Fix under test (teamclaw@4258e0c): the gate asks whether HEAD carries
// commits beyond the task's BASE branch - origin/<default> resolved via
// symbolic-ref origin/HEAD with a conventional origin/main fallback.
// Pushed-or-not is irrelevant to substantiveness.
//
// The fixtures are REAL git repos (bare origin + clone), driven through the
// real exported projectHasMeaningfulFileChanges via the built dist - the
// same module the controller's completion route calls.
//
// Expected stderr noise: contracts 1 and 3 run the production origin/HEAD
// probe against fixtures with no origin/HEAD, so git prints "fatal: ref
// refs/remotes/origin/HEAD is not a symbolic ref" before the code catches it
// and falls back. Those lines are proof the fallback path is exercised.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = path.join(projectRoot, "src", "dist", "src", "controller", "task-results.js");
assert.ok(
  fs.existsSync(dist),
  "task-results dist must be built (run npm --prefix src run build first)",
);
const { projectHasMeaningfulFileChanges } = await import(dist);

// Hermetic workspace: resolveTeamClawProjectsDir() honors TEAMCLAW_WORKSPACE_DIR.
const wsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5654-ws-"));
const projectsDir = path.join(wsDir, "projects");
process.env.TEAMCLAW_WORKSPACE_DIR = wsDir;
process.env.OPENCLAW_STATE_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5654-state-"));

const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).toString();
const gitQuiet = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).toString();
const gitOk = (cwd, ...args) => {
  try { git(cwd, ...args); return true; } catch { return false; }
};

const mkTask = (projectDir) => ({ id: "task-5654", title: "[takeOwnership] x", description: "d", status: "in_progress", projectDir });

/**
 * Build a real fixture: a bare origin (default branch main) seeded with one
 * commit, plus a task worktree cloned from it whose branch carries `extra`
 * commits on top of origin/main. Mirrors the TeamClaw write contract layout:
 * <ws>/projects/<owner>__repo__task-<id>/.
 */
function buildFixture({ name, extraCommits = 1, setOriginHead = false, pushBranch = false }) {
  const projDir = path.join(projectsDir, "teamauto", name);
  fs.mkdirSync(path.dirname(projDir), { recursive: true });
  const originPath = path.join(wsDir, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originPath], { env: gitEnv(), stdio: "ignore" });
  const seed = path.join(wsDir, `${name}-seed`);
  execFileSync("git", ["clone", "-q", originPath, seed], { env: gitEnv(), stdio: "ignore" });
  git(seed, "config", "user.email", "t@t.local");
  git(seed, "config", "user.name", "t");
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  if (setOriginHead) {
    // Publish the default-branch mapping so clones materialize origin/HEAD.
    git(originPath, "symbolic-ref", "HEAD", "refs/heads/main");
  }
  execFileSync("git", ["clone", "-q", originPath, projDir], { env: gitEnv(), stdio: "ignore" });
  if (!setOriginHead) {
    // git >=2.4x materializes origin/HEAD on clone; strip it so the fixture
    // genuinely exercises the conventional origin/main fallback path.
    try {
      gitQuiet(projDir, "remote", "set-head", "origin", "--delete");
    } catch { /* already absent - the state this fixture wants */ }
  }
  git(projDir, "config", "user.email", "t@t.local");
  git(projDir, "config", "user.name", "t");
  git(projDir, "checkout", "-qb", "task-branch", "origin/main");
  for (let i = 0; i < extraCommits; i += 1) {
    fs.writeFileSync(path.join(projDir, `delivered-${i}.txt`), `delivery ${i}\n`);
    git(projDir, "add", ".");
    git(projDir, "commit", "-qm", `deliver ${i}`);
  }
  if (pushBranch) {
    // The #5654 flow: worker pushes the task branch BEFORE submitting the
    // result. After this, every commit is reachable from a remote ref.
    git(projDir, "push", "-q", "origin", "task-branch:refs/heads/task-branch");
  }
  return projDir;
}

let passed = 0;

// ── Contract 1 (the filed bug): push-before-submit must PASS ───────────────
// Live case d4ddd1bd: branch pushed at 08:49, result submitted 08:51, gate
// counted unpushed commits = 0, task failed, issue churned. The fix must
// judge the SAME tree as substantive regardless of push state.
{
  const fixture = buildFixture({ name: "acme__widget__task-d4ddd1bd", extraCommits: 1, pushBranch: true });
  const task = mkTask(`teamauto/${path.basename(fixture)}`);
  const gate = projectHasMeaningfulFileChanges(task, undefined);
  assert.equal(gate, true,
    "push-before-submit: gate must see pushed-but-beyond-base commits as meaningful");
  // The exact live-case git mechanics, asserted independently:
  assert.equal(Number(git(fixture, "rev-list", "--count", "HEAD", "--not", "--remotes").trim()), 0,
    "fixture sanity: after the push there are zero unpushed commits (old gate probe = 0)");
  passed += 1;
}

// ── Contract 2: true no-op (branch == base) must FAIL the gate ─────────────
{
  const fixture = buildFixture({ name: "acme__widget__task-noop", extraCommits: 0, setOriginHead: true });
  const task = mkTask(`teamauto/${path.basename(fixture)}`);
  assert.equal(projectHasMeaningfulFileChanges(task, undefined), false,
    "no-op: branch identical to base must not pass the gate");
  passed += 1;
}

// ── Contract 3: origin/main fallback when origin/HEAD is absent ────────────
// No symbolic-ref published: the gate must fall back to origin/main and still
// count the beyond-base delivery commits.
{
  const fixture = buildFixture({ name: "acme__widget__task-nohead", extraCommits: 2 });
  assert.ok(!gitOk(fixture, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"),
    "fixture sanity: origin/HEAD must be absent for the fallback path");
  const task = mkTask(`teamauto/${path.basename(fixture)}`);
  assert.equal(projectHasMeaningfulFileChanges(task, undefined), true,
    "fallback: no origin/HEAD -> origin/main base still counts beyond-base commits");
  passed += 1;
}

// ── Contract 4: non-task projects keep the mtime scan path ─────────────────
{
  const projDir = path.join(projectsDir, "teamauto", "acme__plain");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "file.txt"), "content\n");
  const task = mkTask("teamauto/acme__plain");
  assert.equal(projectHasMeaningfulFileChanges(task, undefined), true,
    "non-task project: mtime scan still detects a plain file");
  passed += 1;
}

console.log(`test-teamauto-completion-gate-5654: ${passed}/4 contracts green (plus fixture sanity asserts)`);
