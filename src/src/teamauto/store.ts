import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTeamClawProjectsDir } from "../openclaw-workspace.js";

/**
 * TeamAuto persistence: bound repos, schedules, policies, cursors, norms,
 * and write-back bookkeeping. Mirrors the plugin state-dir resolution used by
 * state.ts / github-auth.ts. See TEAMAUTO_DESIGN.md for the design contract.
 */

export const TEAMAUTO_STORE_VERSION = 1;

export type TeamAutoActionPolicy = {
  issueReview: boolean;
  takeOwnership: boolean;
  prReview: boolean;
  createPR: boolean;
  fullReview: "off" | "weekly" | "daily";
  /** #pr-rework: pick up fresh review activity on OUR delivered PRs and
   * rework them (developer role, write mode). Default true - closing the
   * loop is the expected behavior for every deployment. */
  prRework?: boolean;
};

export type TeamAutoKeywordFilter = {
  include: string[];
  exclude: string[];
};

export type TeamAutoRepoPolicy = {
  maxTasksPerSweep: number;
  actions: TeamAutoActionPolicy;
  skipAssignedToHumans: boolean;
  labelFilter: TeamAutoKeywordFilter;
  keywordFilter: TeamAutoKeywordFilter;
};

export type TeamAutoCursors = {
  lastIssueSince: number;
  lastPrSince: number;
  lastCommitSha: string;
  lastFullReviewAt: number;
  seen: Record<string, number>;
  etags: Record<string, string>;
};

export type TeamAutoRepoNorms = {
  commitStyle: string;
  issueTemplate: string | null;
  prTemplate: string | null;
  contributing: string | null;
  learnedAt: number;
};

export type TeamAutoRepoProvision = {
  status: "provisioning" | "ready" | "failed";
  /** Current stage label for UI display, e.g. "cloning repo". */
  message: string;
  startedAt: number;
  updatedAt: number;
};

export type TeamAutoRepo = {
  id: string; // "owner/repo"
  enabled: boolean;
  schedule: string; // cron, default "*/30 * * * *"
  addedAt: number;
  lastSweepAt: number;
  lastSweepSummary: string | null;
  // #5641: task failures surfaced in the next sweep summary. Incremented
  // whenever a write-back is dead-lettered because its task failed without
  // a result; read + reset by the sweep so owners see "failed N" next to
  // "created N/N" instead of a silently dying leg.
  failedTasksSinceLastSweep?: number;
  pausedReason: string | null;
  /** Consecutive auto-paused sweep failures; drives retry backoff (0/undefined = healthy). */
  sweepFailures?: number;
  /** Epoch ms of the last auto-pausing sweep failure. */
  lastSweepErrorAt?: number;
  /** Epoch ms of the last sweep ATTEMPT (success or failure), #266:
   * lastSweepAt/lastSweepSummary stay success-scoped while lastAttemptAt
   * answers "did the scheduler try recently" without the two surfaces
   * contradicting each other when read side by side. */
  lastAttemptAt?: number;
  /** #267-2: bounded per-repo sweep ring (newest last, cap 20). */
  sweeps?: TeamAutoSweepRecord[];
  dryRunDone: boolean;
  /** Bind-time provisioning state; ready/undefined means sweepable. */
  provision?: TeamAutoRepoProvision;
  policy: TeamAutoRepoPolicy;
  cursors: TeamAutoCursors;
  norms: TeamAutoRepoNorms | null;
};

export type TeamAutoWriteBack = {
  taskId: string;
  action: "issueComment" | "prComment" | "createIssue" | "createPR";
  /** #5815: identical-error-text circuit breaker state. */
  lastErrorText?: string;
  lastErrorStreak?: number;
  repoId: string;
  targetId: number | null;
  doneAt: number | null;
  prUrl: string | null;
  error: string | null;
  /** Joint full-review cycle id: same-cycle sections share one umbrella issue. */
  cycleKey?: string;
  /** #5735: delivery-shape disambiguation for the ok activity line (umbrella-created vs section-appended-to-umbrella). */
  deliveryNote?: string;
  /**
   * Issue #24: failed delivery attempts so far. Drives the retry backoff and
   * the terminal give-up marker instead of a sticky error that nothing ever
   * retried or surfaced.
   */
  attempts?: number;
  /** Epoch ms of the last failed delivery attempt. */
  lastErrorAt?: number;
  /** Epoch ms when the next retry becomes due (exponential backoff gate). */
  nextAttemptAt?: number;
  /** #269: set (and persisted) BEFORE dispatch starts so overlapping
   * reconcile passes can see the in-flight intent; cleared on success
   * (doneAt) or failure (error/nextAttemptAt). A crashed process can
   * leave it stale - reconciles older than 10 minutes are reset. */
  inFlightAt?: number;
  /** Terminal marker: set when retry attempts are exhausted; never retried again. */
  failedAt?: number | null;
};

export type TeamAutoActivityKind = "bind" | "provision" | "sweep" | "task" | "writeback" | "claim" | "hygiene";

export type TeamAutoActivityEntry = {
  at: number;
  repoId: string;
  kind: TeamAutoActivityKind;
  text: string;
};

export const TEAMAUTO_ACTIVITY_LIMIT = 100;

export function pushTeamAutoActivity(store: TeamAutoStore, entry: TeamAutoActivityEntry): void {
  store.activity = store.activity ?? [];
  store.activity.push(entry);
  if (store.activity.length > TEAMAUTO_ACTIVITY_LIMIT) {
    store.activity = store.activity.slice(store.activity.length - TEAMAUTO_ACTIVITY_LIMIT);
  }
}

/** #267-2: bounded per-repo sweep ring (newest last, cap 20) - same slice
 * pattern as pushTeamAutoActivity. */
export function pushSweepRecord(repo: TeamAutoRepo, entry: TeamAutoSweepRecord): void {
  repo.sweeps = repo.sweeps ?? [];
  repo.sweeps.push(entry);
  if (repo.sweeps.length > 20) {
    repo.sweeps = repo.sweeps.slice(repo.sweeps.length - 20);
  }
}

/** #267-2 record type: one bounded per-repo sweep history entry. */
export type TeamAutoSweepRecord = {
  at: number;
  ok: boolean;
  summary: string;
  /** #267-1 classification when ok=false: auth | ratelimited | network. */
  failClass?: "auth" | "ratelimited" | "network";
  durationMs: number;
  /** #267-3 per-sweep deltas of the client's cumulative etag counters. */
  etagCalls: number;
  etag304Hits: number;
};

export type TeamAutoStore = {
  version: number;
  repos: TeamAutoRepo[];
  writebacks: TeamAutoWriteBack[];
  /** Bounded activity log for the UI feed (persists across restarts). */
  activity?: TeamAutoActivityEntry[];
  budget: {
    maxTasksPerDay: number;
    firstSweepDryRun: boolean;
    tasksToday: number;
    dayStamp: string;
  };
  /** #claim-recovery: taskId -> recoveredAt. A failed task whose candidate
   * claimed an issue must not orphan it - the recovery pass clears the seen
   * stamp (and the bot's self-assignment) once per taskId so the next sweep
   * re-candidates naturally, while the dead-letter caps bound retries. */
  failedClaimRecovery?: Record<string, number>;
  /** #5725: once-per-task guard for orphan-result alarms (completed with result, no write-back entry, no delivery line). */
  orphanResultAlarms?: Record<string, number>;
  /** #5785: once-per-task guard for undelivered-PR alarms (WRITE tasks accounted as delivered with no PR leg). */
  undeliveredPrAlarms?: Record<string, number>;
  /** #5736: durable delivered-ledger. doneAt write-back entries are pruned
   * every pass and the activity ring is tiny - without this ledger every
   * normally-delivered task re-alarms as an orphan hours later. taskId -> deliveredAt. */
  deliveredResults?: Record<string, number>;
  /** #5738: one-time ledger migration marker (seed from task state, pardoning pre-deploy history once). */
  deliveredResultsInit?: boolean;
  /** #5685 (ggcode, 2026-11-16): "repoId|cycleKey" -> umbrella issue number
   * for joint full reviews. Done write-back entries are pruned at end-of-pass,
   * so an in-store peer scan cannot carry the umbrella pointer across passes
   * (or restarts) and same-cycle sections each minted a duplicate umbrella
   * (live: cycle 20772 -> ggcode issues #5686/#5687/#5688, zero section
   * comments). Bounded to the newest 100 cycles. */
  fullReviewUmbrellas?: Record<string, number>;
};

export function defaultPolicy(): TeamAutoRepoPolicy {
  return {
    maxTasksPerSweep: 5,
    actions: { issueReview: true, takeOwnership: true, prReview: true, createPR: true, fullReview: "weekly" },
    skipAssignedToHumans: true,
    labelFilter: { include: [], exclude: ["wontfix", "teamclaw-skip", "do-not-automate"] },
    keywordFilter: { include: [], exclude: [] },
  };
}

export function defaultCursors(): TeamAutoCursors {
  return { lastIssueSince: 0, lastPrSince: 0, lastCommitSha: "", lastFullReviewAt: 0, seen: {}, etags: {} };
}

function emptyStore(): TeamAutoStore {
  const now = new Date();
  return {
    version: TEAMAUTO_STORE_VERSION,
    repos: [],
    writebacks: [],
    activity: [],
    failedClaimRecovery: {},
    orphanResultAlarms: {},
    deliveredResults: {},
    fullReviewUmbrellas: {},
    budget: {
      maxTasksPerDay: 150,
      firstSweepDryRun: true,
      tasksToday: 0,
      dayStamp: now.toISOString().slice(0, 10),
    },
  };
}

export function resolveTeamAutoPaths(): { storeFile: string; reposRoot: string; legacyReposRoot: string } {
  const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  let base: string;
  if (explicitStateDir) {
    base = path.join(path.resolve(explicitStateDir), "plugins", "teamclaw");
  } else {
    const explicitHome = process.env.OPENCLAW_HOME?.trim() || process.env.HOME?.trim();
    const homeDir = explicitHome ? path.resolve(explicitHome) : os.homedir();
    base = path.join(homeDir, ".openclaw", "plugins", "teamclaw");
  }
  // Repos live inside the TeamClaw workspace projects tree so workers and
  // the workspace browser can actually operate on them (TEAMAUTO_DESIGN.md).
  // The pre-workspace location is kept only to migrate existing clones.
  let reposRoot: string;
  try {
    reposRoot = path.join(resolveTeamClawProjectsDir(), "teamauto");
  } catch {
    reposRoot = path.join(base, "teamauto", "repos");
  }
  return {
    storeFile: path.join(base, "teamauto.json"),
    reposRoot,
    legacyReposRoot: path.join(base, "teamauto", "repos"),
  };
}

const writeQueue: Promise<void>[] = [];

export async function loadTeamAutoStore(): Promise<TeamAutoStore> {
  const { storeFile } = resolveTeamAutoPaths();
  let baseFingerprint = "";
  try {
    const raw = await fs.readFile(storeFile, "utf8");
    baseFingerprint = staleWriteFingerprint(raw);
    const parsed = JSON.parse(raw) as Partial<TeamAutoStore>;
    const store = emptyStore();
    if (Array.isArray(parsed.repos)) {
      store.repos = parsed.repos
        .filter((r): r is TeamAutoRepo => Boolean(r && typeof r.id === "string"))
        .map((r) => ({
          ...r,
          policy: { ...defaultPolicy(), ...(r.policy ?? {}), actions: { ...defaultPolicy().actions, ...(r.policy?.actions ?? {}) } },
          cursors: { ...defaultCursors(), ...(r.cursors ?? {}) },
        }));
    }
    if (Array.isArray(parsed.writebacks)) {
      store.writebacks = parsed.writebacks as TeamAutoWriteBack[];
    }
    if (Array.isArray(parsed.activity)) {
      store.activity = parsed.activity.slice(-TEAMAUTO_ACTIVITY_LIMIT);
    }
    if (parsed.failedClaimRecovery && typeof parsed.failedClaimRecovery === "object") {
      store.failedClaimRecovery = parsed.failedClaimRecovery as Record<string, number>;
    }
    if (parsed.fullReviewUmbrellas && typeof parsed.fullReviewUmbrellas === "object") {
      store.fullReviewUmbrellas = parsed.fullReviewUmbrellas as Record<string, number>;
    }
    // #5736 (ggcode): the orphan-alarm chain (#5725 -> #5736 -> #5738) learned
    // this the hard way three times over - loadTeamAutoStore rebuilds the store
    // field-by-field, so a persistence field missing from this copy list is
    // dropped on EVERY 20s settle reload even though saveTeamAutoStore writes
    // it to disk. With all three alarm fields missing, the alarm silently
    // disarmed: deliveredResultsInit dropped => the one-time migration re-ran
    // each pass and pardoned every completed in-window task (genuine #5725
    // registration loss could never alarm again); deliveredResults dropped =>
    // prune-time delivery records evaporated; orphanResultAlarms dropped =>
    // the once-per-task gate reset (99 alarm lines in 80s live).
    if (parsed.orphanResultAlarms && typeof parsed.orphanResultAlarms === "object") {
      store.orphanResultAlarms = parsed.orphanResultAlarms as Record<string, number>;
    }
    if (parsed.deliveredResults && typeof parsed.deliveredResults === "object") {
      store.deliveredResults = parsed.deliveredResults as Record<string, number>;
    }
    if (typeof parsed.deliveredResultsInit === "boolean") {
      store.deliveredResultsInit = parsed.deliveredResultsInit;
    }
    store.budget = { ...store.budget, ...(parsed.budget ?? {}) };
    (store as TeamAutoStore & { __baseFp?: string }).__baseFp = baseFingerprint;
    return store;
  } catch {
    return emptyStore();
  }
}

/** #5810/#5730 short-path guard helpers (cross-process stale-write protection). */
function staleWriteFingerprint(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return `${raw.length}:${h.toString(36)}`;
}

function mergeStoresOnConflict(disk: TeamAutoStore, saver: TeamAutoStore): TeamAutoStore {
  const maxKey = <T extends Record<string, number>>(a: T | undefined, b: T | undefined): T => {
    const out: Record<string, number> = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b ?? {})) out[k] = Math.max(out[k] ?? 0, v);
    return out as T;
  };
  const unionBy = <T>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string, cap = 600): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const x of [...(a ?? []), ...(b ?? [])]) {
      const k = key(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out.slice(-cap);
  };
  const merged: TeamAutoStore = { ...saver };
  const dayOf = (s: TeamAutoStore["budget"] | undefined) => s?.dayStamp ?? "";
  const diskToday = disk.budget?.tasksToday ?? 0;
  const saverToday = saver.budget?.tasksToday ?? 0;
  merged.budget = {
    ...(disk.budget ?? saver.budget),
    dayStamp: dayOf(disk.budget) !== dayOf(saver.budget) && diskToday > saverToday ? dayOf(disk.budget) : (dayOf(saver.budget) || dayOf(disk.budget)),
    tasksToday: dayOf(disk.budget) === dayOf(saver.budget) ? Math.max(diskToday, saverToday) : saverToday,
    maxTasksPerDay: disk.budget?.maxTasksPerDay ?? saver.budget?.maxTasksPerDay ?? 150,
  } as TeamAutoStore["budget"];
  merged.deliveredResults = maxKey(disk.deliveredResults, saver.deliveredResults);
  merged.orphanResultAlarms = maxKey(disk.orphanResultAlarms, saver.orphanResultAlarms);
  merged.undeliveredPrAlarms = maxKey(disk.undeliveredPrAlarms, saver.undeliveredPrAlarms);
  merged.failedClaimRecovery = maxKey(disk.failedClaimRecovery, saver.failedClaimRecovery);
  merged.fullReviewUmbrellas = maxKey(disk.fullReviewUmbrellas, saver.fullReviewUmbrellas);
  merged.activity = unionBy(disk.activity, saver.activity, (x) => `${x.at}:${String(x.text).slice(0, 60)}`);
  merged.writebacks = unionBy(disk.writebacks, saver.writebacks, (w) => w.taskId, 600).map((w) => {
    const d = (disk.writebacks ?? []).find((x) => x.taskId === w.taskId);
    if (!d) return w;
    return { ...w, doneAt: w.doneAt ?? d.doneAt, failedAt: w.failedAt ?? d.failedAt, attempts: Math.max(w.attempts ?? 0, d.attempts ?? 0), targetId: w.targetId ?? d.targetId };
  });
  const repoMap = new Map<string, TeamAutoRepo>();
  for (const r of [...(disk.repos ?? []), ...(saver.repos ?? [])]) {
    const prev = repoMap.get(r.id);
    if (!prev) { repoMap.set(r.id, r); continue; }
    const diskSide = disk.repos?.includes(prev) ? prev : r;
    const otherSide = diskSide === prev ? r : prev;
    repoMap.set(r.id, {
      ...diskSide,
      lastSweepAt: Math.max(prev.lastSweepAt ?? 0, r.lastSweepAt ?? 0),
      lastAttemptAt: Math.max(prev.lastAttemptAt ?? 0, r.lastAttemptAt ?? 0),
      lastSweepErrorAt: Math.max(prev.lastSweepErrorAt ?? 0, r.lastSweepErrorAt ?? 0),
      sweepFailures: Math.max(prev.sweepFailures ?? 0, r.sweepFailures ?? 0),
      failedTasksSinceLastSweep: Math.max(prev.failedTasksSinceLastSweep ?? 0, r.failedTasksSinceLastSweep ?? 0),
      lastSweepSummary: (prev.lastSweepAt ?? 0) >= (r.lastSweepAt ?? 0) ? prev.lastSweepSummary : r.lastSweepSummary,
      sweeps: unionBy<TeamAutoSweepRecord>(prev.sweeps, r.sweeps, (x) => `${x.at}:${String(x.summary).slice(0, 40)}`, 40),
      cursors: {
        ...diskSide.cursors,
        seen: maxKey(prev.cursors?.seen, otherSide.cursors?.seen) as TeamAutoRepo["cursors"]["seen"],
        etags: { ...(otherSide.cursors?.etags ?? {}), ...(diskSide.cursors?.etags ?? {}) },
        lastIssueSince: Math.max(prev.cursors?.lastIssueSince ?? 0, r.cursors?.lastIssueSince ?? 0),
        lastPrSince: Math.max(prev.cursors?.lastPrSince ?? 0, r.cursors?.lastPrSince ?? 0),
        lastCommitSha: prev.cursors?.lastCommitSha ?? r.cursors?.lastCommitSha,
      } as TeamAutoRepo["cursors"],
    });
  }
  merged.repos = [...repoMap.values()];
  return merged;
}

/** #5677 (ggcode, 2026-11-15): store-level async mutex. The 20s write-back
 * reconcile re-reads the store from disk and saves the whole object; the
 * sweep transaction (registerWriteback + summary) does the same. Without
 * serialization their read-modify-write cycles interleave: reconcile reads
 * BEFORE the sweep's entry save, then its tail-save clobbers the entry the
 * sweep just persisted (live: b3f688c6/#5676 write-back vanished; 3 earlier
 * legs survived by timing luck). Every load→mutate→save section must hold
 * this lock; it is process-local (single controller per state dir). */
const storeLock: { tail: Promise<void> } = { tail: Promise.resolve() };
export async function withStoreLock<T>(section: () => Promise<T>): Promise<T> {
  const prev = storeLock.tail;
  let release!: () => void;
  storeLock.tail = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    return await section();
  } finally {
    release();
  }
}

export async function saveTeamAutoStore(store: TeamAutoStore): Promise<void> {
  const { storeFile } = resolveTeamAutoPaths();
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  const next = writeQueue.length ? writeQueue[writeQueue.length - 1].catch(() => {}) : Promise.resolve();
  const job = next.then(async () => {
    let toWrite: TeamAutoStore = store;
    const guardDir = `${storeFile}.guard-lock`;
    let tookLock = false;
    try {
      await fs.mkdir(guardDir, { recursive: true }).then(() => { tookLock = true; }, () => {});
      if (tookLock) {
        const diskRaw = await fs.readFile(storeFile, "utf8").catch(() => null);
        const baseFp = (store as TeamAutoStore & { __baseFp?: string }).__baseFp;
        if (diskRaw !== null && baseFp && staleWriteFingerprint(diskRaw) !== baseFp) {
          const diskParsed = JSON.parse(diskRaw) as Partial<TeamAutoStore>;
          const diskStore = { ...emptyStore(), ...diskParsed } as TeamAutoStore;
          toWrite = mergeStoresOnConflict(diskStore, store);
        }
      }
    } catch { /* guard degraded - plain write */ }
    try {
      const tmp = `${storeFile}.tmp-${process.pid}-${Date.now()}`;
      const raw = JSON.stringify(toWrite, (k, v) => (k === "__baseFp" ? undefined : v), 2) + "\n";
      await fs.writeFile(tmp, raw, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, storeFile);
      (store as TeamAutoStore & { __baseFp?: string }).__baseFp = staleWriteFingerprint(raw);
    } finally {
      if (tookLock) await fs.rm(guardDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  writeQueue.push(job);
  writeQueue.splice(0, Math.max(0, writeQueue.length - 20));
  await job;
}

export function repoSlugToDirName(repoId: string): string {
  return repoId.replace(/[/\\]/g, "__");
}

export function todayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Budget accounting: resets the daily counter on date rollover. */
export function consumeDailyBudget(store: TeamAutoStore, count: number, now = new Date()): boolean {
  const stamp = todayStamp(now);
  if (store.budget.dayStamp !== stamp) {
    store.budget.dayStamp = stamp;
    store.budget.tasksToday = 0;
  }
  if (store.budget.tasksToday + count > store.budget.maxTasksPerDay) {
    return false;
  }
  store.budget.tasksToday += count;
  return true;
}
