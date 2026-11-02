import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { GithubAuthManager } from "../controller/github-auth.js";
import { repoSlugToDirName, resolveTeamAutoPaths } from "./store.js";

const exec = promisify(execFile);

export const TEAMCLAW_BRANCH_PREFIX = "teamclaw/";

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
    if (await fs.access(path.join(wtPath, ".git")).then(() => true, () => false)) {
      return wtPath; // resume case
    }
    await run(["worktree", "add", "-b", taskBranchName(taskId), wtPath, "HEAD"], base);
    logger.warn(`TeamAuto: worktree ${wtName} (branch ${taskBranchName(taskId)}) for ${taskId}`);
    return wtPath;
  }

  /** Remove a task worktree and its local branch (terminal cleanup). */
  async function removeTaskWorktree(repoId: string, taskId: string): Promise<void> {
    const base = await repoDir(repoId);
    const wtName = taskWorktreeDirName(repoId, taskId);
    const wtPath = path.join(path.dirname(base), wtName);
    try {
      if (await fs.access(wtPath).then(() => true, () => false)) {
        await run(["worktree", "remove", "--force", wtPath], base);
      }
      await run(["branch", "-D", taskBranchName(taskId)], base).catch(() => undefined);
    } catch (err) {
      logger.warn(`TeamAuto: worktree cleanup failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function taskWorktreeRelDir(repoId: string, taskId: string): string {
    return taskWorktreeDirName(repoId, taskId);
  }

  return { ensureCloned, currentSha, recentCommitMessages, readFileIfPresent, safeRepoPath, createWorkBranch, commitAll, pushBranch, ensureTaskWorktree, removeTaskWorktree, taskWorktreeRelDir, taskBranchName, repoDir };
}

export type TeamAutoRepoSync = ReturnType<typeof createRepoSync>;
