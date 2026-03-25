import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PluginLogger } from "../api.js";
import type { GitRepoState, PluginConfig, RepoSyncInfo } from "./types.js";
import { resolveDefaultOpenClawWorkspaceDir } from "./openclaw-workspace.js";

const TEAMCLAW_IMPORT_REF_PREFIX = "refs/teamclaw/imports";
const TEAMCLAW_RUNTIME_EXCLUDES = [
  ".openclaw/",
  ".clawhub/",
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "SOUL.md",
  "skills/",
  "TOOLS.md",
  "USER.md",
];

const repoLocks = new Map<string, Promise<void>>();

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RepoImportResult = {
  merged: boolean;
  fastForwarded: boolean;
  alreadyUpToDate: boolean;
  repo: GitRepoState;
  message: string;
};

type RepoSyncResult = {
  repo: GitRepoState;
  message: string;
};

type RepoPublishResult = {
  repo: GitRepoState;
  published: boolean;
  message: string;
};

export async function ensureControllerGitRepo(
  config: PluginConfig,
  logger: PluginLogger,
): Promise<GitRepoState | null> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  return await withRepoLock(workspaceDir, async () => ensureControllerGitRepoUnlocked(config, logger, workspaceDir));
}

async function ensureControllerGitRepoUnlocked(
  config: PluginConfig,
  logger: PluginLogger,
  workspaceDir: string,
): Promise<GitRepoState | null> {
  if (!config.gitEnabled) {
    return null;
  }

  await fs.mkdir(workspaceDir, { recursive: true });

  const gitDir = path.join(workspaceDir, ".git");
  const repoAlreadyExists = await pathExists(gitDir);

  if (!repoAlreadyExists) {
    logger.info(`TeamClaw: initializing git workspace repo at ${workspaceDir}`);
    await runGit(["init"], { cwd: workspaceDir });
  }

  await configureGitIdentity(workspaceDir, config);
  await configureGitWorkspaceExcludes(workspaceDir);
  await ensureBranchHead(workspaceDir, config.gitDefaultBranch);

  if (!repoAlreadyExists && !await hasHeadCommit(workspaceDir)) {
    await runGit(["add", "-A"], { cwd: workspaceDir });
    await runGit(["commit", "--allow-empty", "-m", "chore: bootstrap TeamClaw workspace"], { cwd: workspaceDir });
  }

  let remoteReady = false;
  if (config.gitRemoteUrl) {
    remoteReady = await ensureOriginRemote(workspaceDir, config, logger);
  }

  return await readGitRepoState(config, remoteReady);
}

export function buildRepoSyncInfo(
  repo: GitRepoState | null | undefined,
  sharedWorkspace: boolean,
): RepoSyncInfo | undefined {
  if (!repo?.enabled) {
    return undefined;
  }

  if (sharedWorkspace) {
    return {
      enabled: true,
      mode: "shared",
      defaultBranch: repo.defaultBranch,
      headCommit: repo.headCommit,
      headSummary: repo.headSummary,
    };
  }

  if (repo.remoteReady && repo.remoteUrl) {
    return {
      enabled: true,
      mode: "remote",
      defaultBranch: repo.defaultBranch,
      remoteUrl: repo.remoteUrl,
      headCommit: repo.headCommit,
      headSummary: repo.headSummary,
    };
  }

  return {
    enabled: true,
    mode: "bundle",
    defaultBranch: repo.defaultBranch,
    bundleUrl: "/api/v1/repo/bundle",
    importUrl: "/api/v1/repo/import",
    headCommit: repo.headCommit,
    headSummary: repo.headSummary,
  };
}

export async function exportControllerGitBundle(
  config: PluginConfig,
  logger: PluginLogger,
): Promise<{ repo: GitRepoState; data: Buffer; filename: string }> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  return await withRepoLock(workspaceDir, async () => {
    const repo = await ensureControllerGitRepoUnlocked(config, logger, workspaceDir);
    if (!repo?.enabled) {
      throw new Error("TeamClaw git collaboration is disabled");
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-bundle-"));
    const bundlePath = path.join(tempDir, "workspace.bundle");

    try {
      await runGit(["bundle", "create", bundlePath, config.gitDefaultBranch], { cwd: workspaceDir });
      const data = await fs.readFile(bundlePath);
      return {
        repo,
        data,
        filename: `teamclaw-${sanitizeRefPart(config.teamName)}-${sanitizeRefPart(config.gitDefaultBranch)}.bundle`,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
        // best-effort temp cleanup
      });
    }
  });
}

export async function importControllerGitBundle(
  config: PluginConfig,
  logger: PluginLogger,
  bundle: Buffer,
  meta: {
    taskId?: string;
    workerId?: string;
  } = {},
): Promise<RepoImportResult> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  return await withRepoLock(workspaceDir, async () => {
    const repo = await ensureControllerGitRepoUnlocked(config, logger, workspaceDir);
    if (!repo?.enabled) {
      throw new Error("TeamClaw git collaboration is disabled");
    }

    const refreshedBeforeImport = await readGitRepoState(config, repo.remoteReady);
    if (refreshedBeforeImport.dirty) {
      return {
        merged: false,
        fastForwarded: false,
        alreadyUpToDate: false,
        repo: refreshedBeforeImport,
        message: "Controller workspace has uncommitted changes; refusing bundle import until the shared repo is clean.",
      };
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-import-"));
    const bundlePath = path.join(tempDir, "worker.bundle");
    const importRef = `${TEAMCLAW_IMPORT_REF_PREFIX}/${sanitizeRefPart(meta.workerId ?? "worker")}-${Date.now().toString(36)}`;

    try {
      await fs.writeFile(bundlePath, bundle);
      await runGit(["fetch", bundlePath, `refs/heads/${config.gitDefaultBranch}:${importRef}`], { cwd: workspaceDir });

      const importedCommit = await revParse(workspaceDir, importRef);
      const currentHead = await revParseOrEmpty(workspaceDir, "HEAD");
      if (currentHead && currentHead === importedCommit) {
        const currentRepo = await readGitRepoState(config, repo.remoteReady);
        return {
          merged: false,
          fastForwarded: false,
          alreadyUpToDate: true,
          repo: currentRepo,
          message: "Controller repo already includes the worker commit.",
        };
      }

      let fastForwarded = true;
      const ffResult = await tryGit(["merge", "--ff-only", importRef], { cwd: workspaceDir });
      if (ffResult.exitCode !== 0) {
        fastForwarded = false;
        const mergeResult = await tryGit(["merge", "--no-edit", importRef], { cwd: workspaceDir });
        if (mergeResult.exitCode !== 0) {
          await abortMergeIfNeeded(workspaceDir);
          const currentRepo = await readGitRepoState(config, repo.remoteReady);
          return {
            merged: false,
            fastForwarded: false,
            alreadyUpToDate: false,
            repo: currentRepo,
            message: `Failed to merge worker bundle for task ${meta.taskId ?? "unknown"}: ${formatCommandError("git merge", mergeResult)}`,
          };
        }
      }

      const currentRepo = await readGitRepoState(config, repo.remoteReady);
      return {
        merged: true,
        fastForwarded,
        alreadyUpToDate: false,
        repo: currentRepo,
        message: fastForwarded
          ? `Imported worker bundle from ${meta.workerId ?? "worker"} with a fast-forward update.`
          : `Imported worker bundle from ${meta.workerId ?? "worker"} with a merge commit.`,
      };
    } finally {
      await tryGit(["update-ref", "-d", importRef], { cwd: workspaceDir });
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
        // best-effort temp cleanup
      });
    }
  });
}

export async function syncWorkerRepo(
  config: PluginConfig,
  logger: PluginLogger,
  controllerUrl: string,
  repoInfo: RepoSyncInfo,
): Promise<RepoSyncResult> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  return await withRepoLock(workspaceDir, async () => syncWorkerRepoUnlocked(config, logger, controllerUrl, repoInfo, workspaceDir));
}

async function syncWorkerRepoUnlocked(
  config: PluginConfig,
  logger: PluginLogger,
  controllerUrl: string,
  repoInfo: RepoSyncInfo,
  workspaceDir: string,
): Promise<RepoSyncResult> {
  await fs.mkdir(workspaceDir, { recursive: true });
 
  if (repoInfo.mode === "shared") {
    if (!await pathExists(path.join(workspaceDir, ".git"))) {
      throw new Error("Shared workspace repo is missing its .git directory");
    }
    const repo = await readGitRepoState(config, false);
    return {
      repo,
      message: `Using shared git workspace on branch ${repo.defaultBranch}.`,
    };
  }

  if (!await pathExists(path.join(workspaceDir, ".git"))) {
    await runGit(["init"], { cwd: workspaceDir });
    await ensureBranchHead(workspaceDir, repoInfo.defaultBranch);
  }
  await configureGitIdentity(workspaceDir, config);
  await configureGitWorkspaceExcludes(workspaceDir);

  const localRepo = await readGitRepoState(config, false);
  if (localRepo.dirty) {
    throw new Error("Worker workspace has uncommitted changes; refusing repo sync until the checkout is clean");
  }

  if (repoInfo.mode === "remote") {
    if (!repoInfo.remoteUrl) {
      throw new Error("Remote repo sync requested but no remoteUrl was provided");
    }
    await runGit(["remote", "remove", "origin"], { cwd: workspaceDir }).catch(() => {
      // ignore missing remote
    });
    await runGit(["remote", "add", "origin", repoInfo.remoteUrl], { cwd: workspaceDir });
    await runGit(["fetch", "origin", repoInfo.defaultBranch], { cwd: workspaceDir });
    await checkoutTrackingBranch(workspaceDir, repoInfo.defaultBranch, `refs/remotes/origin/${repoInfo.defaultBranch}`);
    const mergeResult = await tryGit(["merge", "--ff-only", `refs/remotes/origin/${repoInfo.defaultBranch}`], { cwd: workspaceDir });
    if (mergeResult.exitCode !== 0) {
      throw new Error(`Failed to fast-forward worker checkout from origin/${repoInfo.defaultBranch}: ${formatCommandError("git merge", mergeResult)}`);
    }
  } else {
    if (!repoInfo.bundleUrl) {
      throw new Error("Bundle repo sync requested but no bundleUrl was provided");
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-worker-sync-"));
    const bundlePath = path.join(tempDir, "controller.bundle");
    try {
      const res = await fetch(resolveApiUrl(repoInfo.bundleUrl, controllerUrl));
      if (!res.ok) {
        throw new Error(`Bundle download failed with status ${res.status}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(bundlePath, buffer);
      await runGit(["fetch", bundlePath, `refs/heads/${repoInfo.defaultBranch}:refs/remotes/teamclaw/${repoInfo.defaultBranch}`], {
        cwd: workspaceDir,
      });
      await checkoutTrackingBranch(workspaceDir, repoInfo.defaultBranch, `refs/remotes/teamclaw/${repoInfo.defaultBranch}`);
      const mergeResult = await tryGit(["merge", "--ff-only", `refs/remotes/teamclaw/${repoInfo.defaultBranch}`], { cwd: workspaceDir });
      if (mergeResult.exitCode !== 0) {
        throw new Error(`Failed to fast-forward worker checkout from the controller bundle: ${formatCommandError("git merge", mergeResult)}`);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
        // best-effort temp cleanup
      });
    }
  }

  const repo = await readGitRepoState(config, repoInfo.mode === "remote");
  return {
    repo,
    message: `Repo sync complete on ${repoInfo.mode} mode (${repo.defaultBranch}).`,
  };
}

export async function publishWorkerRepo(
  config: PluginConfig,
  logger: PluginLogger,
  controllerUrl: string,
  repoInfo: RepoSyncInfo,
  meta: {
    taskId: string;
    workerId: string;
    role?: string;
  },
): Promise<RepoPublishResult> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  return await withRepoLock(workspaceDir, async () => publishWorkerRepoUnlocked(config, logger, controllerUrl, repoInfo, meta, workspaceDir));
}

async function publishWorkerRepoUnlocked(
  config: PluginConfig,
  logger: PluginLogger,
  controllerUrl: string,
  repoInfo: RepoSyncInfo,
  meta: {
    taskId: string;
    workerId: string;
    role?: string;
  },
  workspaceDir: string,
): Promise<RepoPublishResult> {
  if (repoInfo.mode === "shared") {
    const repo = await readGitRepoState(config, false);
    return {
      repo,
      published: false,
      message: "Shared workspace repo does not require controller-mediated publish.",
    };
  }

  if (!await pathExists(path.join(workspaceDir, ".git"))) {
    throw new Error("Worker repo is not initialized");
  }

  await configureGitIdentity(workspaceDir, config);
  await configureGitWorkspaceExcludes(workspaceDir);

  const dirtyCheck = await runGit(["status", "--porcelain"], { cwd: workspaceDir });
  if (dirtyCheck.stdout.trim()) {
    await runGit(["add", "-A"], { cwd: workspaceDir });
    const commitMessage = `chore(teamclaw): checkpoint ${meta.taskId} (${meta.role ?? "worker"})`;
    await runGit(["commit", "-m", commitMessage], { cwd: workspaceDir });
  }

  if (repoInfo.mode === "remote") {
    if (!repoInfo.remoteUrl) {
      throw new Error("Remote publish requested but no remoteUrl was provided");
    }

    await runGit(["fetch", "origin", repoInfo.defaultBranch], { cwd: workspaceDir });
    const remoteRef = `refs/remotes/origin/${repoInfo.defaultBranch}`;
    if (await revParseOrEmpty(workspaceDir, remoteRef)) {
      const ffResult = await tryGit(["merge", "--ff-only", remoteRef], { cwd: workspaceDir });
      if (ffResult.exitCode !== 0) {
        const mergeResult = await tryGit(["merge", "--no-edit", remoteRef], { cwd: workspaceDir });
        if (mergeResult.exitCode !== 0) {
          await abortMergeIfNeeded(workspaceDir);
          throw new Error(`Failed to merge latest remote changes before push: ${formatCommandError("git merge", mergeResult)}`);
        }
      }
    }

    await runGit(["push", "origin", `HEAD:refs/heads/${repoInfo.defaultBranch}`], { cwd: workspaceDir });
    const repo = await readGitRepoState(config, true);
    return {
      repo,
      published: true,
      message: `Pushed worker changes for task ${meta.taskId} to origin/${repoInfo.defaultBranch}.`,
    };
  }

  if (!repoInfo.importUrl) {
    throw new Error("Bundle publish requested but no importUrl was provided");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-worker-publish-"));
  const bundlePath = path.join(tempDir, "worker.bundle");
  try {
    await runGit(["bundle", "create", bundlePath, repoInfo.defaultBranch], { cwd: workspaceDir });
    const bundle = await fs.readFile(bundlePath);
    const importUrl = new URL(resolveApiUrl(repoInfo.importUrl, controllerUrl));
    importUrl.searchParams.set("taskId", meta.taskId);
    importUrl.searchParams.set("workerId", meta.workerId);
    if (meta.role) {
      importUrl.searchParams.set("role", meta.role);
    }

    const res = await fetch(importUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bundle import failed with status ${res.status}: ${text}`);
    }

    const payload = await res.json() as { repo?: GitRepoState; message?: string };
    return {
      repo: payload.repo ?? await readGitRepoState(config, false),
      published: true,
      message: payload.message ?? `Imported bundle for task ${meta.taskId}.`,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      // best-effort temp cleanup
    });
  }
}

export async function readGitRepoState(
  config: PluginConfig,
  remoteReady: boolean,
): Promise<GitRepoState> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  const headCommit = await revParseOrEmpty(workspaceDir, "HEAD");
  const headSummary = headCommit
    ? (await runGit(["log", "-1", "--pretty=%s"], { cwd: workspaceDir })).stdout.trim() || undefined
    : undefined;
  const dirty = await hasDirtyWorktree(workspaceDir);

  return {
    enabled: config.gitEnabled,
    mode: remoteReady && config.gitRemoteUrl ? "remote" : "bundle",
    defaultBranch: config.gitDefaultBranch,
    remoteUrl: config.gitRemoteUrl || undefined,
    remoteReady,
    headCommit: headCommit || undefined,
    headSummary,
    dirty,
    lastPreparedAt: Date.now(),
  };
}

async function ensureOriginRemote(
  workspaceDir: string,
  config: PluginConfig,
  logger: PluginLogger,
): Promise<boolean> {
  if (!config.gitRemoteUrl) {
    return false;
  }

  const currentOrigin = await runGit(["remote", "get-url", "origin"], { cwd: workspaceDir }).catch(() => null);
  if (!currentOrigin) {
    await runGit(["remote", "add", "origin", config.gitRemoteUrl], { cwd: workspaceDir });
  } else if (currentOrigin.stdout.trim() !== config.gitRemoteUrl) {
    await runGit(["remote", "set-url", "origin", config.gitRemoteUrl], { cwd: workspaceDir });
  }

  const remoteHeads = await tryGit(["ls-remote", "--heads", "origin", config.gitDefaultBranch], { cwd: workspaceDir });
  if (remoteHeads.exitCode === 0 && remoteHeads.stdout.trim()) {
    return true;
  }

  const pushResult = await tryGit(["push", "-u", "origin", `HEAD:refs/heads/${config.gitDefaultBranch}`], { cwd: workspaceDir });
  if (pushResult.exitCode === 0) {
    return true;
  }

  logger.warn(`TeamClaw: configured git remote is not ready; falling back to bundle sync. ${formatCommandError("git push", pushResult)}`);
  return false;
}

async function checkoutTrackingBranch(workspaceDir: string, branch: string, trackingRef: string): Promise<void> {
  const currentBranch = await currentBranchName(workspaceDir);
  if (!currentBranch) {
    await runGit(["checkout", "-f", "-B", branch, trackingRef], { cwd: workspaceDir });
    return;
  }

  if (currentBranch !== branch) {
    const switchResult = await tryGit(["checkout", "-f", branch], { cwd: workspaceDir });
    if (switchResult.exitCode !== 0) {
      await runGit(["checkout", "-f", "-B", branch, trackingRef], { cwd: workspaceDir });
    }
  }
}

async function configureGitIdentity(workspaceDir: string, config: PluginConfig): Promise<void> {
  const currentName = (await tryGit(["config", "--get", "user.name"], { cwd: workspaceDir })).stdout.trim();
  if (currentName !== config.gitAuthorName) {
    await runGit(["config", "user.name", config.gitAuthorName], { cwd: workspaceDir });
  }

  const currentEmail = (await tryGit(["config", "--get", "user.email"], { cwd: workspaceDir })).stdout.trim();
  if (currentEmail !== config.gitAuthorEmail) {
    await runGit(["config", "user.email", config.gitAuthorEmail], { cwd: workspaceDir });
  }
}

async function configureGitWorkspaceExcludes(workspaceDir: string): Promise<void> {
  const gitDir = path.join(workspaceDir, ".git");
  if (!await pathExists(gitDir)) {
    return;
  }

  const infoDir = path.join(gitDir, "info");
  await fs.mkdir(infoDir, { recursive: true });
  const excludePath = path.join(infoDir, "exclude");
  const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missingPatterns = TEAMCLAW_RUNTIME_EXCLUDES.filter((pattern) => !existingLines.has(pattern));
  if (missingPatterns.length === 0) {
    return;
  }

  const prefix = existing.length === 0 ? "" : (existing.endsWith("\n") ? "" : "\n");
  const header = existing.includes("# TeamClaw runtime workspace noise") ? "" : "# TeamClaw runtime workspace noise\n";
  await fs.writeFile(excludePath, `${existing}${prefix}${header}${missingPatterns.join("\n")}\n`);
}

async function ensureBranchHead(workspaceDir: string, branch: string): Promise<void> {
  const hasGit = await pathExists(path.join(workspaceDir, ".git"));
  if (!hasGit) {
    return;
  }

  await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: workspaceDir }).catch(() => {
    // symbolic-ref can fail if HEAD is already attached to a branch; ignore
  });
}

async function hasHeadCommit(workspaceDir: string): Promise<boolean> {
  const result = await tryGit(["rev-parse", "--verify", "HEAD"], { cwd: workspaceDir });
  return result.exitCode === 0;
}

async function hasDirtyWorktree(workspaceDir: string): Promise<boolean> {
  if (!await pathExists(path.join(workspaceDir, ".git"))) {
    return false;
  }
  const status = await runGit(["status", "--porcelain"], { cwd: workspaceDir });
  return status.stdout.trim().length > 0;
}

async function revParse(workspaceDir: string, ref: string): Promise<string> {
  const result = await runGit(["rev-parse", ref], { cwd: workspaceDir });
  return result.stdout.trim();
}

async function revParseOrEmpty(workspaceDir: string, ref: string): Promise<string> {
  const result = await tryGit(["rev-parse", ref], { cwd: workspaceDir });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

async function currentBranchName(workspaceDir: string): Promise<string> {
  const result = await tryGit(["branch", "--show-current"], { cwd: workspaceDir });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

async function abortMergeIfNeeded(workspaceDir: string): Promise<void> {
  await tryGit(["merge", "--abort"], { cwd: workspaceDir });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], options: { cwd: string }): Promise<CommandResult> {
  const result = await runCommand("git", args, options);
  if (result.exitCode !== 0) {
    throw new Error(formatCommandError(`git ${args.join(" ")}`, result));
  }
  return result;
}

async function tryGit(args: string[], options: { cwd: string }): Promise<CommandResult> {
  return await runCommand("git", args, options);
}

async function withRepoLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const prior = repoLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => gate);
  repoLocks.set(lockKey, queued);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (repoLocks.get(lockKey) === queued) {
      repoLocks.delete(lockKey);
    }
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 0,
      });
    });
  });
}

function formatCommandError(command: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return `${command}: ${detail}`;
}

function resolveApiUrl(urlOrPath: string | undefined, controllerUrl: string): string {
  if (!urlOrPath) {
    throw new Error("Missing controller API URL");
  }
  return new URL(urlOrPath, controllerUrl).toString();
}

function sanitizeRefPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
