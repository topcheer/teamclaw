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

/**
 * TeamClaw-specific workspace directory — a `teamclaw/` subdirectory inside the
 * OpenClaw workspace.  All TeamClaw controller and worker activity is scoped here
 * so that it doesn't pollute or get polluted by other workspace content.
 */
export function resolveTeamClawWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveDefaultOpenClawWorkspaceDir(env, homedir), "teamclaw");
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

async function ensureFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, "utf8");
  }
}
