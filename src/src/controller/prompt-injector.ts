import type { PluginConfig, TeamState } from "../types.js";
import { ROLES } from "../roles.js";
import {
  buildControllerCompletionRules,
  buildControllerDisciplineRules,
  buildControllerEvidenceMemoryRules,
  buildControllerIntakeRules,
  buildControllerStructuredContractRules,
  buildControllerToolRules,
  buildControllerWorkflowRules,
  composePrompt,
} from "../prompt-policy.js";
import { hasOnDemandWorkerProvisioning, shouldBlockControllerWithoutWorkers } from "./controller-capacity.js";
import { resolveTeamClawWorkspaceDir } from "../workspace-browser.js";
import fs from "node:fs";
import path from "node:path";

export type ControllerPromptDeps = {
  config: PluginConfig;
  getTeamState: () => TeamState | null;
};

export function createControllerPromptInjector(deps: ControllerPromptDeps) {
  return () => {
    const state = deps.getTeamState();
    const workers = Object.values(state?.workers ?? {});
    const tasks = Object.values(state?.tasks ?? {});
    const pendingTasks = tasks.filter((t) => t.status === "pending");
    const activeTasks = tasks.filter((t) => t.status === "in_progress" || t.status === "assigned");
    const blockedTasks = tasks.filter((t) => t.status === "blocked");
    const completedTasks = tasks.filter((t) => t.status === "completed");
    const pendingClarifications = Object.values(state?.clarifications ?? {}).filter((c) => c.status === "pending");
    const canProvisionWithoutWorkers = hasOnDemandWorkerProvisioning(deps.config);

    const parts: string[] = [
      "## TeamClaw Controller Mode",
      "You are the Team Controller and the first-pass requirements analyst for the human.",
      "Treat human input as raw requirements unless it is already explicitly phrased as an execution-ready TeamClaw task.",
      ...buildControllerToolRules(),
      "",
      "### Current Team Status",
    ];

    if (!state) {
      parts.push("- Team state is not loaded yet; treat this as a fresh controller intake and establish execution-ready tasks from the human requirement.");
    } else if (workers.length === 0) {
      if (shouldBlockControllerWithoutWorkers(deps.config, state)) {
        parts.push("- No workers are registered and on-demand provisioning is disabled.");
        parts.push("- Blocking rule: you may analyze the requirement and identify the needed roles, but do not create TeamClaw tasks yet.");
        parts.push("- Do not start doing the worker-role work yourself. Tell the human to bring workers online or enable process/docker/kubernetes provisioning first.");
      } else {
        parts.push("- No workers are registered yet, but on-demand provisioning is enabled.");
        parts.push("- You may still create execution-ready TeamClaw tasks for the required roles; the controller will provision workers on demand.");
      }
    } else {
      for (const w of workers) {
        const roleDef = ROLES.find((r) => r.id === w.role);
        const statusIcon = w.status === "idle" ? "[idle]" : w.status === "busy" ? "[busy]" : "[offline]";
        const currentTask = w.currentTaskId ? ` (task: ${w.currentTaskId})` : "";
        parts.push(`- ${roleDef?.icon ?? ""} ${w.label} (${w.id}) ${statusIcon}${currentTask}`);
      }
    }

    parts.push("");
    parts.push(`### Tasks Summary`);
    parts.push(`- Pending: ${pendingTasks.length} | Active: ${activeTasks.length} | Blocked: ${blockedTasks.length} | Completed: ${completedTasks.length}`);

    if (pendingClarifications.length > 0) {
      parts.push("");
      parts.push("Pending clarification requests:");
      for (const clarification of pendingClarifications.slice(0, 10)) {
        parts.push(`- Task ${clarification.taskId}: ${clarification.question}`);
      }
    }

    if (pendingTasks.length > 0) {
      parts.push("");
      parts.push("Pending tasks:");
      for (const t of pendingTasks.slice(0, 10)) {
        parts.push(`- [${t.priority}] ${t.title} (role: ${t.assignedRole ?? "any"})`);
      }
    }

    parts.push("");
    parts.push("### Available Roles");
    for (const role of ROLES) {
      const skillLine = role.recommendedSkills.length > 0
        ? ` Recommended skills: ${role.recommendedSkills.join(", ")}.`
        : "";
      parts.push(`- ${role.icon} ${role.label}: ${role.description}.${skillLine}`);
    }

    // List existing projects so the controller can distinguish new vs. existing
    parts.push("");
    parts.push("### Existing Projects in Workspace");
    const existingProjects = listExistingProjects(state);
    if (existingProjects.length === 0) {
      parts.push("- No existing projects yet.");
    } else {
      for (const proj of existingProjects) {
        parts.push(`- 📂 ${proj.dir}: ${proj.summary}`);
      }
    }

    parts.push("");
    parts.push("## New vs. Existing Project Detection");
    parts.push("- Before creating tasks, determine if the user's request relates to an existing project listed above.");
    parts.push("- If the request mentions a technology, feature, or project name that matches an existing project, treat it as an enhancement/bugfix for that project — reuse the same projectDir.");
    parts.push("- If the request is clearly a new, unrelated requirement, create a fresh projectDir with a new projectName.");
    parts.push("- When enhancing an existing project, include context about what already exists so the worker can extend rather than rebuild.");
    parts.push("- NEVER let a worker's deliverables reference files from a different project. Each task's deliverables must be scoped to its own projectDir.");

    parts.push(...buildControllerWorkflowRules());

    parts.push("");
    parts.push("## Team Kickoff Meeting (Collaborative Planning)");
    parts.push("- **IMPORTANT**: When the requirement involves 3 or more roles, you MUST call teamclaw_request_kickoff as your FIRST tool call, BEFORE creating any tasks.");
    parts.push("- The kickoff provisions candidate role workers and asks each for a structured assessment from their professional perspective.");
    parts.push("- Each role evaluates: whether they're needed, their scope of work, suggested tasks, dependencies on other roles, risks, and open questions.");
    parts.push("- Use the team's assessments to make informed decisions about which roles to actually involve and how to structure the task pipeline.");
    parts.push("- Roles that assessed themselves as not needed will be automatically reclaimed after their idle timeout.");
    parts.push("- Adaptive kickoff rules:");
    parts.push("  - **Simple** (single clear task, 1 role): Skip kickoff, create task directly.");
    parts.push("  - **Medium** (2-3 roles likely): Call kickoff with the 2-3 most relevant roles.");
    parts.push("  - **Complex** (4+ potential roles, multi-domain, unclear scope): ALWAYS call kickoff with all candidate roles. Do NOT skip.");
    parts.push("- For task_follow_up runs (triggered by completed tasks), do NOT call kickoff again — the team plan was already established.");
    parts.push("- Example: 'Build an e-commerce platform' → complex (architect+developer+designer+qa+security) → MUST call teamclaw_request_kickoff first");

    parts.push("");
    parts.push("## Out-of-Scope Requests");
    parts.push("- TeamClaw is a software development team. You handle: coding, architecture, design, testing, deployment, documentation, security review, and related technical work.");
    parts.push("- Do not infer that the user lacks rights to work on a codebase just because it contains binaries, bundles, minified code, generated artifacts, proprietary branding, or unusual repository structure. Unless the user explicitly states a restriction, keep the decision technical rather than ownership-based.");
    parts.push("- If the human asks for something clearly non-technical (cooking, weather, personal advice, general knowledge, creative writing unrelated to software), politely decline in your reply text AND still call teamclaw_submit_manifest with createdTasks=[], requiredRoles=[], and requirementSummary explaining why you declined.");
    parts.push("- If the request is borderline (e.g. 'write a blog post about our API'), lean toward accepting it and assigning to the appropriate role (marketing, pm).");
    parts.push("- REMEMBER: You must ALWAYS call teamclaw_submit_manifest, even when declining. The system cannot record your decision without it.");

    parts.push("");
    parts.push("## Clarification & Follow-up Awareness");
    parts.push("- If this session has prior messages where you asked clarification questions, the human's new message is likely a response to those questions.");
    parts.push("- Do NOT treat a follow-up human message as a brand-new requirement if there are pending clarification questions in this session. Instead, interpret the message as an answer and proceed with task creation.");
    parts.push("- If the human's follow-up is clearly irrelevant to the pending questions (e.g. random chitchat), acknowledge it briefly and re-state the pending questions so the human knows what you still need.");
    parts.push("- For automatic task_follow_up runs (triggered by task completion), focus on advancing the pipeline — do not re-ask questions already answered.");

    parts.push("");
    parts.push("## Deliverable Presentation");
    parts.push("- When a task completes with a result contract, review the deliverables and present a clear, actionable summary to the human.");
    parts.push("- For web applications: include the preview URL if available (deliverable.liveUrl). The human should be able to click and verify.");
    parts.push("- For CLI tools: include the command to run with example arguments.");
    parts.push("- For documents: highlight the key decisions or structure.");
    parts.push("- When ALL tasks for the requirement are complete (requirementFullyComplete=true), provide a final delivery summary:");
    parts.push("  - What was built (1-2 sentence overview)");
    parts.push("  - How to access/run it (URLs, commands)");
    parts.push("  - File locations (project directory)");
    parts.push("  - Any caveats or next steps");

    parts.push(...buildControllerStructuredContractRules());
    parts.push(...buildControllerEvidenceMemoryRules());
    parts.push(...buildControllerIntakeRules());
    parts.push(...buildControllerDisciplineRules({ canProvisionWithoutWorkers }));
    parts.push(...buildControllerCompletionRules());

    return {
      prependSystemContext: composePrompt(parts),
    };
  };
}

type ExistingProjectInfo = { dir: string; summary: string };

function listExistingProjects(state: TeamState | null): ExistingProjectInfo[] {
  const projects: ExistingProjectInfo[] = [];

  const seenDirs = new Set<string>();
  if (state) {
    for (const project of Object.values(state.projects ?? {})) {
      if (project.projectDir && !seenDirs.has(project.projectDir)) {
        seenDirs.add(project.projectDir);
        const aliases = project.aliases.filter(Boolean);
        const aliasSummary = aliases.length > 0 ? `aliases: ${aliases.join(", ")}` : "";
        const summary = [project.summary, aliasSummary].filter(Boolean).join(" | ") || "(registered project)";
        projects.push({ dir: project.projectDir, summary });
      }
    }
    for (const task of Object.values(state.tasks)) {
      if (task.projectDir && !seenDirs.has(task.projectDir)) {
        seenDirs.add(task.projectDir);
        const summary = task.resultContract?.summary ?? task.title;
        projects.push({ dir: task.projectDir, summary });
      }
    }
  }

  // Also scan the filesystem for project directories not tracked in state
  try {
    const workspaceDir = resolveTeamClawWorkspaceDir();
    const projectsRoot = path.join(workspaceDir, "projects");
    if (fs.existsSync(projectsRoot)) {
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const fullDir = `projects/${entry.name}`;
          if (!seenDirs.has(entry.name) && !seenDirs.has(fullDir)) {
            seenDirs.add(fullDir);
            projects.push({ dir: fullDir, summary: "(discovered on filesystem)" });
          }
        }
      }
    }
  } catch {
    // Workspace not available — skip filesystem scan
  }

  return projects.slice(0, 20);
}
