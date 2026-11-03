import { randomBytes } from "node:crypto";

import type { PluginLogger } from "../../api.js";
import type { GithubAuthManager } from "../controller/github-auth.js";
import type { RoleId, TaskInfo, TeamState } from "../types.js";
import { createGithubClient } from "./github-client.js";
import { learnNorms, renderNormsBlock } from "./norms.js";
import { createRepoSync, teamAutoProjectDir } from "./repo-sync.js";
import { nextFireMs } from "./schedule.js";
import { advanceCursors, sweepRepo, type Candidate } from "./scanner.js";
import {
  consumeDailyBudget,
  defaultCursors,
  defaultPolicy,
  loadTeamAutoStore,
  pushTeamAutoActivity,
  saveTeamAutoStore,
  type TeamAutoActivityEntry,
  type TeamAutoRepo,
  type TeamAutoRepoNorms,
  type TeamAutoRepoProvision,
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

export { nextFireMs, ScheduleParseError } from "./schedule.js";
export type TeamAutoSchedulerDeps = {
  logger: PluginLogger;
  auth: GithubAuthManager;
  getTeamState: () => TeamState | null;
  updateTeamState: (updater: (state: TeamState) => void) => TeamState;
  onTasksCreated: () => Promise<void>;
  /** Optional hook fired for every recorded activity entry (WS broadcast). */
  onActivity?: (entry: TeamAutoActivityEntry) => void;
};

/** Max failed attempts before a candidate is permanently skipped (dead-lettered). */
export const TEAMAUTO_DEAD_LETTER_ATTEMPTS = 3;

/** The dedup marker for a candidate as embedded in task descriptions. */
export function idempotencyMarker(candidate: { key: string; kind: string }): string {
  return `Idempotency-Key: ${candidate.key}:${candidate.kind}`;
}

/** Failed task attempts for a candidate (task history is the attempt log). */
export function failedAttemptCount(
  state: { tasks: Record<string, { description: string; status: string }> },
  candidate: { key: string; kind: string },
): number {
  const marker = idempotencyMarker(candidate);
  return Object.values(state.tasks).filter((t) => t.description.includes(marker) && t.status === "failed").length;
}

export function createTeamAutoScheduler(deps: TeamAutoSchedulerDeps) {
  const { logger, auth } = deps;

  function recordActivity(store: TeamAutoStore, entry: TeamAutoActivityEntry): void {
    pushTeamAutoActivity(store, entry);
    deps.onActivity?.(entry);
  }
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
    const schedule = options.schedule?.trim() || "*/30 * * * *";
    nextFireMs(schedule); // validates: throws ScheduleParseError for unsupported expressions
    const repo: TeamAutoRepo = {
      id: normalized,
      enabled: true,
      schedule,
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
    // Provision (clone + norms learning) runs in the background so bind
    // returns immediately; sweeps stay gated until provision completes.
    repo.provision = { status: "provisioning", message: "cloning repo", startedAt: Date.now(), updatedAt: Date.now() };
    s.repos.push(repo);
    recordActivity(s, { at: Date.now(), repoId: normalized, kind: "bind", text: `bound (schedule ${repo.schedule})` });
    await saveTeamAutoStore(s);
    scheduleRepo(repo);
    void provisionRepoInBackground(normalized, info.cloneUrl, info.defaultBranch);
    logger.info(`TeamAuto: bound ${normalized} (schedule ${repo.schedule}${repo.dryRunDone ? "" : ", first sweep dry-run"}; provisioning in background)`);
    return repo;
  }

  async function provisionRepoInBackground(repoId: string, cloneUrl: string, defaultBranch: string): Promise<void> {
    try {
      const s0 = await ensureStore();
      const repoRef = s0.repos.find((r) => r.id === repoId);
      if (!repoRef) { return; }
      await updateRepoProvision(repoId, { status: "provisioning", message: "learning repo norms" });
      const norms = await learnNorms(repoRef, client, sync, cloneUrl, defaultBranch);
      await updateRepoProvision(repoId, { status: "ready", message: "ready", norms });
      const sReady = await ensureStore();
      recordActivity(sReady, { at: Date.now(), repoId, kind: "provision", text: "ready (clone + norms done)" });
      logger.info(`TeamAuto: provisioned ${repoId} (clone + norms done)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`TeamAuto: provisioning failed for ${repoId}: ${message}`);
      await updateRepoProvision(repoId, { status: "failed", message });
      const sFailed = await ensureStore();
      recordActivity(sFailed, { at: Date.now(), repoId, kind: "provision", text: `failed: ${message}` });
    }
  }

  async function updateRepoProvision(repoId: string, patch: Partial<TeamAutoRepoProvision> & { norms?: TeamAutoRepoNorms }): Promise<void> {
    const s = await ensureStore();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) { return; }
    repo.provision = { status: patch.status ?? repo.provision?.status ?? "provisioning", message: patch.message ?? repo.provision?.message ?? "", startedAt: repo.provision?.startedAt ?? Date.now(), updatedAt: Date.now() };
    if (patch.norms) { repo.norms = patch.norms; }
    await saveTeamAutoStore(s);
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
      const schedule = patch.schedule.trim();
      nextFireMs(schedule); // validates before persisting
      repo.schedule = schedule;
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
    // Sweeps stay gated until bind-time provisioning (clone + norms) settles.
    if (repo.provision?.status === "provisioning") {
      const summary = `skipped: still provisioning (${repo.provision.message})`;
      logger.debug?.(`TeamAuto: ${repo.id} ${summary}`);
      return summary;
    }
    if (repo.provision?.status === "failed") {
      const summary = `skipped: provisioning failed (${repo.provision.message})`;
      logger.warn(`TeamAuto: ${repo.id} ${summary}`);
      return summary;
    }
    const s = await ensureStore();
    if (sweeping.has(repo.id)) {
      return "sweep already in progress";
    }
    sweeping.add(repo.id);
    try {
      const { candidates, issues, pulls } = await sweepRepo(repo, client);
      const dryRun = !repo.dryRunDone && s.budget.firstSweepDryRun;
      if (dryRun) {
        // One observing pass, then act. Flip unconditionally - flipping only
        // when candidates existed deadlocked empty first sweeps in dry-run
        // mode forever (dry-run never advanced cursors -> still "first sweep"
        // -> still zero candidates -> dryRunDone never set).
        repo.dryRunDone = true;
      }
      if (!dryRun) {
        // Advance only for acting sweeps: a dry-run must leave the cursors
        // untouched so the reported actions are actually performed next time
        // instead of being marked as already-seen.
        advanceCursors(repo, issues, pulls);
      }
      // Joint full reviews bypass the per-sweep cap: they append AFTER issue/
      // pull candidates, so a busy repo would otherwise starve them forever
      // (cap filled every sweep, lastFullReviewAt never advancing). They are
      // at most one cycle (3 sections) per interval, so this stays bounded.
      const fullReviews = candidates.filter((c) => c.kind === "fullReview");
      const regular = candidates.filter((c) => c.kind !== "fullReview").slice(0, Math.max(0, repo.policy.maxTasksPerSweep - fullReviews.length));
      const capped = [...fullReviews, ...regular];
      let created = 0;
      const summary: string[] = [`found ${candidates.length} candidate(s)`];

      if (capped.length && dryRun) {
        summary.push(...capped.map((c) => `DRY-RUN would ${c.kind}: ${c.title}`));
        repo.lastSweepSummary = `dry-run: ${summary.join("; ")}`;
      } else if (capped.length) {
        if (!consumeDailyBudget(s, capped.length)) {
          summary.push("skipped: daily task budget exhausted");
        } else {
          for (const candidate of capped) {
            const taskId = enqueueCandidate(repo, candidate);
            if (taskId === "dead-lettered") {
              recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "sweep", text: `dead-lettered after ${TEAMAUTO_DEAD_LETTER_ATTEMPTS} failed attempts: ${candidate.kind}: ${candidate.title}` });
            } else if (taskId) {
              recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "task", text: `${candidate.kind}: ${candidate.title}` });
              const action = candidate.kind === "prReview"
                ? ("prComment" as const)
                : candidate.kind === "fullReview"
                  ? ("createIssue" as const)
                  : ("issueComment" as const);
              registerWriteback(taskId, action, repo.id, candidate.number || null, candidate.cycle !== undefined ? String(candidate.cycle) : undefined);
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
      recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "sweep", text: repo.lastSweepSummary ?? "sweep complete" });
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

  function enqueueCandidate(repo: TeamAutoRepo, candidate: Candidate): string | "dead-lettered" | undefined {
    let createdId: string | undefined;
    let deadLettered = false;
    deps.updateTeamState((state) => {
      // Idempotency: an active task for the same object AND kind wins. The
      // key rides in the description (TaskInfo has no dedicated field) and
      // must be a distinct marked line - titles contain human text that never
      // matches the raw key (that was the pre-fix bug). Kind-scoping matters:
      // object-level keys starved takeOwnership (review always enqueued first).
      const dedupMarker = idempotencyMarker(candidate);
      const duplicate = Object.values(state.tasks).find(
        (t) => t.description.includes(dedupMarker) && t.status !== "completed" && t.status !== "failed",
      );
      if (duplicate) {
        return;
      }
      // Dead-letter: task history doubles as the attempt log. The dedup above
      // only blocks ACTIVE tasks, so a failed candidate would be re-enqueued
      // every sweep forever (observed: issue #12 re-candidated 4 sweeps in a
      // row, burning daily budget on churn). Cap the retries instead.
      if (failedAttemptCount(state, candidate) >= TEAMAUTO_DEAD_LETTER_ATTEMPTS) {
        deadLettered = true;
        return;
      }
      const task: TaskInfo = {
        id: newId("teamauto"),
        title: `[${candidate.kind}] ${candidate.title}`,
        description: [
          `TeamAuto autonomous work for ${candidate.repoId}.`,
          dedupMarker,
          `Local checkout: projects/${teamAutoProjectDir(candidate.repoId)} in the team workspace.`,
          ...(candidate.writeMode === "read-only" || (!candidate.writeMode && candidate.kind !== "takeOwnership")
            ? [
                "READ-ONLY TASK (collaboration contract): You must NOT modify, create, or delete any files - your reply IS the deliverable.",
                "Base your review on the committed HEAD state (use git show/git log); uncommitted working-tree changes belong to a concurrent write task and must be ignored.",
              ]
            : [
                "WRITE TASK (collaboration contract): you are executing in a dedicated git worktree; deliver your changes via commits there - the controller turns your branch into a PR.",
              ]),
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
        writeMode: candidate.writeMode === "write" ? "write" : "read-only",
        createdBy: "teamauto",
        projectDir: teamAutoProjectDir(candidate.repoId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.tasks[task.id] = task;
      createdId = task.id;
    });
    return deadLettered ? "dead-lettered" : createdId;
  }

  // ---------- write-back reconciler ----------

  async function reconcileWritebacks(): Promise<void> {
    const s = await ensureStore();
    const state0 = deps.getTeamState();
    // Dead letters: entries whose task is gone or failed without a result can
    // never deliver - drop them instead of accumulating forever.
    if (state0) {
      const before = s.writebacks.length;
      s.writebacks = s.writebacks.filter((w) => {
        if (w.doneAt) { return true; }
        const t = state0.tasks[w.taskId];
        const dead = !t || (t.status === "failed" && !t.result);
        if (dead) {
          logger.warn(`TeamAuto: dropping dead write-back ${w.taskId} (${t ? "task failed without result" : "task missing"})`);
        }
        return !dead;
      });
      if (s.writebacks.length !== before) { await saveTeamAutoStore(s); }
    }
    // Self-heal: an entry whose task later COMPLETED with a result (e.g. the
    // completion gate rejected an early submission, then a retry succeeded)
    // must be retried - a sticky error here would silently drop delivery.
    for (const w of s.writebacks) {
      if (w.error && !w.doneAt && state0) {
        const t = state0.tasks[w.taskId];
        if (t && t.status === "completed" && t.result) {
          w.error = null;
        }
      }
    }
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
          let body = `${task.result.trim()}\n${MARKER_FOOTER(role)}`;
          let writebackDone = false;
          // WRITE TASKS (collaboration contract): commit the task worktree,
          // push its branch, open a PR, and attach the link to the reply.
          const repoId = entry.repoId;
          const isTeamAutoWrite = task.writeMode === "write" && task.projectDir?.includes("__task-");
          if (isTeamAutoWrite) {
            try {
              const info = await client.getRepoInfo(repoId.split("/")[0]!, repoId.split("/")[1]!);
              const wtDir = await sync.ensureTaskWorktree(repoId, task.id);
              const committed = await sync.commitAll(wtDir, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`.slice(0, 200), `teamclaw-${role}`, `teamclaw-${role}@users.noreply.github.com`);
              const branch = `teamclaw/task-${task.id.replace(/[^\w-]/g, "")}`;
              // Workers often commit themselves inside the worktree - deliver
              // whenever the branch carries commits beyond base, not only when
              // commitAll just added new ones.
              const deliverable = committed || (await sync.branchHasCommits(wtDir, info.defaultBranch));
              if (deliverable) {
                await sync.pushBranch(repoId, wtDir, info.cloneUrl, branch);
                const pr = await client.createPullRequest(repoId.split("/")[0]!, repoId.split("/")[1]!, branch, info.defaultBranch, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`.slice(0, 120), `${task.result.trim()}\n${MARKER_FOOTER(role)}`);
                entry.prUrl = pr.url;
                body = `${body}\n\nDelivered as PR: ${pr.url}`;
                recordActivity(s, { at: Date.now(), repoId, kind: "writeback", text: `PR opened: ${pr.url}` });
              }
              await sync.removeTaskWorktree(repoId, task.id);
            } catch (prErr) {
              entry.error = `worktree PR delivery failed: ${prErr instanceof Error ? prErr.message : String(prErr)}`;
              logger.warn(`TeamAuto: ${entry.error} (${task.id})`);
            }
          }
          if (entry.action === "issueComment" && entry.targetId) {
            await client.postIssueComment(owner, name, entry.targetId, body);
            entry.doneAt = Date.now();
            writebackDone = true;
            // Our own comment bumps the issue's updatedAt, which the scanner
            // treats as new activity - advance the seen cursor so we do not
            // re-trigger a review of an object we just replied to. External
            // edits (updatedAt > now) still re-arm the candidate.
            const issueRepo = s.repos.find((r) => r.id === entry.repoId);
            if (issueRepo) {
              issueRepo.cursors.seen[`${entry.repoId}#issue-${entry.targetId}`] = Date.now();
            }
          } else if (entry.action === "prComment" && entry.targetId) {
            await client.postPullReviewComment(owner, name, entry.targetId, body);
            entry.doneAt = Date.now();
            writebackDone = true;
            const prRepo = s.repos.find((r) => r.id === entry.repoId);
            if (prRepo) {
              prRepo.cursors.seen[`${entry.repoId}#pr-${entry.targetId}`] = Date.now();
            }
          } else if (entry.action === "createIssue") {
            // Joint full review: same-cycle sections land in ONE umbrella issue
            // (first completed section creates it, the rest post as comments).
            const sectionBody = `### ${role} section\n\n${task.result.trim()}\n${MARKER_FOOTER(role)}`;
            if (entry.cycleKey) {
              const peers = s.writebacks.filter((w) => w.repoId === entry.repoId && w.cycleKey === entry.cycleKey && w.taskId !== entry.taskId && w.targetId != null && w.doneAt);
              const umbrella = peers[0];
              if (umbrella && umbrella.targetId != null) {
                await client.postIssueComment(owner, name, umbrella.targetId, sectionBody);
                entry.targetId = umbrella.targetId;
                entry.doneAt = Date.now();
                writebackDone = true;
              } else if (entry.targetId == null) {
                const number = await client.createIssue(
                  owner,
                  name,
                  `[teamclaw:fullreview] Joint full review - ${entry.repoId}`,
                  `Joint multi-role full review (cycle ${entry.cycleKey}). Each role appends its section as a comment below.\n\n${sectionBody}`,
                  ["teamclaw", "teamclaw:fullreview"],
                );
                entry.targetId = number;
                entry.doneAt = Date.now();
                writebackDone = true;
              }
            } else {
              const number = await client.createIssue(owner, name, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`, sectionBody, ["teamclaw"]);
              entry.targetId = number;
              entry.doneAt = Date.now();
              writebackDone = true;
            }
          } else {
            entry.error = `unsupported action ${entry.action}`;
          }
          if (writebackDone) {
            recordActivity(s, { at: Date.now(), repoId: entry.repoId, kind: "writeback", text: `${entry.action} #${entry.targetId ?? "-"} ok (${task.id})` });
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
  function registerWriteback(taskId: string, action: "issueComment" | "prComment" | "createIssue" | "createPR", repoId: string, targetId: number | null, cycleKey?: string): void {
    void ensureStore().then((s) => {
      if (s.writebacks.some((w) => w.taskId === taskId)) {
        return;
      }
      s.writebacks.push({ taskId, action, repoId, targetId, doneAt: null, prUrl: null, error: null, cycleKey });
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
    let delay: number;
    try {
      delay = nextFireMs(repo.schedule);
    } catch (err) {
      logger.error(`TeamAuto: ${repo.id} has an unsupported schedule "${repo.schedule}" and will not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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

  async function getStatus(): Promise<{ repos: TeamAutoRepo[]; budget: TeamAutoStore["budget"]; activity: NonNullable<TeamAutoStore["activity"]> }> {
    const s = await ensureStore();
    return { repos: s.repos, budget: s.budget, activity: s.activity ?? [] };
  }

  async function getActivity(): Promise<NonNullable<TeamAutoStore["activity"]>> {
    const s = await ensureStore();
    return (s.activity ?? []).slice().reverse();
  }

  return { addRepo, removeRepo, setRepoEnabled, updateRepo, runSweepNow, registerWriteback, reconcileWritebacks, start, stop, getStatus, getActivity, ensureWriteWorktree, removeWriteWorktree };

  /** Collaboration contract: dispatch asks for a task-scoped worktree dir (rel to projects root). */
  async function ensureWriteWorktree(repoId: string, taskId: string): Promise<string> {
    const wtAbs = await sync.ensureTaskWorktree(repoId, taskId);
    void wtAbs;
    // Rel dir INCLUDING the teamauto/ level (basename dropped it and pointed
    // workers outside the git worktree).
    return sync.taskWorktreeRelDir(repoId, taskId);
  }

  async function removeWriteWorktree(repoId: string, taskId: string): Promise<void> {
    await sync.removeTaskWorktree(repoId, taskId);
  }
}

export type TeamAutoScheduler = ReturnType<typeof createTeamAutoScheduler>;
