// #265: the commits leg of the teamauto sweep pipeline (third signal source).
// Before the fix, client.listCommits had zero callers and cursors.lastCommitSha
// never advanced - the commits column was empty across all repos. These tests
// pin the wired behavior: fetch + cursor filter + delta surfacing + cursor
// advance (only on acting sweeps, same as the other legs).
import assert from "node:assert/strict";

const scanner = await import("../src/dist/src/teamauto/scanner.js");
const { sweepRepo, advanceCursors } = scanner;

// Minimal harness matching TeamAutoRepo + TeamAutoGithubClient shapes.
function makeRepo(overrides = {}) {
  return {
    id: "acme/widget",
    enabled: true,
    addedAt: 1,
    dryRunDone: true,
    lastSweepAt: 0,
    lastSweepSummary: "",
    pausedReason: null,
    sweepFailures: 0,
    lastSweepErrorAt: 0,
    policy: {
      actions: { issueReview: true, prReview: true, fullReview: false },
      maxTasksPerSweep: 3,
      skipAssignedToHumans: false,
      ...overrides.policy,
    },
    cursors: {
      lastIssueSince: 0,
      lastPrSince: 0,
      lastCommitSha: "",
      seen: {},
      etags: {},
      ...overrides.cursors,
    },
    ...overrides.root,
  };
}

function makeClient({ issues = [], pulls = [], commits = [] } = {}) {
  return {
    async listIssues() { return issues; },
    async listPulls() { return pulls; },
    async listCommits(owner, repo, sinceSha) {
      this.commitsCalls = (this.commitsCalls ?? 0) + 1;
      this.lastSinceSha = sinceSha;
      return commits;
    },
  };
}

// 1) Empty cursor (first sweep): commits are fetched but the delta stays
//    empty - the first pass establishes the cursor without flooding.
{
  const repo = makeRepo();
  const client = makeClient({ commits: [{ sha: "a1", message: "one" }, { sha: "a2", message: "two" }] });
  const out = await sweepRepo(repo, client);
  assert.equal(client.commitsCalls, 1, "commits leg is fetched");
  assert.equal(out.commits.length, 2);
  assert.equal(out.newCommits.length, 0, "first sweep observes without reporting a delta");
  advanceCursors(repo, [], [], 1, out.commits);
  assert.equal(repo.cursors.lastCommitSha, "a1", "cursor advances to feed HEAD");
}

// 2) Steady state: new HEAD past the cursor yields a delta; cursor re-advances.
{
  const repo = makeRepo({ cursors: { lastCommitSha: "b2" } });
  const client = makeClient({ commits: [{ sha: "c3", message: "three" }, { sha: "b2", message: "two" }] });
  const out = await sweepRepo(repo, client);
  assert.equal(client.lastSinceSha, "b2", "cursor is passed to listCommits");
  assert.deepEqual(out.newCommits.map((c) => c.sha), ["c3"], "delta stops at the old cursor");
  advanceCursors(repo, [], [], 1, out.commits);
  assert.equal(repo.cursors.lastCommitSha, "c3");
}

// 3) No new commits: empty feed keeps the cursor untouched.
{
  const repo = makeRepo({ cursors: { lastCommitSha: "z9" } });
  const client = makeClient({ commits: [] });
  const out = await sweepRepo(repo, client);
  assert.equal(out.newCommits.length, 0);
  advanceCursors(repo, [], [], 1, out.commits);
  assert.equal(repo.cursors.lastCommitSha, "z9", "empty feed must not move the cursor");
}

// 4) Feed with unchanged HEAD: delta is empty even though the feed is not.
{
  const repo = makeRepo({ cursors: { lastCommitSha: "h1" } });
  const client = makeClient({ commits: [{ sha: "h1", message: "head" }, { sha: "h0", message: "old" }] });
  const out = await sweepRepo(repo, client);
  assert.equal(out.newCommits.length, 0, "HEAD == cursor means no delta");
}

console.log("test-teamauto-commits-leg: all 4 sections passed");
