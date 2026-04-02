import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import type { PluginLogger } from "../api.js";

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
  const list = agents && Array.isArray(agents.list) ? agents.list : [];
  const normalizedAgentId = normalizeAgentId(agentId);
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
  const hasConfiguredModel = Boolean(configuredModel);
  const hasAuthProfiles = Boolean(authPath) && existsSync(authPath);
  const status = hasConfiguredModel && hasAuthProfiles ? "ready" : "missing";
  const missingParts = [];
  if (!hasConfiguredModel) {
    missingParts.push("no model is configured");
  }
  if (!hasAuthProfiles) {
    missingParts.push("no auth-profiles.json was found");
  }
  return {
    status,
    hasConfiguredModel,
    hasAuthProfiles,
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
export function deriveProjectSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
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
  const nextList = Array.isArray(agents.list) ? [...agents.list] : [];
  const rootTools = isRecord(parsed.tools) ? parsed.tools : {};
  const rootExec = isRecord(rootTools.exec) ? rootTools.exec : {};
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const teamclawPluginEntry = isRecord(entries[TEAMCLAW_AGENT_ID]) ? entries[TEAMCLAW_AGENT_ID] : {};
  const existingPluginConfig = isRecord(teamclawPluginEntry.config) ? teamclawPluginEntry.config : {};
  const teamclawWorkspaceDir = path.join(resolveDefaultOpenClawStateDir(), `workspace-${TEAMCLAW_AGENT_ID}`);
  const teamclawAgentDir = path.join(resolveDefaultOpenClawStateDir(), "agents", TEAMCLAW_AGENT_ID, "agent");
  const existingIndex = nextList.findIndex((entry) => isRecord(entry) && normalizeAgentId(entry.id) === TEAMCLAW_AGENT_ID);
  const existingEntry = existingIndex >= 0 && isRecord(nextList[existingIndex]) ? nextList[existingIndex] : {};
  const existingEntryTools = isRecord(existingEntry.tools) ? existingEntry.tools : {};
  const existingEntryExec = isRecord(existingEntryTools.exec) ? existingEntryTools.exec : {};
  const nextEntryExec: Record<string, unknown> = {
    ...cloneJsonValue(rootExec),
    ...cloneJsonValue(existingEntryExec),
  };
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
  const nextEntry: Record<string, unknown> = {
    ...existingEntry,
    id: TEAMCLAW_AGENT_ID,
    workspace: typeof existingEntry.workspace === "string" && existingEntry.workspace.trim()
      ? existingEntry.workspace
      : teamclawWorkspaceDir,
    agentDir: typeof existingEntry.agentDir === "string" && existingEntry.agentDir.trim()
      ? existingEntry.agentDir
      : teamclawAgentDir,
    tools: {
      ...cloneJsonValue(existingEntryTools),
      exec: nextEntryExec,
    },
  };
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

  const entryChanged = JSON.stringify(existingEntry) !== JSON.stringify(nextEntry);
  const pluginConfigChanged = JSON.stringify(existingPluginConfig) !== JSON.stringify(nextPluginConfig);
  if (!entryChanged && !pluginConfigChanged) {
    return;
  }

  if (existingIndex >= 0) {
    nextList[existingIndex] = nextEntry;
  } else {
    nextList.push(nextEntry);
  }
  agents.list = nextList;
  parsed.agents = agents;
  if (pluginConfigChanged) {
    teamclawPluginEntry.config = nextPluginConfig;
    entries[TEAMCLAW_AGENT_ID] = teamclawPluginEntry;
    plugins.entries = entries;
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
