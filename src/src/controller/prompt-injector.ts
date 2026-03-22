import type { PluginConfig, TeamState } from "../types.js";
import { ROLES } from "../roles.js";

export type ControllerPromptDeps = {
  config: PluginConfig;
  getTeamState: () => TeamState | null;
};

export function createControllerPromptInjector(deps: ControllerPromptDeps) {
  return () => {
    const state = deps.getTeamState();
    if (!state) return null;

    const workers = Object.values(state.workers);
    const tasks = Object.values(state.tasks);
    const pendingTasks = tasks.filter((t) => t.status === "pending");
    const activeTasks = tasks.filter((t) => t.status === "in_progress" || t.status === "assigned");
    const completedTasks = tasks.filter((t) => t.status === "completed");

    const parts: string[] = [
      "## TeamClaw Controller Mode",
      "You are the Team Controller. You manage a virtual software team with the following capabilities:",
      "",
      "### Available Tools",
      "- teamclaw_create_task: Create a new task with role assignment",
      "- teamclaw_list_tasks: List all tasks with status filtering",
      "- teamclaw_assign_task: Assign a task to a specific worker",
      "- teamclaw_send_message: Send messages between team members",
      "",
      "### Current Team Status",
    ];

    if (workers.length === 0) {
      parts.push("- No workers registered yet");
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
    parts.push(`- Pending: ${pendingTasks.length} | Active: ${activeTasks.length} | Completed: ${completedTasks.length}`);

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
      parts.push(`- ${role.icon} ${role.label}: ${role.description}`);
    }

    return {
      prependSystemContext: parts.join("\n"),
    };
  };
}
