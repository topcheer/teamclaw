import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import type { PluginLogger } from "../api.js";
// Dependency-free canonical role id list (Phase 1.2); see role-ids.ts for why
// this module cannot value-import roles.ts.
import { ROLE_IDS } from "./role-ids.js";

export const TEAMCLAW_AGENT_ID = "teamclaw";
export const TEAMCLAW_ISOLATION_MODE_INDEPENDENT = "independent";
export const TEAMCLAW_ISOLATION_MODE_MAIN = "main";
const TEAMCLAW_RECOMMENDED_EXEC_SECURITY = "full";
const TEAMCLAW_RECOMMENDED_EXEC_ASK = "off";

const DEFAULT_AGENTS_MD = `# AGENTS.md

This workspace is shared by TeamClaw controller and workers.

Rules:
- Treat task-provided file paths as hints; verify they exist before reading or editing.
- Use the shared \`memory/\` directory for lightweight notes when useful.
- Check \`memory/patterns.md\` for previously discovered codebase patterns before starting work.
- Check for \`.teamclaw-notes.md\` files in directories you work on for prior context.
- Report meaningful progress during longer tasks.
- If requirements or environment details are missing and work cannot continue safely, request clarification instead of guessing.
`;

const DEFAULT_BOOTSTRAP_MD = `# BOOTSTRAP.md

This is a TeamClaw workspace bootstrap file.

If the project files you expect are missing:
1. Search the workspace before assuming the path is correct.
2. Call out missing artifacts explicitly.
3. Ask for clarification when the missing artifact blocks the task.
`;

const DEFAULT_HEARTBEAT_MD = `# HEARTBEAT.md

# Keep this file empty (or with only comments) to skip heartbeat API calls.
`;

const DEFAULT_PATTERNS_MD = `# Codebase Patterns

Reusable patterns discovered by TeamClaw workers during task execution.
This file is automatically maintained — new patterns are appended as workers complete tasks.
Read this file before starting work to benefit from previously discovered knowledge.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!trimmed) {
    return "main";
  }
  return trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "main";
}

function expandUserPath(
  value: string,
  homedir: () => string = os.homedir,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function resolveConfiguredOpenClawWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const parsed = loadOpenClawConfigRecord(env, homedir);
  if (!parsed) {
    return "";
  }
  const agents = isRecord(parsed.agents) ? parsed.agents : null;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : null;
  if (defaults && typeof defaults.workspace === "string" && defaults.workspace.trim()) {
    return expandUserPath(defaults.workspace, homedir);
  }
  return "";
}

function resolveConfiguredTeamClawIsolationMode(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const parsed = loadOpenClawConfigRecord(env, homedir);
  if (!parsed) {
    return TEAMCLAW_ISOLATION_MODE_INDEPENDENT;
  }
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : null;
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : null;
  const teamclawEntry = entries && isRecord(entries[TEAMCLAW_AGENT_ID]) ? entries[TEAMCLAW_AGENT_ID] : null;
  const teamclawConfig = teamclawEntry && isRecord(teamclawEntry.config) ? teamclawEntry.config : null;
  return teamclawConfig?.agentIsolationMode === TEAMCLAW_ISOLATION_MODE_MAIN
    ? TEAMCLAW_ISOLATION_MODE_MAIN
    : TEAMCLAW_ISOLATION_MODE_INDEPENDENT;
}

function resolveExplicitTeamClawWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.TEAMCLAW_WORKSPACE_DIR?.trim();
  if (!override) {
    return "";
  }
  return expandUserPath(override, homedir);
}

function loadOpenClawConfigRecord(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Record<string, unknown> | null {
  const configPath = resolveDefaultOpenClawConfigPath(env, homedir);
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveConfiguredAgentEntry(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Record<string, unknown> | null {
  const parsed = loadOpenClawConfigRecord(env, homedir);
  if (!parsed) {
    return null;
  }
  const agents = isRecord(parsed.agents) ? parsed.agents : null;
  const normalizedAgentId = normalizeAgentId(agentId);
  // OpenClaw 2026.10+ keyed agents.entries take precedence; legacy hosts
  // (<2026.10) only have the array-shaped agents.list.
  const entries = agents && isRecord(agents.entries) ? agents.entries : null;
  const keyedEntry = entries ? entries[normalizedAgentId] : null;
  if (isRecord(keyedEntry)) {
    return keyedEntry;
  }
  const list = agents && Array.isArray(agents.list) ? agents.list : [];
  for (const entry of list) {
    if (!isRecord(entry)) {
      continue;
    }
    if (normalizeAgentId(entry.id) === normalizedAgentId) {
      return entry;
    }
  }
  return null;
}

function resolveConfiguredDefaultModelValue(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const parsed = loadOpenClawConfigRecord(env, homedir);
  if (!parsed) {
    return "";
  }
  const agents = isRecord(parsed.agents) ? parsed.agents : null;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : null;
  const model = defaults?.model;
  if (typeof model === "string") {
    return model.trim();
  }
  if (isRecord(model) && typeof model.primary === "string") {
    return model.primary.trim();
  }
  return "";
}

function resolveConfiguredTeamClawModelValue(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const teamclawEntry = resolveConfiguredAgentEntry(TEAMCLAW_AGENT_ID, env, homedir);
  const model = teamclawEntry?.model;
  if (typeof model === "string") {
    return model.trim();
  }
  if (isRecord(model) && typeof model.primary === "string") {
    return model.primary.trim();
  }
  return resolveConfiguredDefaultModelValue(env, homedir);
}

function cloneJsonValue<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

function resolveConfiguredDefaultAgentId(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const parsed = loadOpenClawConfigRecord(env, homedir);
  if (!parsed) {
    return "main";
  }
  const agents = isRecord(parsed.agents) ? parsed.agents : null;
  const list = agents && Array.isArray(agents.list) ? agents.list.filter(isRecord) : [];
  if (list.length === 0) {
    return "main";
  }
  const defaultEntry = list.find((entry) => entry.default === true) ?? list[0];
  return normalizeAgentId(defaultEntry.id);
}

export function resolveDefaultOpenClawHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const baseHome = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homedir();
  return path.resolve(baseHome);
}

export function resolveDefaultOpenClawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const stateDirOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDirOverride) {
    return path.resolve(stateDirOverride);
  }

  return path.join(resolveDefaultOpenClawHomeDir(env, homedir), ".openclaw");
}

export function resolveDefaultOpenClawConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const configPathOverride = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPathOverride) {
    return path.resolve(configPathOverride);
  }

  return path.join(resolveDefaultOpenClawStateDir(env, homedir), "openclaw.json");
}

export function resolveDefaultOpenClawWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const configuredWorkspaceDir = resolveConfiguredOpenClawWorkspaceDir(env, homedir);
  if (configuredWorkspaceDir) {
    return configuredWorkspaceDir;
  }
  const stateDir = resolveDefaultOpenClawStateDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(stateDir, `workspace-${profile}`);
  }
  return path.join(stateDir, "workspace");
}

export function resolveTeamClawAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (resolveConfiguredTeamClawIsolationMode(env, homedir) === TEAMCLAW_ISOLATION_MODE_MAIN) {
    return resolveDefaultAgentDir(env, homedir);
  }
  const configuredEntry = resolveConfiguredAgentEntry(TEAMCLAW_AGENT_ID, env, homedir);
  if (configuredEntry && typeof configuredEntry.agentDir === "string" && configuredEntry.agentDir.trim()) {
    return expandUserPath(configuredEntry.agentDir, homedir);
  }
  return path.join(resolveDefaultOpenClawStateDir(env, homedir), "agents", TEAMCLAW_AGENT_ID, "agent");
}

export type TeamClawModelReadiness = {
  status: "ready" | "missing";
  hasConfiguredModel: boolean;
  hasAuthProfiles: boolean;
  configuredModel: string;
  authPath: string;
  message: string;
};

/**
 * OpenClaw 2026.10+ moved model-provider auth out of the legacy per-agent
 * `auth-profiles.json` file and into the host config. Two host shapes exist:
 * 2026.10 wrote `models.providers[*]` with apiKey/auth (optionally backed by
 * the secrets store); 2026.11 onboard writes `auth.profiles[*]` entries
 * (`provider` + `mode`, the secret itself in the secrets store) and models
 * reference profiles via the `<model>@<profile>` suffix. Treat either shape
 * as ready so the readiness gate does not false-negative on current hosts.
 */
function hostConfiguredProviderAuthExists(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): boolean {
  try {
    const configPath = resolveDefaultOpenClawConfigPath(env, homedir);
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      models?: { providers?: Record<string, unknown> };
      providers?: Record<string, unknown>;
      auth?: { profiles?: Record<string, unknown> };
    };
    const providers = parsed.models?.providers ?? parsed.providers ?? {};
    const inlineProviderAuth = Object.values(providers).some(
      (value) =>
        Boolean(value) &&
        typeof value === "object" &&
        ("apiKey" in (value as object) || "auth" in (value as object)),
    );
    if (inlineProviderAuth) {
      return true;
    }
    const authProfiles = Object.values(parsed.auth?.profiles ?? {});
    return authProfiles.some(
      (value) => Boolean(value) && typeof value === "object",
    );
  } catch {
    return false;
  }
}

export function getTeamClawModelReadiness(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): TeamClawModelReadiness {
  const configuredModel = resolveConfiguredTeamClawModelValue(env, homedir);
  const authCandidates = [
    path.join(resolveTeamClawAgentDir(env, homedir), "auth-profiles.json"),
    path.join(resolveDefaultAgentDir(env, homedir), "auth-profiles.json"),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const authPath = authCandidates.find((candidatePath) => {
    try {
      return existsSync(candidatePath);
    } catch {
      return false;
    }
  }) ?? authCandidates[0] ?? "";
  const hasAuthProfiles = Boolean(authPath) && existsSync(authPath);
  const hasHostProviderAuth = !hasAuthProfiles && hostConfiguredProviderAuthExists(env, homedir);
  const authReady = hasAuthProfiles || hasHostProviderAuth;
  const hasConfiguredModel = Boolean(configuredModel);
  const status = hasConfiguredModel && authReady ? "ready" : "missing";
  const missingParts = [];
  if (!hasConfiguredModel) {
    missingParts.push("no model is configured");
  }
  if (!authReady) {
    missingParts.push("no auth-profiles.json was found");
  }
  return {
    status,
    hasConfiguredModel,
    hasAuthProfiles: authReady,
    configuredModel,
    authPath,
    message: status === "ready"
      ? `TeamClaw is ready with model ${configuredModel}.`
      : `TeamClaw cannot work yet because ${missingParts.join(" and ")}.`,
  };
}

export function resolveDefaultAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const defaultAgentId = resolveConfiguredDefaultAgentId(env, homedir);
  const configuredEntry = resolveConfiguredAgentEntry(defaultAgentId, env, homedir);
  if (configuredEntry && typeof configuredEntry.agentDir === "string" && configuredEntry.agentDir.trim()) {
    return expandUserPath(configuredEntry.agentDir, homedir);
  }
  return path.join(resolveDefaultOpenClawStateDir(env, homedir), "agents", defaultAgentId, "agent");
}

export function resolveTeamClawAgentWorkspaceRootDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const explicitWorkspaceDir = resolveExplicitTeamClawWorkspaceDir(env, homedir);
  if (explicitWorkspaceDir) {
    return explicitWorkspaceDir;
  }
  if (resolveConfiguredTeamClawIsolationMode(env, homedir) === TEAMCLAW_ISOLATION_MODE_MAIN) {
    return resolveDefaultOpenClawWorkspaceDir(env, homedir);
  }
  const configuredEntry = resolveConfiguredAgentEntry(TEAMCLAW_AGENT_ID, env, homedir);
  if (configuredEntry && typeof configuredEntry.workspace === "string" && configuredEntry.workspace.trim()) {
    return expandUserPath(configuredEntry.workspace, homedir);
  }
  return path.join(resolveDefaultOpenClawStateDir(env, homedir), `workspace-${TEAMCLAW_AGENT_ID}`);
}

export function buildTeamClawAgentSessionKey(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const trimmed = input.trim();
  const agentMatch = trimmed.match(/^agent:[^:]+:(.+)$/i);
  const logicalKey = (agentMatch?.[1] ?? trimmed).trim().toLowerCase() || "main";
  if (resolveConfiguredTeamClawIsolationMode(env, homedir) === TEAMCLAW_ISOLATION_MODE_MAIN) {
    return logicalKey;
  }
  return `agent:${TEAMCLAW_AGENT_ID}:${logicalKey}`;
}

export function resolveDefaultTeamClawRuntimeRootDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveDefaultOpenClawStateDir(env, homedir), "teamclaw-runtimes");
}

/**
 * TeamClaw-specific workspace directory.
 *
 * By default this resolves to a dedicated OpenClaw agent workspace sibling such as
 * `<stateDir>/workspace-teamclaw`.
 *
 * When `agentIsolationMode` is set to `main`, TeamClaw falls back to the legacy
 * shared layout and uses `<default-workspace>/teamclaw`.
 */
export function resolveTeamClawWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (resolveConfiguredTeamClawIsolationMode(env, homedir) === TEAMCLAW_ISOLATION_MODE_MAIN) {
    return path.join(resolveTeamClawAgentWorkspaceRootDir(env, homedir), TEAMCLAW_AGENT_ID);
  }
  return resolveTeamClawAgentWorkspaceRootDir(env, homedir);
}

/**
 * True when the teamclaw workspace is still the implicit default (nothing
 * explicitly configured) - the UI uses this to offer a one-time workspace
 * relocation prompt on first load.
 */
export function teamClawWorkspaceIsDefault(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): boolean {
  if (resolveExplicitTeamClawWorkspaceDir(env, homedir)) {
    return false;
  }
  const entry = resolveConfiguredAgentEntry(TEAMCLAW_AGENT_ID, env, homedir);
  return typeof (entry as { workspace?: unknown } | null)?.workspace !== "string";
}

/**
 * Persist a new teamclaw workspace path into the host config, writing the
 * 2026.10 keyed agents.entries shape (legacy agents.list folded + removed,
 * ownership=explicit for multi-agent rosters). Legacy list-only hosts keep
 * the array shape.
 */
export async function updateTeamClawWorkspaceDir(
  workspaceDir: string,
  logger?: { warn?: (message: string) => void },
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Promise<{ configPath: string; agentEntryPath: string }> {
  if (!workspaceDir.trim()) {
    throw new Error("workspace path is required");
  }
  // Reject relative paths: path.resolve() would silently join them onto the
  // gateway process cwd (which can be the workspace itself), producing a
  // nested garbage path in the host config.
  if (!workspaceDir.trim().startsWith("/") && !workspaceDir.trim().startsWith("~/") && workspaceDir.trim() !== "~") {
    throw new Error("workspace path must be absolute (start with / or ~/)");
  }
  const normalized = path.resolve(expandUserPath(workspaceDir.trim(), homedir));
  const configPath = resolveDefaultOpenClawConfigPath(env, homedir);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON5.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!isRecord(parsed)) {
      throw new Error("host config is not an object");
    }
  } catch (err) {
    throw new Error(`failed to read host config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const agents = isRecord(parsed.agents) ? parsed.agents : {};
  const patch: Record<string, unknown> = { workspace: normalized };

  const legacyList = Array.isArray(agents.list) ? agents.list.filter(isRecord) : [];
  if (isRecord(agents.entries) || legacyList.length === 0) {
    const entries = isRecord(agents.entries) ? agents.entries : {};
    for (const legacyEntry of legacyList) {
      const legacyId = typeof legacyEntry.id === "string" ? legacyEntry.id : "";
      if (!legacyId || isRecord(entries[legacyId])) {
        continue;
      }
      const migrated = cloneJsonValue(legacyEntry);
      delete migrated.id;
      entries[legacyId] = migrated;
    }
    const existing = isRecord(entries[TEAMCLAW_AGENT_ID]) ? entries[TEAMCLAW_AGENT_ID] : {};
    entries[TEAMCLAW_AGENT_ID] = { ...cloneJsonValue(existing), ...patch };
    agents.entries = entries;
    delete agents.list;
    if (Object.keys(entries).length > 1 && agents.ownership !== "explicit") {
      agents.ownership = "explicit";
    }
  } else {
    const nextList = [...legacyList];
    const index = nextList.findIndex((entry) => entry.id === TEAMCLAW_AGENT_ID);
    if (index >= 0) {
      nextList[index] = { ...cloneJsonValue(nextList[index]), ...patch };
    } else {
      nextList.push({ id: TEAMCLAW_AGENT_ID, ...patch });
    }
    agents.list = nextList;
  }
  parsed.agents = agents;
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  logger?.warn?.(`TeamClaw: workspace updated to ${normalized} (restart the gateway to apply)`);
  return { configPath, agentEntryPath: normalized };
}

// Phase 1.2: the catalog's id set and order derive from the canonical
// role-ids.ts list (openclaw-workspace.ts sits below roles.ts in the module
// graph, so it cannot value-import the registry itself). The labels are the
// compact names the model-settings dialog has always shown; they
// intentionally differ from the full registry labels in roles.ts (e.g.
// "Project Manager" vs "Product Manager"), so they stay explicit here.
// tests/test-role-single-source.mjs pins the derived output to the exact
// pre-Phase-1.2 value.
const TEAMCLAW_ROLE_CATALOG_LABELS: Record<string, string> = {
  pm: "Project Manager",
  architect: "Architect",
  developer: "Developer",
  qa: "QA Engineer",
  "release-engineer": "Release Engineer",
  "infra-engineer": "Infra Engineer",
  devops: "DevOps Engineer",
  "security-engineer": "Security Engineer",
  designer: "Designer",
  marketing: "Marketing",
  "data-engineer": "Data Engineer",
};

export const TEAMCLAW_ROLE_CATALOG: ReadonlyArray<{ id: string; label: string }> = ROLE_IDS.map((id) => ({
  id,
  label: TEAMCLAW_ROLE_CATALOG_LABELS[id] ?? id,
}));

export type TeamClawModelCatalog = {
  defaultModel: string;
  roleModelOverrides: Record<string, string>;
  roles: ReadonlyArray<{ id: string; label: string }>;
  providers: ReadonlyArray<{ id: string; models: string[] }>;
};

/**
 * Model catalog for the UI settings dialog: provider/model ids from the host
 * config (names only - never secrets), plus the current teamclaw default and
 * per-role overrides.
 */
/**
 * Live host model catalog via `openclaw models list --json` (the gateway's
 * own resolved catalog: provider plugins, dynamic entries, availability).
 * Cached briefly because the CLI spawn costs ~seconds; falls back to the
 * static config models when unavailable.
 */
let liveCatalogCache: { at: number; providers: Array<{ id: string; models: string[] }> } | null = null;
let liveCatalogInFlight: Promise<Array<{ id: string; models: string[] }>> | null = null;
const LIVE_CATALOG_TTL_MS = 30_000;

/**
 * Resolve how to invoke the openclaw CLI from inside the gateway process.
 * LaunchAgent processes may lack /opt/homebrew/bin on PATH, so prefer
 * node + the host package entry resolved through the plugin's node_modules
 * link (the host links itself there at install time); fall back to the bare
 * command name.
 */
function resolveOpenClawCliInvocation(): { command: string; args: string[] } {
  if (process.execPath) {
    try {
      const moduleRequire = createRequire(import.meta.url);
      const hostPkgDir = path.dirname(moduleRequire.resolve("openclaw/package.json"));
      const entry = path.join(hostPkgDir, "openclaw.mjs");
      if (existsSync(entry)) {
        return { command: process.execPath, args: [entry] };
      }
    } catch (resolveErr) {
      // Resolution failure is expected on hosts without the node_modules link;
      // fall through to the bare CLI name.
      void resolveErr;
    }
  }
  return { command: "openclaw", args: [] };
}

function buildCatalogCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The gateway LaunchAgent environment carries runtime variables (e.g.
  // OPENCLAW_GATEWAY_PORT) that hijack the CLI's behavior, and may lack the
  // package manager bin dirs. Pass a minimal, PATH-augmented env instead.
  const clean: NodeJS.ProcessEnv = {
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", env.PATH || "/usr/bin:/bin"].join(path.delimiter),
  };
  for (const key of ["HOME", "USER", "LANG", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME"]) {
    if (typeof env[key] === "string") {
      clean[key] = env[key];
    }
  }
  return clean;
}

async function readLiveModelCatalogProviders(env: NodeJS.ProcessEnv): Promise<Array<{ id: string; models: string[] }>> {
  const now = Date.now();
  if (liveCatalogCache && now - liveCatalogCache.at < LIVE_CATALOG_TTL_MS) {
    return liveCatalogCache.providers;
  }
  if (liveCatalogInFlight) {
    return liveCatalogInFlight;
  }
  liveCatalogInFlight = (async () => {
    try {
      const invocation = resolveOpenClawCliInvocation();
      // IMPORTANT: `openclaw models list` is a gateway RPC client. Running it
      // synchronously (spawnSync) from inside a gateway plugin service
      // deadlocks: the CLI cannot reach the gateway whose event loop is
      // blocked waiting on it. Async execFile keeps the loop free.
      const { stdout } = await execFileAsync(
        invocation.command,
        [...invocation.args, "models", "list", "--json"],
        {
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
          env: buildCatalogCliEnv(env),
        },
      );
      const parsed = JSON.parse(stdout) as { models?: unknown };
    const byProvider = new Map<string, Set<string>>();
    if (Array.isArray(parsed.models)) {
      for (const entry of parsed.models) {
        const key = isRecord(entry) && typeof (entry as { key?: unknown }).key === "string"
          ? (entry as { key: string }).key
          : "";
        if (!key || (entry as { available?: unknown }).available === false) {
          continue;
        }
        const slash = key.indexOf("/");
        const providerId = slash > 0 ? key.slice(0, slash) : key;
        const modelId = slash > 0 ? key.slice(slash + 1) : "";
        if (!modelId) {
          continue;
        }
        if (!byProvider.has(providerId)) {
          byProvider.set(providerId, new Set());
        }
        byProvider.get(providerId)!.add(modelId);
      }
    }
    const providers = [...byProvider.entries()]
      .map(([id, models]) => ({ id, models: [...models].sort() }))
      .sort((left, right) => left.id.localeCompare(right.id));
      liveCatalogCache = { at: now, providers };
      return providers;
    } catch (err) {
      console.warn(`[teamclaw] live model catalog unavailable: ${err instanceof Error ? err.message : String(err)}`);
      liveCatalogCache = { at: now, providers: [] };
      return [];
    } finally {
      liveCatalogInFlight = null;
    }
  })();
  return liveCatalogInFlight;
}

export async function getTeamClawModelCatalog(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Promise<TeamClawModelCatalog> {
  const parsedConfig = loadOpenClawConfigRecord(env, homedir);
  const staticProviders: Array<{ id: string; models: string[] }> = [];
  const modelsSection = parsedConfig && isRecord(parsedConfig.models) ? parsedConfig.models : null;
  const providerMap = modelsSection && isRecord((modelsSection as { providers?: unknown }).providers)
    ? (modelsSection as { providers: Record<string, unknown> }).providers
    : null;
  if (providerMap) {
    for (const [providerId, providerValue] of Object.entries(providerMap)) {
      if (!isRecord(providerValue)) {
        continue;
      }
      const rawModels = Array.isArray((providerValue as { models?: unknown }).models)
        ? (providerValue as { models: unknown[] }).models
        : [];
      const models = rawModels
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }
          const id = isRecord(entry) ? (entry as { id?: unknown }).id : undefined;
          return typeof id === "string" ? id : "";
        })
        .filter(Boolean);
      staticProviders.push({ id: providerId, models });
    }
  }

  // Live catalog first; merge static config entries in (dedup) so models the
  // user pinned in config but the live resolver has not surfaced still show.
  const merged = new Map<string, Set<string>>();
  for (const provider of [...(await readLiveModelCatalogProviders(env)), ...staticProviders]) {
    if (!merged.has(provider.id)) {
      merged.set(provider.id, new Set());
    }
    const target = merged.get(provider.id)!;
    for (const model of provider.models) {
      target.add(model);
    }
  }
  const providers = [...merged.entries()]
    .map(([id, models]) => ({ id, models: [...models].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));

  let roleModelOverrides: Record<string, string> = {};
  const pluginsSection = parsedConfig && isRecord(parsedConfig.plugins) ? parsedConfig.plugins : null;
  const pluginEntries = pluginsSection && isRecord((pluginsSection as { entries?: unknown }).entries)
    ? (pluginsSection as { entries: Record<string, unknown> }).entries
    : null;
  const teamclawPlugin = pluginEntries ? pluginEntries[TEAMCLAW_AGENT_ID] : null;
  const pluginConfig = isRecord(teamclawPlugin) ? (teamclawPlugin as { config?: unknown }).config : null;
  const overrides = pluginConfig && isRecord(pluginConfig) ? (pluginConfig as { roleModelOverrides?: unknown }).roleModelOverrides : null;
  if (overrides && isRecord(overrides)) {
    roleModelOverrides = { ...(overrides as Record<string, string>) };
  }

  return {
    defaultModel: resolveConfiguredTeamClawModelValue(env, homedir),
    roleModelOverrides,
    roles: TEAMCLAW_ROLE_CATALOG,
    providers,
  };
}

/**
 * Persist model configuration: the teamclaw agent default model (host config
 * agents.entries.teamclaw.model) and per-role overrides (plugin config
 * roleModelOverrides). The gateway hot-reloads config changes; a restart is
 * only needed if a change does not take effect.
 */
export async function updateTeamClawModelConfig(
  update: { defaultModel?: string; roleModelOverrides?: Record<string, string> },
  logger?: { warn?: (message: string) => void },
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Promise<{ configPath: string }> {
  const configPath = resolveDefaultOpenClawConfigPath(env, homedir);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON5.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!isRecord(parsed)) {
      throw new Error("host config is not an object");
    }
  } catch (err) {
    throw new Error(`failed to read host config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof update.defaultModel === "string" && update.defaultModel.trim()) {
    const agents = isRecord(parsed.agents) ? parsed.agents : {};
    const entries = isRecord(agents.entries) ? agents.entries : {};
    const teamclaw = isRecord(entries[TEAMCLAW_AGENT_ID]) ? entries[TEAMCLAW_AGENT_ID] : {};
    entries[TEAMCLAW_AGENT_ID] = { ...teamclaw, model: update.defaultModel.trim() };
    agents.entries = entries;
    if (Object.keys(entries).length > 1 && agents.ownership !== "explicit") {
      agents.ownership = "explicit";
    }
    parsed.agents = agents;
  }

  if (update.roleModelOverrides !== undefined && update.roleModelOverrides !== null) {
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const pluginEntries = isRecord(plugins.entries) ? plugins.entries : {};
    const teamclawPlugin = isRecord(pluginEntries[TEAMCLAW_AGENT_ID]) ? pluginEntries[TEAMCLAW_AGENT_ID] : { enabled: true };
    const pluginConfig = isRecord((teamclawPlugin as { config?: unknown }).config)
      ? (teamclawPlugin as { config: Record<string, unknown> }).config
      : {};
    pluginEntries[TEAMCLAW_AGENT_ID] = {
      ...teamclawPlugin,
      config: { ...pluginConfig, roleModelOverrides: update.roleModelOverrides },
    };
    plugins.entries = pluginEntries;
    parsed.plugins = plugins;
  }

  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  logger?.warn?.("TeamClaw: model config updated (hot-reload applies; restart the gateway if a change does not take effect)");
  return { configPath };
}

/**
 * Persist hot-reloadable worker-provisioning fields into the host
 * openclaw.json plugins.entries.teamclaw.config (read-modify-write, same
 * pattern as updateTeamClawModelConfig). Only whitelisted fields are
 * touched; unknown keys in the existing plugin config are preserved.
 */
export async function updateTeamClawProvisioningConfig(
  update: {
    workerProvisioningMinPerRole?: number;
    workerProvisioningMaxPerRole?: number;
    workerProvisioningIdleTtlMs?: number;
  },
  logger?: { warn?: (message: string) => void },
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Promise<{ configPath: string }> {
  const configPath = resolveDefaultOpenClawConfigPath(env, homedir);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON5.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!isRecord(parsed)) {
      throw new Error("host config is not an object");
    }
  } catch (err) {
    throw new Error(`failed to read host config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const pluginEntries = isRecord(plugins.entries) ? plugins.entries : {};
  const teamclawPlugin = isRecord(pluginEntries[TEAMCLAW_AGENT_ID]) ? pluginEntries[TEAMCLAW_AGENT_ID] : { enabled: true };
  const pluginConfig = isRecord((teamclawPlugin as { config?: unknown }).config)
    ? { ...(teamclawPlugin as { config: Record<string, unknown> }).config }
    : {};
  for (const [key, value] of Object.entries(update)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      pluginConfig[key] = value;
    }
  }
  pluginEntries[TEAMCLAW_AGENT_ID] = { ...teamclawPlugin, config: pluginConfig };
  plugins.entries = pluginEntries;
  parsed.plugins = plugins;

  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  logger?.warn?.("TeamClaw: worker provisioning config persisted (hot-reload applies to the running controller)");
  return { configPath };
}

/**
 * Resolve the `projects/` root inside the TeamClaw workspace.
 * Each orchestration run or ad-hoc task gets its own subdirectory here.
 */
export function resolveTeamClawProjectsDir(
  env?: NodeJS.ProcessEnv,
  homedir?: () => string,
): string {
  return path.join(resolveTeamClawWorkspaceDir(env, homedir), "projects");
}

/**
 * Resolve a project path relative to the active TeamClaw workspace.
 * Workers operate inside the TeamClaw workspace itself, so project-local file
 * operations should use `projects/<projectDir>` regardless of isolation mode.
 */
export function buildTeamClawProjectWorkspacePath(projectDir: string): string {
  const normalized = String(projectDir || "").trim().replace(/^\/+|\/+$/gu, "");
  return normalized ? `projects/${normalized}` : "projects";
}

/**
 * Resolve a project path relative to the TeamClaw agent workspace root.
 * Preview metadata is evaluated from the agent workspace root, which differs
 * between `independent` and `main` isolation modes.
 */
export function buildTeamClawProjectAgentRelativePath(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const workspaceRelative = buildTeamClawProjectWorkspacePath(projectDir);
  const agentWorkspaceRoot = resolveTeamClawAgentWorkspaceRootDir(env, homedir);
  const teamclawWorkspaceDir = resolveTeamClawWorkspaceDir(env, homedir);
  const absoluteProjectPath = path.join(teamclawWorkspaceDir, workspaceRelative);
  const relativeToAgentRoot = path.relative(agentWorkspaceRoot, absoluteProjectPath).replace(/\\/gu, "/");
  return relativeToAgentRoot || ".";
}

/**
 * Derive a filesystem-safe project slug from free-form text.
 *
 * 1. Lower-case, replace non-alphanumeric runs with hyphens, trim to ~50 chars.
 * 2. Append a short random suffix to avoid collisions.
 *
 * Example: "Build a payment system with Stripe" → "build-a-payment-system-with-stripe-k3f9m2"
 */
export function deriveStableProjectKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

export function deriveProjectSlug(text: string): string {
  const slug = deriveStableProjectKey(text);
  const suffix = randomSuffix(6);
  return slug ? `${slug}-${suffix}` : suffix;
}

function randomSuffix(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export async function ensureOpenClawWorkspaceMemoryDir(logger: PluginLogger): Promise<string> {
  await ensureTeamClawAgentBootstrap(logger);
  const workspaceDir = resolveTeamClawWorkspaceDir();
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(memoryDir, { recursive: true });
    await ensureFileIfMissing(path.join(workspaceDir, "AGENTS.md"), DEFAULT_AGENTS_MD);
    await ensureFileIfMissing(path.join(workspaceDir, "BOOTSTRAP.md"), DEFAULT_BOOTSTRAP_MD);
    await ensureFileIfMissing(path.join(workspaceDir, "HEARTBEAT.md"), DEFAULT_HEARTBEAT_MD);
    await ensureFileIfMissing(path.join(memoryDir, "patterns.md"), DEFAULT_PATTERNS_MD);
  } catch (err) {
    logger.warn(
      `TeamClaw: failed to ensure OpenClaw workspace memory dir at ${memoryDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return memoryDir;
}

export async function ensureTeamClawAgentBootstrap(logger: PluginLogger): Promise<void> {
  const teamclawAgentDir = resolveTeamClawAgentDir();
  const teamclawWorkspaceRoot = resolveTeamClawAgentWorkspaceRootDir();
  const isolationMode = resolveConfiguredTeamClawIsolationMode();
  try {
    await fs.mkdir(teamclawWorkspaceRoot, { recursive: true });
    if (isolationMode === TEAMCLAW_ISOLATION_MODE_MAIN) {
      return;
    }
    await ensureTeamClawAgentConfigBootstrap(logger);
    await fs.mkdir(teamclawAgentDir, { recursive: true });
    const sourceAgentDirs = [
      resolveDefaultAgentDir(),
      path.join(resolveDefaultOpenClawStateDir(), "agents", "main", "agent"),
    ].filter((value, index, values) => values.indexOf(value) === index);
    for (const sourceAgentDir of sourceAgentDirs) {
      const sourceAuthProfilesPath = path.join(sourceAgentDir, "auth-profiles.json");
      try {
        await fs.access(sourceAuthProfilesPath);
      } catch {
        continue;
      }
      const targetAuthProfilesPath = path.join(teamclawAgentDir, "auth-profiles.json");
      await fs.copyFile(sourceAuthProfilesPath, targetAuthProfilesPath);
      logger.info(`TeamClaw: bootstrapped dedicated agent auth from ${sourceAuthProfilesPath}`);
      break;
    }
  } catch (err) {
    logger.warn(
      `TeamClaw: failed to bootstrap dedicated agent runtime: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function ensureTeamClawAgentConfigBootstrap(logger: PluginLogger): Promise<void> {
  const configPath = resolveDefaultOpenClawConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON5.parse(raw);
    if (!isRecord(candidate)) {
      return;
    }
    parsed = candidate;
  } catch {
    return;
  }

  const agents = isRecord(parsed.agents) ? parsed.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const rootTools = isRecord(parsed.tools) ? parsed.tools : {};
  const rootExec = isRecord(rootTools.exec) ? rootTools.exec : {};
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const pluginEntries = isRecord(plugins.entries) ? plugins.entries : {};
  const teamclawPluginEntry = isRecord(pluginEntries[TEAMCLAW_AGENT_ID]) ? pluginEntries[TEAMCLAW_AGENT_ID] : {};
  const existingPluginConfig = isRecord(teamclawPluginEntry.config) ? teamclawPluginEntry.config : {};
  const teamclawAgentDir = path.join(resolveDefaultOpenClawStateDir(), "agents", TEAMCLAW_AGENT_ID, "agent");

  // OpenClaw 2026.10+ rejects agents.list ("moved to keyed agents.entries")
  // and rejects tools.exec objects mixing mode with security/ask. Write the
  // keyed shape whenever the host already uses it, and never reintroduce the
  // legacy list on modern hosts.
  const agentEntries = isRecord(agents.entries) ? agents.entries : {};
  const legacyList = Array.isArray(agents.list) ? agents.list.filter(isRecord) : [];
  const modernSchema = isRecord(agents.entries) || legacyList.length === 0;

  const findExistingAgentEntry = (): { entry: Record<string, unknown>; source: "entries" | "list" | "none" } => {
    const keyed = agentEntries[TEAMCLAW_AGENT_ID];
    if (isRecord(keyed)) {
      return { entry: keyed, source: "entries" };
    }
    const fromList = legacyList.find((entry) => normalizeAgentId(entry.id) === TEAMCLAW_AGENT_ID);
    if (fromList) {
      return { entry: fromList, source: "list" };
    }
    return { entry: {}, source: "none" };
  };
  const existing = findExistingAgentEntry();
  const existingEntry = existing.entry;
  const existingEntryTools = isRecord(existingEntry.tools) ? existingEntry.tools : {};
  const existingEntryExec = isRecord(existingEntryTools.exec) ? existingEntryTools.exec : {};
  const nextEntryExec: Record<string, unknown> = {
    ...cloneJsonValue(rootExec),
    ...cloneJsonValue(existingEntryExec),
  };
  if (typeof nextEntryExec.mode === "string" && nextEntryExec.mode.trim()) {
    // Keyed-schema hosts forbid combining mode with security/ask.
    delete nextEntryExec.security;
    delete nextEntryExec.ask;
  } else {
    if (typeof nextEntryExec.security !== "string" || !nextEntryExec.security.trim()) {
      nextEntryExec.security = typeof rootExec.security === "string" && rootExec.security.trim()
        ? rootExec.security.trim()
        : TEAMCLAW_RECOMMENDED_EXEC_SECURITY;
    }
    if (typeof nextEntryExec.ask !== "string" || !nextEntryExec.ask.trim()) {
      nextEntryExec.ask = typeof rootExec.ask === "string" && rootExec.ask.trim()
        ? rootExec.ask.trim()
        : TEAMCLAW_RECOMMENDED_EXEC_ASK;
    }
  }
  const nextEntry: Record<string, unknown> = {
    ...cloneJsonValue(existingEntry),
    agentDir: typeof existingEntry.agentDir === "string" && existingEntry.agentDir.trim()
      ? existingEntry.agentDir
      : teamclawAgentDir,
    tools: {
      ...cloneJsonValue(existingEntryTools),
      exec: nextEntryExec,
    },
  };
  // Keep the workspace implicit when unset: materializing the default here
  // would make "default" and "explicitly configured" indistinguishable, which
  // the UI workspace-relocation prompt depends on. The runtime resolver falls
  // back to <stateDir>/workspace-teamclaw either way.
  if (typeof existingEntry.workspace === "string" && existingEntry.workspace.trim()) {
    nextEntry.workspace = existingEntry.workspace;
  }
  if (!modernSchema) {
    nextEntry.id = TEAMCLAW_AGENT_ID;
  }
  if (nextEntry.model == null && defaults.model != null) {
    nextEntry.model = cloneJsonValue(defaults.model);
  }

  const nextPluginConfig: Record<string, unknown> = {
    ...existingPluginConfig,
  };
  if (
    nextPluginConfig.mode === "controller"
    && nextPluginConfig.processModel === "multi"
    && nextPluginConfig.workerProvisioningType === "none"
    && nextPluginConfig.workerProvisioningDisabled !== true
  ) {
    nextPluginConfig.workerProvisioningType = "process";
  }

  const entryChanged = JSON.stringify(existingEntry) !== JSON.stringify(nextEntry)
    || (modernSchema && (legacyList.length > 0 || !isRecord(agentEntries[TEAMCLAW_AGENT_ID])));
  const pluginConfigChanged = JSON.stringify(existingPluginConfig) !== JSON.stringify(nextPluginConfig);
  if (!entryChanged && !pluginConfigChanged) {
    return;
  }

  if (modernSchema) {
    // Fold any legacy list entries into the keyed map, then drop the list so
    // 2026.10 hosts stop rejecting the config.
    for (const legacyEntry of legacyList) {
      const legacyId = normalizeAgentId(legacyEntry.id);
      if (!legacyId || isRecord(agentEntries[legacyId])) {
        continue;
      }
      const migrated = cloneJsonValue(legacyEntry);
      delete migrated.id;
      agentEntries[legacyId] = migrated;
    }
    const keyedNextEntry = cloneJsonValue(nextEntry);
    delete keyedNextEntry.id;
    agentEntries[TEAMCLAW_AGENT_ID] = keyedNextEntry;
    agents.entries = agentEntries;
    delete agents.list;
    if (Object.keys(agentEntries).length > 1 && agents.ownership !== "explicit") {
      agents.ownership = "explicit";
    }
  } else {
    const nextList = [...legacyList];
    const existingIndex = nextList.findIndex((entry) => isRecord(entry) && normalizeAgentId(entry.id) === TEAMCLAW_AGENT_ID);
    if (existingIndex >= 0) {
      nextList[existingIndex] = nextEntry;
    } else {
      nextList.push(nextEntry);
    }
    agents.list = nextList;
  }
  parsed.agents = agents;
  if (pluginConfigChanged) {
    teamclawPluginEntry.config = nextPluginConfig;
    pluginEntries[TEAMCLAW_AGENT_ID] = teamclawPluginEntry;
    plugins.entries = pluginEntries;
    parsed.plugins = plugins;
  }
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  logger.info(`TeamClaw: bootstrapped dedicated agent config into ${configPath}`);
}

async function ensureFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, "utf8");
  }
}
