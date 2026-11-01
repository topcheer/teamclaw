import type { GithubAuthManager } from "../controller/github-auth.js";

/**
 * Minimal GitHub REST client for TeamAuto: ETag-conditional GETs, light
 * pagination, and the write endpoints we need. All requests ride the stored
 * device-flow token via the auth manager (transparent refresh).
 */

const API = "https://api.github.com";
const VERSION = "2026-03-10";
const USER_AGENT = "teamclaw-teamauto";

export class GithubClientError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubClientError";
    this.status = status;
  }
}

export type EtagCache = Record<string, string>;

export type SweepableIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  assignees: string[];
  labels: string[];
  updatedAt: string;
  user: string;
  htmlUrl: string;
};

export type SweepablePull = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  updated_at: string;
  user: string;
  head: string;
  htmlUrl: string;
};

export type GithubRepoInfo = {
  fullName: string;
  defaultBranch: string;
  cloneUrl: string;
  permissions: { push: boolean; pull: boolean };
};

export function createGithubClient(auth: GithubAuthManager) {
  async function request(
    method: string,
    urlPath: string,
    options: { body?: unknown; etagKey?: string; etags?: EtagCache } = {},
  ): Promise<{ status: number; data: unknown; notModified: boolean }> {
    const headers: Record<string, string> = {
      ...(await auth.getAuthHeaders()),
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": VERSION,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const etagKey = options.etagKey ? `${method} ${urlPath}` : undefined;
    if (etagKey && options.etags?.[etagKey]) {
      headers["If-None-Match"] = options.etags[etagKey];
    }
    const response = await fetch(`${API}${urlPath}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (etagKey) {
      const etag = response.headers.get("etag");
      if (etag && options.etags) {
        options.etags[etagKey] = etag;
      }
    }
    if (response.status === 304) {
      return { status: 304, data: null, notModified: true };
    }
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      const message = (data as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
      throw new GithubClientError(message, response.status);
    }
    return { status: response.status, data, notModified: false };
  }

  async function getJson<T>(urlPath: string, etags?: EtagCache): Promise<T | null> {
    const { data, notModified } = await request("GET", urlPath, { etagKey: etags ? urlPath : undefined, etags });
    return notModified ? null : data as T;
  }

  return {
    request,

    async getRepoInfo(owner: string, repo: string): Promise<GithubRepoInfo> {
      const data = await getJson<Record<string, unknown>>(`/repos/${owner}/${repo}`);
      if (!data) {
        throw new GithubClientError("unexpected 304 without etag", 500);
      }
      const perms = (data.permissions ?? {}) as Record<string, boolean>;
      return {
        fullName: String(data.full_name ?? `${owner}/${repo}`),
        defaultBranch: String(data.default_branch ?? "main"),
        cloneUrl: String(data.clone_url ?? `https://github.com/${owner}/${repo}.git`),
        permissions: { push: Boolean(perms.push), pull: Boolean(perms.pull ?? true) },
      };
    },

    /** Issues updated since the cursor; pass 0 for a first (bounded) backfill. */
    async listIssues(owner: string, repo: string, sinceMs: number, etags?: EtagCache): Promise<SweepableIssue[]> {
      const since = sinceMs > 0 ? new Date(sinceMs).toISOString() : new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const data = await getJson<unknown[]>(
        `/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=desc&per_page=50&since=${encodeURIComponent(since)}`,
        etags,
      );
      if (!data) {
        return [];
      }
      return data
        .filter((raw) => {
          const item = raw as Record<string, unknown>;
          // The issues API also returns PRs; drop them (pull_request field).
          return !item.pull_request;
        })
        .map((raw) => {
          const item = raw as Record<string, unknown>;
          return {
            number: Number(item.number ?? 0),
            title: String(item.title ?? ""),
            body: String(item.body ?? ""),
            state: item.state === "closed" ? "closed" : "open",
            assignees: Array.isArray(item.assignees) ? item.assignees.map((a) => String((a as { login?: string }).login ?? "")) : [],
            labels: Array.isArray(item.labels) ? item.labels.map((l) => String((l as { name?: string }).name ?? "")) : [],
            updatedAt: String(item.updated_at ?? ""),
            user: String((item.user as { login?: string } | undefined)?.login ?? ""),
            htmlUrl: String(item.html_url ?? ""),
          } satisfies SweepableIssue;
        });
    },

    async listPulls(owner: string, repo: string, etags?: EtagCache): Promise<SweepablePull[]> {
      const data = await getJson<unknown[]>(
        `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`,
        etags,
      );
      if (!data) {
        return [];
      }
      return data.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          number: Number(item.number ?? 0),
          title: String(item.title ?? ""),
          body: String(item.body ?? ""),
          state: item.state === "closed" ? "closed" : "open",
          draft: Boolean(item.draft),
          updated_at: String(item.updated_at ?? ""),
          user: String((item.user as { login?: string } | undefined)?.login ?? ""),
          head: String((item.head as { ref?: string } | undefined)?.ref ?? ""),
          htmlUrl: String(item.html_url ?? ""),
        } satisfies SweepablePull;
      });
    },

    async listCommits(owner: string, repo: string, sinceSha: string): Promise<{ sha: string; message: string }[]> {
      const suffix = sinceSha ? `?sha=${encodeURIComponent(sinceSha)}` : "?per_page=20";
      void suffix;
      // Compare-style walk is heavy; use the commits feed and filter client-side.
      const data = await getJson<unknown[]>(`/repos/${owner}/${repo}/commits?per_page=30`);
      if (!data) {
        return [];
      }
      const commits = data.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          sha: String(item.sha ?? ""),
          message: String((item.commit as { message?: string } | undefined)?.message ?? "").split("\n")[0],
        };
      });
      if (!sinceSha) {
        return commits.slice(0, 10);
      }
      const index = commits.findIndex((c) => c.sha.startsWith(sinceSha.slice(0, 10)));
      return index === -1 ? commits.slice(0, 5) : commits.slice(0, index);
    },

    // ---- write side (require Contents/Issues/PR write on the App) ----

    async postIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
      const { data } = await request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body: { body } });
      return Number((data as { id?: number }).id ?? 0);
    },

    async postPullReviewComment(owner: string, repo: string, pullNumber: number, body: string): Promise<void> {
      await request("POST", `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, { body: { event: "COMMENT", body } });
    },

    async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[]): Promise<number> {
      const { data } = await request("POST", `/repos/${owner}/${repo}/issues`, {
        body: { title, body, ...(labels?.length ? { labels } : {}) },
      });
      return Number((data as { number?: number }).number ?? 0);
    },

    async assignIssue(owner: string, repo: string, issueNumber: number, assignee: string): Promise<void> {
      await request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, { body: { assignees: [assignee] } });
    },

    /** Repos the logged-in user can select in the TeamAuto bind picker. */
    async listUserRepos(): Promise<{ id: string; fullName: string; private: boolean; pushedAt: string | null }[]> {
      const data = await getJson<unknown[]>("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100");
      if (!data) {
        return [];
      }
      return data.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          id: String(item.full_name ?? ""),
          fullName: String(item.full_name ?? ""),
          private: Boolean(item.private),
          pushedAt: typeof item.pushed_at === "string" ? item.pushed_at : null,
        };
      }).filter((r) => r.id);
    },
  };
}

export type TeamAutoGithubClient = ReturnType<typeof createGithubClient>;
