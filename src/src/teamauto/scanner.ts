import { getActiveProfile } from "../profile-loader.js";
import type { RoleId } from "../types.js";
import type { SweepableIssue, SweepablePull, TeamAutoGithubClient } from "./github-client.js";
import type { TeamAutoRepo } from "./store.js";

/**
 * Incremental sweep: turn a repo's changed issues/PRs into candidate work
 * items, applying the per-repo policy (assignment rules, keyword/label
 * filters, idempotency via the `seen` cursor map).
 */

export type CandidateKind = "issueReview" | "takeOwnership" | "prReview" | "fullReview";

/**
 * Joint full-review section definitions: which review sections exist and
 * what each section focuses on. The ROLE SET is derived from the ACTIVE team
 * profile at sweep time (Phase 2.3, P1 handover debt item 4): only sections
 * whose role id is a role of the active profile are scheduled, replacing the
 * old hardcoded role-id literal list + closed role union. software-rd keeps
 * all three sections, so its sweeps are unchanged; a profile that carries
 * none of the section roles simply produces no joint full-review candidates.
 */
const JOINT_REVIEW_SECTIONS: ReadonlyArray<{ id: RoleId; focus: string }> = [
  {
    id: "architect",
    focus: "architecture and structure: module boundaries, layering, README/docs accuracy, maintainability hotspots, dead or duplicated code paths",
  },
  {
    id: "qa",
    focus: "quality and tests: test coverage gaps, flaky-test hotspots, error-handling weaknesses, missing failure-path tests, CI blind spots",
  },
  {
    id: "security-engineer",
    focus: "security surface: dependency risks, secret handling, injection/validation gaps, auth-sensitive paths, unsafe defaults",
  },
];

/**
 * Joint-review sections whose roles exist in the ACTIVE profile, in section
 * order (one candidate per role, one shared cycle). Derived per call so a
 * profile switch flips the joint fan-out on the next sweep.
 */
export function resolveJointReviewSections(): ReadonlyArray<{ id: RoleId; focus: string }> {
  const activeRoleIds = new Set(getActiveProfile().roles.map((role) => role.id));
  return JOINT_REVIEW_SECTIONS.filter((section) => activeRoleIds.has(section.id));
}

export type Candidate = {
  kind: CandidateKind;
  repoId: string;
  key: string; // idempotency key, e.g. "owner/repo#issue-42"
  number: number;
  title: string;
  /**
   * Role the candidate is routed to. RoleId (not a software-only literal
   * union) since Phase 2.3 debt item 4: candidates may name any role of the
   * active profile.
   */
  role: RoleId;
  /** Collaboration contract: reviews are read-only, ownership work writes. */
  writeMode: "read-only" | "write";
  /** Shared full-review cycle id: write-backs group on it (umbrella issue). */
  cycle?: number;
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
): Promise<{ candidates: Candidate[]; issues: SweepableIssue[]; pulls: SweepablePull[]; newCommits: { sha: string; message: string }[]; commits: { sha: string; message: string }[] }> {
  const [owner, name] = repo.id.split("/");
  const issues = await client.listIssues(owner, name, repo.cursors.lastIssueSince, repo.cursors.etags);
  const pulls = repo.policy.actions.prReview
    ? await client.listPulls(owner, name, repo.cursors.etags)
    : [];
  // #265: the commits leg was dead code (listCommits had zero callers,
  // lastCommitSha never advanced) - the designed third signal source never
  // ran. Wire it as an observation-only feed: fetch, filter past the cursor,
  // and surface the delta. Cursor advance happens in advanceCursors (with
  // the other legs, so dry-run semantics stay intact); it produces no task
  // candidates (issue/pull policies stay the sole candidate sources).
  const commits = await client.listCommits(owner, name, repo.cursors.lastCommitSha);
  // Newest-first feed: when the cursor is set, stop the delta at the first
  // entry whose sha equals it (that commit and everything after is already
  // known). An unset cursor means first sweep: observe only, report nothing.
  const newCommits = repo.cursors.lastCommitSha
    ? commits.slice(0, (() => { const i = commits.findIndex((c) => c.sha === repo.cursors.lastCommitSha); return i === -1 ? commits.length : i; })())
    : [];
  const candidates: Candidate[] = [];

  for (const issue of issues) {
    // Dedup: seen map survives sweeps; a closed-then-reopened issue updates.
    const key = `${repo.id}#issue-${issue.number}`;
    const updatedAtMs = Date.parse(issue.updatedAt) || 0;
    if ((repo.cursors.seen[key] ?? 0) >= updatedAtMs) {
      continue;
    }
    // NOTE: no first-sweep gate here. Gating candidates on "first sweep"
    // combined with the dry-run not advancing cursors deadlocked repos in
    // observe-only mode forever (zero candidates -> dryRunDone never set).
    // Backlog protection comes from the per-sweep cap + one dry-run pass.
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
      writeMode: "read-only" as const,
    };
    // #269 6th case (ggcode#4785): an issue eligible for BOTH actions got
    // two tasks in the same sweep, each delivering its own comment - the
    // delivery layer correctly treats them as independent entries. Collapse
    // at the source: when ownership applies (open + enabled) it wins and
    // subsumes the triage read; issueReview fires only when ownership is
    // disabled for this repo (or the issue is closed and un-reviewable via
    // ownership, e.g. follow-up triage on a closed issue).
    const ownershipApplies = repo.policy.actions.takeOwnership && issue.state === "open";
    if (repo.policy.actions.issueReview && !ownershipApplies) {
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
        writeMode: "write",
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
    // See the issue-loop note: no first-sweep gate (deadlock source).
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
        role: "qa" as const,
        writeMode: "read-only" as const,
        title: truncate(`Review PR #${pull.number}: ${pull.title}`, 120),
        reason: "new/updated pull request needs review",
        context: `PR #${pull.number} by @${pull.user} (head: ${pull.head})\nLink: ${pull.htmlUrl}\n\nDescription:\n${truncate(pull.body, 4000)}`,
      });
    }
  }

  // Periodic full review (weekly/daily), independent of per-object cursors.
  if (repo.policy.actions.fullReview !== "off") {
    const intervalMs = repo.policy.actions.fullReview === "daily" ? 24 * 3600_000 : 7 * 24 * 3600_000;
    // Interval-gated only (the old !firstSweep gate could never open for a
    // repo whose first sweep observed nothing - see the deadlock note above).
    if (now - repo.cursors.lastFullReviewAt >= intervalMs) {
      const cycle = Math.floor(now / intervalMs);
      // Joint review: one candidate per section role of the ACTIVE profile,
      // one shared cycle. Each role's reply becomes a labeled section of a
      // single umbrella review issue (the write-back reconciler groups by
      // the cycle key).
      for (const section of resolveJointReviewSections()) {
        const role = section.id;
        candidates.push({
          repoId: repo.id,
          key: `${repo.id}#fullreview-${cycle}-${role}`,
          kind: "fullReview",
          number: 0,
          role,
          writeMode: "read-only" as const,
          cycle,
          title: `Full repository review (${role}): ${repo.id}`,
          reason: `scheduled ${repo.policy.actions.fullReview} full review (joint, ${role} section)`,
          context: [
            `Perform the ${role} section of a joint full-repository review of ${repo.id}.`,
            `Your focus: ${section.focus}.`,
            "Other roles cover complementary areas in parallel - do NOT duplicate their scope; go deep on yours.",
            "Your reply becomes the " + role + " section of the joint review issue on GitHub. Do not change code.",
          ].join("\n"),
        });
      }
    }
  }

  return { candidates: candidates.slice(0, repo.policy.maxTasksPerSweep * 2), issues, pulls, newCommits, commits };
}

/** Advance cursors after tasks were enqueued (or observed on first sweep). */
export function advanceCursors(repo: TeamAutoRepo, issues: SweepableIssue[], pulls: SweepablePull[], now = Date.now(), commits: { sha: string; message: string }[] = []): void {
  for (const issue of issues) {
    repo.cursors.seen[`${repo.id}#issue-${issue.number}`] = Date.parse(issue.updatedAt) || now;
  }
  for (const pull of pulls) {
    repo.cursors.seen[`${repo.id}#pr-${pull.number}`] = Date.parse(pull.updated_at) || now;
  }
  // Commit cursor: the feed is newest-first, so when anything came back the
  // HEAD entry IS the new cursor. Empty feed keeps the old cursor (nothing
  // new to advance to).
  if (commits.length > 0) {
    repo.cursors.lastCommitSha = commits[0].sha;
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
