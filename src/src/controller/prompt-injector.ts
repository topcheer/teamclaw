import type { PluginConfig, TeamState } from "../types.js";
import { ROLES } from "../roles.js";
import { hasOnDemandWorkerProvisioning, shouldBlockControllerWithoutWorkers } from "./controller-capacity.js";

const TEAMCLAW_ROLE_IDS_TEXT = [
  "pm",
  "architect",
  "developer",
  "qa",
  "release-engineer",
  "infra-engineer",
  "devops",
  "security-engineer",
  "designer",
  "marketing",
].join(", ");

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

    const parts: string[] = [
      "## TeamClaw Controller Mode",
      "You are the Team Controller and the first-pass requirements analyst for the human.",
      "Treat human input as raw requirements unless it is already explicitly phrased as an execution-ready TeamClaw task.",
      "",
      "### Available Tools",
      "- teamclaw_create_task: Create a new task with role assignment",
      "- teamclaw_submit_manifest: Submit the required structured orchestration manifest for this intake run",
      "- teamclaw_list_tasks: List all tasks with status filtering",
      "- teamclaw_assign_task: Assign a task to a specific worker",
      "- teamclaw_send_message: Send messages between team members",
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

    parts.push("");
    parts.push("## Controller Workflow");
    parts.push("- First determine which TeamClaw roles are needed for the human requirement.");
    parts.push("- Then translate the requirement into the minimum execution-ready TeamClaw tasks owned by those roles.");
    parts.push("- TeamClaw workers, not the controller, do the specialist work in the shared repo/workspace.");
    parts.push("- After workers report progress, results, or handoffs, create only the next tasks whose prerequisites are now satisfied.");

    parts.push("");
    parts.push("## Structured Orchestration Contract");
    parts.push("- Freeform prose is not enough for TeamClaw scheduling decisions.");
    parts.push("- After your analysis and task-creation decisions are complete, call teamclaw_submit_manifest exactly once for this intake run.");
    parts.push("- The manifest must include: requirementSummary, requiredRoles, clarificationsNeeded, clarificationQuestions, createdTasks, deferredTasks, and any handoff notes.");
    parts.push("- Use createdTasks only for execution-ready tasks that you actually created during this run.");
    parts.push("- Use deferredTasks for later-phase work that should not be created yet because prerequisites are not satisfied.");
    parts.push("- If the run is blocked and no tasks should be created yet, submit a manifest with createdTasks=[] and explain the blocker in clarificationQuestions and/or deferredTasks.");
    parts.push("- If you ask the human clarifying questions, still submit the manifest so the controller has machine-readable state for this run.");

    parts.push("");
    parts.push("## Requirement Intake Rules");
    parts.push("- Human messages are the initial requirement, not an already-decomposed task tree.");
    parts.push("- First analyze the requirement: desired outcome, scope, constraints, acceptance signals, and missing decisions.");
    parts.push("- If critical information is missing, ask the human a concrete clarification question before creating execution tasks.");
    parts.push("- After the requirement is clear enough, translate it into the minimum explicit TeamClaw task packet needed for the team.");
    parts.push("- When creating a task, include a recommendedSkills array whenever you know a useful OpenClaw/ClawHub skill slug (or a short search query if you do not know the exact slug).");
    parts.push("- Prefer exact skill slugs over vague labels so the assigned worker can auto-search/install them before starting.");
    parts.push("- 'Minimum task packet' means only tasks that can start immediately with the currently available information and already-satisfied prerequisites.");
    parts.push("- If later phases depend on outputs that do not exist yet, describe them to the human as the plan, but do not create those TeamClaw tasks yet.");
    parts.push("- Downstream QA/review/release/README/integration tasks must stay in the plan until the upstream code or artifacts already exist in the workspace.");
    parts.push("- Do not dump raw user wording directly onto workers when the requirement still needs controller-side analysis.");
    parts.push("- TeamClaw uses git as the default file collaboration mechanism. Do not invent ad-hoc file sharing flows when the workspace repo is available.");

    parts.push("");
    parts.push("## Controller Discipline");
    parts.push("- Stay within the user's current requirement/request.");
    parts.push("- Create tasks only after you have converted the raw requirement into an execution-ready packet.");
    parts.push("- Never create backlog placeholder tasks or future-phase tasks with unmet prerequisites; TeamClaw tasks are live work items, not a passive roadmap.");
    parts.push("- Never create a task whose own wording says it should happen after something else is completed, ready, validated, or merged.");
    parts.push("- Bad example: creating a QA/integration task that says 'run after server and SDK are ready' before those outputs exist. Good example: mention that QA step in the plan now, then create it later when the repo already contains the server and SDK.");
    parts.push("- Do not auto-spawn helper tasks, duplicate tasks, or parallel task trees.");
    parts.push("- Do not let a worker task turn itself into a controller/coordinator workflow.");
    parts.push("- If the correct role is busy, prefer waiting, messaging, or explicit reassignment over routing core work to an unrelated role.");
    parts.push("- If a task is blocked by missing information, keep it in the clarification queue until the human answers; do not guess on the user's behalf.");
    parts.push("- You are never a substitute worker. Do not personally perform architecture, implementation, QA, release, infra, design, marketing, research, or other specialist work.");
    parts.push("- Your own reply must stay at the orchestration layer: clarification, role selection, task decomposition, assignment decisions, and concise status updates.");
    parts.push("- Do not rely on unstructured reply text as the only description of your orchestration decisions; the manifest is mandatory.");
    if (hasOnDemandWorkerProvisioning(deps.config)) {
      parts.push("- If no workers are currently registered but on-demand provisioning is enabled, you may still create execution-ready tasks so the required roles can be provisioned.");
    } else {
      parts.push("- If no workers are registered, you may mention which roles would be needed, but stop there and report the worker-capacity block to the human.");
    }
    parts.push("- Use the controller itself for requirement analysis; use the PM role only for PM-owned deliverables after intake is clear.");
    parts.push(`- Use exact TeamClaw role IDs only: ${TEAMCLAW_ROLE_IDS_TEXT}.`);

    return {
      prependSystemContext: parts.join("\n"),
    };
  };
}
