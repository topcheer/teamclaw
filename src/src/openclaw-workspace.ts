import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import type { PluginLogger } from "../api.js";

const DEFAULT_AGENTS_MD = `# AGENTS.md

This workspace is shared by TeamClaw controller and workers.

Rules:
- Treat task-provided file paths as hints; verify they exist before reading or editing.
- Use the shared \`memory/\` directory for lightweight notes when useful.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const configPath = resolveDefaultOpenClawConfigPath(env, homedir);
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    if (!isRecord(parsed)) {
      return "";
    }
    const agents = isRecord(parsed.agents) ? parsed.agents : null;
    const defaults = agents && isRecord(agents.defaults) ? agents.defaults : null;
    if (defaults && typeof defaults.workspace === "string" && defaults.workspace.trim()) {
      return expandUserPath(defaults.workspace, homedir);
    }
  } catch {
    // Fall back to the legacy state-dir-derived workspace path below.
  }
  return "";
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

export function resolveDefaultTeamClawRuntimeRootDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(path.dirname(resolveDefaultOpenClawWorkspaceDir(env, homedir)), "teamclaw-runtimes");
}

export async function ensureOpenClawWorkspaceMemoryDir(logger: PluginLogger): Promise<string> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(memoryDir, { recursive: true });
    await ensureFileIfMissing(path.join(workspaceDir, "AGENTS.md"), DEFAULT_AGENTS_MD);
    await ensureFileIfMissing(path.join(workspaceDir, "BOOTSTRAP.md"), DEFAULT_BOOTSTRAP_MD);
    await ensureFileIfMissing(path.join(workspaceDir, "HEARTBEAT.md"), DEFAULT_HEARTBEAT_MD);
  } catch (err) {
    logger.warn(
      `TeamClaw: failed to ensure OpenClaw workspace memory dir at ${memoryDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return memoryDir;
}

async function ensureFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, "utf8");
  }
}
