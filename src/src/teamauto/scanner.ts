import type { SweepableIssue, SweepablePull, TeamAutoGithubClient } from "./github-client.js";
import type { TeamAutoRepo } from "./store.js";

/**
 * Incremental sweep: turn a repo's changed issues/PRs into candidate work
 * items, applying the per-repo policy (assignment rules, keyword/label
 * filters, idempotency via the `seen` cursor map).
 */

export type CandidateKind = "issueReview" | "takeOwnership" | "prReview" | "fullReview";

export type Candidate = {
  kind: CandidateKind;
  repoId: string;
  key: string; // idempotency key, e.g. "owner/repo#issue-42"
  number: number;
  title: string;
  role: "qa" | "developer" | "architect";
  reason: string;
  context: string;
};

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => k.trim() && lower.includes(k.trim().toLowerCase()));
}

function labelAllowed(issue: SweepableIssue, repo: TeamAutoRepo): boolean {
  const { include, exclude } = repo.policy.labelFilter;
  if (exclude.some((l) => issue.labels.includes(l))) {
    return false;
  }
  if (include.length && !include.some((l) => issue.labels.includes(l))) {
    return false;
  }
  return true;
}

function keywordAllowed(title: string, repo: TeamAutoRepo): boolean {
  const { include, exclude } = repo.policy.keywordFilter;
  if (exclude.length && matchesAny(title, exclude)) {
    return false;
  }
  if (include.length && !matchesAny(title, include)) {
    return false;
  }
  return true;
}

const TEAMCLAW_MARKER_RE = /\[teamclaw(?::\w+)?\]/i;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

export async function sweepRepo(
  repo: TeamAutoRepo,
  client: TeamAutoGithubClient,
  now = Date.now(),
): Promise<{ candidates: Candidate[]; issues: SweepableIssue[]; pulls: SweepablePull[] }> {
  const [owner, name] = repo.id.split("/");
  const issues = await client.listIssues(owner, name, repo.cursors.lastIssueSince, repo.cursors.etags);
  const pulls = repo.policy.actions.prReview
    ? await client.listPulls(owner, name, repo.cursors.etags)
    : [];
  const candidates: Candidate[] = [];
  const firstSweep = repo.cursors.lastIssueSince === 0;

  for (const issue of issues) {
    // Dedup: seen map survives sweeps; a closed-then-reopened issue updates.
    const key = `${repo.id}#issue-${issue.number}`;
    const updatedAtMs = Date.parse(issue.updatedAt) || 0;
    if ((repo.cursors.seen[key] ?? 0) >= updatedAtMs) {
      continue;
    }
    // First sweep only observes - it seeds cursors without enqueuing a flood.
    if (firstSweep) {
      continue;
    }
    if (!labelAllowed(issue, repo) || !keywordAllowed(issue.title, repo)) {
      continue;
    }
    if (repo.policy.skipAssignedToHumans && issue.assignees.length > 0) {
      continue;
    }
    // Never self-assign or review our own threads.
    if (TEAMCLAW_MARKER_RE.test(issue.title) || TEAMCLAW_MARKER_RE.test(issue.body)) {
      continue;
    }
    const base = {
      repoId: repo.id,
      key,
      number: issue.number,
      role: "qa" as const,
    };
    if (repo.policy.actions.issueReview) {
      candidates.push({
        ...base,
        kind: "issueReview",
        title: truncate(`Review issue #${issue.number}: ${issue.title}`, 120),
        reason: "new/updated issue needs triage",
        context: `Issue #${issue.number} by @${issue.user}\nTitle: ${issue.title}\nLabels: ${issue.labels.join(", ") || "none"}\nLink: ${issue.htmlUrl}\n\nBody:\n${truncate(issue.body, 4000)}`,
      });
    }
    if (repo.policy.actions.takeOwnership && issue.state === "open") {
      candidates.push({
        ...base,
        kind: "takeOwnership",
        role: "developer",
        title: truncate(`Take ownership of issue #${issue.number}: ${issue.title}`, 120),
        reason: "unassigned issue eligible for autonomous ownership",
        context: `Own and implement issue #${issue.number}: ${issue.title}\nLink: ${issue.htmlUrl}\n\nBody:\n${truncate(issue.body, 6000)}`,
      });
    }
  }

  for (const pull of pulls) {
    const key = `${repo.id}#pr-${pull.number}`;
    const updatedAtMs = Date.parse(pull.updated_at) || 0;
    if ((repo.cursors.seen[key] ?? 0) >= updatedAtMs) {
      continue;
    }
    if (firstSweep) {
      continue;
    }
    // Skip our own PRs and drafts.
    if (pull.head.startsWith("teamclaw/") || pull.draft || TEAMCLAW_MARKER_RE.test(pull.title)) {
      continue;
    }
    if (repo.policy.actions.prReview) {
      candidates.push({
        repoId: repo.id,
        key,
        kind: "prReview",
        number: pull.number,
        role: "qa",
        title: truncate(`Review PR #${pull.number}: ${pull.title}`, 120),
        reason: "new/updated pull request needs review",
        context: `PR #${pull.number} by @${pull.user} (head: ${pull.head})\nLink: ${pull.htmlUrl}\n\nDescription:\n${truncate(pull.body, 4000)}`,
      });
    }
  }

  // Periodic full review (weekly/daily), independent of per-object cursors.
  if (repo.policy.actions.fullReview !== "off") {
    const intervalMs = repo.policy.actions.fullReview === "daily" ? 24 * 3600_000 : 7 * 24 * 3600_000;
    if (now - repo.cursors.lastFullReviewAt >= intervalMs && !firstSweep) {
      candidates.push({
        repoId: repo.id,
        key: `${repo.id}#fullreview-${Math.floor(now / intervalMs)}`,
        kind: "fullReview",
        number: 0,
        role: "architect",
        title: `Full repository review: ${repo.id}`,
        reason: `scheduled ${repo.policy.actions.fullReview} full review`,
        context: `Perform a full-repository review of ${repo.id}. Inspect the codebase structure, README accuracy, error handling hotspots, and test coverage gaps. Create issues for significant findings (title prefixed "[teamclaw:architect]") instead of changing code.`,
      });
    }
  }

  return { candidates: candidates.slice(0, repo.policy.maxTasksPerSweep * 2), issues, pulls };
}

/** Advance cursors after tasks were enqueued (or observed on first sweep). */
export function advanceCursors(repo: TeamAutoRepo, issues: SweepableIssue[], pulls: SweepablePull[], now = Date.now()): void {
  for (const issue of issues) {
    repo.cursors.seen[`${repo.id}#issue-${issue.number}`] = Date.parse(issue.updatedAt) || now;
  }
  for (const pull of pulls) {
    repo.cursors.seen[`${repo.id}#pr-${pull.number}`] = Date.parse(pull.updated_at) || now;
  }
  // Cap the seen map so it cannot grow unbounded.
  const entries = Object.entries(repo.cursors.seen);
  if (entries.length > 2000) {
    entries.sort((a, b) => a[1] - b[1]);
    for (const [key] of entries.slice(0, entries.length - 2000)) {
      delete repo.cursors.seen[key];
    }
  }
  // `since` cursors track the newest observed object time, never the sweep's
  // wall clock - objects updated between fetch and save must not fall behind
  // the cursor forever.
  let maxIssueUpdated = 0;
  let maxPullUpdated = 0;
  for (const issue of issues) {
    maxIssueUpdated = Math.max(maxIssueUpdated, Date.parse(issue.updatedAt) || now);
  }
  for (const pull of pulls) {
    maxPullUpdated = Math.max(maxPullUpdated, Date.parse(pull.updated_at) || now);
  }
  repo.cursors.lastIssueSince = Math.max(repo.cursors.lastIssueSince, maxIssueUpdated);
  repo.cursors.lastPrSince = Math.max(repo.cursors.lastPrSince, maxPullUpdated);
}
