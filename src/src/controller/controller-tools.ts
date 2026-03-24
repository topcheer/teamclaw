import { Type } from "@sinclair/typebox";
import type { PluginConfig, TaskInfo, TeamState } from "../types.js";

export type ControllerToolsDeps = {
  config: PluginConfig;
  controllerUrl: string;
  getTeamState: () => TeamState | null;
};

const EXECUTION_READY_BLOCKERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bdepends?\s+on\b/i, reason: "it explicitly depends on other unfinished work" },
  { pattern: /\bprerequisite\b/i, reason: "it references a prerequisite that may not be satisfied yet" },
  { pattern: /\bwait(?:ing)?\s+for\b/i, reason: "it says the work should wait for another output first" },
  { pattern: /\bafter\b.+\b(complete|completed|ready|available|exists?)\b/i, reason: "it is phrased as a later-phase task" },
  { pattern: /\bonce\b.+\b(complete|completed|ready|available|exists?)\b/i, reason: "it is phrased as a later-phase task" },
  { pattern: /依赖|前置|前提/u, reason: "it explicitly mentions a predecessor dependency" },
  { pattern: /完成后|就绪后|待.*完成|等待.*完成/u, reason: "it is described as work for a later phase" },
];

export function createControllerTools(deps: ControllerToolsDeps) {
  const { config, controllerUrl, getTeamState } = deps;
  const baseUrl = controllerUrl;

  return [
    {
      name: "teamclaw_create_task",
      label: "Create Team Task",
      description: "Create an execution-ready team task after the controller has analyzed the raw human requirement, clarified missing decisions, and confirmed the task can start immediately",
      parameters: Type.Object({
        title: Type.String({ description: "Task title" }),
        description: Type.String({ description: "Execution-ready task description with scope, expected deliverable, constraints, resolved clarifications, and no unmet predecessor dependency" }),
        priority: Type.Optional(Type.String({ description: "Priority: low, medium, high, critical" })),
        assignedRole: Type.Optional(Type.String({ description: "Exact target role ID (pm, architect, developer, qa, release-engineer, infra-engineer, devops, security-engineer, designer, marketing)" })),
        recommendedSkills: Type.Optional(
          Type.Array(
            Type.String({
              description: "Exact OpenClaw/ClawHub skill slug when known; otherwise a short skill-discovery query",
            }),
          ),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const title = String(params.title ?? "");
        const description = String(params.description ?? "");
        if (!title) {
          return { content: [{ type: "text" as const, text: "title is required." }] };
        }

        const blocker = detectExecutionReadyBlocker(description);
        if (blocker) {
          return {
            content: [{
              type: "text" as const,
              text: `Refusing to create task "${title}" because it is not execution-ready: ${blocker}. Only create tasks that can start immediately; keep downstream work in the controller plan until prerequisites are already complete.`,
            }],
          };
        }

        try {
          const res = await fetch(`${baseUrl}/api/v1/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              description,
              priority: params.priority ?? "medium",
              assignedRole: params.assignedRole ?? undefined,
              recommendedSkills: Array.isArray(params.recommendedSkills) ? params.recommendedSkills : undefined,
              createdBy: "controller",
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            return { content: [{ type: "text" as const, text: `Failed to create task: ${err}` }] };
          }

          const data = await res.json() as { task: TaskInfo };
          const task = data.task;
          const assigned = task.assignedWorkerId
            ? ` -> assigned to ${task.assignedWorkerId}`
            : task.status === "pending"
              ? " (pending - no available worker)"
              : "";
          const recommended = Array.isArray(task.recommendedSkills) && task.recommendedSkills.length > 0
            ? ` | skills: ${task.recommendedSkills.join(", ")}`
            : "";

          return {
            content: [{
              type: "text" as const,
              text: `Task created: ${task.title} [${task.id}] [${task.priority}]${assigned}${recommended}`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_list_tasks",
      label: "List Team Tasks",
      description: "List all tasks with optional status filter",
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: "Filter by status: pending, assigned, in_progress, review, blocked, completed, failed" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const status = typeof params.status === "string" ? params.status : undefined;

        try {
          const url = new URL(`${baseUrl}/api/v1/tasks`);
          if (status) url.searchParams.set("status", status);
          const res = await fetch(url.toString());
          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to list tasks: ${res.status}` }] };
          }

          const data = await res.json() as { tasks: TaskInfo[] };
          if (data.tasks.length === 0) {
            return { content: [{ type: "text" as const, text: "No tasks found." }] };
          }

          const lines = data.tasks.map((t) => {
            const assignee = t.assignedWorkerId ? ` -> ${t.assignedWorkerId.slice(0, 8)}` : "";
            return `[${t.status}] ${t.priority.toUpperCase()} ${t.title} (${t.id})${assignee}`;
          });

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_assign_task",
      label: "Assign Team Task",
      description: "Assign a task to a specific worker or let the router decide",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID to assign" }),
        workerId: Type.Optional(Type.String({ description: "Specific worker ID (omit for auto-routing)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const taskId = String(params.taskId ?? "");
        if (!taskId) {
          return { content: [{ type: "text" as const, text: "taskId is required." }] };
        }

        try {
          const body: Record<string, unknown> = {};
          if (params.workerId) body.workerId = params.workerId;

          const res = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/assign`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            const err = await res.text();
            return { content: [{ type: "text" as const, text: `Failed to assign task: ${err}` }] };
          }

          const data = await res.json() as { task: TaskInfo; worker?: { id: string; label: string } };
          const worker = data.worker;
          const workerInfo = worker ? ` assigned to ${worker.label} (${worker.id})` : " (no available worker)";
          return { content: [{ type: "text" as const, text: `Task assigned: ${data.task.title}${workerInfo}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_send_message",
      label: "Send Team Message",
      description: "Send a direct message or broadcast to team members after requirement analysis when coordination is actually needed",
      parameters: Type.Object({
        content: Type.String({ description: "Message content" }),
        toRole: Type.Optional(Type.String({ description: "Target role for direct message (omit for broadcast)" })),
        taskId: Type.Optional(Type.String({ description: "Related task ID" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const content = String(params.content ?? "");
        if (!content) {
          return { content: [{ type: "text" as const, text: "content is required." }] };
        }

        try {
          const endpoint = params.toRole
            ? `${baseUrl}/api/v1/messages/direct`
            : `${baseUrl}/api/v1/messages/broadcast`;

          const body: Record<string, unknown> = {
            from: "controller",
            content,
            taskId: params.taskId ?? null,
          };
          if (params.toRole) body.toRole = params.toRole;

          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to send message: ${res.status}` }] };
          }

          const data = await res.json() as { status: string; recipients?: number };
          if (params.toRole) {
            return { content: [{ type: "text" as const, text: `Message sent to ${params.toRole}: ${data.status}` }] };
          }
          return { content: [{ type: "text" as const, text: `Broadcast sent to ${data.recipients ?? 0} recipients` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
  ];
}

function detectExecutionReadyBlocker(description: string): string | null {
  const text = description.trim();
  if (!text) {
    return null;
  }

  for (const blocker of EXECUTION_READY_BLOCKERS) {
    if (blocker.pattern.test(text)) {
      return blocker.reason;
    }
  }

  return null;
}
