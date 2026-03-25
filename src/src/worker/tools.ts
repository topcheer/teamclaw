import { Type } from "@sinclair/typebox";
import {
  backfillWorkerProgressContract,
  ensureTeamMessageContract,
  normalizeContractRole,
  normalizeContractStringList,
  normalizeOptionalContractText,
  normalizeTaskHandoffContract,
  normalizeWorkerProgressContract,
  normalizeWorkerTaskResultContract,
  renderWorkerProgressText,
} from "../interaction-contracts.js";
import type { PluginConfig, WorkerIdentity } from "../types.js";

const ALLOWED_PROGRESS_STATUSES = new Set(["in_progress", "review"]);

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
        targetRole: Type.String({ description: "Exact target role ID (pm, architect, developer, qa, release-engineer, infra-engineer, devops, security-engineer, designer, marketing)" }),
        question: Type.String({ description: "The question to ask" }),
        taskId: Type.Optional(Type.String({ description: "Related task ID if any" })),
        summary: Type.Optional(Type.String({ description: "Short structured summary for this question" })),
        details: Type.Optional(Type.String({ description: "Optional extra context for the peer" })),
        requestedAction: Type.Optional(Type.String({ description: "Concrete response/action needed from the peer" })),
        references: Type.Optional(Type.Array(Type.String({ description: "Relevant task IDs, file paths, or artifact references" }))),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team. Cannot send messages." }] };
        }

        const targetRole = String(params.targetRole ?? "");
        const question = String(params.question ?? "");
        const normalizedTargetRole = normalizeContractRole(targetRole);

        if (!targetRole || !question) {
          return { content: [{ type: "text" as const, text: "targetRole and question are required." }] };
        }

        try {
          const contract = ensureTeamMessageContract(null, {
            type: "direct",
            content: question,
            toRole: normalizedTargetRole,
            taskId: typeof params.taskId === "string" ? params.taskId : undefined,
            summary: typeof params.summary === "string" ? params.summary : undefined,
            details: typeof params.details === "string" ? params.details : undefined,
            requestedAction: typeof params.requestedAction === "string" ? params.requestedAction : undefined,
            references: normalizeContractStringList(params.references),
            intent: "question",
            needsResponse: true,
          });
          const res = await fetch(`${identity.controllerUrl}/api/v1/messages/direct`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: identity.workerId,
              fromRole: identity.role,
              toRole: targetRole,
              content: question,
              taskId: params.taskId ?? null,
              contract,
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
        summary: Type.Optional(Type.String({ description: "Short structured summary for the broadcast" })),
        details: Type.Optional(Type.String({ description: "Optional extra context for the team" })),
        requestedAction: Type.Optional(Type.String({ description: "Optional action the team should take after reading this message" })),
        needsResponse: Type.Optional(Type.Boolean({ description: "Whether the broadcast expects a response from recipients" })),
        references: Type.Optional(Type.Array(Type.String({ description: "Relevant task IDs, file paths, or artifact references" }))),
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
          const contract = ensureTeamMessageContract(null, {
            type: "broadcast",
            content: message,
            taskId: typeof params.taskId === "string" ? params.taskId : undefined,
            summary: typeof params.summary === "string" ? params.summary : undefined,
            details: typeof params.details === "string" ? params.details : undefined,
            requestedAction: typeof params.requestedAction === "string" ? params.requestedAction : undefined,
            needsResponse: typeof params.needsResponse === "boolean" ? params.needsResponse : undefined,
            references: normalizeContractStringList(params.references),
            intent: "announcement",
          });
          const res = await fetch(`${identity.controllerUrl}/api/v1/messages/broadcast`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: identity.workerId,
              fromRole: identity.role,
              content: message,
              taskId: params.taskId ?? null,
              contract,
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
        targetRole: Type.String({ description: "Exact target role ID to request review from" }),
        reviewContent: Type.String({ description: "Content to review or description of what needs review" }),
        taskId: Type.String({ description: "Related task ID" }),
        summary: Type.Optional(Type.String({ description: "Short structured summary for the review request" })),
        requestedAction: Type.Optional(Type.String({ description: "Concrete review action expected from the target role" })),
        references: Type.Optional(Type.Array(Type.String({ description: "Relevant file paths, artifacts, or checks to review" }))),
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
          const contract = ensureTeamMessageContract(null, {
            type: "review-request",
            content: reviewContent,
            toRole: normalizeContractRole(targetRole),
            taskId,
            summary: typeof params.summary === "string" ? params.summary : undefined,
            requestedAction: typeof params.requestedAction === "string" ? params.requestedAction : undefined,
            references: normalizeContractStringList(params.references),
            intent: "review-request",
            needsResponse: true,
          });
          const res = await fetch(`${identity.controllerUrl}/api/v1/messages/review-request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: identity.workerId,
              fromRole: identity.role,
              toRole: targetRole,
              content: reviewContent,
              taskId,
              contract,
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
        targetRole: Type.String({ description: "Exact target role ID to hand off to" }),
        reason: Type.String({ description: "Reason for the handoff" }),
        summary: Type.Optional(Type.String({ description: "Short structured summary for the handoff" })),
        expectedNextStep: Type.Optional(Type.String({ description: "Concrete next step the receiving role should take" })),
        artifacts: Type.Optional(Type.Array(Type.String({ description: "Files, task IDs, or artifacts the next role should inspect first" }))),
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
          const contract = normalizeTaskHandoffContract(null, {
            targetRole: normalizeContractRole(targetRole),
            reason,
            summary: typeof params.summary === "string" ? params.summary : undefined,
            expectedNextStep: typeof params.expectedNextStep === "string" ? params.expectedNextStep : undefined,
            artifacts: normalizeContractStringList(params.artifacts),
          });
          const res = await fetch(`${identity.controllerUrl}/api/v1/tasks/${taskId}/handoff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fromWorkerId: identity.workerId,
              targetRole,
              reason,
              contract,
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
      name: "teamclaw_submit_result_contract",
      label: "Submit Result Contract",
      description: "Record the structured completion/blocker contract for the current task before the final worker reply is returned",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID" }),
        outcome: Type.Optional(Type.String({ description: "Outcome: completed, blocked, or failed" })),
        summary: Type.String({ description: "Short structured summary of the worker result" }),
        deliverables: Type.Optional(
          Type.Array(
            Type.Object({
              kind: Type.String({ description: "Deliverable kind: file, directory, command, artifact, or note" }),
              value: Type.String({ description: "Deliverable identifier, path, or note" }),
              summary: Type.Optional(Type.String({ description: "Optional short note about this deliverable" })),
            }),
          ),
        ),
        keyPoints: Type.Optional(Type.Array(Type.String({ description: "Important decisions, findings, or implementation notes" }))),
        blockers: Type.Optional(Type.Array(Type.String({ description: "Any unresolved blockers or risks" }))),
        followUps: Type.Optional(
          Type.Array(
            Type.Object({
              type: Type.String({ description: "Follow-up type: review, handoff, clarification, downstream-task" }),
              targetRole: Type.Optional(Type.String({ description: "Role that should handle the follow-up" })),
              reason: Type.String({ description: "Why this follow-up is needed" }),
            }),
          ),
        ),
        questions: Type.Optional(Type.Array(Type.String({ description: "Any remaining open questions" }))),
        notes: Type.Optional(Type.String({ description: "Optional extra delivery notes" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const taskId = String(params.taskId ?? "");
        if (!taskId) {
          return { content: [{ type: "text" as const, text: "taskId is required." }] };
        }

        const contract = normalizeWorkerTaskResultContract({
          version: "1.0",
          outcome: typeof params.outcome === "string" ? params.outcome : "completed",
          summary: params.summary,
          deliverables: params.deliverables,
          keyPoints: params.keyPoints,
          blockers: params.blockers,
          followUps: params.followUps,
          questions: params.questions,
          notes: params.notes,
        });
        if (!contract) {
          return { content: [{ type: "text" as const, text: "summary is required for teamclaw_submit_result_contract." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/tasks/${taskId}/result-contract`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contract, workerId: identity.workerId }),
          });
          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to submit result contract: ${res.status}` }] };
          }
          return {
            content: [{
              type: "text" as const,
              text: `Result contract recorded for ${taskId}: ${contract.outcome} / ${contract.summary}`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    },
    {
      name: "teamclaw_request_clarification",
      label: "Request Clarification",
      description: "Block the current task and send an explicit clarification question to the controller/human",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID that is blocked" }),
        question: Type.String({ description: "The exact question that must be answered before work can continue" }),
        blockingReason: Type.String({ description: "Why this task cannot proceed safely without clarification" }),
        context: Type.Optional(Type.String({ description: "Optional brief context or the specific decision that is missing" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const taskId = String(params.taskId ?? "");
        const question = String(params.question ?? "");
        const blockingReason = String(params.blockingReason ?? "");
        const context = typeof params.context === "string" ? params.context : undefined;

        if (!taskId || !question || !blockingReason) {
          return { content: [{ type: "text" as const, text: "taskId, question, and blockingReason are required." }] };
        }

        try {
          const res = await fetch(`${identity.controllerUrl}/api/v1/clarifications`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taskId,
              requestedBy: identity.workerId,
              requestedByWorkerId: identity.workerId,
              requestedByRole: identity.role,
              question,
              blockingReason,
              context,
            }),
          });

          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Failed to request clarification: ${res.status}` }] };
          }

          return { content: [{ type: "text" as const, text: "Clarification requested. The task is now blocked until a human answers." }] };
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
        progress: Type.Optional(Type.String({ description: "Progress update message" })),
        status: Type.Optional(Type.String({ description: "Optional non-terminal status: in_progress or review. Do not use completed or failed here." })),
        summary: Type.Optional(Type.String({ description: "Short structured progress summary" })),
        currentStep: Type.Optional(Type.String({ description: "What the worker is doing right now" })),
        nextStep: Type.Optional(Type.String({ description: "What the worker plans to do next" })),
        blockers: Type.Optional(Type.Array(Type.String({ description: "Any blockers slowing progress" }))),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const identity = getIdentity();
        if (!identity) {
          return { content: [{ type: "text" as const, text: "Not registered with a team." }] };
        }

        const taskId = String(params.taskId ?? "");
        const progress = typeof params.progress === "string" ? params.progress : "";
        const status = typeof params.status === "string" ? params.status : undefined;

        if (!taskId) {
          return { content: [{ type: "text" as const, text: "taskId is required." }] };
        }
        if (!progress && typeof params.summary !== "string") {
          return { content: [{ type: "text" as const, text: "progress or summary is required." }] };
        }
        if (status && !ALLOWED_PROGRESS_STATUSES.has(status)) {
          return {
            content: [{
              type: "text" as const,
              text: "status must be in_progress or review. Do not mark tasks completed or failed via teamclaw_report_progress; finish by returning the deliverable or surfacing the error.",
            }],
          };
        }

        try {
          const progressContract = normalizeWorkerProgressContract({
            version: "1.0",
            summary: typeof params.summary === "string" ? params.summary : progress,
            status,
            currentStep: params.currentStep,
            nextStep: params.nextStep,
            blockers: params.blockers,
          }) ?? backfillWorkerProgressContract(progress, status);
          const patch: Record<string, unknown> = {
            progress: renderWorkerProgressText(progressContract, progress),
          };
          if (status) {
            patch.status = status;
          }
          if (progressContract) {
            patch.progressContract = progressContract;
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
