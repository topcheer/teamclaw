// PR-C of issue #204 (http-server monolith split): the controller project
// identity/registry family and the controller-run session queries extracted
// verbatim from controller/http-server.ts. Zero behavior change. This module
// must NEVER import http-server (the reverse edge exists:
// http-server -> project-registry); every function here is pure over
// TeamState/ControllerRunInfo snapshots.
import type {
  ControllerRunInfo,
  TeamState,
} from "../types.js";
import { deriveStableProjectKey } from "../openclaw-workspace.js";
import { normalizeControllerIntakeSessionKey } from "./task-execution.js";

const EXISTING_PROJECT_REUSE_HINT_RE = /\b(existing|optimi(?:s|z)e|optimi(?:s|z)ation|improvement|enhanc(?:e|ement)|follow[- ]?up|extend|update|bugfix|bug fix)\b/iu;
const GENERIC_PROJECT_FOLLOW_UP_RE = /\b(continue|continuing|next step|what else|what's next|follow[- ]?up|more|remaining)\b|继续|接下来|下一步|还有哪些|还可以做什么/u;
const PROJECT_MATCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "build",
  "complete",
  "existing",
  "follow",
  "for",
  "hub",
  "improvement",
  "improvements",
  "internal",
  "optimization",
  "product",
  "project",
  "requirement",
  "request",
  "studio",
  "system",
  "the",
  "this",
  "up",
  "update",
  "web",
]);

export function resolveExistingProjectIdentityFromMessage(
  message: string,
  state: TeamState | null,
): { projectId?: string; projectDir?: string } | undefined {
  const normalizedMessage = normalizeProjectMatchingText(message);
  if (!normalizedMessage) {
    return undefined;
  }
  const explicitAlias = normalizeProjectMatchingText(extractExplicitProjectNameHint(message) ?? "");

  let best: { projectId?: string; projectDir: string; score: number; updatedAt: number } | null = null;
  const candidates = collectExistingProjectCandidates(state);
  for (const candidate of candidates) {
    const normalizedAliases = Array.from(candidate.aliases)
      .map((alias) => normalizeProjectMatchingText(alias))
      .filter(Boolean)
      .reduce<string[]>((acc, alias) => {
        acc.push(alias);
        return acc;
      }, []);
    const hasExplicitAliasMatch = explicitAlias
      ? normalizedAliases.some((alias) => alias.includes(explicitAlias) || explicitAlias.includes(alias))
      : false;
    if (explicitAlias && !hasExplicitAliasMatch) {
      continue;
    }
    const aliasScore = normalizedAliases
      .reduce((score, alias) => {
        if (!alias) {
          return score;
        }
        return normalizedMessage.includes(alias)
          ? Math.max(score, alias.split(" ").length + 10)
          : score;
      }, 0);
    const tokenScore = scoreProjectTokenOverlap(normalizedMessage, candidate.searchText);
    const totalScore = Math.max(aliasScore, tokenScore);
    if (totalScore < 2) {
      continue;
    }
    if (!best || totalScore > best.score || (totalScore === best.score && candidate.updatedAt > best.updatedAt)) {
      best = {
        projectId: candidate.projectId,
        projectDir: candidate.projectDir,
        score: totalScore,
        updatedAt: candidate.updatedAt,
      };
    }
  }
  if (best) {
    return { projectId: best.projectId, projectDir: best.projectDir };
  }
  if ((EXISTING_PROJECT_REUSE_HINT_RE.test(message) || GENERIC_PROJECT_FOLLOW_UP_RE.test(message)) && candidates.length === 1) {
    return {
      projectId: candidates[0]?.projectId,
      projectDir: candidates[0]?.projectDir,
    };
  }
  return undefined;
}

export function collectExistingProjectCandidates(state: TeamState | null): Array<{
  projectId?: string;
  projectDir: string;
  aliases: Set<string>;
  searchText: string;
  updatedAt: number;
}> {
  const byProjectDir = new Map<string, { projectId?: string; aliases: Set<string>; texts: string[]; updatedAt: number }>();
  const addCandidate = (
    projectDir: string | undefined,
    text: string | undefined,
    updatedAt: number,
    alias?: string | null,
    projectId?: string,
  ) => {
    if (!projectDir) {
      return;
    }
    const entry = byProjectDir.get(projectDir) ?? { projectId, aliases: new Set<string>(), texts: [], updatedAt: 0 };
    if (!entry.projectId && projectId) {
      entry.projectId = projectId;
    }
    if (text && text.trim()) {
      entry.texts.push(text);
    }
    if (alias && alias.trim()) {
      entry.aliases.add(alias.trim());
    }
    entry.updatedAt = Math.max(entry.updatedAt, updatedAt);
    byProjectDir.set(projectDir, entry);
  };

  for (const project of Object.values(state?.projects ?? {})) {
    addCandidate(project.projectDir, project.summary, project.updatedAt, project.id, project.id);
    for (const alias of project.aliases ?? []) {
      addCandidate(project.projectDir, alias, project.updatedAt, alias, project.id);
    }
  }
  for (const run of Object.values(state?.controllerRuns ?? {})) {
    addCandidate(run.projectDir, run.request, run.updatedAt, extractProjectAliasFromText(run.request), run.projectId);
    addCandidate(run.projectDir, run.title, run.updatedAt, extractProjectAliasFromText(run.title), run.projectId);
    addCandidate(run.projectDir, run.manifest?.projectName, run.updatedAt, run.manifest?.projectName, run.projectId);
  }
  for (const task of Object.values(state?.tasks ?? {})) {
    addCandidate(task.projectDir, task.title, task.updatedAt, extractProjectAliasFromText(task.title), task.projectId);
    addCandidate(task.projectDir, task.description, task.updatedAt, extractProjectAliasFromText(task.description), task.projectId);
    addCandidate(task.projectDir, task.resultContract?.summary, task.updatedAt, null, task.projectId);
  }

  return Array.from(byProjectDir.entries()).map(([projectDir, entry]) => ({
    projectId: entry.projectId,
    projectDir,
    aliases: entry.aliases,
    searchText: entry.texts.join("\n"),
    updatedAt: entry.updatedAt,
  }));
}

export function extractExplicitProjectNameHint(text: string | undefined): string | undefined {
  const value = String(text ?? "");
  const namedMatch = value.match(/(?:品牌|brand|project\s*name|产品名|名字)\s*[:：]?\s*[`"'“”]?([a-z][a-z0-9_-]{1,39})[`"'“”]?/iu);
  if (namedMatch?.[1]) {
    return deriveStableProjectKey(namedMatch[1]);
  }
  const inlineNames = Array.from(value.matchAll(/`([a-z][a-z0-9_-]{1,39})`/giu))
    .map((match) => deriveStableProjectKey(match[1]))
    .filter(Boolean);
  return inlineNames.length === 1 ? inlineNames[0] : undefined;
}

export function findProjectRecordByDir(state: TeamState | null, projectDir: string | undefined) {
  if (!state || !projectDir) {
    return undefined;
  }
  return Object.values(state.projects ?? {}).find((project) => project.projectDir === projectDir);
}

export function syncProjectRegistryEntry(
  state: TeamState,
  input: {
    projectId?: string;
    projectDir?: string;
    aliases?: Array<string | undefined | null>;
    summary?: string;
    updatedAt: number;
  },
): { projectId?: string; projectDir?: string } {
  state.projects = state.projects && typeof state.projects === "object" ? state.projects : {};
  let normalizedProjectId = deriveStableProjectKey(input.projectId ?? "");
  let existing = normalizedProjectId ? state.projects[normalizedProjectId] : undefined;
  const byDir = findProjectRecordByDir(state, input.projectDir);
  if (!existing && byDir) {
    existing = byDir;
  }
  if (!existing && input.projectDir) {
    normalizedProjectId = normalizedProjectId || deriveStableProjectKey(input.projectDir);
    if (normalizedProjectId) {
      existing = {
        id: normalizedProjectId,
        projectDir: input.projectDir,
        aliases: [],
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        lastUsedAt: input.updatedAt,
      };
      state.projects[normalizedProjectId] = existing;
    }
  }
  if (!existing) {
    return { projectId: normalizedProjectId || undefined, projectDir: input.projectDir };
  }
  if (normalizedProjectId && existing.id !== normalizedProjectId && !state.projects[normalizedProjectId]) {
    delete state.projects[existing.id];
    existing.id = normalizedProjectId;
    state.projects[normalizedProjectId] = existing;
  }
  if (!existing.projectDir && input.projectDir) {
    existing.projectDir = input.projectDir;
  }
  const aliasSet = new Set(existing.aliases ?? []);
  aliasSet.add(existing.id);
  if (existing.projectDir) {
    aliasSet.add(existing.projectDir);
  }
  for (const alias of input.aliases ?? []) {
    const normalizedAlias = deriveStableProjectKey(String(alias ?? ""));
    if (normalizedAlias) {
      aliasSet.add(normalizedAlias);
    }
  }
  existing.aliases = Array.from(aliasSet);
  existing.summary = input.summary || existing.summary;
  existing.updatedAt = Math.max(existing.updatedAt || 0, input.updatedAt);
  existing.lastUsedAt = Math.max(existing.lastUsedAt || 0, input.updatedAt);
  return { projectId: existing.id, projectDir: existing.projectDir };
}

export function resolveProjectIdentityForSession(
  sessionKey: string,
  state: TeamState | null,
): { projectId?: string; projectDir?: string } | undefined {
  const runId = findLatestControllerRunIdForSession(sessionKey, state, { preferActive: true });
  if (!runId) {
    return undefined;
  }
  const run = state?.controllerRuns[runId];
  if (!run) {
    return undefined;
  }
  const project = findProjectRecordByDir(state, run.projectDir);
  return {
    projectId: run.projectId ?? project?.id,
    projectDir: run.projectDir ?? project?.projectDir,
  };
}

export function resolveProjectIdentityForTaskId(
  taskId: string,
  state: TeamState | null,
): { projectId?: string; projectDir?: string } | undefined {
  const task = state?.tasks?.[taskId];
  if (!task) {
    return undefined;
  }
  const project = findProjectRecordByDir(state, task.projectDir);
  return {
    projectId: task.projectId ?? project?.id,
    projectDir: task.projectDir ?? project?.projectDir,
  };
}

export function extractProjectAliasFromText(text: string | undefined): string | null {
  const firstMeaningfulLine = String(text ?? "")
    .split(/\n+/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find(Boolean);
  if (!firstMeaningfulLine) {
    return null;
  }
  const normalized = firstMeaningfulLine
    .replace(/^(product|optimization)\s+requirement[:：]\s*/iu, "")
    .replace(/^implement\s+/iu, "")
    .replace(/^design\s+/iu, "")
    .replace(/^enhance\s+/iu, "")
    .replace(/^qa[:\s-]+/iu, "")
    .replace(/\s+(architecture|application|web app|workflows?|improvements?)$/iu, "")
    .trim();
  if (normalized.length < 4 || normalized.length > 80) {
    return null;
  }
  return normalized;
}

export function normalizeProjectMatchingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#:[\]()/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function scoreProjectTokenOverlap(message: string, candidateText: string): number {
  const messageTokens = tokenizeProjectMatchingText(message);
  if (messageTokens.size === 0) {
    return 0;
  }
  const candidateTokens = tokenizeProjectMatchingText(candidateText);
  let overlap = 0;
  for (const token of candidateTokens) {
    if (messageTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

export function tokenizeProjectMatchingText(text: string): Set<string> {
  return new Set(
    normalizeProjectMatchingText(text)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !PROJECT_MATCH_STOPWORDS.has(token)),
  );
}

export function isActiveControllerRun(run: ControllerRunInfo): boolean {
  return run.status === "pending" || run.status === "running";
}

export function findLatestControllerRunIdForSession(
  sessionKey: string,
  state: TeamState | null,
  options?: { preferActive?: boolean },
): string | null {
  const normalizedSessionKey = normalizeControllerIntakeSessionKey(sessionKey);
  const matchingRuns = Object.values(state?.controllerRuns ?? {})
    .filter((run) => normalizeControllerIntakeSessionKey(run.sessionKey) === normalizedSessionKey)
    .sort((left, right) => {
      if (options?.preferActive) {
        const leftScore = isActiveControllerRun(left) ? 1 : 0;
        const rightScore = isActiveControllerRun(right) ? 1 : 0;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
      }
      return right.updatedAt - left.updatedAt;
    });
  return matchingRuns[0]?.id ?? null;
}

export function resolveProjectDirForSession(
  sessionKey: string,
  state: TeamState | null,
): string | undefined {
  return resolveProjectIdentityForSession(sessionKey, state)?.projectDir;
}
