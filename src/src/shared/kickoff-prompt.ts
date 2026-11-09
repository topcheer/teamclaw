// Shared contracts layer (issue #226, W3): the kickoff assessment prompt
// builder, lifted verbatim from controller/kickoff-orchestrator.ts. The
// worker builds this prompt when it answers a kickoff assessment request
// (worker/worker-service.ts), so the prompt contract must live in the shared
// layer — worker must never import the controller tree. Pure function: its
// only dependencies are the RoleId type and the active-profile role lookup,
// both root-level modules, so the move drags in zero controller code.
import type { RoleId } from "../types.js";
import { getActiveRole } from "../profile-loader.js";

/**
 * Build the kickoff assessment prompt sent to a worker.
 * The worker should respond with structured JSON matching KickoffAssessment.
 */
export function buildKickoffAssessmentPrompt(role: RoleId, requirement: string): string {
  const roleDef = getActiveRole(role);
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
