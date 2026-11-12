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
  repoId: string;
  targetId: number | null;
  doneAt: number | null;
  prUrl: string | null;
  error: string | null;
  /** Joint full-review cycle id: same-cycle sections share one umbrella issue. */
  cycleKey?: string;
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
  try {
    const raw = await fs.readFile(storeFile, "utf8");
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
    store.budget = { ...store.budget, ...(parsed.budget ?? {}) };
    return store;
  } catch {
    return emptyStore();
  }
}

export async function saveTeamAutoStore(store: TeamAutoStore): Promise<void> {
  const { storeFile } = resolveTeamAutoPaths();
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  const tmp = `${storeFile}.tmp-${process.pid}-${Date.now()}`;
  const next = writeQueue.length ? writeQueue[writeQueue.length - 1].catch(() => {}) : Promise.resolve();
  const job = next.then(async () => {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, storeFile);
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
