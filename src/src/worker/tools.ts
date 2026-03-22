import { Type } from "@sinclair/typebox";
import type { PluginConfig, WorkerIdentity } from "../types.js";

export type WorkerToolsDeps = {
  config: PluginConfig;
  getIdentity: () => WorkerIdentity | null;
};

export function createWorkerTools(deps: WorkerToolsDeps) {
  const { config, getIdentity } = deps;

  return [
    {
      name: "teamclaw_ask_peer",
      label: "Ask Team Peer",
      description: "Send a question to another team member by role",
      parameters: Type.Object({
        targetRole: Type.String({ description: "Target role (e.g., architect, qa, pm)" }),
        question: Type.String({ description: "The question to ask" }),
        taskId: Type.Optional(Type.String({ description: "Related task ID if any" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team. Cannot send messages." }] };
        }

        const targetRole = String(params.targetRole ?? "");
        const question = String(params.question ?? "");

        if (!targetRole || !question) {
          return { content: [{ type: "text" as const, text: "targetRole and question are required." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/messages/direct`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: identity.workerId,
              fromRole: identity.role,
              toRole: targetRole,
              content: question,
              taskId: params.taskId ?? null,
            }),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to send message: ${res.status}` }] };
          }

          return { content: [{ type: "text" as const, text: `Message sent to ${targetRole}.` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_broadcast",
      label: "Broadcast to Team",
      description: "Send a message to all team members",
      parameters: Type.Object({
        message: Type.String({ description: "The message to broadcast" }),
        taskId: Type.Optional(Type.String({ description: "Related task ID if any" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const message = String(params.message ?? "");
        if (!message) {
          return { content: [{ type: "text" as const, text: "message is required." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/messages/broadcast`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: identity.workerId,
              fromRole: identity.role,
              content: message,
              taskId: params.taskId ?? null,
            }),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to broadcast: ${res.status}` }] };
          }

          return { content: [{ type: "text" as const, text: "Broadcast sent to all team members." }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_request_review",
      label: "Request Review",
      description: "Request a review from a specific role (e.g., qa for testing, architect for design review)",
      parameters: Type.Object({
        targetRole: Type.String({ description: "Role to request review from" }),
        reviewContent: Type.String({ description: "Content to review or description of what needs review" }),
        taskId: Type.String({ description: "Related task ID" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const targetRole = String(params.targetRole ?? "");
        const reviewContent = String(params.reviewContent ?? "");
        const taskId = String(params.taskId ?? "");

        if (!targetRole || !reviewContent) {
          return { content: [{ type: "text" as const, text: "targetRole and reviewContent are required." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/messages/review-request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: identity.workerId,
              fromRole: identity.role,
              toRole: targetRole,
              content: reviewContent,
              taskId,
            }),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to request review: ${res.status}` }] };
          }

          return { content: [{ type: "text" as const, text: `Review request sent to ${targetRole}.` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_suggest_handoff",
      label: "Suggest Handoff",
      description: "Suggest handing off the current task to another role",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID to hand off" }),
        targetRole: Type.String({ description: "Role to hand off to" }),
        reason: Type.String({ description: "Reason for the handoff" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const taskId = String(params.taskId ?? "");
        const targetRole = String(params.targetRole ?? "");
        const reason = String(params.reason ?? "");

        if (!taskId || !targetRole) {
          return { content: [{ type: "text" as const, text: "taskId and targetRole are required." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/tasks/${taskId}/handoff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fromWorkerId: identity.workerId,
              targetRole,
              reason,
            }),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to suggest handoff: ${res.status}` }] };
          }

          return { content: [{ type: "text" as const, text: `Handoff suggested to ${targetRole}.` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_get_team_status",
      label: "Get Team Status",
      description: "Get current team status including all workers and tasks",
      parameters: Type.Object({}),
      async execute(_id: string) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/team/status`);
          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to get status: ${res.status}` }] };
          }
          const data = await res.json() as Record<string, unknown>;
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_report_progress",
      label: "Report Progress",
      description: "Report progress on an assigned task",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID" }),
        progress: Type.String({ description: "Progress update message" }),
        status: Type.Optional(Type.String({ description: "New status: in_progress, review, completed, failed" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const taskId = String(params.taskId ?? "");
        const progress = String(params.progress ?? "");

        if (!taskId) {
          return { content: [{ type: "text" as const, text: "taskId is required." }] };
        }

        try {
          const patch: Record<string, unknown> = { progress };
          if (params.status) {
            patch.status = params.status;
          }

          const res = await fetch(`${identity.controllerUrl}/api/v1/tasks/${taskId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to report progress: ${res.status}` }] };
          }

          return { content: [{ type: "text" as const, text: "Progress reported." }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
  ];
}
