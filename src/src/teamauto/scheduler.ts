import { randomBytes } from "node:crypto";

import type { PluginLogger } from "../../api.js";
import type { GithubAuthManager } from "../controller/github-auth.js";
import type { RoleId, TaskInfo, TeamState } from "../types.js";
import { createGithubClient } from "./github-client.js";
import { learnNorms, renderNormsBlock } from "./norms.js";
import { createRepoSync } from "./repo-sync.js";
import { advanceCursors, sweepRepo, type Candidate } from "./scanner.js";
import {
  consumeDailyBudget,
  defaultCursors,
  defaultPolicy,
  loadTeamAutoStore,
  saveTeamAutoStore,
  type TeamAutoRepo,
  type TeamAutoStore,
} from "./store.js";

/**
 * TeamAuto scheduler: per-repo cron sweeps -> TeamClaw tasks -> GitHub
 * write-backs. Fully autonomous per the user's decisions (TEAMAUTO_DESIGN.md):
 * comments/PRs/issues are posted directly; ambiguous work goes through the
 * normal clarification blocking flow.
 */

const MARKER_FOOTER = (role: string) => `\n---\n[teamclaw:${role}] autonomous via TeamClaw`;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Minimal cron: supports minute-step schedules like "star-slash-n" (every n minutes), "@hourly", "@daily", plain-number fallback to minutes. */
export function nextFireMs(schedule: string): number {
  const trimmed = schedule.trim();
  if (trimmed === "@hourly") {
    return 3600_000;
  }
  if (trimmed === "@daily") {
    return 24 * 3600_000;
  }
  const match = trimmed.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (match) {
    return Math.max(1, Number(match[1])) * 60_000;
  }
  const digits = trimmed.match(/\d+/);
  return digits ? Math.max(1, Number(digits[0])) * 60_000 : 30 * 60_000;
}
export type TeamAutoSchedulerDeps = {
  logger: PluginLogger;
  auth: GithubAuthManager;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
  onTasksCreated: () => Promise<void>;
};

export function createTeamAutoScheduler(deps: TeamAutoSchedulerDeps) {
  const { logger, auth } = deps;
  const client = createGithubClient(auth);
  const sync = createRepoSync(auth, logger);
  const timers = new Map<string, NodeJS.Timeout>();
  const sweeping = new Set<string>();
  let running = false;
  let store: TeamAutoStore | null = null;
  let writebackTimer: NodeJS.Timeout | null = null;

  async function ensureStore(): Promise<TeamAutoStore> {
    if (!store) {
      store = await loadTeamAutoStore();
    }
    return store;
  }

  // ---------- public repo management ----------

  async function addRepo(repoId: string, options: { schedule?: string; keywordInclude?: string[]; keywordExclude?: string[] } = {}): Promise<TeamAutoRepo> {
    const s = await ensureStore();
    const normalized = repoId.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(normalized)) {
      throw new Error(`invalid repo id: ${repoId} (expected owner/repo)`);
    }
    if (s.repos.some((r) => r.id === normalized)) {
      throw new Error(`${normalized} is already bound`);
    }
    const [owner, name] = normalized.split("/");
    const info = await client.getRepoInfo(owner, name);
    if (!info.permissions.pull) {
      throw new Error(`no read access to ${normalized}`);
    }
    const repo: TeamAutoRepo = {
      id: normalized,
      enabled: true,
      schedule: options.schedule?.trim() || "*/30 * * * *",
      addedAt: Date.now(),
      lastSweepAt: 0,
      lastSweepSummary: null,
      pausedReason: null,
      dryRunDone: !s.budget.firstSweepDryRun,
      policy: defaultPolicy(),
      cursors: defaultCursors(),
      norms: null,
    };
    if (options.keywordInclude?.length) {
      repo.policy.keywordFilter.include = options.keywordInclude;
    }
    if (options.keywordExclude?.length) {
      repo.policy.keywordFilter.exclude = options.keywordExclude;
    }
    // Learn norms eagerly so the very first sweep already carries them.
    try {
      repo.norms = await learnNorms(repo, client, sync, info.cloneUrl, info.defaultBranch);
    } catch (err) {
      logger.warn(`TeamAuto: norms learning deferred for ${normalized}: ${err instanceof Error ? err.message : String(err)}`);
    }
    s.repos.push(repo);
    await saveTeamAutoStore(s);
    scheduleRepo(repo);
    logger.info(`TeamAuto: bound ${normalized} (schedule ${repo.schedule}${repo.dryRunDone ? "" : ", first sweep dry-run"})`);
    return repo;
  }

  async function removeRepo(repoId: string): Promise<void> {
    const s = await ensureStore();
    s.repos = s.repos.filter((r) => r.id !== repoId);
    await saveTeamAutoStore(s);
    const timer = timers.get(repoId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(repoId);
    }
  }

  async function setRepoEnabled(repoId: string, enabled: boolean): Promise<void> {
    const s = await ensureStore();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) {
      throw new Error(`${repoId} not bound`);
    }
    repo.enabled = enabled;
    repo.pausedReason = enabled ? null : (repo.pausedReason ?? "disabled by user");
    await saveTeamAutoStore(s);
    if (enabled) {
      scheduleRepo(repo);
    }
  }

  async function updateRepo(repoId: string, patch: { schedule?: string; maxTasksPerSweep?: number; fullReview?: "off" | "weekly" | "daily"; takeOwnership?: boolean } = {}): Promise<TeamAutoRepo> {
    const s = await ensureStore();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) {
      throw new Error(`${repoId} not bound`);
    }
    if (patch.schedule?.trim()) {
      repo.schedule = patch.schedule.trim();
    }
    if (typeof patch.maxTasksPerSweep === "number" && patch.maxTasksPerSweep > 0) {
      repo.policy.maxTasksPerSweep = Math.min(20, Math.floor(patch.maxTasksPerSweep));
    }
    if (patch.fullReview) {
      repo.policy.actions.fullReview = patch.fullReview;
    }
    if (typeof patch.takeOwnership === "boolean") {
      repo.policy.actions.takeOwnership = patch.takeOwnership;
    }
    await saveTeamAutoStore(s);
    scheduleRepo(repo);
    return repo;
  }

  async function runSweepNow(repoId: string, force = true): Promise<string> {
    const s = await ensureStore();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) {
      throw new Error(`${repoId} not bound`);
    }
    return runSweep(repo, force);
  }

  // ---------- sweep engine ----------

  async function runSweep(repo: TeamAutoRepo, force: boolean): Promise<string> {
    const s = await ensureStore();
    if (sweeping.has(repo.id)) {
      return "sweep already in progress";
    }
    sweeping.add(repo.id);
    try {
      const { candidates, issues, pulls } = await sweepRepo(repo, client);
      const dryRun = !repo.dryRunDone && s.budget.firstSweepDryRun;
      if (!dryRun) {
        // Advance only for acting sweeps: a dry-run must leave the cursors
        // untouched so the reported actions are actually performed next time
        // instead of being marked as already-seen.
        advanceCursors(repo, issues, pulls);
      }
      const capped = candidates.slice(0, repo.policy.maxTasksPerSweep);
      let created = 0;
      const summary: string[] = [`found ${candidates.length} candidate(s)`];

      if (capped.length && dryRun) {
        summary.push(...capped.map((c) => `DRY-RUN would ${c.kind}: ${c.title}`));
        repo.dryRunDone = true;
        repo.lastSweepSummary = `dry-run: ${summary.join("; ")}`;
      } else if (capped.length) {
        if (!consumeDailyBudget(s, capped.length)) {
          summary.push("skipped: daily task budget exhausted");
        } else {
          for (const candidate of capped) {
            const taskId = enqueueCandidate(repo, candidate);
            if (taskId) {
              const action = candidate.kind === "prReview"
                ? ("prComment" as const)
                : candidate.kind === "fullReview"
                  ? ("createIssue" as const)
                  : ("issueComment" as const);
              registerWriteback(taskId, action, repo.id, candidate.number || null);
              created++;
            }
          }
          repo.lastSweepSummary = `created ${created}/${capped.length} task(s)`;
          if (capped.some((c) => c.kind === "fullReview")) {
            repo.cursors.lastFullReviewAt = Date.now();
          }
        }
      } else {
        repo.lastSweepSummary = "no new work";
      }
      repo.lastSweepAt = Date.now();
      await saveTeamAutoStore(s);
      if (created > 0) {
        await deps.onTasksCreated().catch((err) => {
          logger.warn(`TeamAuto: auto-assign trigger failed: ${String(err)}`);
        });
      }
      logger.info(`TeamAuto: sweep ${repo.id} -> ${repo.lastSweepSummary}`);
      return repo.lastSweepSummary ?? "sweep complete";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repo.pausedReason = `sweep failed: ${message}`;
      await saveTeamAutoStore(s).catch(() => {});
      logger.warn(`TeamAuto: sweep failed for ${repo.id}: ${message}`);
      return `error: ${message}`;
    } finally {
      sweeping.delete(repo.id);
    }
  }

  function enqueueCandidate(repo: TeamAutoRepo, candidate: Candidate): string | undefined {
    let createdId: string | undefined;
    deps.updateTeamState((state) => {
      // Idempotency: an active or recent task for the same key wins.
      const duplicate = Object.values(state.tasks).find(
        (t) => t.title.includes(candidate.key) && t.status !== "completed" && t.status !== "failed",
      );
      if (duplicate) {
        return;
      }
      const task: TaskInfo = {
        id: newId("teamauto"),
        title: `[${candidate.kind}] ${candidate.title}`,
        description: [
          `TeamAuto autonomous work for ${candidate.repoId}.`,
          renderNormsBlock(repo.norms, repo.id),
          "---",
          candidate.context,
          "---",
          `When finished, your reply becomes the GitHub ${candidate.kind === "prReview" || candidate.kind === "issueReview" ? "review comment" : "deliverable"}. ` +
            `If the material is ambiguous or blocked on a human decision, request clarification instead of guessing.`,
          MARKER_FOOTER(candidate.role),
        ].join("\n"),
        status: "pending",
        priority: candidate.kind === "takeOwnership" ? "high" : "medium",
        assignedRole: candidate.role as RoleId,
        createdBy: "teamauto",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.tasks[task.id] = task;
      createdId = task.id;
    });
    return createdId;
  }

  // ---------- write-back reconciler ----------

  async function reconcileWritebacks(): Promise<void> {
    const s = await ensureStore();
    const pending = s.writebacks.filter((w) => !w.doneAt && !w.error);
    if (!pending.length) {
      return;
    }
    const state = deps.getTeamState();
    if (!state) {
      return;
    }
    for (const entry of pending) {
      const task = state.tasks[entry.taskId];
      if (!task || (task.status !== "completed" && task.status !== "failed")) {
        continue;
      }
      const repo = s.repos.find((r) => r.id === entry.repoId);
      const [owner, name] = entry.repoId.split("/");
      try {
        if (task.status === "failed" || !task.result) {
          entry.error = task.status === "failed" ? (task.error ?? "task failed") : "task completed without a textual result";
        } else {
          const role = (task.assignedRole ?? "qa") as string;
          const body = `${task.result.trim()}\n${MARKER_FOOTER(role)}`;
          if (entry.action === "issueComment" && entry.targetId) {
            await client.postIssueComment(owner, name, entry.targetId, body);
            entry.doneAt = Date.now();
          } else if (entry.action === "prComment" && entry.targetId) {
            await client.postPullReviewComment(owner, name, entry.targetId, body);
            entry.doneAt = Date.now();
          } else if (entry.action === "createIssue") {
            const number = await client.createIssue(owner, name, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`, body, ["teamclaw"]);
            entry.targetId = number;
            entry.doneAt = Date.now();
          } else {
            entry.error = `unsupported action ${entry.action}`;
          }
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        logger.warn(`TeamAuto: writeback failed (${entry.repoId} ${entry.action} #${entry.targetId ?? "-"}): ${entry.error}`);
      }
      void repo;
    }
    s.writebacks = s.writebacks.filter((w) => !w.doneAt).slice(-500);
    await saveTeamAutoStore(s);
  }

  // Register the write-back intent when a task lands in the task store.
  function registerWriteback(taskId: string, action: "issueComment" | "prComment" | "createIssue" | "createPR", repoId: string, targetId: number | null): void {
    void ensureStore().then((s) => {
      if (s.writebacks.some((w) => w.taskId === taskId)) {
        return;
      }
      s.writebacks.push({ taskId, action, repoId, targetId, doneAt: null, prUrl: null, error: null });
      void saveTeamAutoStore(s);
    }).catch(() => {});
  }

  // ---------- scheduling loop ----------

  function scheduleRepo(repo: TeamAutoRepo): void {
    const previous = timers.get(repo.id);
    if (previous) {
      clearTimeout(previous);
      timers.delete(repo.id);
    }
    if (!repo.enabled) {
      return;
    }
    const delay = nextFireMs(repo.schedule);
    const timer = setTimeout(() => {
      void (async () => {
        const s = await ensureStore();
        const fresh = s.repos.find((r) => r.id === repo.id);
        if (fresh?.enabled && fresh.pausedReason === null) {
          await runSweep(fresh, false);
        }
        if (fresh?.enabled) {
          scheduleRepo(fresh);
        }
      })();
    }, delay);
    timer.unref?.();
    timers.set(repo.id, timer);
  }

  async function start(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    const s = await ensureStore();
    for (const repo of s.repos) {
      scheduleRepo(repo);
    }
    if (s.repos.length) {
      logger.info(`TeamAuto: scheduler started for ${s.repos.length} repo(s)`);
    }
    writebackTimer = setInterval(() => {
      void reconcileWritebacks();
    }, 20_000);
    writebackTimer.unref?.();
  }

  async function stop(): Promise<void> {
    running = false;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    if (writebackTimer) {
      clearInterval(writebackTimer);
      writebackTimer = null;
    }
  }

  async function getStatus(): Promise<{ repos: TeamAutoRepo[]; budget: TeamAutoStore["budget"] }> {
    const s = await ensureStore();
    return { repos: s.repos, budget: s.budget };
  }

  return { addRepo, removeRepo, setRepoEnabled, updateRepo, runSweepNow, registerWriteback, reconcileWritebacks, start, stop, getStatus };
}

export type TeamAutoScheduler = ReturnType<typeof createTeamAutoScheduler>;
