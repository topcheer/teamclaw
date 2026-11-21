import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";

import type { PluginLogger } from "../../api.js";
// Issue #226 W5: cross-subsystem contract lives in the shared layer now.
import type { GithubAuthManager } from "../shared/github-auth.js";
// Phase 2.3/2.5 (cross-review adopted suggestion): manual-proposal roles
// validate against the ACTIVE profile and default to its defaultRole instead
// of hardcoded software role literals.
import { getActiveDefaultRole, validateActiveRoleId } from "../profile-loader.js";
import type { TaskInfo, TeamState } from "../types.js";
import { createGithubClient } from "./github-client.js";
import { learnNorms, renderNormsBlock } from "./norms.js";
import { createRepoSync, teamAutoProjectDir, type TaskDeliveryOracle, type TaskTargetClosedOracle } from "./repo-sync.js";
import { ENVELOPE_LEAK_MARKER } from "./write-payload-guard.js";
import { nextFireMs } from "./schedule.js";
import { resolveTeamAutoPaths } from "./store.js";
import { advanceCursors, sweepRepo, type Candidate } from "./scanner.js";
import { withStoreLock } from "./store.js";
import {
  consumeDailyBudget,
  defaultCursors,
  defaultPolicy,
  loadTeamAutoStore,
  pushTeamAutoActivity,
  saveTeamAutoStore,
  pushSweepRecord,
  type TeamAutoActivityEntry,
  type TeamAutoRepo,
  type TeamAutoRepoNorms,
  type TeamAutoRepoProvision,
  type TeamAutoStore,
  type TeamAutoWriteBack,
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

/** Max HARD (non-transient) failures before a candidate is dead-lettered. */
export const TEAMAUTO_DEAD_LETTER_ATTEMPTS = 3;

/** Max TOTAL failures (transient included) before a candidate is dead-lettered. */
export const TEAMAUTO_DEAD_LETTER_TRANSIENT_ATTEMPTS = 6;

/**
 * Failure signatures that are environmental, not the task's fault - the same
 * candidate is likely to succeed on a later sweep. Observed live (92-task
 * dump): upstream rate limiting ("AI service needs a short break"), shared
 * workspace snapshot races ("Workspace filesystem changed"), worker gateway
 * lifecycle races ("Gateway request entry is closed"). These get a wider
 * retry allowance than hard failures so they do not dead-letter good work.
 */
export const TRANSIENT_FAILURE_RE = /workspace filesystem changed|ai service needs a short break|gateway request entry is closed|rate.?limit|timed? ?out|econnreset|socket hang up|bad gateway|service unavailable/i;

/** The dedup marker for a candidate as embedded in task descriptions. */
export function idempotencyMarker(candidate: { key: string; kind: string }): string {
  return `Idempotency-Key: ${candidate.key}:${candidate.kind}`;
}

/** #claim-recovery: parse the marker back out of a (failed) task's
 * description - `{ repoId, number, kind, key }` or null. Issue candidates
 * only (PR keys `#pr-` are not claim-bearing). */
export function parseClaimMarker(description: string): { repoId: string; number: number; kind: string; key: string } | null {
  const m = /Idempotency-Key: ([^:\s]+)#issue-(\d+):(\w+)/.exec(description);
  if (!m) {
    return null;
  }
  const number = Number(m[2]);
  if (!m[1] || !Number.isFinite(number)) {
    return null;
  }
  return { repoId: m[1], number, kind: m[3], key: `${m[1]}#issue-${number}` };
}

/** Failed task attempts for a candidate (task history is the attempt log). */
export function failedAttemptCount(
  state: { tasks: Record<string, { description: string; status: string; error?: string }> },
  candidate: { key: string; kind: string },
): number {
  const marker = idempotencyMarker(candidate);
  return Object.values(state.tasks).filter((t) => t.description.includes(marker) && t.status === "failed").length;
}

/** Failed attempts whose error is NOT a known transient signature. */
export function hardAttemptCount(
  state: Parameters<typeof failedAttemptCount>[0],
  candidate: { key: string; kind: string },
): number {
  const marker = idempotencyMarker(candidate);
  return Object.values(state.tasks).filter(
    (t) => t.description.includes(marker) && t.status === "failed" && !(t.error && TRANSIENT_FAILURE_RE.test(t.error)),
  ).length;
}

/** Auto-pause retry backoff for classes where a fast retry is useless or
 * harmful: 30m after the 1st failure, doubling, capped at 4h. auth needs a
 * human re-login; ratelimited retried early just re-triggers the limit. */
export const SWEEP_RETRY_BASE_MINUTES = 30;
export const SWEEP_RETRY_MAX_MINUTES = 240;
export function sweepBackoffMinutes(failures: number): number {
  return Math.min(SWEEP_RETRY_BASE_MINUTES * 2 ** Math.max(0, failures - 1), SWEEP_RETRY_MAX_MINUTES);
}

/** Sweep-timeout report: a transient "fetch failed" sat a full 30m before
 * its first retry - a seconds-long network blip cost half an hour of repo
 * idle time. Network-class failures get a fast ladder: 1m, 2m, 4m... capped
 * at 15m. The cap means a genuinely-down network converges to one attempt
 * per 15m (slower than the old ladder's first step, so we never hammer),
 * but a single blip costs one minute instead of thirty. */
export const SWEEP_NETWORK_RETRY_BASE_MINUTES = 1;
export const SWEEP_NETWORK_RETRY_MAX_MINUTES = 15;
export function sweepNetworkBackoffMinutes(failures: number): number {
  return Math.min(SWEEP_NETWORK_RETRY_BASE_MINUTES * 2 ** Math.max(0, failures - 1), SWEEP_NETWORK_RETRY_MAX_MINUTES);
}

/** Class-aware dispatch: the retry ladder a failure class deserves. */
export function sweepBackoffMinutesFor(failClass: SweepFailClass, failures: number): number {
  return failClass === "network" ? sweepNetworkBackoffMinutes(failures) : sweepBackoffMinutes(failures);
}

/** Timer floor when arming the retry ladder: a just-missed due time must not
 * fire at 0ms (tight failure/retry loop protection). */
export const SWEEP_RETRY_FLOOR_MS = 5_000;

/** Epoch ms when an auto-paused repo becomes due for its next retry attempt. */
export function sweepRetryDueAt(failures: number, lastErrorAt: number, failClass: SweepFailClass = "network"): number {
  return lastErrorAt + sweepBackoffMinutesFor(failClass, failures) * 60_000;
}

/** In-place network retries: a transient "fetch failed"/"terminated" is
 * retried immediately INSIDE the sweep invocation (user report 2026-11-14:
 * "sweep failed[network] (auto-retry in ~30min): fetch failed" - the repo
 * idled half an hour on a blip that a 5s retry would have survived). 10
 * attempts with a 3s..30s delay ladder (~2.5min worst case) before the
 * failure is recorded and the pause/backoff path takes over. Non-network
 * classes (auth, ratelimited) never retry in place - retrying is useless
 * or harmful. */
export const SWEEP_INPLACE_RETRIES = 10;
export const SWEEP_INPLACE_DELAY_BASE_MS = 3_000;
export const SWEEP_INPLACE_DELAY_MAX_MS = 30_000;
export function sweepInplaceDelayMs(attempt: number): number {
  return Math.min(SWEEP_INPLACE_DELAY_BASE_MS * 2 ** Math.max(0, attempt - 1), SWEEP_INPLACE_DELAY_MAX_MS);
}

/**
 * Issue #24: max write-back delivery attempts before the entry is marked
 * terminally failed (failedAt) and never retried again.
 */
export const TEAMAUTO_WRITEBACK_MAX_ATTEMPTS = 6;

/**
 * Issue #24: write-back retry backoff - 1 minute after the 1st failure,
 * doubling per attempt, capped at 2 hours. Over
 * TEAMAUTO_WRITEBACK_MAX_ATTEMPTS attempts this spaces transient GitHub API
 * failures (secondary rate limits, 5xx, token refresh races) across roughly
 * an hour before giving up, instead of the pre-fix behavior (sticky error
 * with no retry/no visibility, then a 20s hammer once the self-heal landed).
 */
export const WRITEBACK_RETRY_BASE_MS = 60_000;
export const WRITEBACK_RETRY_MAX_MS = 2 * 60 * 60_000;
export function writebackBackoffMs(attempts: number): number {
  return Math.min(WRITEBACK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), WRITEBACK_RETRY_MAX_MS);
}

/** Epoch ms when a failed write-back becomes due for its next retry. */
export function writebackRetryDueAt(attempts: number, lastErrorAt: number): number {
  return lastErrorAt + writebackBackoffMs(attempts);
}

/** #267-1: sweep failures are classified so operators can act on the RIGHT
 * root cause: 401 -> re-login, 403/429 -> back off harder, network -> the
 * existing retry ladder. undici wraps HTTP errors; the status rides on
 * err.cause (fetch failed). Unknown causes stay "network" - the ladder's
 * existing semantics. */
export type SweepFailClass = "auth" | "ratelimited" | "network";
export function classifySweepError(err: unknown): SweepFailClass {
  const cause = (err as { cause?: { status?: number }; status?: number })?.cause ?? (err as { status?: number });
  const status = Number(cause?.status ?? 0);
  if (status === 401) return "auth";
  if (status === 403 || status === 429) return "ratelimited";
  return "network";
}

/** Auto-pauses (set by the sweep catch block) are cooldowns; user pauses are not.
 * Accept BOTH the legacy prefix ("sweep failed: ...") and the #267 classified
 * format ("sweep failed[network]: ...") - the classified format broke the old
 * startsWith("sweep failed:") check, so successful sweeps could never clear
 * the pause and the retry timer never re-armed (all four repos stuck paused
 * after the 12:30 restart-window failures; found 2026-11-12). */
export function isAutoPause(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /^sweep failed(\[[^\]]*\])?:/.test(reason);
}

/** Recover the fail class from a persisted auto-pause reason
 * ("sweep failed[network]: ..."). Legacy/unparsable reasons default to the
 * fast network ladder - a wrong guess only retries sooner, and the ladder
 * itself still caps the attempt rate, so the default is safe. */
export function failClassFromPauseReason(reason: string | null | undefined): SweepFailClass {
  const m = reason?.match(/^sweep failed\[([^\]]*)\]/);
  return m && (m[1] === "auth" || m[1] === "ratelimited" || m[1] === "network") ? m[1] : "network";
}

export function createTeamAutoScheduler(deps: TeamAutoSchedulerDeps) {
  const { logger, auth } = deps;

  function recordActivity(store: TeamAutoStore, entry: TeamAutoActivityEntry): void {
    pushTeamAutoActivity(store, entry);
    deps.onActivity?.(entry);
  }

  /**
   * Issue #24: a failed write-back used to be a sticky `error` field whose
   * only trace was one warn log line - the completed task's result never
   * reached GitHub and nothing surfaced it. Centralized failure handling:
   * persist the failure (attempts/backoff), expose it in the activity feed,
   * and give up terminally (failedAt) once attempts are exhausted or the
   * caller flags the failure undeliverable.
   */
  function markWritebackFailure(store: TeamAutoStore, entry: TeamAutoWriteBack, message: string, options: { terminal?: boolean } = {}): void {
    entry.error = message;
    entry.inFlightAt = undefined; // #269: failed dispatch releases the intent
    entry.attempts = (entry.attempts ?? 0) + 1;
    // #5815: identical-error-text circuit breaker. The same message three
    // ladder runs in a row is a structural dead end (zero-diff 422s burned
    // six runs live) - stop early instead of burning the full ladder.
    const sameText = entry.lastErrorText !== undefined && message.slice(0, 120) === entry.lastErrorText.slice(0, 120);
    entry.lastErrorText = message.slice(0, 200);
    entry.lastErrorStreak = sameText ? (entry.lastErrorStreak ?? 0) + 1 : 1;
    const deterministicStreak = (entry.lastErrorStreak ?? 0) >= 3;
    entry.lastErrorAt = Date.now();
    entry.nextAttemptAt = writebackRetryDueAt(entry.attempts, entry.lastErrorAt);
    // #5651: a non-fast-forward push whose rebase self-heal also failed is
    // deterministic - retrying the same push 6 more times just burns ~25min.
    // Dead-letter immediately (the next sweep re-claims on a fresh branch).
    // #5767 (ggcode, 2026-11-18): deterministic hook/environment failures are
    // not transient - a repo pre-commit calling bash4+ builtins on a bash3.2
    // host ("mapfile: command not found") retried 6 times for 33 minutes
    // before dying. Same fail-fast as the #5651 non-fast-forward signature:
    // hook-not-found / command-not-found / not-executable signatures are
    // structural, every retry is a guaranteed repeat.
    const deterministicHookFailure = /(?:hooks?\/[^:]*: line \d+: \w+: command not found|hook declined|cannot run hook|exited with error before)/.test(message);
    const gaveUp = options.terminal === true || entry.attempts >= TEAMAUTO_WRITEBACK_MAX_ATTEMPTS || deterministicStreak || /push rejected \(non-fast-forward\) and rebase self-heal failed/.test(message) || deterministicHookFailure;
    if (gaveUp && !entry.doneAt) {
      entry.failedAt = Date.now();
      recordActivity(store, {
        at: Date.now(),
        repoId: entry.repoId,
        kind: "writeback",
        text: `failed permanently after ${entry.attempts} attempt(s) (${entry.action} #${entry.targetId ?? "-"}, task ${entry.taskId}): ${message}`,
      });
      logger.warn(`TeamAuto: write-back ${entry.taskId} (${entry.repoId} ${entry.action} #${entry.targetId ?? "-"}) gave up after ${entry.attempts} attempts: ${message}`);
      return;
    }
    recordActivity(store, {
      at: Date.now(),
      repoId: entry.repoId,
      kind: "writeback",
      text: `failed (attempt ${entry.attempts}/${TEAMAUTO_WRITEBACK_MAX_ATTEMPTS}, retry in ~${Math.max(1, Math.round(writebackBackoffMs(entry.attempts) / 60_000))}min) (${entry.action} #${entry.targetId ?? "-"}): ${message}`,
    });
    logger.warn(`TeamAuto: writeback failed (${entry.repoId} ${entry.action} #${entry.targetId ?? "-"}): ${message}`);
  }

  /**
   * Issue #24: write-back delivery stats surfaced through getStatus() so the
   * repos endpoint, the teamclaw_teamauto_status tool, and the activity feed
   * can see stuck/failed deliveries instead of only warn logs.
   */
  function summarizeWritebacks(store: TeamAutoStore): {
    pending: number;
    errored: number;
    failed: number;
    lastError: {
      taskId: string;
      repoId: string;
      action: string;
      targetId: number | null;
      attempts: number;
      terminal: boolean;
      at: number | null;
      message: string | null;
    } | null;
  } {
    const open = store.writebacks.filter((w) => !w.doneAt);
    const failed = open.filter((w) => w.failedAt);
    const errored = open.filter((w) => w.error && !w.failedAt);
    const lastErrorEntry = open
      .filter((w) => w.error)
      .sort((a, b) => (b.lastErrorAt ?? 0) - (a.lastErrorAt ?? 0))[0];
    return {
      pending: open.length - failed.length - errored.length,
      errored: errored.length,
      failed: failed.length,
      lastError: lastErrorEntry
        ? {
            taskId: lastErrorEntry.taskId,
            repoId: lastErrorEntry.repoId,
            action: lastErrorEntry.action,
            targetId: lastErrorEntry.targetId,
            attempts: lastErrorEntry.attempts ?? 0,
            terminal: Boolean(lastErrorEntry.failedAt),
            at: lastErrorEntry.lastErrorAt ?? null,
            message: lastErrorEntry.error,
          }
        : null,
    };
  }
  const client = createGithubClient(auth);
  const sync = createRepoSync(auth, logger);
  // #173 follow-up 5: squash-merge delivery oracle for worktree GC. After a
  // squash merge + branch deletion the task commits are unreachable from
  // origin/<default>, so the rev-list own-count never drains and the worktree
  // is retained forever. Positive proof = a merged PR whose head tip is exactly
  // the worktree's HEAD. Every failure path resolves false (fail toward keep).
  const squashDeliveryOracle: TaskDeliveryOracle = async (repoId, taskId, headTip) => {
    try {
      const [owner, name] = repoId.split("/");
      if (!owner || !name) {
        return false;
      }
      return await client.prHeadDelivered(owner, name, sync.taskBranchName(taskId), headTip);
    } catch {
      return false;
    }
  };
  // #orphan-gc: is the worktree's TARGET (issue/PR) closed? An issue closed
  // without our delivery (fixed elsewhere / rejected / the PR superseded)
  // makes the worktree an orphan no matter how dirty it is - the pre-fix GC
  // retained such trees forever ("retained: dirty worktree", 42 and
  // climbing on the live instance). Resolves true only on a POSITIVE closed
  // state; unknown task / unparsable marker / API failure all resolve null
  // (fail toward keep).
  const targetClosedOracle: TaskTargetClosedOracle = async (repoId, taskId) => {
    const teamState = deps.getTeamState();
    const task = teamState?.tasks?.[taskId];
    if (!task || typeof task.description !== "string") {
      return null;
    }
    const parsed = parseClaimMarker(task.description);
    if (!parsed) {
      return null;
    }
    try {
      const [owner, name] = parsed.repoId.split("/");
      if (!owner || !name) {
        return null;
      }
      const fresh = await client.getIssue(owner, name, parsed.number);
      return fresh.state === "closed";
    } catch {
      return null;
    }
  };
  const timers = new Map<string, NodeJS.Timeout>();
  const sweeping = new Set<string>();
  let running = false;
  let store: TeamAutoStore | null = null;
  let writebackTimer: NodeJS.Timeout | null = null;
  let claimRecoveryTimer: NodeJS.Timeout | null = null;
  let gcTimer: NodeJS.Timeout | null = null;

  async function ensureStore(): Promise<TeamAutoStore> {
    if (!store) {
      store = await loadTeamAutoStore();
    }
    return store;
  }

  /**
   * #5792 (ggcode, 2026-11-19): one fresh handle per locked transaction.
   * The 20s reconcile pass reassigns the closure `store` from disk on EVERY
   * pass; a section that captured `ensureStore()` BEFORE that flip and saves
   * AFTER it re-writes a stale snapshot, erasing everything persisted in
   * between. Live shape (the #5792 zero-fire regression): the sweep captured
   * its handle before the unlocked network phase; registerWritebackUnlocked -
   * called inside the sweep's locked tx - re-resolved the flipped closure, so
   * the entry was pushed and saved onto the NEW object while the tx tail
   * re-saved the OLD handle: "created 2/2" logged, writebacks[] empty on
   * disk, zero ladder rows, orphan alarms ~10min after completion, 100% of
   * tasks after the 3b1a175 deploy restart re-based the tick grid onto the
   * sweep window. Every load->mutate->save section that spans an await
   * boundary must take its handle UNDER the lock via this helper.
   */
  async function reloadStoreUnlocked(): Promise<TeamAutoStore> {
    store = await loadTeamAutoStore();
    return store;
  }

  // ---------- public repo management ----------

  async function addRepo(repoId: string, options: { schedule?: string; keywordInclude?: string[]; keywordExclude?: string[] } = {}): Promise<TeamAutoRepo> {
    const normalized = repoId.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(normalized)) {
      throw new Error(`invalid repo id: ${repoId} (expected owner/repo)`);
    }
    const [owner, name] = normalized.split("/");
    const info = await client.getRepoInfo(owner, name);
    if (!info.permissions.pull) {
      throw new Error(`no read access to ${normalized}`);
    }
    const schedule = options.schedule?.trim() || "*/30 * * * *";
    nextFireMs(schedule); // validates: throws ScheduleParseError for unsupported expressions
    // #5792: captured AFTER the network await - a capture before
    // getRepoInfo could be orphaned by a reconcile reload and the bind
    // save would then erase concurrent writeback registrations.
    const s = await ensureStore();
    if (s.repos.some((r) => r.id === normalized)) {
      throw new Error(`${normalized} is already bound`);
    }
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
    // #5792: frozen identity for the under-lock rebind below - the repo node
    // used inside the tx must come from the FRESH store handle, not this
    // possibly-orphaned snapshot.
    const repoOuter = repo;
    const repoOuterId = repo.id;
    const sweepStartedAt = Date.now();
    const etagBefore = client.etagStats();
    try {
      // #sweep-inplace: transient network failures retry IN PLACE (see
      // SWEEP_INPLACE_RETRIES) - only a network blip that survives ~2.5min of
      // retrying reaches the failure-recording path below.
      let swept: Awaited<ReturnType<typeof sweepRepo>> | undefined;
      let lastNetworkErr: unknown;
      for (let attempt = 1; attempt <= SWEEP_INPLACE_RETRIES; attempt++) {
        try {
          swept = await sweepRepo(repo, client);
          // #5706 (ggcode): sweep observability - "no new work" is ambiguous
          // between an empty fetch (etag 304 / API silence) and full filter
          // rejection. Log the funnel so starvation diagnoses itself.
          logger.info(`TeamAuto: scan funnel ${repo.id}: fetched ${swept.issues.length} issue(s)/${swept.pulls.length} pull(s) -> ${swept.candidates.length} candidate(s) (since=${repo.cursors.lastIssueSince ? new Date(repo.cursors.lastIssueSince).toISOString() : "unset"})`);
          break;
        } catch (err) {
          if (classifySweepError(err) !== "network") {
            throw err;
          }
          lastNetworkErr = err;
          const message0 = err instanceof Error ? err.message : String(err);
          logger.warn(`TeamAuto: sweep ${repo.id} network error (attempt ${attempt}/${SWEEP_INPLACE_RETRIES}): ${message0}`);
          if (attempt < SWEEP_INPLACE_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, sweepInplaceDelayMs(attempt)));
          }
        }
      }
      if (!swept) {
        throw lastNetworkErr;
      }
      const { candidates, issues, pulls, newCommits, commits } = swept;
      const dryRun = !repo.dryRunDone && s.budget.firstSweepDryRun;
      if (dryRun) {
        // One observing pass, then act. Flip unconditionally - flipping only
        // when candidates existed deadlocked empty first sweeps in dry-run
        // mode forever (dry-run never advanced cursors -> still "first sweep"
        // -> still zero candidates -> dryRunDone never set).
        repo.dryRunDone = true;
      }
      // #5712 (ggcode) / teamclaw#274: the ENTIRE sweep store transaction -
      // cursor/seen advance, budget consume, task activity, write-back
      // registrations, summary, sweep record, and the commit save - is one
      // read-modify-write section. It previously raced the (locked) 20s
      // write-back reconcile: reconcile's disk reload + tail save clobbered
      // the sweep's writes (live: 20:30 batch lost summary/budget/activity
      // while later claim/write-back saves survived). registerWriteback
      // inside uses the *Unlocked core - the promise-chain mutex is NOT
      // re-entrant.
      let created = 0; // #5712: outside the lock scope - read after commit
      let sweepSummary: string | null = null; // #5792: read after the commit
      await withStoreLock(async () => {
      // #5792 (ggcode): bind ONE fresh handle (and repo node) under the
      // lock. The outer `s` was captured before the unlocked network phase;
      // a 20s reconcile reload during sweepRepo orphaned it, and the tail
      // save below then erased the writeback registrations that
      // registerWritebackUnlocked had just persisted onto the reloaded
      // closure ("created 2/2" logged, writebacks[] empty on disk, zero
      // ladder rows - the #5792 zero-fire regression).
      const s = await reloadStoreUnlocked();
      const repo = s.repos.find((r) => r.id === repoOuterId) ?? repoOuter;
      if (!dryRun) {
        // Advance only for acting sweeps: a dry-run must leave the cursors
        // untouched so the reported actions are actually performed next time
        // instead of being marked as already-seen.
        advanceCursors(repo, issues, pulls, Date.now(), commits);
      }
      // Joint full reviews bypass the per-sweep cap: they append AFTER issue/
      // pull candidates, so a busy repo would otherwise starve them forever
      // (cap filled every sweep, lastFullReviewAt never advancing). They are
      // at most one cycle (3 sections) per interval, so this stays bounded.
      const fullReviews = candidates.filter((c) => c.kind === "fullReview");
      const regular = candidates.filter((c) => c.kind !== "fullReview").slice(0, Math.max(0, repo.policy.maxTasksPerSweep - fullReviews.length));
      const capped = [...fullReviews, ...regular];
      const summary: string[] = [`found ${candidates.length} candidate(s)`];
      // #265: surface the commits delta so the third signal source is
      // observable in sweep summaries (was silently dead before).
      if (newCommits.length > 0) {
        summary.push(`${newCommits.length} new commit(s) (HEAD ${newCommits[0].sha.slice(0, 7)})`);
      }

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
              // #claim-dequeue (user 2026-11-15): claiming at ENQUEUE locked a
              // string of issues behind the one-writer-per-repo queue while
              // they waited - and blindly claimed issues where external
              // collaborators had started working in the scan-to-claim gap.
              // Claiming now happens at DEQUEUE (claimTaskAtDequeue, called
              // from the task assignment path) after a fresh conflict check.
              const action = candidate.kind === "prReview"
                ? ("prComment" as const)
                : candidate.kind === "fullReview"
                  ? ("createIssue" as const)
                  : candidate.kind === "prRework"
                    ? ("prComment" as const)
                    : ("issueComment" as const);
              await registerWritebackUnlocked(taskId, action, repo.id, candidate.number || null, candidate.cycle !== undefined ? String(candidate.cycle) : undefined);
              created++;
            }
          }
          // #5824: the admission check consumed capped.length UP FRONT,
          // but duplicate-active (or dead-letter) skips never enqueue - the
          // budget burned on nothing (live: created 0/2, budget 11->13).
          // Refund the difference so the ledger tracks CREATED tasks only;
          // the capped.length admission gate above still bounds the batch.
          if (created < capped.length) {
            s.budget.tasksToday = Math.max(0, s.budget.tasksToday - (capped.length - created));
          }
          const failedSince = repo.failedTasksSinceLastSweep ?? 0;
          repo.failedTasksSinceLastSweep = 0;
          repo.lastSweepSummary = `created ${created}/${capped.length} task(s)${failedSince > 0 ? `; FAILED ${failedSince} since last sweep` : ""}`;
          if (capped.some((c) => c.kind === "fullReview")) {
            repo.cursors.lastFullReviewAt = Date.now();
          }
        }
      } else {
        const failedSince0 = repo.failedTasksSinceLastSweep ?? 0;
        repo.failedTasksSinceLastSweep = 0;
        repo.lastSweepSummary = failedSince0 > 0 ? `no new work; FAILED ${failedSince0} since last sweep` : "no new work";
      }
      repo.lastSweepAt = Date.now();
      if (isAutoPause(repo.pausedReason)) {
        repo.pausedReason = null;
        recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "sweep", text: "sweep recovered, auto-pause cleared" });
      }
      repo.sweepFailures = 0;
      repo.lastAttemptAt = Date.now(); // #266: success is also an attempt
      const etagAfter = client.etagStats();
      pushSweepRecord(repo, { at: Date.now(), ok: true, summary: repo.lastSweepSummary ?? "sweep complete", durationMs: Date.now() - sweepStartedAt, etagCalls: Math.max(0, etagAfter.calls - etagBefore.calls), etag304Hits: Math.max(0, etagAfter.hits - etagBefore.hits) });
      recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "sweep", text: repo.lastSweepSummary ?? "sweep complete" });
      sweepSummary = repo.lastSweepSummary; // #5792: post-commit readers use the tx-scoped repo
      await saveTeamAutoStore(s);
      }); // withStoreLock: sweep transaction
      if (created > 0) {
        await deps.onTasksCreated().catch((err) => {
          logger.warn(`TeamAuto: auto-assign trigger failed: ${String(err)}`);
        });
      }
      logger.info(`TeamAuto: sweep ${repo.id} -> ${sweepSummary}`);
      return sweepSummary ?? "sweep complete";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Transient failures (network blips, restart-interrupted sweeps) used to
      // pause a repo FOREVER - teamclaw sat auto-paused 15h on one "fetch
      // failed". Auto-pauses are cooldowns now: the timer retries after the
      // backoff below, and a success clears the state in the block above.
      // #5712: failure bookkeeping is a store RMW too - same lock.
      await withStoreLock(async () => {
      // #5792: fresh handle under the lock (same stale-snapshot class as
      // the sweep transaction above).
      const s = await reloadStoreUnlocked();
      const repo = s.repos.find((r) => r.id === repoOuterId) ?? repoOuter;
      repo.sweepFailures = (repo.sweepFailures ?? 0) + 1;
      repo.lastSweepErrorAt = Date.now();
      repo.lastAttemptAt = repo.lastSweepErrorAt; // #266: failures must be visible without inferring from lastSweepErrorAt
      const failClass = classifySweepError(err);
      repo.pausedReason = `sweep failed[${failClass}]: ${message}`;
      const etagAfter = client.etagStats();
      pushSweepRecord(repo, { at: Date.now(), ok: false, summary: `sweep failed[${failClass}]: ${message}`, failClass, durationMs: Date.now() - sweepStartedAt, etagCalls: Math.max(0, etagAfter.calls - etagBefore.calls), etag304Hits: Math.max(0, etagAfter.hits - etagBefore.hits) });
      recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "sweep", text: `sweep failed[${failClass}] (auto-retry in ~${sweepBackoffMinutesFor(failClass, repo.sweepFailures)}min): ${message}` });
      await saveTeamAutoStore(s).catch(() => {});
      }); // withStoreLock: failure bookkeeping
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
      // row, burning daily budget on churn). Cap the retries instead - hard
      // failures fast (3), environmental/transient failures get a wider
      // allowance (6 total) so rate limits or workspace races do not kill
      // work that would succeed on a quieter sweep.
      if (
        hardAttemptCount(state, candidate) >= TEAMAUTO_DEAD_LETTER_ATTEMPTS
        || failedAttemptCount(state, candidate) >= TEAMAUTO_DEAD_LETTER_TRANSIENT_ATTEMPTS
      ) {
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
        // Candidate.role is RoleId since Phase 2.3 debt item 4 (scanner role
        // set derives from the active team profile) - no cast needed.
        assignedRole: candidate.role,
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

  /**
   * Agent-facing manual proposal: inject a candidate directly (bypassing the
   * GitHub-object sweep) while reusing the full pipeline - idempotency dedup,
   * dead-letter caps, budget accounting, norms blocks, worktree checkout.
   * No writeback is registered (there is no GitHub object to write back to);
   * the result stays in the task system, visible via teamclaw_list_tasks.
   */
  async function proposeManual(
    repoId: string,
    input: { kind: Candidate["kind"]; title: string; context: string; role?: string; writeMode?: "read-only" | "write" },
  ): Promise<string> {
    const s = await ensureStore();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) {
      throw new Error(`${repoId} not bound`);
    }
    const kind: Candidate["kind"] = input.kind === "takeOwnership" || input.kind === "issueReview" || input.kind === "prReview" || input.kind === "fullReview" ? input.kind : "issueReview";
    // Cross-review adopted suggestion: the caller-supplied role is untrusted
    // input - validate it against the ACTIVE profile (drops unknown and
    // not-in-this-profile ids) and fall back to the profile defaultRole
    // instead of the old hardcoded "developer"/"architect" software literals.
    const role = validateActiveRoleId(input.role) ?? getActiveDefaultRole();
    const candidate: Candidate = {
      repoId,
      key: `${repoId}#manual-${Date.now()}`,
      kind,
      number: 0,
      role,
      writeMode: input.writeMode ?? (kind === "takeOwnership" ? "write" : "read-only"),
      title: input.title.slice(0, 120),
      reason: "manual proposal from agent tool",
      context: input.context,
    };
    const taskId = enqueueCandidate(repo, candidate);
    if (taskId === "dead-lettered") {
      throw new Error(`proposal dead-lettered (${kind} exceeded failure caps for this repo)`);
    }
    if (taskId) {
      recordActivity(s, { at: Date.now(), repoId, kind: "task", text: `manual ${kind}: ${candidate.title}` });
      await saveTeamAutoStore(s);
      return taskId;
    }
    return "duplicate-active-skipped";
  }

  // ---------- write-back reconciler ----------
  // #269: the 20s interval fires `void reconcileWritebacks()` fire-and-forget,
  // and a slow delivery (worktree ensure + commit + PR > 20s) let the next
  // tick re-read the same pending entries before doneAt landed - same
  // comment delivered twice (ggcode#5480, byte-identical pair). Two-layer
  // fix: serialize the whole pass (guard below) + intent-first inFlightAt
  // persisted BEFORE dispatch so even a concurrent caller cannot re-send.
  let reconcileInFlight = false;
  async function reconcileWritebacks(): Promise<void> {
    if (reconcileInFlight) {
      return; // a pass is still delivering - never overlap (#269)
    }
    // #269 recurrence (23:40 CST): MULTIPLE gateway processes share one
    // ~/.openclaw store (launchctl service + spawned gateways). In-process
    // guards cannot see another process's deliveries - each kept its
    // startup-cached store and delivered the same pending row (3s apart,
    // two "issueComment ok" for one task). Cross-process mutex: an atomic
    // mkdir lock dir next to the store file; stale (>5min) locks are
    // taken over (crashed holder).
    const { storeFile } = resolveTeamAutoPaths();
    const lockDir = `${storeFile}.reconcile-lock`;
    let locked = false;
    try {
      try {
        await fs.mkdir(lockDir);
        locked = true;
      } catch {
        // Held - unless stale (holder crashed mid-pass).
        try {
          const st = await fs.stat(lockDir);
          if (Date.now() - st.mtimeMs > 300_000) {
            await fs.rm(lockDir, { recursive: true, force: true });
            await fs.mkdir(lockDir);
            locked = true;
          }
        } catch { /* racing takeover - someone else won; skip this pass */ }
      }
      if (!locked) {
        return; // another PROCESS is mid-reconcile; our next tick re-tries
      }
      reconcileInFlight = true;
      try {
        await doReconcileWritebacks();
      } finally {
        reconcileInFlight = false;
      }
    } finally {
      if (locked) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function doReconcileWritebacks(): Promise<void> {
    // #2677: the WHOLE read-modify-write section holds the store lock -
    // an unlocked reload+save here clobbered a concurrently-registered
    // write-back entry (see store.ts withStoreLock).
    await withStoreLock(async () => {
    await doReconcileWritebacksLocked();
    }).catch((err) => {
      // #5677 ask: never swallow a delivery-pass crash silently - a lost
      // entry with zero trace is invisible; surface it in the log AND the
      // activity feed so the failure class is diagnosable.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`TeamAuto: write-back pass CRASHED (entries may retry next tick): ${msg}`);
      void ensureStore().then((s) => {
        recordActivity(s, { at: Date.now(), repoId: "*", kind: "writeback", text: `delivery pass crashed: ${msg.slice(0, 140)}` });
        return saveTeamAutoStore(s);
      }).catch(() => {});
    });
  }

  async function doReconcileWritebacksLocked(): Promise<void> {
    // #269 recurrence: re-read the store from disk EVERY pass - the
    // closure cache is a startup snapshot that never sees another
    // process's persisted inFlightAt/doneAt, which is exactly how the
    // 23:40 double delivery happened.
    store = await loadTeamAutoStore();
    const s = store;
    const state0 = deps.getTeamState();
    // Dead letters: entries whose task is gone or failed without a result can
    // never deliver - drop them instead of accumulating forever.
    if (state0) {
      const before = s.writebacks.length;
      const deadOnes: typeof s.writebacks = [];
      s.writebacks = s.writebacks.filter((w) => {
        if (w.doneAt) { return true; }
        const t = state0.tasks[w.taskId];
        const dead = !t || (t.status === "failed" && !t.result);
        if (dead) {
          logger.warn(`TeamAuto: dropping dead write-back ${w.taskId} (${t ? "task failed without result" : "task missing"})`);
          deadOnes.push(w);
          // #5641: the 3-day architect-leg outage was invisible because a
          // failed-without-result task produced NO activity line and the next
          // sweep summary still said "created 3/3". Record both surfaces.
          recordActivity(s, { at: Date.now(), repoId: w.repoId, kind: "task", text: `task failed without result, write-back dropped: ${w.taskId}${t?.error ? ` (${String(t.error).slice(0, 120)})` : ""}` });
          const failedRepo = s.repos.find((r) => r.id === w.repoId);
          if (failedRepo) {
            failedRepo.failedTasksSinceLastSweep = (failedRepo.failedTasksSinceLastSweep ?? 0) + 1;
          }
        }
        return !dead;
      });
      if (s.writebacks.length !== before) { await saveTeamAutoStore(s); }
      // #5725 (ggcode): settle self-audit. A COMPLETED teamauto task with a
      // textual result whose write-back entry is absent AND whose ok line is
      // missing from the activity feed means the registration (or the whole
      // entry) was lost - the ladder redundancy channel silently failed.
      // Alarm once per task so the observability contract survives entry loss.
      let auditDirty = false;
      if (state0) {
        s.orphanResultAlarms ??= {};
        s.deliveredResults ??= {};
        // #5738 (ggcode, 2026-11-17): ONE-TIME migration. The #5736 backfill
        // only stamped entries still present in the write-back array at
        // deploy time - historically delivered legs were already pruned, so
        // they all re-entered the alarm domain on the first settled pass
        // (23 tasks, 99 lines in 80s). Seed the ledger once from the task
        // state itself: everything completed with a result inside the audit
        // window at init time is treated as delivered (the sentinel verified
        // those 23 were all normally delivered). Accepted trade-off: any
        // genuine pre-deploy orphan is pardoned once - signal > archaeology.
        // #5770: gate the one-time migration on an EMPTY table, not just the
        // flag - a generation-window store clobber can wipe the flag while
        // the table survives (or vice versa), and a re-run re-stamps
        // completedAt as deliveredAt for the current window, forging delivery
        // records that mask genuine orphans (live: 57cc2770/e975ddac stamped
        // at the exact completion millisecond, audit went silent).
        if (!s.deliveredResultsInit && Object.keys(s.deliveredResults).length === 0) {
          s.deliveredResultsInit = true;
          for (const task of Object.values(state0.tasks ?? {})) {
            if (task?.id && task.status === "completed" && task.result && task.id.startsWith("teamauto-") && task.completedAt && Date.now() - task.completedAt <= 24 * 3600_000) {
              s.deliveredResults[task.id] = task.completedAt;
            }
          }
          auditDirty = true;
        }
        let alarmedThisPass = 0; // #5772: at most ONE orphan alarm per settle pass
        // #5777: tasks whose direct-send delivery lands AFTER completion
        // (live: delivered 5m21s post-completed, zero ladder/ledger trail)
        // would alarm at the first tick. Grace period first; at grace
        // expiry the audit checks the GitHub surface ONCE for a teamclaw
        // marker comment and back-fills the ledger when the product exists.
        const ghClient = createGithubClient(auth);
        for (const task of Object.values(state0.tasks ?? {})) {
          if (!task?.id || task.status !== "completed" || !task.result || !task.id.startsWith("teamauto-")) continue;
          // #5772: 24h -> 6h audit window. A restart replays the audit over
          // HISTORICAL completed tasks whose write-back entries are long
          // pruned and whose ledger truth died in a generation-window clobber
          // - that population is exactly the false-alarm storm (14 healthy
          // tasks at once, live). Genuine orphans surface within hours; the
          // remaining tail is not worth storm-shaped noise.
          if (task.completedAt && Date.now() - task.completedAt > 6 * 3600_000) continue;
          // #5738: once-per-task gate; the audit now persists its own
          // mutations in the same pass (auditDirty save below), so the gate
          // survives the next 20s disk reload instead of re-alarming.
          const lastAlarmAt = s.orphanResultAlarms[task.id];
          if (lastAlarmAt) continue;
          // #5777: direct-send grace - do not judge before a slow worker
          // direct-post has had its chance.
          if (task.completedAt && Date.now() - task.completedAt < 10 * 60_000) continue;
          // #5736: delivered-source is the DURABLE ledger (entry present OR
          // recorded at prune time) - never the activity ring, which rolls in
          // hours and made every normal delivery a false orphan.
          // #5770: a REAL delivery happens >= one reconcile tick (20s) after
          // completion; a ledger stamp within 2s of completedAt is a migration
          // artifact, not evidence of delivery - do not let it silence the
          // orphan audit.
          const deliveredAt = s.deliveredResults[task.id];
          const ledgerIsArtifact = deliveredAt !== undefined && task.completedAt !== undefined && Math.abs(deliveredAt - task.completedAt) < 2000;
          const hasEntry = s.writebacks.some((w) => w.taskId === task.id) || (deliveredAt !== undefined && !ledgerIsArtifact);
          if (!hasEntry) {
            // #5777: grace expired and still no books - verify the GitHub
            // surface ONCE for a teamclaw marker comment (worker direct-send
            // shape) before declaring an orphan. A marker hit back-fills the
            // ledger; only a genuinely bare issue alarms.
            // #5781: channel-aware verification - a prReview task's product
            // lives on the PR review surface (reviews + PR conversation
            // comments), which getIssueCommentBodies cannot see (live:
            // d7152fe0 delivered two COMMENTED reviews, issue-surface check
            // matched zero, false orphan). Route by target type: PR number
            // -> feedback bodies (reviews + comments), issue number ->
            // issue comments.
            const prNumMatch = /(?:PR|pull request) #(\d+)/i.exec(`${task.title}`);
            const numMatch = prNumMatch ?? /issue #(\d+)/.exec(`${task.title}`);
            const repoMatch = /TeamAuto autonomous work for ([\w./-]+)\./.exec(`${task.description}`);
            // #5783 contract 5b: the fetched bodies must stay visible BELOW the
            // evidence check - the self-heal gate distinguishes "surface
            // completely silent" (rescue re-delivery) from "surface carries
            // bare/foreign bodies that match no evidence" (orphan alarm).
            let targetBodies: string[] = [];
            if (numMatch && repoMatch) {
              const [o, n] = repoMatch[1].split("/");
              const targetNum = Number(numMatch[1]);
              targetBodies = prNumMatch
                ? await ghClient.getPullFeedbackBodies(o, n, targetNum).catch(() => [] as string[])
                : await ghClient.getIssueCommentBodies(o, n, targetNum).catch(() => [] as string[]);
              // #5780: workers deliver in more shapes than the ladder marker -
              // narrative bodies ("Fix delivered ... via TeamClaw autonomous")
              // and branch-reference footers carry no [teamclaw:] prefix and
              // zeroed the evidence check (live: 8fdf5efd false-alarmed).
              // #5730/23da7606 sharpening: exotic bodies with ZERO teamclaw
              // references exist too (first wild case, mk:false on all
              // three predicates). The universal fallback: a direct-send
              // body IS the task result - fingerprint match on its first
              // 60 chars catches every shape, marker or not.
              const resultFingerprint = task.result.replace(/\s+/g, " ").trim().slice(0, 60);
              const ghEvidence = targetBodies.some((b) => /\[teamclaw[:\]]/i.test(b) || /teamclaw|teamauto/i.test(b) || /teamclaw\/task-/.test(b) || (resultFingerprint.length >= 40 && b.replace(/\s+/g, " ").includes(resultFingerprint)));
              if (ghEvidence) {
                // #5785 reconciliation (rebase of #284 onto the 085fc67
                // chain): the undelivered-PR self-check now lives in the
                // dedicated PR-face settle audit below - a REST probe via
                // listPullsByHead plus the durable prDeliveries ledger. This
                // inline local-evidence variant (085fc67/e882af2) is removed
                // so a WRITE task with issue-face evidence but a missing PR
                // leg has exactly ONE alarm path, not two competing ones.
                s.deliveredResults[task.id] = Date.now();
                auditDirty = true;
                recordActivity(s, { at: Date.now(), repoId: repoMatch[1], kind: "writeback", text: `ledger back-filled from GitHub evidence: ${task.id} direct-send delivery verified on issue #${numMatch[1]} (no ladder trail - #5777 timing shape)` });
                await saveTeamAutoStore(s).catch(() => {});
                continue;
              }
            }
            // #5792 self-heal (ggcode): the registration was lost in
            // flight (live: the sweep transaction's stale tail-save erased
            // it - "created 2/2" logged, zero ladder rows). Re-register from
            // the already-parsed target so the ladder re-delivers the result
            // instead of only alarming: prReview bodies have NO direct-send
            // surface, so without this the review verdict (e.g. a REQUEST
            // CHANGES on a live PR) is lost forever.
            // #5783 contract 5b gate: the rescue is for a COMPLETELY SILENT
            // surface only. When the surface already carries bodies that
            // match no evidence (live shape: a bare worker direct-post or a
            // foreign/human review), the audit must take the verdict the
            // evidence predicate hands it - the alarm. Re-registering there
            // swallowed the alarm (5b regression after bb09e1e) and would
            // re-post a duplicate beside the unverified body.
            // #5785 reconciliation: WRITE tasks are ALSO out of scope - their
            // lost registration is the PR-face settle audit's jurisdiction
            // (listPullsByHead probe + prDeliveries ledger below). A healed
            // issueComment entry here would sit in s.writebacks and mask
            // that audit exactly like the live incident's comment-shaped
            // evidence did, or re-deliver a comment beside an unknown
            // push/PR state - the double-delivery hazard #5785 documents.
            if (numMatch && repoMatch && targetBodies.length === 0 && task.writeMode !== "write") {
              const healTargetNum = Number(numMatch[1]);
              await registerWritebackUnlocked(task.id, prNumMatch ? "prComment" : "issueComment", repoMatch[1], healTargetNum);
              if (s.writebacks.some((w) => w.taskId === task.id)) {
                recordActivity(s, { at: Date.now(), repoId: repoMatch[1], kind: "writeback", text: `orphan self-heal: re-registered ${prNumMatch ? "prComment" : "issueComment"} #${healTargetNum} for ${task.id} (registration lost in flight - #5792); the ladder will re-deliver` });
                logger.warn(`TeamAuto: orphan self-heal re-registered ${prNumMatch ? "prComment" : "issueComment"} #${healTargetNum} for ${task.id}`);
                auditDirty = true;
                await saveTeamAutoStore(s).catch(() => {});
                if (++alarmedThisPass >= 1) break; // storm cap: one audit ACTION per pass
                continue;
              }
              // Re-registration was skipped (e.g. another task's OPEN entry
              // owns this target) - fall through to the alarm below.
            }
            s.orphanResultAlarms[task.id] = Date.now();
            auditDirty = true;
            recordActivity(s, { at: Date.now(), repoId: "*", kind: "writeback", text: `orphan result alarm: task ${task.id} completed with a result but has NO write-back entry and no delivery record (registration lost - ladder redundancy silently absent)` });
            logger.warn(`TeamAuto: orphan completed task ${task.id} without write-back entry`);
            // #5772: persist the gate IMMEDIATELY on the alarming branch -
            // deferring to the block-tail save lost the write to a
            // restart-timeline clobber once already (#5738 regression).
            await saveTeamAutoStore(s).catch(() => {});
            if (++alarmedThisPass >= 1) break; // storm cap: one per pass
          }
        }
        // #5785 (ggcode, 2026-11-18): undelivered-PR audit - the PR-face
        // sibling of the orphan-result audit above. A completed WRITE task
        // delivers on TWO faces: the issue/review comment (verified above)
        // and the push+createPR leg, which per the WRITE collaboration
        // contract ONLY the write-back ladder performs. The orphan audit is
        // comment-shaped: a worker direct-post on the issue face back-fills
        // deliveredResults and silences it, while the PR face never came
        // into existence (live: branch pushed, zero PR across a 10m42s
        // three-probe window, writebacks [] throughout, gate silent - the
        // issue-face delivery masked the missing PR face entirely).
        // Contract: a completed WRITE task inside the audit window must
        // (a) still own a write-back entry (the ladder owns its PR face;
        // delivery failures surface via the retry ladder and the
        // "completed task delivery LOST" alarm), or (b) carry a durable
        // PR-face record (prDeliveries - stamped at prune time from
        // entry.prUrl), or (c) show a PR (any state) whose head is its task
        // branch. None of the three => ONE undelivered-PR alarm line.
        let prAlarmedThisPass = 0;
        for (const task of Object.values(state0.tasks ?? {})) {
          if (!task?.id || task.status !== "completed" || !task.result || !task.id.startsWith("teamauto-")) continue;
          // Same shape predicate as the delivery path's isTeamAutoWrite:
          // only dispatched WRITE tasks carry the PR-face contract.
          if (task.writeMode !== "write" || !task.projectDir?.includes("__task-")) continue;
          // The window math needs completedAt (the task system stamps it on
          // completion); tasks without it are not judgeable here.
          if (!task.completedAt) continue;
          if (Date.now() - task.completedAt > 6 * 3600_000) continue;
          if (s.undeliveredPrAlarms?.[task.id]) continue;
          // Same #5777 grace as the orphan audit: a slow ladder delivery (or
          // a manual push+PR) gets its window before judgement.
          if (Date.now() - task.completedAt < 10 * 60_000) continue;
          if (s.writebacks.some((w) => w.taskId === task.id)) continue;
          if (s.prDeliveries?.[task.id]) continue;
          const prRepoMatch = /TeamAuto autonomous work for ([\w./-]+)\./.exec(`${task.description}`);
          const taskBranch = `teamclaw/task-${task.id.replace(/[^\w-]/g, "")}`;
          let prFaceUrl: string | null = null;
          if (prRepoMatch) {
            const [prOwner, prName] = prRepoMatch[1].split("/");
            // Distinguish fetch FAILURE (null -> retry next settle pass; a
            // blip must not gate the check permanently) from a definitive
            // empty list (-> alarm).
            const pulls = await ghClient.listPullsByHead(prOwner, prName, taskBranch).catch(() => null);
            if (pulls === null) continue;
            const hit = pulls.find((p) => p.htmlUrl) ?? pulls[0];
            if (hit) prFaceUrl = hit.htmlUrl || `#${hit.number}`;
          }
          s.undeliveredPrAlarms ??= {};
          s.undeliveredPrAlarms[task.id] = Date.now();
          auditDirty = true;
          if (prFaceUrl) {
            s.prDeliveries ??= {};
            s.prDeliveries[task.id] = prFaceUrl;
            recordActivity(s, { at: Date.now(), repoId: prRepoMatch?.[1] ?? "*", kind: "writeback", text: `PR face verified: ${task.id} has no write-back entry but PR ${prFaceUrl} exists for branch ${taskBranch} - createPR fired through another path (undelivered-PR audit pardon, #5785)` });
          } else {
            recordActivity(s, { at: Date.now(), repoId: prRepoMatch?.[1] ?? "*", kind: "writeback", text: `undelivered-PR alarm: task ${task.id} completed (WRITE) with NO write-back entry and no PR from branch ${taskBranch} - the createPR leg never fired (enqueue-side registration skipped; the issue-face delivery masked it - #5785)` });
            logger.warn(`TeamAuto: undelivered PR for completed WRITE task ${task.id} (branch ${taskBranch})`);
            // Same #5738 discipline as the orphan alarm: persist the gate on
            // the alarming branch, not only at the block tail.
            await saveTeamAutoStore(s).catch(() => {});
          }
          if (++prAlarmedThisPass >= 1) break; // storm cap: one per pass
        }
        if (s.undeliveredPrAlarms && Object.keys(s.undeliveredPrAlarms).length > 200) {
          const prGateEntries = Object.entries(s.undeliveredPrAlarms).sort((a, b) => a[1] - b[1]);
          for (const [k] of prGateEntries.slice(0, prGateEntries.length - 100)) delete s.undeliveredPrAlarms[k];
        }
        if (Object.keys(s.orphanResultAlarms).length > 200) {
          const entries = Object.entries(s.orphanResultAlarms).sort((a, b) => a[1] - b[1]);
          for (const [k] of entries.slice(0, entries.length - 100)) delete s.orphanResultAlarms[k];
        }
        // #5738: the gate lives on disk - persist audit mutations in the SAME
        // pass that makes them, or the next 20s reload resets the gate and
        // re-alarms everything (99 lines / 23 tasks live).
        if (auditDirty) { await saveTeamAutoStore(s); }
      }
      // Live-verified gap (mw5aun1l, 2026-11-07): this drop path fires for
      // failed-without-result tasks BEFORE the pending loop below, so the
      // terminal worktree cleanup there never ran for them - the single
      // largest leak source. Safety-clean here too (same contract). The
      // filter callback cannot await, hence the post-filter pass.
      for (const w of deadOnes) {
        const t = state0.tasks[w.taskId];
        if (t && t.writeMode === "write" && t.projectDir?.includes("__task-")) {
          const r = await sync.safeRemoveTaskWorktree(w.repoId, w.taskId, squashDeliveryOracle, targetClosedOracle);
          if (r.removed) {
            // #173 follow-up 4: positive removal line - without it a successful
            // terminal cleanup is invisible in logs (only kept/failed logged).
            logger.warn(`TeamAuto: terminal task ${w.taskId} worktree removed (${r.reason})`);
          } else if (!r.reason.includes("already gone")) {
            logger.warn(`TeamAuto: terminal task ${w.taskId} worktree kept: ${r.reason}`);
          }
        }
      }
    }
    // Self-heal: an entry whose task later COMPLETED with a result (e.g. the
    // completion gate rejected an early submission, then a retry succeeded)
    // must be retried - a sticky error here would silently drop delivery.
    // Issue #24: the retry now respects the per-entry backoff (nextAttemptAt)
    // so a failing write-back no longer hammers GitHub on every 20s pass;
    // legacy entries without a nextAttemptAt (pre-#24 stores) retry once
    // immediately and then enter the normal backoff ladder. Terminally
    // failed entries (failedAt) are never retried again.
    for (const w of s.writebacks) {
      if (w.error && !w.doneAt && !w.failedAt && state0) {
        const t = state0.tasks[w.taskId];
        // #5719: a FAILED task WITH a result is deliverable too (the result is
        // the work product - analysis/diagnostic legs). Same backoff reset.
        if (t && t.result && (t.status === "completed" || t.status === "failed") && (w.nextAttemptAt ?? 0) <= Date.now()) {
          w.error = null;
        }
      }
    }
    // #269: reset stale in-flight intents (crashed mid-dispatch) so they
    // re-enter the pending set instead of wedging forever.
    for (const w of s.writebacks) {
      if (w.inFlightAt && !w.doneAt && Date.now() - w.inFlightAt > 600_000) {
        w.inFlightAt = undefined;
      }
    }
    const pendingAll = s.writebacks.filter((w) => !w.doneAt && !w.error && !w.failedAt && !w.inFlightAt);
    // #269 per-target dedupe (delivery side): cap at ONE entry per target
    // key per pass, so N pending rows aimed at the same issue/PR cannot
    // burst N same-second comments even if they somehow slipped the enqueue
    // check (e.g. pre-fix stores). Deferred rows simply ride the next 20s
    // pass. Null-target create* rows key on taskId: each is a distinct
    // create intent and must never be merged.
    const seenTarget = new Set<string>();
    const pending = [];
    for (const w of pendingAll) {
      const key = w.targetId != null ? `${w.action}|${w.repoId}|${w.targetId}` : `${w.action}|${w.taskId}`;
      if (seenTarget.has(key)) {
        continue;
      }
      seenTarget.add(key);
      pending.push(w);
    }
    if (!pending.length) {
      return;
    }
    const state = deps.getTeamState();
    if (!state) {
      return;
    }
    for (const entry of pending) {
      // #5685 (ggcode, 2026-11-16): gate on a TERMINAL task BEFORE touching
      // the entry. The old order stamped inFlightAt first and `continue`d
      // for still-running tasks, leaving the sticky intent to wedge the
      // entry out of pendingAll until the 600s stale reset - a completed
      // task's write-back was deliverable in exactly one 20s window every
      // ~10 minutes (live: the 02:30 fullReview legs delivered 8m42s-9m51s
      // after completion, long misread as deliberate "slow release"). The
      // intent stamp now happens only when the pass is about to dispatch.
      const task = state.tasks[entry.taskId];
      if (!task || (task.status !== "completed" && task.status !== "failed")) {
        continue;
      }
      // #269 intent-first: persist the dispatch intent BEFORE any await so
      // an overlapping pass (or a future guard-less caller) filters this
      // entry out instead of re-delivering it.
      entry.inFlightAt = Date.now();
      await saveTeamAutoStore(s);
      const repo = s.repos.find((r) => r.id === entry.repoId);
      const [owner, name] = entry.repoId.split("/");
      try {
        if (!task.result) {
          // Undeliverable in every future pass: "completed without result"
          // cannot recover. #5719 (ggcode, 2026-11-16): a FAILED task WITH a
          // textual result is NOT in this class - the result is the
          // deliverable (analysis/diagnostic work products). It now falls
          // through to normal delivery with an error footer; only
          // result-less entries (failed or completed) stay terminal.
          // Failed-without-result entries are additionally dropped by the
          // dead-letter pass on the next reconcile.
          markWritebackFailure(
            s,
            entry,
            task.status === "failed" ? (task.error ?? "task failed") : "task completed without a textual result",
            { terminal: true },
          );
          // Terminal write task: its dispatch-time worktree has no delivery
          // path left - remove it when the worker never produced deliverable
          // commits (safety-checked, undelivered work is retained + logged).
          if (task.writeMode === "write" && task.projectDir?.includes("__task-")) {
            const r = await sync.safeRemoveTaskWorktree(entry.repoId, task.id, squashDeliveryOracle, targetClosedOracle);
            if (r.removed) {
              // #173 follow-up 4: positive removal line - symmetric with the
              // boot-GC path which logs both directions.
              logger.warn(`TeamAuto: terminal task ${task.id} worktree removed (${r.reason})`);
            } else if (!r.reason.includes("already gone")) {
              logger.warn(`TeamAuto: terminal task ${task.id} worktree kept: ${r.reason}`);
            }
          }
        } else {
          const role = (task.assignedRole ?? "qa") as string;
          let body = `${task.result.trim()}\n${MARKER_FOOTER(role)}`;
          // #5719: a failed-with-result task delivers its result (the work
          // product) with the failure context appended - never silently
          // dropped as before.
          if (task.status === "failed" && task.error) {
            body = `${body}\n\n---\n[task reported failed: ${task.error.slice(0, 300)}]`;
          }
          let writebackDone = false;
          // WRITE TASKS (collaboration contract): commit the task worktree,
          // push its branch, open a PR, and attach the link to the reply.
          const repoId = entry.repoId;
          const isTeamAutoWrite = task.writeMode === "write" && task.projectDir?.includes("__task-");
          let prDeliveryFailed = false;
          if (isTeamAutoWrite && task.status !== "failed") {
            // #5719: a FAILED write task's worktree carries no deliverable by
            // construction (that is usually WHY it failed) - the PR step just
            // burns retries against an empty worktree. Deliver the result
            // comment directly; the worktree is cleaned by the terminal pass.
            try {
              const info = await client.getRepoInfo(repoId.split("/")[0]!, repoId.split("/")[1]!);
              const wtDir = await sync.ensureTaskWorktree(repoId, task.id, info.defaultBranch, info.cloneUrl);
              const committed = await sync.commitAll(wtDir, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`.slice(0, 200), `teamclaw-${role}`, `teamclaw-${role}@users.noreply.github.com`);
              const branch = `teamclaw/task-${task.id.replace(/[^\w-]/g, "")}`;
              // Workers often commit themselves inside the worktree - deliver
              // whenever the branch carries commits beyond base, not only when
              // commitAll just added new ones.
              // #5815: compare against the REMOTE base tip, not the stale
              // local baseline - a stale checkout makes a zero-commit branch
              // look deliverable and the PR dies on a deterministic 422
              // (zero diff) six times in a row.
              const deliverable = committed || (await sync.branchHasCommits(wtDir, info.defaultBranch, info.cloneUrl));
              if (deliverable) {
                const push = await sync.pushBranch(repoId, wtDir, info.cloneUrl, branch, (pushErr) => {
                  // #5788: dedicated push-failure activity line - symmetric
                  // with the createPR ladder rows.
                  recordActivity(s, { at: Date.now(), repoId, kind: "writeback", text: `push failed for ${branch}: ${pushErr.slice(0, 140)} - branch is LOCAL-ONLY until this is resolved` });
                });
                if (push.alreadyDelivered) {
                  // #stale-base follow-up: a previous incarnation already
                  // delivered this branch (PR merged). Skip PR creation and
                  // the retry ladder - the task's work is on the remote.
                  body = `${body}\n\nWork for this task was already delivered on branch \`${branch}\` (previous delivery).`;
                  recordActivity(s, { at: Date.now(), repoId, kind: "writeback", text: `already delivered on ${branch} - skipped duplicate push/PR` });
                  // #5785: this shape delivered a PR in a previous
                  // incarnation - record the PR face so the settle audit
                  // does not re-verify it against GitHub forever after.
                  s.prDeliveries ??= {};
                  s.prDeliveries[task.id] = `branch:${branch} (previous delivery)`;
                } else {
                  let pr;
                  let prSkippedForZeroDiff = false;
                  try {
                    pr = await client.createPullRequest(repoId.split("/")[0]!, repoId.split("/")[1]!, branch, info.defaultBranch, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`.slice(0, 120), `${task.result.trim()}\n${MARKER_FOOTER(role)}`);
                  } catch (prErr) {
                    // #5788: a 422 on a freshly-pushed head almost always
                    // means the push NEVER LANDED (live: two stranded legs,
                    // generic "Validation Failed" masked it). Probe the head
                    // and disambiguate the failure text before rethrowing.
                    const pmsg = prErr instanceof Error ? prErr.message : String(prErr);
                    if (/422|Validation Failed/i.test(pmsg)) {
                      const probe = await sync.branchExistsRemotely(wtDir, branch).catch(() => false);
                      if (!probe) {
                        throw new Error(`createPR 422 with head branch ABSENT on remote - the PUSH never landed for ${branch} (see push-failure activity; local-only branch)`);
                      }
                      // #5815: branch IS present but PR still 422 - the zero-
                      // diff shape (head is an ancestor of base: the task
                      // completed with analysis-only output / misplaced-repo
                      // verdict). NOT retriable: every ladder run is the same
                      // 422. Deliver the result as the comment directly with
                      // an analysis note, like the #5719 failed-write path.
                      const zeroDiff = await sync.branchIsAncestorOfRemoteBase(wtDir, branch, info.defaultBranch).catch(() => false);
                      if (zeroDiff) {
                        body = `${body}\n\nNo code changes (analysis-only completion - no PR needed).`;
                        recordActivity(s, { at: Date.now(), repoId, kind: "writeback", text: `zero-diff 422 classified: ${task.id} completed with analysis-only output - delivering as comment, PR ladder skipped (#5815)` });
                        prDeliveryFailed = false;
                        prSkippedForZeroDiff = true;
                      }
                      if (!prSkippedForZeroDiff) throw prErr;
                    } else {
                      throw prErr;
                    }
                  }
                  if (prSkippedForZeroDiff) {
                    // fall through to the comment delivery below with the
                    // analysis-amended body - no PR to attach.
                  } else if (pr) {
                  entry.prUrl = pr.url;
                  body = `${body}\n\nDelivered as PR: ${pr.url}`;
                  recordActivity(s, { at: Date.now(), repoId, kind: "writeback", text: `PR opened: ${pr.url}` });
                  }
                }
              }
              await sync.removeTaskWorktree(repoId, task.id);
            } catch (prErr) {
              markWritebackFailure(s, entry, `worktree PR delivery failed: ${prErr instanceof Error ? prErr.message : String(prErr)}`);
              // #269 4th recurrence (ggcode#5524): a failed PR step must abort
              // the WHOLE entry this pass. The old fall-through posted the
              // link-less comment anyway, set doneAt, and the #24 cleanup
              // cleared the error - a partial delivery masked as success.
              // The retry pass then delivered the WITH-link comment too:
              // two comments 2s apart. Fail atomically instead: the entry
              // keeps its failed state + backoff and replays BOTH steps
              // (PR first, then comment) on the next attempt.
              // #5767: a COMPLETED task whose delivery exhausts is the worst
              // outcome (work done, product lost, owner unaware) - surface it
              // as its own alarm line, not just the retry-ladder failure row.
              if (task.status === "completed") {
                recordActivity(s, { at: Date.now(), repoId: entry.repoId, kind: "writeback", text: `completed task delivery LOST: ${task.id} finished but its worktree/PR delivery keeps failing (${prErr instanceof Error ? prErr.message.slice(0, 120) : String(prErr)}) - manual delivery may be required` });
              }
              prDeliveryFailed = true;
            }
          }
          if (prDeliveryFailed) {
            continue;
          }
          if (entry.action === "issueComment" && entry.targetId) {
            // #5818 defense-in-depth: the target may have been closed since
            // enqueue/dequeue - commenting on a closed issue pollutes the
            // resolution record. Re-check state first; closed -> skip with a
            // visible line (the result stays in the task record for manual
            // retrieval if ever needed).
            try {
              const targetIssue = await client.getIssue(owner, name, entry.targetId);
              if (targetIssue.state !== "open") {
                entry.doneAt = Date.now();
                entry.inFlightAt = undefined;
                writebackDone = true;
                recordActivity(s, { at: Date.now(), repoId: entry.repoId, kind: "writeback", text: `issueComment #${entry.targetId} skipped: issue CLOSED at delivery time - result retained in task record (#5818)` });
                logger.info(`TeamAuto: write-back ${entry.taskId} skipped - target issue #${entry.targetId} closed`);
              }
            } catch { /* state check failed - attempt delivery anyway */ }
          }
          if (entry.action === "issueComment" && entry.targetId && !writebackDone) {
            // #5725 / #5660 parity: the worker may have posted the same body
            // directly during its execution window (takeOwnership legs deliver
            // an ownership-wrap comment themselves). Posting again duplicates;
            // skipping silently breaks the observability contract. Exact
            // whitespace-normalized match -> mark done + record the skip.
            const normalizedBody = body.replace(/\s+/g, " ").trim();
            const existingBodies = await client.getIssueCommentBodies(owner, name, entry.targetId);
            if (existingBodies.some((b) => b.replace(/\s+/g, " ").trim() === normalizedBody)) {
              entry.doneAt = Date.now();
              entry.inFlightAt = undefined;
              writebackDone = true;
              recordActivity(s, { at: Date.now(), repoId: entry.repoId, kind: "writeback", text: `dedupe-skipped: identical body already on issue #${entry.targetId} (worker direct-post) - ladder posting skipped` });
              logger.info(`TeamAuto: write-back ${entry.taskId} issueComment deduped - identical body already on issue #${entry.targetId}`);
            } else {
            await client.postIssueComment(owner, name, entry.targetId, body);
            entry.doneAt = Date.now();
            entry.inFlightAt = undefined;
            writebackDone = true;
            }
            // Our own comment bumps the issue's updatedAt, which the scanner
            // treats as new activity - advance the seen cursor so we do not
            // re-trigger a review of an object we just replied to. External
            // edits (updatedAt > now) still re-arm the candidate.
            const issueRepo = s.repos.find((r) => r.id === entry.repoId);
            if (issueRepo) {
              issueRepo.cursors.seen[`${entry.repoId}#issue-${entry.targetId}`] = Date.now();
            }
          } else if (entry.action === "prComment" && entry.targetId) {
            // #5660 (ggcode, 2026-11-15): the worker already posted the same
            // review body directly during its execution window; the ladder
            // then delivered the IDENTICAL text 20s later - readers got the
            // review twice. Before posting, check the target's existing
            // feedback (reviews + comments, whitespace-normalized): an exact
            // match means delivery already happened through the other
            // channel - mark done and record the skip.
            // #5783: the prComment channel shipped BARE worker results - no
            // MARKER_FOOTER - so the evidence predicate (#5777-#5781 chain)
            // never matched its own deliveries and every prReview leg
            // false-alarmed. Append the footer like every other channel.
            // #5783 residual (same day): the shared body construction above
            // ALREADY appends one MARKER_FOOTER for every channel, so the
            // extra append here shipped the marker TWICE; and
            // getPullFeedbackBodies returns whitespace-COLLAPSED bodies, so
            // a "\n---\n[teamclaw:]" strip can never match the existing
            // side - a footered worker direct-post still double-delivered.
            // Post exactly ONE footer (stripping any footer blocks the
            // worker echoed into its result) and dedupe footer-agnostic
            // AFTER collapsing, so bare, footered and twice-footered shapes
            // all compare equal on both sides.
            const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
            const stripCollapsedFooter = (t: string) => collapse(t).replace(/ ?--- ?\[teamclaw:[^\]]+\].*$/, "").trim();
            const postBody = `${body.replace(/\n?---\n\[teamclaw:[^\]]+\][^\n]*/g, "").trimEnd()}\n${MARKER_FOOTER(role)}`;
            const normalized = stripCollapsedFooter(body);
            const existing = await client.getPullFeedbackBodies(owner, name, entry.targetId).catch(() => [] as string[]);
            if (existing.some((b) => stripCollapsedFooter(b) === normalized)) {
              entry.doneAt = Date.now();
              entry.inFlightAt = undefined;
              writebackDone = true;
              recordActivity(s, { at: Date.now(), repoId: entry.repoId, kind: "writeback", text: `dedupe-skipped: identical review body already on PR #${entry.targetId} (worker direct-post) - ladder posting skipped` });
              logger.info(`TeamAuto: write-back ${entry.taskId} prComment deduped - identical body already on PR #${entry.targetId}`);
            } else {
              await client.postPullReviewComment(owner, name, entry.targetId, postBody);
              entry.doneAt = Date.now();
              entry.inFlightAt = undefined;
              writebackDone = true;
            }
            const prRepo = s.repos.find((r) => r.id === entry.repoId);
            if (prRepo) {
              prRepo.cursors.seen[`${entry.repoId}#pr-${entry.targetId}`] = Date.now();
            }
          } else if (entry.action === "createIssue") {
            // Joint full review: same-cycle sections land in ONE umbrella issue
            // (first completed section creates it, the rest post as comments).
            const sectionBody = `### ${role} section\n\n${task.result.trim()}\n${MARKER_FOOTER(role)}`;
            if (entry.cycleKey) {
              // #5685 (ggcode, 2026-11-16): the umbrella pointer must survive
              // the end-of-pass pruning of done write-back entries (and
              // process restarts). The old lookup only saw peers delivered
              // in the SAME pass, so every cross-pass section minted its own
              // duplicate umbrella - live: cycle 20772 produced issues
              // #5686/#5687/#5688 (three "Joint full review" umbrellas,
              // zero section comments). The store map is the durable
              // pointer; an in-pass done peer remains as a fallback for
              // stores written before this fix.
              const cycleKey = `${entry.repoId}|${entry.cycleKey}`;
              s.fullReviewUmbrellas = s.fullReviewUmbrellas ?? {};
              const peerEntry = s.writebacks.find((w) => w.repoId === entry.repoId && w.cycleKey === entry.cycleKey && w.taskId !== entry.taskId && w.targetId != null && w.doneAt);
              const umbrellaNumber = s.fullReviewUmbrellas[cycleKey] ?? peerEntry?.targetId ?? null;
              if (umbrellaNumber != null) {
                // Crash-retry guard: this entry may BE the creator whose
                // createIssue + umbrella-map write persisted but whose doneAt
                // did not. The umbrella body already carries its section, so
                // a creator retry completes silently instead of re-posting.
                if (entry.targetId !== umbrellaNumber) {
                  await client.postIssueComment(owner, name, umbrellaNumber, sectionBody);
                }
                entry.targetId = umbrellaNumber;
                s.fullReviewUmbrellas[cycleKey] = umbrellaNumber;
                entry.doneAt = Date.now();
            entry.inFlightAt = undefined;
                writebackDone = true;
                entry.deliveryNote = "section-appended-to-umbrella";
              } else if (entry.targetId == null) {
                const number = await client.createIssue(
                  owner,
                  name,
                  `[teamclaw:fullreview] Joint full review - ${entry.repoId}`,
                  `Joint multi-role full review (cycle ${entry.cycleKey}). Each role appends its section as a comment below.\n\n${sectionBody}`,
                  ["teamclaw", "teamclaw:fullreview"],
                );
                entry.targetId = number;
                s.fullReviewUmbrellas[cycleKey] = number;
                entry.deliveryNote = "umbrella-created";
                // Persist the umbrella pointer immediately: done entries are
                // pruned at end-of-pass, and a crash between create and the
                // tail save must not lose the only record of the umbrella.
                const umbrellaKeys = Object.keys(s.fullReviewUmbrellas);
                if (umbrellaKeys.length > 100) {
                  for (const staleKey of umbrellaKeys.slice(0, umbrellaKeys.length - 100)) {
                    delete s.fullReviewUmbrellas[staleKey];
                  }
                }
                await saveTeamAutoStore(s);
                entry.doneAt = Date.now();
            entry.inFlightAt = undefined;
                writebackDone = true;
              }
            } else {
              const number = await client.createIssue(owner, name, `[teamclaw:${role}] ${task.title.replace(/^\[[^\]]+\]\s*/, "")}`, sectionBody, ["teamclaw"]);
              entry.targetId = number;
              entry.doneAt = Date.now();
            entry.inFlightAt = undefined;
              writebackDone = true;
            }
          } else {
            markWritebackFailure(s, entry, `unsupported action ${entry.action}`, { terminal: true });
          }
          if (writebackDone) {
            // Delivery succeeded: clear any transient failure state so a
            // partially-failed entry (e.g. PR opened on an earlier retry)
            // does not linger in the errored/failed stats (issue #24).
            entry.error = null;
            entry.failedAt = null;
            // #5735: distinguish created-vs-appended so umbrella cycles stop
            // reading as double-creates (two "createIssue #N ok" lines for
            // one issue is by design: first creates, peers append sections).
            recordActivity(s, { at: Date.now(), repoId: entry.repoId, kind: "writeback", text: `${entry.action} #${entry.targetId ?? "-"} ok${entry.deliveryNote ? ` [${entry.deliveryNote}]` : ""} (${task.id}${entry.attempts ? `, after ${entry.attempts} failed attempt(s)` : ""})` });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        markWritebackFailure(s, entry, message, {
          // #5704: an envelope-frame rejection is deterministic corruption -
          // the payload cannot change between attempts. Fail terminally
          // instead of burning the retry ladder re-posting the same frame.
          terminal: message.includes(ENVELOPE_LEAK_MARKER),
        });
      }
      void repo;
    }
    // #5736 (ggcode): record deliveries into the durable ledger BEFORE the
    // done-entry prune - the write-back array and the tiny activity ring are
    // both short-lived, but the orphan audit runs for 24h after completion.
    // Without this, every normally-delivered task alarms as an orphan once
    // its entry is pruned and its ok line rolls off the ring.
    s.deliveredResults ??= {};
    s.prDeliveries ??= {};
    for (const w of s.writebacks) {
      if (w.doneAt) {
        s.deliveredResults[w.taskId] = w.doneAt;
        // #5785: PR-face delivery must be durable too - the entry (and its
        // prUrl) dies at the prune below, and the undelivered-PR audit needs
        // to tell "PR opened, entry pruned" apart from "registration never
        // happened" without re-probing GitHub for every healthy task.
        if (w.prUrl) {
          s.prDeliveries[w.taskId] = w.prUrl;
        }
      }
    }
    const deliveredEntries = Object.entries(s.deliveredResults);
    if (deliveredEntries.length > 2000) {
      deliveredEntries.sort((a, b) => a[1] - b[1]);
      for (const [k] of deliveredEntries.slice(0, deliveredEntries.length - 1500)) delete s.deliveredResults[k];
    }
    s.writebacks = s.writebacks.filter((w) => !w.doneAt).slice(-500);
    await saveTeamAutoStore(s);
  }

  // Register the write-back intent when a task lands in the task store.
  // #5643 (user report 2026-11-15): this used to be fire-and-forget
  // (void ensureStore().then(...).catch(() => {})) - the push+save raced the
  // sweep's own awaited store save AND swallowed its own errors. The 11-15
  // 02:00 batch lost ALL THREE fullReview write-back entries that way
  // (tasks + activity + "created 3/3" persisted; the entries did not), so
  // completed reviews delivered nothing, silently. Registration is now part
  // of the sweep transaction: the caller awaits it before the sweep's own
  // save, and failures propagate instead of vanishing.
  async function registerWriteback(taskId: string, action: "issueComment" | "prComment" | "createIssue" | "createPR", repoId: string, targetId: number | null, cycleKey?: string): Promise<void> {
    // #5712 (ggcode) / teamclaw#274: every store read-modify-write must hold
    // withStoreLock. Public entry takes the lock; the sweep transaction calls
    // the *Unlocked core directly because IT already holds the lock (the
    // promise-chain mutex is NOT re-entrant - nesting would deadlock).
    await withStoreLock(async () => {
      await reloadStoreUnlocked(); // #5792: fresh handle under the lock
      return registerWritebackUnlocked(taskId, action, repoId, targetId, cycleKey);
    });
  }

  async function registerWritebackUnlocked(taskId: string, action: "issueComment" | "prComment" | "createIssue" | "createPR", repoId: string, targetId: number | null, cycleKey?: string): Promise<void> {
    const s = await ensureStore();
    if (s.writebacks.some((w) => w.taskId === taskId)) {
      return;
    }
    // #5785 (ggcode, 2026-11-18): the enqueue-side per-target dedupe is
    // REMOVED. It skipped a registration whenever ANY pending entry aimed at
    // the same target + action, on the assumption "the pending original
    // still delivers the content" - but write-back content is per-task
    // (task.result): a different task's entry delivers ITS OWN result,
    // never this one. Live shape: a later leg on the same issue enrolled
    // while an earlier leg's entry was still pending; the later task's
    // registration was silently swallowed, so its completed WRITE result
    // never entered the ladder - the branch sat on the remote with no PR
    // (writebacks [] across the whole 10m42s observation window) and only
    // the worker's issue-face direct-post kept the orphan audit quiet.
    // Duplicate protection is fully covered by the other three guards:
    //   (1) same-taskId idempotency above (a re-registration of ONE task),
    //   (2) the #269 delivery-side per-target cap (ONE entry per target key
    //       per pass - co-target rows serialize across 20s passes), and
    //   (3) exact-body dedupe at post time (worker direct-posts).
    if (targetId != null && s.writebacks.some((w) => w.targetId === targetId && w.repoId === repoId && w.action === action && !w.doneAt)) {
      recordActivity(s, { at: Date.now(), repoId, kind: "writeback", text: `co-target write-back registered: ${taskId} joins ${s.writebacks.filter((w) => w.targetId === targetId && w.repoId === repoId && w.action === action && !w.doneAt).length} pending ${action} row(s) on #${targetId} - rows serialize via the delivery-side per-pass cap (#5785)` });
    }
    s.writebacks.push({ taskId, action, repoId, targetId, doneAt: null, prUrl: null, error: null, cycleKey });
    await saveTeamAutoStore(s);
  }

  // #claim-dequeue (user report 2026-11-15): claim at DEQUEUE time, not
  // enqueue. Enqueue-time claims locked a whole queue of issues behind the
  // one-writer-per-repo serialization while they waited; and a blind claim
  // over issues where external collaborators had begun working (comments,
  // assignees) only produced conflicts. At dequeue we re-check FRESH state:
  //   - any assignee -> stand down (a human or another bot owns it)
  //   - any external comment posted after the task was enqueued -> stand
  //     down (someone is actively working; our own bot's comments excluded)
  // Only a quiet, unowned issue gets claimed (assign, comment fallback),
  // with the existing seen+60s self-bump guard.
  async function claimTaskAtDequeue(task: {
    id: string;
    title: string;
    description: string;
    createdAt?: number;
  }): Promise<{ claimed: boolean; reason?: string; retryEligibility?: boolean }> {
    const kindMatch = /^\[([^\]]+)\]/.exec(task.title);
    if (!kindMatch || kindMatch[1] !== "takeOwnership") return { claimed: false, reason: "not a takeOwnership task" };
    const numMatch = /issue #(\d+)/.exec(task.title);
    if (!numMatch) return { claimed: false, reason: "no issue number" };
    const issueNumber = Number(numMatch[1]);
    const repoMatch = /TeamAuto autonomous work for ([\w./-]+)\./.exec(task.description);
    if (!repoMatch) return { claimed: false, reason: "no repo in description" };
    const repoId = repoMatch[1];
    const [owner, name] = repoId.split("/");
    if (!owner || !name) return { claimed: false, reason: "bad repo id" };
    const client = createGithubClient(auth);
    // #5740 (ggcode, 2026-11-17): eligibility CHECK failures (fetch failed on
    // getIssue/getAuthenticatedUser/getIssueCommentsSince) must NOT let the
    // task run unclaimed - the conflict check is the core #claim-dequeue
    // contract. Only the WRITE phase (assign/comment) may continue
    // unclaimed on failure (original 2026-11-15 semantics). The caller
    // reverts the assignment on retryEligibility so the next auto-assign
    // pass re-checks; a network blip delays execution by ~20s, an outage
    // loops at assignment cadence instead of silently bypassing the gate.
    let login: string;
    try {
      const fresh = await client.getIssue(owner, name, issueNumber);
      if (fresh.state !== "open") {
        return { claimed: false, reason: "issue closed" };
      }
      const s0 = await ensureStore();
      const repo0 = s0.repos.find((r) => r.id === repoId);
      if ((repo0?.policy.skipAssignedToHumans ?? true) && fresh.assignees.length > 0) {
        recordActivity(await ensureStore(), { at: Date.now(), repoId, kind: "claim", text: `deferred claim: issue #${issueNumber} has assignee(s) ${fresh.assignees.join(",")} at dequeue - standing down` });
        return { claimed: false, reason: "assignees present" };
      }
      // External-work check: comments posted after the task was ENQUEUED.
      const sinceIso = new Date(task.createdAt ?? Date.now()).toISOString();
      login = (await client.getAuthenticatedUser()).login;
      const comments = await client.getIssueCommentsSince(owner, name, issueNumber, sinceIso);
      // #5819: same-account multi-seat blindness. Filtering purely by
      // account excludes ALL seats sharing the bot account - a sibling seat
      // claiming the same issue ([claim master_coordinator] ...) was
      // invisible and both seats implemented it (live: #5812 double
      // delivery). Content-aware: same-account comments carrying a SEAT
      // declaration ([claim X]/[done X]) count as external UNLESS X is one
      // of teamauto's own roles (those are this pipeline's own prior legs -
      // retry legs must not stand down on their own history).
      const seatDecl = /\[(claim|done)\s+([a-z_-]+)\s*\]/i;
      const teamautoRoles = new Set(["developer", "qa", "architect", "security-engineer", "security-engineer-role"]);
      const external = comments.filter((c) => {
        if (c.user !== login) return true;
        const m = seatDecl.exec(String((c as { body?: string }).body ?? ""));
        return Boolean(m && !teamautoRoles.has(m[2]!.toLowerCase()));
      });
      if (external.length > 0) {
        recordActivity(await ensureStore(), { at: Date.now(), repoId, kind: "claim", text: `deferred claim: ${external.length} external comment(s) since enqueue on issue #${issueNumber} (latest by @${external[external.length - 1]?.user}) - standing down` });
        return { claimed: false, reason: "external activity" };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordActivity(await ensureStore(), { at: Date.now(), repoId, kind: "claim", text: `claim-at-dequeue ELIGIBILITY CHECK failed for issue #${issueNumber}: ${msg.slice(0, 120)} - reverting assignment, will retry` });
      return { claimed: false, reason: "eligibility-check-failed", retryEligibility: true };
    }
    // #5740 (ggcode, 2026-11-17): the WRITE phase keeps the original
    // 2026-11-15 "continue unclaimed" semantics when it fails (the
    // eligibility checks DID pass), but it must not vanish silently - the
    // caller swallows rejections - so record the audit line here and return
    // a non-retrying result.
    try {
      let claimNote = "";
      try {
        await client.assignIssue(owner, name, issueNumber, login);
        claimNote = `claimed issue #${issueNumber} as @${login} (at dequeue)`;
      } catch {
        // Fallback: a visible claim comment carries the same placeholder
        // semantics when the App lacks the assignees write surface.
        await client.postIssueComment(owner, name, issueNumber, `TeamClaw (teamclaw/developer, @${login}) has taken ownership of this issue and is implementing it autonomously - a PR will follow.`);
        claimNote = `claimed issue #${issueNumber} via comment (assign unavailable, at dequeue)`;
      }
      await withStoreLock(async () => {
        // #5792: one fresh handle under the lock. The old shape captured
        // `s` before the claim writes (network awaits) and saved it inside
        // the lock - a reconcile reload in between orphaned the handle and
        // the save wiped concurrent registrations; the claim activity note
        // also only persisted when it rode the same (possibly stale) object.
        const s = await reloadStoreUnlocked();
        recordActivity(s, { at: Date.now(), repoId, kind: "claim", text: claimNote });
        const freshRepo = s.repos.find((r) => r.id === repoId);
        if (freshRepo) {
          // +60s guard: our own write (assign or comment) bumps updated_at.
          freshRepo.cursors.seen[`${repoId}#issue-${issueNumber}`] = Date.now() + 60_000;
          await saveTeamAutoStore(s);
        }
      });
      return { claimed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordActivity(await ensureStore(), { at: Date.now(), repoId, kind: "claim", text: `claim-at-dequeue WRITE failed for issue #${issueNumber}: ${msg.slice(0, 120)} - continuing unclaimed` });
      return { claimed: false, reason: "claim write failed" };
    }
  }

  /** #268: make a takeOwnership claim VISIBLE on the issue itself. Until now
   * assignIssue was dead code and registerWriteback had no assign action, so
   * claims existed only in internal state - humans could not see the bot had
   * picked an issue up (collision risk), contradicting the design decision
   * that identity presents as the logged-in account's activity.
   * Fired at ENQUEUE time: a claim is a placeholder declaration; posting it
   * at completion would leave the whole execution window claim-invisible.
   * Best-effort, never blocks the task. Review notes (#268):
   *  (a) re-check assignees at claim time (the scan snapshot is seconds
   *      stale - a human may have self-assigned in between);
   *  (b) stamp cursors.seen with NOW + 60s on BOTH success paths (assign
   *      AND fallback comment) because our own write bumps the issue's
   *      updated_at - a bare-assign stamp would lose the scanner's
   *      `seen >= updatedAt` comparison next sweep and re-candidate the
   *      issue we just claimed (self-triggering loop). */
  function claimIssue(repo: TeamAutoRepo, candidate: { key: string; number: number; kind: string; title: string }): void {
    if (candidate.kind !== "takeOwnership" || !candidate.number) {
      return;
    }
    void (async () => {
      const [owner, name] = repo.id.split("/");
      const client = createGithubClient(auth);
      try {
        const fresh = await client.getIssue(owner, name, candidate.number);
        if (fresh.state !== "open") {
          return;
        }
        if (repo.policy.skipAssignedToHumans && fresh.assignees.length > 0) {
          recordActivity(await ensureStore(), { at: Date.now(), repoId: repo.id, kind: "claim", text: `claim skipped: issue #${candidate.number} gained an assignee since scan` });
          return;
        }
        const { login } = await client.getAuthenticatedUser();
        let claimNote = "";
        try {
          await client.assignIssue(owner, name, candidate.number, login);
          claimNote = `claimed issue #${candidate.number} as @${login}`;
        } catch {
          // Fallback: a visible claim comment carries the same placeholder
          // semantics when the App lacks the assignees write surface.
          await client.postIssueComment(owner, name, candidate.number, `TeamClaw (teamclaw/developer, @${login}) has taken ownership of this issue and is implementing it autonomously - a PR will follow.`);
          claimNote = `claimed issue #${candidate.number} via comment (assign unavailable)`;
        }
        await withStoreLock(async () => {
        // #5792: one fresh handle under the lock (same stale-snapshot class
        // as the sweep transaction - the capture used to predate the claim
        // network writes).
        const s = await reloadStoreUnlocked();
        recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "claim", text: claimNote });
        const freshRepo = s.repos.find((r) => r.id === repo.id);
        if (freshRepo) {
          // +60s guard: our own write (assign or comment) bumps updated_at;
          // see helper doc.
          freshRepo.cursors.seen[candidate.key] = Date.now() + 60_000;
          await saveTeamAutoStore(s);
        }
        });
      } catch (err) {
        logger.warn(`TeamAuto: claim for ${repo.id}#${candidate.number} failed (task continues unclaimed): ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  /** #claim-recovery: a task that CLAIMED an issue (takeOwnership stamps the
   * seen cursor AND self-assigns the bot at enqueue time; issueReview stamps
   * the cursor) locks the issue twice against re-candidacy. When the task
   * fails, the issue must not be orphaned - nobody (human or bot) would ever
   * pick it up again. Once per failed taskId: clear the seen stamp so the
   * next sweep re-candidates naturally, and for takeOwnership remove the
   * bot's own assignment (human assignees untouched). The existing
   * dead-letter caps (3 hard / 6 transient) bound how often this can loop. */
  async function recoverFailedClaims(): Promise<void> {
    const teamState = deps.getTeamState();
    if (!teamState) {
      return;
    }
    const s = await ensureStore();
    s.failedClaimRecovery ??= {};
    let changed = false;
    for (const [taskId, task] of Object.entries(teamState.tasks ?? {})) {
      if (task?.status !== "failed" || typeof task.description !== "string" || !task.description.includes("Idempotency-Key:")) {
        continue;
      }
      // #5823-loop: "Cancelled: ..." terminal states (#5818 closed / #5823
      // stand-down) are VERDICTS, not failures - recovering them re-opens the
      // issue, the next leg re-verdicts the same way, and the pair loops
      // forever burning a leg per sweep (live: #5827/#5829 two-loop at
      // 11:32/11:47). #claim-recovery is for real execution failures only.
      if (typeof task.error === "string" && task.error.startsWith("Cancelled:")) {
        continue;
      }
      if (s.failedClaimRecovery[taskId]) {
        continue;
      }
      const parsed = parseClaimMarker(task.description);
      const repo = parsed ? s.repos.find((r) => r.id === parsed.repoId) : undefined;
      if (!parsed || !repo) {
        continue;
      }
      delete repo.cursors.seen[parsed.key];
      s.failedClaimRecovery[taskId] = Date.now();
      changed = true;
      recordActivity(s, { at: Date.now(), repoId: repo.id, kind: "sweep", text: `recovered failed task ${taskId}: issue #${parsed.number} re-opened for the next sweep` });
      if (parsed.kind === "takeOwnership") {
        void (async () => {
          try {
            const client = createGithubClient(auth);
            const { login } = await client.getAuthenticatedUser();
            const [owner, name] = repo.id.split("/");
            await client.removeIssueAssignees(owner, name, parsed.number, [login]);
          } catch (err) {
            logger.warn(`TeamAuto: unassign for failed claim ${repo.id}#${parsed.number} failed (scanner may skip it until a human clears the assignee): ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
    }
    if (changed) {
      const entries = Object.entries(s.failedClaimRecovery).sort((a, b) => a[1] - b[1]);
      if (entries.length > 200) {
        s.failedClaimRecovery = Object.fromEntries(entries.slice(entries.length - 200));
      }
      await saveTeamAutoStore(s);
    }
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
    // Auto-paused repos arm the RETRY ladder, not the regular schedule: the
    // retry-due check used to ride the next regular tick, so "auto-retry in
    // ~1min" for a network blip really meant "at the next hourly tick".
    // While paused, retry at the class-aware backoff; a successful sweep
    // clears pausedReason and restores the regular schedule below.
    if (isAutoPause(repo.pausedReason) && repo.lastSweepErrorAt) {
      delay = Math.max(SWEEP_RETRY_FLOOR_MS, sweepRetryDueAt(repo.sweepFailures ?? 1, repo.lastSweepErrorAt, failClassFromPauseReason(repo.pausedReason)) - Date.now());
    } else {
      try {
        delay = nextFireMs(repo.schedule);
      } catch (err) {
        logger.error(`TeamAuto: ${repo.id} has an unsupported schedule "${repo.schedule}" and will not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const s = await ensureStore();
          const fresh = s.repos.find((r) => r.id === repo.id);
          const retryDue = fresh
            ? isAutoPause(fresh.pausedReason) && Date.now() >= sweepRetryDueAt(fresh.sweepFailures ?? 1, fresh.lastSweepErrorAt ?? 0, failClassFromPauseReason(fresh.pausedReason))
            : false;
          if (fresh?.enabled && (fresh.pausedReason === null || retryDue)) {
            await runSweep(fresh, false);
          }
          if (fresh?.enabled) {
            scheduleRepo(fresh);
          }
        } catch (err) {
          // The timer chain must survive any single tick failure. Before this
          // guard, a rejected ensureStore() (corrupt store file, IO error)
          // unhandled-rejected through `void`, scheduleRepo(fresh) never ran,
          // and the repo's scheduling chain died silently until a gateway
          // restart. Re-arm from the last known config; updateRepo re-arms on
          // config change anyway, so a stale schedule here is bounded.
          logger.warn(`TeamAuto: sweep tick failed for ${repo.id}, re-arming timer: ${err instanceof Error ? err.message : String(err)}`);
          try {
            scheduleRepo(repo);
          } catch {
            // scheduleRepo only throws on programmer error; a dead chain here
            // is still recoverable by restart (start() rebuilds all timers).
          }
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
    claimRecoveryTimer = setInterval(() => {
      void recoverFailedClaims();
    }, 60_000);
    claimRecoveryTimer.unref?.();
    // #gc-periodic: worktree GC used to be boot-only with an enabled-repo
    // filter - two defects (live-instance audit 2026-11-14): (a) a disabled
    // repo ("do no NEW work") never got cleaned at all; (b) the single boot
    // pass ran before the device-flow auth warmed up, so every targetClosed
    // oracle call failed toward keep and closed-target orphans stayed (4
    // confirmed misretains). Now a recurring pass: first run delayed 60s
    // (auth warm), then every 6h - transient oracle failures self-heal on
    // the next pass.
    const gcDelay = setTimeout(() => {
      void runGcPass();
      gcTimer = setInterval(() => {
        void runGcPass();
      }, 6 * 60 * 60_000);
      gcTimer.unref?.();
    }, 60_000);
    gcDelay.unref?.();
  }

  /** #gc-periodic: one full worktree GC pass over ALL bound repos (enabled
   * or not - GC is hygiene, not new work). Shared by the boot-delayed first
   * run and the 6h recurrence. */
  async function runGcPass(): Promise<void> {
    try {
      // #173 follow-up 3: with getTeamState() === null the isTerminal
      // predicate below classifies EVERY task as terminal - GC must not run
      // blind over an unloaded team state (fails toward skip).
      if (!deps.getTeamState()) {
        logger.warn("TeamAuto: worktree GC skipped (team state unavailable)");
        return;
      }
      const s = await ensureStore();
      let removed = 0;
      let retained = 0;
      let stale = 0;
      const retainedDetails: string[] = [];
      for (const repo of s.repos) {
        const isTerminal = (taskId: string): boolean => {
          const t = deps.getTeamState()?.tasks[taskId];
          if (t && t.status !== "completed" && t.status !== "failed") return false;
          // Review F1: a terminal task with a pending write-back (push
          // ok / PR failed, 20s-retry window) still needs its worktree -
          // the retry delivers the PR from the surviving branch. Do not
          // GC until the write-back settles (doneAt or dropped). Issue
          // #24: terminally failed write-backs (failedAt) count as settled
          // too - safeRemoveTaskWorktree still retains unpushed work.
          return !s.writebacks.some((w) => w.taskId === taskId && !w.doneAt && !w.failedAt);
        };
        // #gc3: no task record anywhere in team-state -> the owner ruled
        // outright deletion (2026-11-14, "全删") - such worktrees can never
        // be judged by any oracle and were retained forever.
        const isUnknownTask = (taskId: string): boolean => !deps.getTeamState()?.tasks?.[taskId];
        const r = await sync.gcTaskWorktrees(repo.id, isTerminal, squashDeliveryOracle, targetClosedOracle, isUnknownTask);
        removed += r.removed.length;
        retained += r.retained.length;
        stale += r.stale;
        retainedDetails.push(...r.retained.map((x) => `${x.taskId}: ${x.reason}`));
      }
      if (removed || retained || stale) {
        // #173 follow-up 4: per-task retain reasons recorded as activity
        // (PR #167 promised "outcome logged + recorded as activity"); the
        // stale count surfaces dir-gone-but-branch-kept leaks too.
        const detail = retainedDetails.length
          ? `; ${retainedDetails.slice(0, 10).join("; ")}${retainedDetails.length > 10 ? `; +${retainedDetails.length - 10} more` : ""}`
          : "";
        const stalePart = stale ? `, stale ${stale}` : "";
        await withStoreLock(async () => {
          // #5792: fresh handle under the lock - the capture predates the
          // (long) gcTaskWorktrees git awaits and could be orphaned by a
          // reconcile reload; saving it wiped concurrent registrations.
          const sGc = await reloadStoreUnlocked();
          recordActivity(sGc, { at: Date.now(), repoId: "*", kind: "task", text: `worktree GC: removed ${removed}, retained ${retained} (undelivered${detail})${stalePart}` });
          await saveTeamAutoStore(sGc);
        });
        logger.warn(`TeamAuto: worktree GC removed ${removed}, retained ${retained}${stalePart}`);
      }
    } catch (err) {
      logger.warn(`TeamAuto: worktree GC failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function stop(): Promise<void> {
    running = false;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    if (writebackTimer) {
      clearInterval(writebackTimer);
      if (claimRecoveryTimer) {
        clearInterval(claimRecoveryTimer);
      }
      if (gcTimer) {
        clearInterval(gcTimer);
      }
      writebackTimer = null;
    }
  }

  async function getStatus(): Promise<{
    repos: TeamAutoRepo[];
    budget: TeamAutoStore["budget"];
    activity: NonNullable<TeamAutoStore["activity"]>;
    writebacks: ReturnType<typeof summarizeWritebacks>;
  }> {
    const s = await ensureStore();
    // Issue #24: failed/stuck write-back deliveries are part of the status
    // payload (repos endpoint + teamclaw_teamauto_status tool) instead of
    // being invisible outside warn logs.
    return { repos: s.repos, budget: s.budget, activity: s.activity ?? [], writebacks: summarizeWritebacks(s) };
  }

  async function getActivity(): Promise<NonNullable<TeamAutoStore["activity"]>> {
    const s = await ensureStore();
    return (s.activity ?? []).slice().reverse();
  }

  return { addRepo, removeRepo, setRepoEnabled, updateRepo, runSweepNow, registerWriteback, reconcileWritebacks, claimTaskAtDequeue, start, stop, getStatus, getActivity, ensureWriteWorktree, removeWriteWorktree, proposeManual };

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
