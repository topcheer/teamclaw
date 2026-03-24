import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../../api.js";
import { normalizeRecommendedSkills } from "../roles.js";
import { resolveDefaultOpenClawWorkspaceDir } from "../openclaw-workspace.js";
import type { TaskAssignmentPayload, TaskExecutionEventInput } from "../types.js";

type SkillCli = "openclaw" | "clawhub";

type CommandResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export type SkillInstallResult = {
  installed: string[];
  skipped: string[];
  failed: Array<{ skill: string; error: string }>;
  events: TaskExecutionEventInput[];
};

function truncateOutput(value: string, limit = 400): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit).trimEnd()}…`;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function isSkillSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(value) && !/\s/.test(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: error.message,
      });
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

async function detectSkillCli(workspaceDir: string): Promise<SkillCli | null> {
  const openclaw = await runCommand("openclaw", ["skills", "list", "--json"], workspaceDir);
  if (openclaw.ok) {
    return "openclaw";
  }

  const clawhub = await runCommand("clawhub", ["list"], workspaceDir);
  if (clawhub.ok) {
    return "clawhub";
  }

  return null;
}

function resolveSlugFromOpenClawSearch(requested: string, output: string): {
  slug?: string;
  summary: string;
} {
  try {
    const parsed = JSON.parse(output) as { results?: Array<{ slug?: string; displayName?: string; version?: string }> };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const summary = results.slice(0, 3).map((entry) => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const displayName = typeof entry.displayName === "string" ? entry.displayName : slug;
      const version = typeof entry.version === "string" ? `@${entry.version}` : "";
      return slug ? `${slug}${version} (${displayName})` : displayName;
    }).filter(Boolean).join("; ");

    const exact = results.find((entry) => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const displayName = typeof entry.displayName === "string" ? entry.displayName : "";
      return normalizeKey(slug) === normalizeKey(requested) || normalizeKey(displayName) === normalizeKey(requested);
    });

    return {
      slug: typeof exact?.slug === "string" ? exact.slug : undefined,
      summary: summary || "no exact ClawHub search match recorded",
    };
  } catch {
    return {
      summary: truncateOutput(output) || "search returned no structured results",
    };
  }
}

function buildInstalledSkillPath(workspaceDir: string, skillSlug: string): string {
  return path.join(workspaceDir, "skills", skillSlug);
}

export async function installRecommendedSkills(
  assignment: TaskAssignmentPayload,
  logger: PluginLogger,
): Promise<SkillInstallResult> {
  const recommendedSkills = normalizeRecommendedSkills(assignment.recommendedSkills ?? []);
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  const events: TaskExecutionEventInput[] = [];
  const installed: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ skill: string; error: string }> = [];

  if (recommendedSkills.length === 0) {
    return { installed, skipped, failed, events };
  }

  await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });

  const cli = await detectSkillCli(workspaceDir);
  if (!cli) {
    const message = "No skill installer CLI is available (expected openclaw or clawhub in PATH).";
    logger.warn(`Worker: ${message}`);
    events.push({
      type: "error",
      phase: "skills_preflight_unavailable",
      source: "worker",
      status: "running",
      message,
    });
    return {
      installed,
      skipped,
      failed: recommendedSkills.map((skill) => ({ skill, error: message })),
      events,
    };
  }

  events.push({
    type: "lifecycle",
    phase: "skills_preflight_started",
    source: "worker",
    status: "running",
    message: `Preparing ${recommendedSkills.length} recommended skill(s) via ${cli}.`,
  });

  for (const requestedSkill of recommendedSkills) {
    let resolvedSlug = isSkillSlug(requestedSkill) ? requestedSkill : undefined;
    const installedPath = resolvedSlug ? buildInstalledSkillPath(workspaceDir, resolvedSlug) : "";

    if (installedPath && await pathExists(installedPath)) {
      skipped.push(requestedSkill);
      events.push({
        type: "lifecycle",
        phase: "skill_install_skipped",
        source: "worker",
        status: "running",
        message: `Skill ${requestedSkill} is already present in the workspace.`,
      });
      continue;
    }

    if (cli === "openclaw") {
      const searchResult = await runCommand(
        "openclaw",
        ["skills", "search", requestedSkill, "--limit", "5", "--json"],
        workspaceDir,
      );
      if (searchResult.ok) {
        const resolved = resolveSlugFromOpenClawSearch(requestedSkill, searchResult.stdout);
        if (!resolvedSlug && resolved.slug) {
          resolvedSlug = resolved.slug;
        }
        events.push({
          type: "progress",
          phase: "skill_search_completed",
          source: "worker",
          status: "running",
          message: `Skill search for "${requestedSkill}": ${resolved.summary}.`,
        });
      } else {
        events.push({
          type: "error",
          phase: "skill_search_failed",
          source: "worker",
          status: "running",
          message: `Skill search failed for "${requestedSkill}": ${truncateOutput(searchResult.stderr || searchResult.stdout) || `exit ${searchResult.code}`}.`,
        });
      }
    } else {
      const searchResult = await runCommand(
        "clawhub",
        ["search", requestedSkill, "--limit", "5"],
        workspaceDir,
      );
      const searchMessage = searchResult.ok
        ? truncateOutput(searchResult.stdout) || "search completed"
        : truncateOutput(searchResult.stderr || searchResult.stdout) || `exit ${searchResult.code}`;
      events.push({
        type: searchResult.ok ? "progress" : "error",
        phase: searchResult.ok ? "skill_search_completed" : "skill_search_failed",
        source: "worker",
        status: "running",
        message: `Skill search for "${requestedSkill}": ${searchMessage}.`,
      });
    }

    if (!resolvedSlug) {
      const message = `No installable skill slug was resolved for "${requestedSkill}".`;
      failed.push({ skill: requestedSkill, error: message });
      events.push({
        type: "error",
        phase: "skill_install_failed",
        source: "worker",
        status: "running",
        message,
      });
      continue;
    }

    const installResult = cli === "openclaw"
      ? await runCommand("openclaw", ["skills", "install", resolvedSlug], workspaceDir)
      : await runCommand("clawhub", ["install", resolvedSlug, "--workdir", workspaceDir, "--dir", "skills"], workspaceDir);

    if (!installResult.ok) {
      const message = truncateOutput(installResult.stderr || installResult.stdout) || `exit ${installResult.code}`;
      failed.push({ skill: requestedSkill, error: message });
      events.push({
        type: "error",
        phase: "skill_install_failed",
        source: "worker",
        status: "running",
        message: `Failed to install ${resolvedSlug}: ${message}.`,
      });
      continue;
    }

    installed.push(resolvedSlug);
    events.push({
      type: "lifecycle",
      phase: "skill_install_completed",
      source: "worker",
      status: "running",
      message: `Installed recommended skill ${resolvedSlug}.`,
    });
  }

  events.push({
    type: failed.length > 0 ? "error" : "lifecycle",
    phase: failed.length > 0 ? "skills_preflight_partial" : "skills_preflight_completed",
    source: "worker",
    status: "running",
    message: `Skill preflight finished: ${installed.length} installed, ${skipped.length} already present, ${failed.length} failed.`,
  });

  return {
    installed,
    skipped,
    failed,
    events,
  };
}
