import type { TeamAutoRepo, TeamAutoRepoNorms } from "./store.js";
import type { TeamAutoGithubClient } from "./github-client.js";
import type { TeamAutoRepoSync } from "./repo-sync.js";

/**
 * Norms learning: absorb the target repo's collaboration conventions
 * (CONTRIBUTING, issue/PR templates, commit style) so every TeamClaw worker
 * prompt for that repo carries them - "转手目标仓库里面的协作规范".
 */

const CONVENTIONAL_RE = /^(\w+)(\([^)]+\))?!?:\s.+/;

function detectCommitStyle(messages: string[]): string {
  if (!messages.length) {
    return "unspecified - keep subject lines short and descriptive";
  }
  const matches = messages.filter((m) => CONVENTIONAL_RE.test(m)).length;
  if (matches >= messages.length * 0.6) {
    return "conventional commits (type(scope)!: subject)";
  }
  const chinese = messages.filter((m) => /[\u4e00-\u9fff]/.test(m)).length;
  if (chinese >= messages.length * 0.6) {
    return "plain subject lines, Chinese";
  }
  return "plain subject lines, English";
}

export async function learnNorms(
  repo: TeamAutoRepo,
  client: TeamAutoGithubClient,
  sync: TeamAutoRepoSync,
  cloneUrl: string,
  defaultBranch: string,
): Promise<TeamAutoRepoNorms> {
  let dir: string | null = null;
  try {
    dir = await sync.ensureCloned(repo.id, cloneUrl, defaultBranch);
  } catch {
    dir = null;
  }

  const [owner, name] = repo.id.split("/");
  const fetchRemote = async (apiPath: string): Promise<string | null> => {
    try {
      const { data } = await client.request("GET", apiPath);
      const record = data as { content?: string; encoding?: string };
      if (typeof record.content === "string" && record.encoding === "base64") {
        return Buffer.from(record.content, "base64").toString("utf8");
      }
    } catch {
      // absent file is fine
    }
    return null;
  };

  const contributing =
    (await fetchRemote(`/repos/${owner}/${name}/contents/CONTRIBUTING.md`)) ??
    (dir ? await sync.readFileIfPresent(dir, "CONTRIBUTING.md") : null);
  const issueTemplate =
    (await fetchRemote(`/repos/${owner}/${name}/contents/.github/ISSUE_TEMPLATE.md`)) ??
    (dir ? await sync.readFileIfPresent(dir, ".github/ISSUE_TEMPLATE.md") : null);
  const prTemplate =
    (await fetchRemote(`/repos/${owner}/${name}/contents/.github/PULL_REQUEST_TEMPLATE.md`)) ??
    (dir ? await sync.readFileIfPresent(dir, ".github/PULL_REQUEST_TEMPLATE.md") : null);

  let commitStyle = "unspecified";
  if (dir) {
    try {
      commitStyle = detectCommitStyle(await sync.recentCommitMessages(dir, 100));
    } catch {
      commitStyle = "unspecified";
    }
  }

  return {
    commitStyle,
    issueTemplate: issueTemplate?.slice(0, 2000) ?? null,
    prTemplate: prTemplate?.slice(0, 2000) ?? null,
    contributing: contributing?.slice(0, 4000) ?? null,
    learnedAt: Date.now(),
  };
}

/** Render the learned norms into a compact prompt block for workers. */
export function renderNormsBlock(norms: TeamAutoRepoNorms | null, repoId: string): string {
  if (!norms) {
    return `Target repo: ${repoId}\nCollaboration norms: not learned yet - follow common sense and read existing issues/PRs for style.\n`;
  }
  const lines = [
    `Target repo: ${repoId}`,
    `Commit style: ${norms.commitStyle}`,
  ];
  if (norms.contributing) {
    lines.push(`CONTRIBUTING.md excerpt:\n${norms.contributing.slice(0, 1500)}`);
  }
  if (norms.issueTemplate) {
    lines.push(`Issue template excerpt:\n${norms.issueTemplate.slice(0, 800)}`);
  }
  if (norms.prTemplate) {
    lines.push(`PR template excerpt:\n${norms.prTemplate.slice(0, 800)}`);
  }
  return lines.join("\n") + "\n";
}
