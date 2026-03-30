/**
 * Team Kickoff Orchestrator
 *
 * Implements the "Team Kickoff Meeting" pattern: before committing to an execution
 * plan, the controller provisions candidate-role workers and asks each for a
 * structured assessment of the requirement from their professional perspective.
 *
 * Flow:
 *   1. Controller's initial LLM pass identifies complexity + candidate roles
 *   2. Controller calls `teamclaw_request_kickoff` tool
 *   3. This module provisions workers for each candidate role
 *   4. Each worker receives a kickoff assessment request (lightweight LLM call)
 *   5. Assessments are collected and returned to the controller
 *   6. Controller synthesizes team input into final execution plan
 *   7. Unneeded workers are reclaimed by the idle TTL mechanism
 */

import type { PluginLogger } from "../../api.js";
import type { KickoffAssessment, KickoffPlan, RoleId, TeamState, WorkerInfo } from "../types.js";
import { getRole, ROLES } from "../roles.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum time to wait for all workers to register after provisioning. */
const WORKER_PROVISION_TIMEOUT_MS = 90_000;

/** Maximum time to wait for a single worker's kickoff assessment. */
const ASSESSMENT_TIMEOUT_MS = 120_000;

/** Poll interval when waiting for workers to appear in state. */
const WORKER_POLL_INTERVAL_MS = 2_000;

const VALID_ROLE_IDS = new Set<string>(ROLES.map((r) => r.id));

// ── Types ────────────────────────────────────────────────────────────────────

export type KickoffOrchestratorDeps = {
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  /** Trigger provisioning for a specific role (returns immediately). */
  ensureRoleProvisioned: (role: RoleId) => Promise<void>;
  /** Send a kickoff assessment request to a worker and get the response. */
  requestWorkerAssessment: (worker: WorkerInfo, requirement: string) => Promise<KickoffAssessment>;
};

export type KickoffRequest = {
  requirement: string;
  candidateRoles: RoleId[];
  complexity: "simple" | "medium" | "complex";
};

export type KickoffResult = {
  plan: KickoffPlan;
  /** Human-readable summary of the team discussion for the controller LLM. */
  summary: string;
};

// ── Public API ───────────────────────────────────────────────────────────────

export async function runKickoffMeeting(
  request: KickoffRequest,
  deps: KickoffOrchestratorDeps,
): Promise<KickoffResult> {
  const { logger } = deps;
  const { requirement, candidateRoles, complexity } = request;

  // Validate roles
  const validRoles = candidateRoles.filter((r) => VALID_ROLE_IDS.has(r));
  if (validRoles.length === 0) {
    return buildEmptyResult(complexity, "No valid candidate roles provided.");
  }

  logger.info(`Kickoff: starting team meeting — complexity=${complexity}, candidates=[${validRoles.join(", ")}]`);

  // Phase 1: Provision all candidate role workers in parallel
  const provisionPromises = validRoles.map(async (role) => {
    try {
      await deps.ensureRoleProvisioned(role);
    } catch (err) {
      logger.warn(`Kickoff: failed to provision ${role}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  await Promise.all(provisionPromises);

  // Phase 2: Wait for workers to appear in state
  const availableWorkers = await waitForWorkers(validRoles, deps);
  if (availableWorkers.size === 0) {
    return buildEmptyResult(complexity, "No workers became available within the provisioning timeout.");
  }

  logger.info(`Kickoff: ${availableWorkers.size}/${validRoles.length} workers available — requesting assessments`);

  // Phase 3: Send assessment requests to all available workers in parallel
  const assessments: KickoffAssessment[] = [];
  const assessmentPromises = [...availableWorkers.entries()].map(async ([role, worker]) => {
    try {
      const assessment = await deps.requestWorkerAssessment(worker, requirement);
      assessment.role = role; // ensure role is set correctly
      assessments.push(assessment);
    } catch (err) {
      logger.warn(`Kickoff: assessment failed for ${role}: ${err instanceof Error ? err.message : String(err)}`);
      // Record a failed assessment so the controller knows this role didn't respond
      assessments.push({
        role,
        needed: false,
        scope: `Assessment failed: ${err instanceof Error ? err.message : String(err)}`,
        suggestedTasks: [],
        dependencies: [],
        risks: [`Could not assess — ${err instanceof Error ? err.message : "unknown error"}`],
        questions: [],
      });
    }
  });
  await Promise.all(assessmentPromises);

  // Phase 4: Build the kickoff plan
  const plan: KickoffPlan = {
    complexity,
    candidateRoles: validRoles,
    assessments,
    completed: true,
  };

  const summary = buildKickoffSummary(plan, requirement);
  logger.info(`Kickoff: team meeting complete — ${assessments.filter((a) => a.needed).length}/${assessments.length} roles needed`);

  return { plan, summary };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function waitForWorkers(
  roles: RoleId[],
  deps: KickoffOrchestratorDeps,
): Promise<Map<RoleId, WorkerInfo>> {
  const deadline = Date.now() + WORKER_PROVISION_TIMEOUT_MS;
  const result = new Map<RoleId, WorkerInfo>();

  while (Date.now() < deadline) {
    const state = deps.getTeamState();
    if (state) {
      for (const role of roles) {
        if (result.has(role)) continue;

        const worker = Object.values(state.workers).find(
          (w) => w.role === role && (w.status === "idle" || w.status === "busy"),
        );
        if (worker) {
          result.set(role, worker);
        }
      }

      if (result.size === roles.length) {
        break; // all workers found
      }
    }

    await sleep(WORKER_POLL_INTERVAL_MS);
  }

  return result;
}

function buildEmptyResult(complexity: KickoffPlan["complexity"], reason: string): KickoffResult {
  return {
    plan: {
      complexity,
      candidateRoles: [],
      assessments: [],
      completed: true,
    },
    summary: `Team kickoff could not be completed: ${reason} Proceed with controller-only planning.`,
  };
}

function buildKickoffSummary(plan: KickoffPlan, _requirement: string): string {
  const parts: string[] = [];
  parts.push(`## Team Kickoff Meeting Results (${plan.complexity} complexity)`);
  parts.push("");

  const needed = plan.assessments.filter((a) => a.needed);
  const notNeeded = plan.assessments.filter((a) => !a.needed);

  if (needed.length > 0) {
    parts.push("### Roles Confirmed Needed");
    for (const a of needed) {
      const roleDef = getRole(a.role);
      const icon = roleDef?.icon ?? "•";
      parts.push(`\n**${icon} ${roleDef?.label ?? a.role}**`);
      parts.push(`- Scope: ${a.scope}`);
      if (a.suggestedTasks.length > 0) {
        parts.push(`- Suggested tasks: ${a.suggestedTasks.join("; ")}`);
      }
      if (a.dependencies.length > 0) {
        parts.push(`- Dependencies: ${a.dependencies.join("; ")}`);
      }
      if (a.risks.length > 0) {
        parts.push(`- Risks: ${a.risks.join("; ")}`);
      }
      if (a.questions.length > 0) {
        parts.push(`- Questions: ${a.questions.join("; ")}`);
      }
    }
  }

  if (notNeeded.length > 0) {
    parts.push("");
    parts.push("### Roles Not Needed");
    for (const a of notNeeded) {
      const roleDef = getRole(a.role);
      parts.push(`- ${roleDef?.icon ?? "•"} ${roleDef?.label ?? a.role}: ${a.scope}`);
    }
  }

  parts.push("");
  parts.push("### Team Consensus");
  parts.push(`- Required roles: ${needed.map((a) => a.role).join(", ") || "none identified"}`);

  const allTasks = needed.flatMap((a) =>
    a.suggestedTasks.map((t) => `[${a.role}] ${t}`),
  );
  if (allTasks.length > 0) {
    parts.push("- Suggested task breakdown:");
    for (const t of allTasks) {
      parts.push(`  - ${t}`);
    }
  }

  const allDeps = needed.flatMap((a) => a.dependencies);
  if (allDeps.length > 0) {
    parts.push(`- Cross-role dependencies: ${[...new Set(allDeps)].join("; ")}`);
  }

  const allRisks = needed.flatMap((a) => a.risks);
  if (allRisks.length > 0) {
    parts.push(`- Team risks: ${[...new Set(allRisks)].join("; ")}`);
  }

  const allQuestions = needed.flatMap((a) => a.questions);
  if (allQuestions.length > 0) {
    parts.push(`- Unresolved questions: ${[...new Set(allQuestions)].join("; ")}`);
  }

  parts.push("");
  parts.push("Use these team assessments to create the final execution plan. Only create tasks for roles that confirmed they are needed. Respect the dependency ordering suggested by the team.");

  return parts.join("\n");
}

/**
 * Build the kickoff assessment prompt sent to a worker.
 * The worker should respond with structured JSON matching KickoffAssessment.
 */
export function buildKickoffAssessmentPrompt(role: RoleId, requirement: string): string {
  const roleDef = getRole(role);
  const roleLabel = roleDef?.label ?? role;

  return [
    `You are the ${roleLabel} in a virtual software team.`,
    `Your team is conducting a kickoff meeting for a new requirement.`,
    ``,
    `## Requirement`,
    requirement,
    ``,
    `## Your Task`,
    `Evaluate this requirement from your professional perspective as ${roleLabel}.`,
    `Respond with a JSON object (and nothing else) with these fields:`,
    ``,
    `{`,
    `  "needed": boolean,        // Is your role needed for this project?`,
    `  "scope": string,          // What would you contribute? (1-2 sentences)`,
    `  "suggestedTasks": string[], // Specific tasks you'd handle (2-5 items)`,
    `  "dependencies": string[],  // What you need from other roles before or during your work`,
    `  "risks": string[],         // Concerns or risks from your perspective`,
    `  "questions": string[]      // Clarifications you'd want before starting`,
    `}`,
    ``,
    `Guidelines:`,
    `- Be honest about whether your role is truly needed. Don't inflate your importance.`,
    `- For "needed", consider: does the project actually require ${roleLabel}-level expertise?`,
    `- A simple single-file script does NOT need an architect. A TODO app does NOT need a security engineer.`,
    `- Keep suggestedTasks concrete and actionable, not vague.`,
    `- Only list dependencies on roles that are actually relevant.`,
    `- Return ONLY the JSON object, no markdown fencing, no explanation.`,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { ASSESSMENT_TIMEOUT_MS };
