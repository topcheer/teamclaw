import { Type } from "@sinclair/typebox";
import type { PluginConfig, TaskInfo, TeamState } from "../types.js";

export type ControllerToolsDeps = {
  config: PluginConfig;
  controllerUrl: string;
  getTeamState: () => TeamState | null;
};

export function createControllerTools(deps: ControllerToolsDeps) {
  const { config, controllerUrl, getTeamState } = deps;
  const baseUrl = controllerUrl;

  return [
    {
      name: "teamclaw_create_task",
      label: "Create Team Task",
      description: "Create a new task for the virtual team",
      parameters: Type.Object({
        title: Type.String({ description: "Task title" }),
        description: Type.String({ description: "Detailed task description" }),
        priority: Type.Optional(Type.String({ description: "Priority: low, medium, high, critical" })),
        assignedRole: Type.Optional(Type.String({ description: "Target role (e.g., developer, qa, architect)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const title = String(params.title ?? "");
        const description = String(params.description ?? "");
        if (!title) {
          return { content: [{ type: "text" as const, text: "title is required." }] };
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
              createdBy: "boss",
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

          return {
            content: [{
              type: "text" as const,
              text: `Task created: ${task.title} [${task.id}] [${task.priority}]${assigned}`,
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
        status: Type.Optional(Type.String({ description: "Filter by status: pending, assigned, in_progress, review, completed, failed" })),
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
      description: "Send a direct message or broadcast to team members",
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
