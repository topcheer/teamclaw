import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Issue #226 W5: cross-subsystem contract lives in the shared layer now.
import type { GithubAuthManager } from "../shared/github-auth.js";
import { repoSlugToDirName, resolveTeamAutoPaths } from "./store.js";

const exec = promisify(execFile);

export const TEAMCLAW_BRANCH_PREFIX = "teamclaw/";

/**
 * Delivery oracle for worktree GC (#173 follow-up 5): after a squash merge +
 * branch deletion the task branch's commits never become reachable from
 * origin/<default> (different shas, same content), so ls-remote is empty and
 * the local rev-list own-count never drains. The scheduler supplies an oracle
 * that asks GitHub whether a PR carrying EXACTLY this head tip was merged.
 * Returns true only on positive proof; any error must resolve false (fail
 * toward keep).
 */
export type TaskDeliveryOracle = (
  repoId: string,
  taskId: string,
  headTip: string,
) => Promise<boolean>;

/**
 * #orphan-gc oracle: is the worktree's TARGET (issue/PR) closed? true =
 * positively closed (the worktree is an orphan - even a dirty tree has no
 * possible delivery), null/false = unknown or still open (fail toward keep).
 */
export type TaskTargetClosedOracle = (
  repoId: string,
  taskId: string,
) => Promise<boolean | null>;

/** TaskInfo.projectDir slug for a bound repo (relative to the projects dir). */
export function teamAutoProjectDir(repoId: string): string {
  return `teamauto/${repoSlugToDirName(repoId)}`;
}

/**
 * Git operations for TeamAuto. Authentication uses the device-flow token
 * inline in the remote URL (x-access-token basic auth) - proven to survive
 * GitHub's smart-HTTP redirects where extraheader injection does not. The
 * token never touches disk: remotes are rewritten per invocation and the
 * on-disk remote stays a clean https URL.
 */

function gitEnv(): Record<string, string> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function run(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: gitEnv(),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

export function createRepoSync(auth: GithubAuthManager, logger: { warn: (m: string) => void }) {
  async function tokenizedUrl(cloneUrl: string): Promise<string> {
    const token = await auth.getAccessToken();
    const clean = cloneUrl.replace(/^https:\/\//, "").replace(/\.git$/, "");
    return `https://x-access-token:${token}@${clean}.git`;
  }

  async function repoDir(repoId: string): Promise<string> {
    const { reposRoot, legacyReposRoot } = resolveTeamAutoPaths();
    await fs.mkdir(reposRoot, { recursive: true });
    const dir = path.join(reposRoot, repoSlugToDirName(repoId));
    const legacy = path.join(legacyReposRoot, repoSlugToDirName(repoId));
    // One-time migration: move pre-workspace clones into the projects tree.
    try {
      await fs.stat(path.join(legacy, ".git"));
      try {
        await fs.stat(path.join(dir, ".git"));
      } catch {
        await fs.mkdir(path.dirname(dir), { recursive: true });
        try {
          await fs.rename(legacy, dir);
        } catch {
          // Cross-device (EXDEV): copy then remove the original.
          await fs.cp(legacy, dir, { recursive: true });
          await fs.rm(legacy, { recursive: true, force: true });
        }
      }
    } catch {
      // No legacy clone - normal path.
    }
    return dir;
  }

  /** Clone if absent, otherwise fetch + reset to the default branch tip. */
  async function ensureCloned(repoId: string, cloneUrl: string, defaultBranch: string): Promise<string> {
    const dir = await repoDir(repoId);
    const gitDir = path.join(dir, ".git");
    let exists = false;
    try {
      const stat = await fs.stat(gitDir);
      exists = stat.isDirectory() || stat.isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      const authed = await tokenizedUrl(cloneUrl);
      await run(["clone", "--filter=blob:none", "--no-checkout", authed, dir]);
      await run(["checkout", defaultBranch], dir);
    } else {
      const authed = await tokenizedUrl(cloneUrl);
      // Fetch via a one-shot URL override; the stored remote stays clean.
      await run(["fetch", authed, defaultBranch], dir);
      await run(["reset", "--hard", `FETCH_HEAD`], dir);
    }
    return dir;
  }

  async function currentSha(dir: string): Promise<string> {
    return (await run(["rev-parse", "HEAD"], dir)).trim();
  }

  async function recentCommitMessages(dir: string, count: number): Promise<string[]> {
    const out = await run(["log", `--format=%s`, `-n`, String(count)], dir);
    return out.split("\n").filter(Boolean);
  }

  async function readFileIfPresent(dir: string, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(dir, relPath), "utf8");
    } catch {
      return null;
    }
  }

  /** Safety-checked worktree path for repo files (blocks traversal). */
  function safeRepoPath(dir: string, relPath: string): string | null {
    const target = path.resolve(dir, relPath);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      return null;
    }
    return target;
  }

  async function createWorkBranch(dir: string, name: string): Promise<void> {
    await run(["checkout", "-B", name], dir);
  }

  async function commitAll(dir: string, message: string, authorName: string, authorEmail: string): Promise<boolean> {
    const status = await run(["status", "--porcelain"], dir);
    if (!status.trim()) {
      return false;
    }
    await run(["add", "-A"], dir);
    await run(["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", message], dir);
    return true;
  }

  async function pushBranch(repoId: string, dir: string, cloneUrl: string, branch: string): Promise<void> {
    const authed = await tokenizedUrl(cloneUrl);
    try {
      await run(["push", authed, `HEAD:refs/heads/${branch}`], dir);
    } catch (err) {
      logger.warn(`TeamAuto: push failed for ${repoId}#${branch}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** Deterministic worktree dir (relative name) for a TeamAuto write task. */
  function taskWorktreeDirName(repoId: string, taskId: string): string {
    return `${teamAutoProjectDir(repoId)}__task-${taskId.replace(/[^\w-]/g, "")}`;
  }

  function taskBranchName(taskId: string): string {
    return `teamclaw/task-${taskId.replace(/[^\w-]/g, "")}`;
  }

  // ---------- in-use sentinel (#173 follow-up 2) ----------

  // The lock lives in the per-worktree git ADMIN dir, never inside the worktree
  // tree: a file in the tree would dirty `git status --porcelain` and wedge the
  // GC dirty guard. The admin dir is removed together with the worktree.
  const TASK_LOCK_NAME = "teamclaw-task-lock.json";

  async function taskLockPath(wtPath: string): Promise<string | null> {
    try {
      const out = (await run(["rev-parse", "--git-dir"], wtPath)).trim();
      return path.join(path.resolve(wtPath, out), TASK_LOCK_NAME);
    } catch {
      return null;
    }
  }

  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: alive but owned by another user - treat as in use.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function writeTaskLock(wtPath: string): Promise<void> {
    const lockPath = await taskLockPath(wtPath);
    if (!lockPath) {
      return;
    }
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => undefined);
  }

  /**
   * Live foreign controller holding this worktree, or null. Covers two
   * controllers sharing one projects/ tree: whoever created/resumed the
   * worktree last recorded its pid; GC (a different live pid) must not rip the
   * tree out from under it. Our OWN pid never blocks (we are the GC). An
   * orphaned worker process is not visible from the controller - the dirty
   * guard remains that case's backstop (fails toward keep).
   */
  async function worktreeInUseBy(wtPath: string): Promise<number | null> {
    const lockPath = await taskLockPath(wtPath);
    if (!lockPath) {
      return null;
    }
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: number };
      const pid = Number(lock.pid);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
        return pid;
      }
    } catch {
      // missing/corrupt lock - cannot prove in-use; proceed.
    }
    return null;
  }

  /**
   * Collaboration contract: write tasks execute in a dedicated git worktree
   * branched from HEAD. Reuses an existing worktree (resume-safe) so the
   * checkpoint/retry path lands in the same tree.
   */
  async function ensureTaskWorktree(repoId: string, taskId: string): Promise<string> {
    const base = await repoDir(repoId);
    const wtName = taskWorktreeDirName(repoId, taskId);
    // wtName carries the teamauto/ level for the REL path; the physical dir is
    // a SIBLING of the base checkout (path.join would nest teamauto/ twice).
    const wtPath = path.join(path.dirname(base), path.basename(wtName));
    if (!(await fs.access(path.join(wtPath, ".git")).then(() => true, () => false))) {
      await run(["worktree", "add", "-b", taskBranchName(taskId), wtPath, "HEAD"], base);
      logger.warn(`TeamAuto: worktree ${wtName} (branch ${taskBranchName(taskId)}) for ${taskId}`);
    }
    // Refresh the in-use sentinel on create AND resume (#173 follow-up 2).
    await writeTaskLock(wtPath);
    return wtPath;
  }

  /** Remove a task worktree and its local branch (terminal cleanup). */
  async function removeTaskWorktree(repoId: string, taskId: string): Promise<void> {
    const base = await repoDir(repoId);
    const wtName = taskWorktreeDirName(repoId, taskId);
    const wtPath = path.join(path.dirname(base), path.basename(wtName));
    try {
      if (await fs.access(wtPath).then(() => true, () => false)) {
        await run(["worktree", "remove", "--force", wtPath], base).catch(async () => {
          // Not a registered worktree anymore (stale admin dir / manual mv):
          // prune registrations and delete the directory directly.
          await run(["worktree", "prune"], base).catch(() => undefined);
          await fs.rm(wtPath, { recursive: true, force: true });
        });
      }
      await run(["branch", "-D", taskBranchName(taskId)], base).catch(() => undefined);
    } catch (err) {
      logger.warn(`TeamAuto: worktree cleanup failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Terminal-state removal with a delivery-safety check: delete the task
   * worktree only when its work is either already on the remote (branch tip
   * matches) or nonexistent (no commits of its own). Undelivered local work
   * is retained and reported - never silently destroyed.
   */
  async function safeRemoveTaskWorktree(
    repoId: string,
    taskId: string,
    deliveryOracle?: TaskDeliveryOracle,
    targetClosedOracle?: TaskTargetClosedOracle,
    isUnknownTask?: (taskId: string) => boolean,
  ): Promise<{ removed: boolean; reason: string }> {
    const base = await repoDir(repoId);
    const wtName = taskWorktreeDirName(repoId, taskId);
    const wtPath = path.join(path.dirname(base), path.basename(wtName));
    const branch = taskBranchName(taskId);
    if (!(await fs.access(wtPath).then(() => true, () => false))) {
      // Review F4: the dir is gone but a stale local branch can survive an
      // earlier removal whose branch -D failed. Reap it when the remote tip
      // still matches (work provably on the remote); otherwise leave it.
      try {
        const refs = await run(["ls-remote", "origin", `refs/heads/${branch}`], base);
        const remoteTip = refs.split("\t")[0]?.trim() ?? "";
        const localTip = remoteTip ? (await run(["rev-parse", branch], base).catch(() => "")).trim() : "";
        if (remoteTip && localTip === remoteTip) {
          await run(["branch", "-D", branch], base);
          return { removed: true, reason: "worktree already gone; reaped stale branch (tip matches remote)" };
        }
      } catch { /* conservative: leave the branch */ }
      return { removed: false, reason: "already gone" };
    }
    try {
      // #173 follow-up 2: in-use sentinel - a live foreign controller recorded
      // in the task lock owns this tree; never remove under it.
      const inUsePid = await worktreeInUseBy(wtPath);
      if (inUsePid !== null) {
        return { removed: false, reason: `retained: in use by live process (pid ${inUsePid})` };
      }
      // #gc3 (user policy 2026-11-14: "全删"): a worktree whose task has NO
      // record left in team-state (task history pruned) can never be judged
      // by delivery/target oracles and was retained forever. The owner
      // ruled: delete outright, no archive. Still placed AFTER the in-use
      // sentinel - a live foreign controller may be finishing work in it.
      if (isUnknownTask?.(taskId)) {
        await removeTaskWorktree(repoId, taskId);
        return { removed: true, reason: "orphaned: no task record (delete policy)" };
      }
      // #orphan-gc: the target issue/PR is CLOSED - no delivery this worktree
      // could ever produce would be wanted (the issue was fixed/rejected
      // elsewhere, the PR superseded). This is the authoritative orphan
      // signal: it overrides the dirty guard, because "uncommitted work"
      // toward a closed target has no future. Placed AFTER the in-use check -
      // a live foreign controller may still be finishing a delivery race.
      if (targetClosedOracle) {
        const closed = await targetClosedOracle(repoId, taskId).catch(() => null);
        if (closed === true) {
          await removeTaskWorktree(repoId, taskId);
          return { removed: true, reason: "orphaned: target issue/PR closed (dirty tree dropped - no possible delivery)" };
        }
      }
      // #173 follow-up 1: the dirty guard must cover BOTH removal paths. The
      // tip-match branch used to remove without any dirty check, silently
      // destroying post-delivery worker edits (small window, but real).
      const dirty = await run(["status", "--porcelain"], wtPath).catch(() => "x");
      if (dirty.trim()) {
        return { removed: false, reason: "retained: dirty worktree (uncommitted changes)" };
      }
      const remoteRefs = await run(["ls-remote", "origin", `refs/heads/${branch}`], base);
      const remoteTip = remoteRefs.split("\t")[0]?.trim() ?? "";
      if (remoteTip) {
        const localTip = (await run(["rev-parse", branch], base).catch(() => "")).trim();
        if (localTip && localTip === remoteTip) {
          await removeTaskWorktree(repoId, taskId);
          return { removed: true, reason: "delivered (branch tip on remote)" };
        }
        return { removed: false, reason: "retained: local branch ahead of pushed tip (unpushed work)" };
      }
      // Branch never pushed (or deleted post-merge): the worktree is the only
      // copy. Keep it when it carries its own commits; drop it when the worker
      // never committed anything at all.
      const info = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], base).catch(() => "");
      const defaultBranch = info.trim().replace(/^origin\//, "") || "main";
      const own = await run(["rev-list", "--count", `HEAD`, "--not", `origin/${defaultBranch}`], wtPath).catch(() => null);
      if (own === null) {
        // Cannot prove emptiness (fetch state unknown) - conservative keep.
        return { removed: false, reason: "retained: could not verify emptiness" };
      }
      if (Number(own.trim()) === 0) {
        await removeTaskWorktree(repoId, taskId);
        return { removed: true, reason: "no own commits, branch never pushed" };
      }
      // #173 follow-up 5: squash-merge + branch deletion re-leak. own > 0 with
      // an empty ls-remote is ALSO the shape of a delivered-via-squash PR whose
      // branch was auto-deleted (shas unreachable, content merged). Ask the
      // oracle for positive proof (merged PR with exactly this head tip);
      // anything less retains the worktree.
      if (deliveryOracle) {
        const headTip = (await run(["rev-parse", "HEAD"], wtPath).catch(() => "")).trim();
        if (headTip && (await deliveryOracle(repoId, taskId, headTip).catch(() => false))) {
          await removeTaskWorktree(repoId, taskId);
          return { removed: true, reason: "delivered via merged PR (squash-merge, head tip matches)" };
        }
      }
      return { removed: false, reason: `retained: ${own.trim()} unpushed own commit(s)` };
    } catch (err) {
      return { removed: false, reason: `retained: gc check failed (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  /**
   * Reconcile leftover task worktrees on disk: for every `<slug>__task-*`
   * sibling whose task is terminal (or unknown), apply the delivery-safety
   * removal. Heals the historical backlog that pre-dates terminal cleanup.
   */
  async function gcTaskWorktrees(
    repoId: string,
    isTerminal: (taskId: string) => boolean,
    deliveryOracle?: TaskDeliveryOracle,
    targetClosedOracle?: TaskTargetClosedOracle,
    isUnknownTask?: (taskId: string) => boolean,
  ): Promise<{ removed: string[]; retained: { taskId: string; reason: string }[]; stale: number }> {
    const base = await repoDir(repoId);
    const siblings = path.dirname(base);
    // taskWorktreeDirName(repoId, "x") = "teamauto/<slug>__task-x"; the
    // physical dir is its basename, so the scan prefix is basename minus "x".
    const withSentinel = path.basename(taskWorktreeDirName(repoId, "x"));
    const prefix = withSentinel.slice(0, withSentinel.length - 1);
    const removed: string[] = [];
    const retained: { taskId: string; reason: string }[] = [];
    let stale = 0;
    const apply = async (taskId: string): Promise<void> => {
      const r = await safeRemoveTaskWorktree(repoId, taskId, deliveryOracle, targetClosedOracle, isUnknownTask);
      if (r.removed) {
        removed.push(taskId);
        logger.warn(`TeamAuto: worktree GC removed ${taskId} (${r.reason})`);
      } else if (r.reason.includes("already gone")) {
        // #173 QA finding: dir already gone but a stale local branch survives
        // (squash-merge leak face) - previously invisible in both the log and
        // the activity line. Counted + logged now.
        stale += 1;
        logger.warn(`TeamAuto: worktree GC ${taskId}: worktree already gone (stale branch may remain)`);
      } else {
        retained.push({ taskId, reason: r.reason });
        logger.warn(`TeamAuto: worktree GC kept ${taskId}: ${r.reason}`);
      }
    };
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(siblings)).filter((e) => e.startsWith(prefix));
    } catch {
      entries = [];
    }
    const dirTaskIds: string[] = [];
    for (const entry of entries) {
      const taskId = entry.slice(prefix.length);
      if (!taskId) continue;
      dirTaskIds.push(taskId);
      if (!isTerminal(taskId)) continue; // active/resumable task - worktree is resume state
      await apply(taskId);
    }
    // #173 QA finding: BRANCH-ONLY leaks - the worktree dir is already gone
    // but the local teamclaw/task-* branch survives (e.g. an earlier removal
    // whose branch -D failed, or the squash-merge stale-branch face). The
    // directory enumeration above never sees them; enumerate the branches too
    // so safeRemoveTaskWorktree can reap (tip on remote) or at least surface
    // them in the stale count instead of leaking silently forever.
    const branchPrefix = `${TEAMCLAW_BRANCH_PREFIX}task-`;
    let branchRefs: string[] = [];
    try {
      branchRefs = (await run(["for-each-ref", "--format=%(refname:short)", `refs/heads/${branchPrefix}*`], base))
        .split("\n")
        .filter(Boolean);
    } catch {
      branchRefs = [];
    }
    const seen = new Set(dirTaskIds);
    for (const ref of branchRefs) {
      const taskId = ref.slice(branchPrefix.length);
      if (!taskId || seen.has(taskId)) continue;
      if (!isTerminal(taskId)) continue;
      await apply(taskId);
    }
    return { removed, retained, stale };
  }

  function taskWorktreeRelDir(repoId: string, taskId: string): string {
    return taskWorktreeDirName(repoId, taskId);
  }

  /** True when HEAD has commits beyond the base branch (worktree delivery). */
  async function branchHasCommits(dir: string, baseBranch: string): Promise<boolean> {
    try {
      const out = await run(["rev-list", "--count", "HEAD", "--not", baseBranch], dir);
      return Number(out.trim()) > 0;
    } catch {
      // Base branch name unknown/unfetched - fall back to diff against first parent chain
      try {
        const root = await run(["rev-list", "--max-parents=0", "HEAD"], dir);
        return root.trim().length > 0;
      } catch {
        return false;
      }
    }
  }

  return { ensureCloned, currentSha, recentCommitMessages, readFileIfPresent, safeRepoPath, createWorkBranch, commitAll, pushBranch, ensureTaskWorktree, removeTaskWorktree, safeRemoveTaskWorktree, gcTaskWorktrees, taskWorktreeRelDir, taskBranchName, branchHasCommits, repoDir };
}

export type TeamAutoRepoSync = ReturnType<typeof createRepoSync>;
