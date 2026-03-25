import { Type } from "@sinclair/typebox";
import type {
  ControllerOrchestrationManifest,
  PluginConfig,
  TaskInfo,
  TeamState,
} from "../types.js";
import { buildControllerNoWorkersMessage, hasOnDemandWorkerProvisioning, shouldBlockControllerWithoutWorkers } from "./controller-capacity.js";
import {
  normalizeManifestCreatedTasks,
  normalizeManifestDeferredTasks,
  normalizeManifestRoleList,
  normalizeManifestStringList,
  normalizeOptionalManifestText,
} from "./orchestration-manifest.js";
import {
  ensureTeamMessageContract,
  normalizeContractRole,
  normalizeContractStringList,
} from "../interaction-contracts.js";

export type ControllerToolsDeps = {
  config: PluginConfig;
  controllerUrl: string;
  getTeamState: () => TeamState | null;
  sessionKey?: string | null;
};

const EXECUTION_READY_BLOCKERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bdepends?\s+on\b/i, reason: "it explicitly depends on other unfinished work" },
  { pattern: /\bprerequisite\b/i, reason: "it references a prerequisite that may not be satisfied yet" },
  { pattern: /\bwait(?:ing)?\s+for\b/i, reason: "it says the work should wait for another output first" },
  { pattern: /依赖于|前置条件|前置依赖|前提条件|前序任务|上游任务/u, reason: "it explicitly mentions a predecessor dependency" },
  { pattern: /待.*完成|等待.*完成/u, reason: "it is described as work for a later phase" },
];

const ENGLISH_LATER_PHASE_CLAUSE_RE = /\b(?:after|once)\b(.+?)\b(complete|completed|ready|available|exists?)\b/i;
const ENGLISH_LATER_PHASE_DEPENDENCY_RE = /\b(?:task|tasks|service|services|module|modules|phase|phases|api|apis|interface|interfaces|review|qa|design|developer|architect|skeleton|backend|frontend|deliverable|artifact|handoff)\b/i;
const CHINESE_LATER_PHASE_CLAUSE_RE = /(.+?)(完成后|就绪后)/u;
const CHINESE_LATER_PHASE_DEPENDENCY_RE = /(?:服务|模块|任务|阶段|接口|骨架|后端|前端|设计|审查|开发|测试|架构|交付物|文档|交接)/u;
const SERVICE_NAME_RE = /\b[a-z0-9_-]+-service\b/i;
const SERVICE_NAME_GLOBAL_RE = /\b[a-z0-9_-]+-service\b/gi;
const ACTIVE_TASK_STATUSES = new Set(["pending", "assigned", "in_progress", "review", "blocked"]);
const REPO_WIDE_CODE_CHANGE_RE = /(financial-erp-backend\/|all services|all microservices|all backend services|所有服务|所有微服务|全部微服务|统一.*kafka|kafka topic|db\/migration|schema|ddl|api路径|trusted\.packages|pom\.xml|webmvcconfig|安全响应头)/i;
const DOC_ONLY_SCOPE_RE = /(文档|docs\/|api design|architecture document|设计文档|报告|report)/i;

export function createControllerTools(deps: ControllerToolsDeps) {
  const { config, controllerUrl, getTeamState, sessionKey } = deps;
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
        const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
        if (!title) {
          return { content: [{ type: "text" as const, text: "title is required." }] };
        }

        const state = getTeamState();
        if (shouldBlockControllerWithoutWorkers(config, state)) {
          return {
            content: [{
              type: "text" as const,
              text: `${buildControllerNoWorkersMessage()} Stop after reporting this block to the human.`,
            }],
          };
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
        const overlapBlocker = detectActiveTaskOverlap(title, description, state);
        if (overlapBlocker) {
          return {
            content: [{
              type: "text" as const,
              text: `Refusing to create task "${title}" because it is not execution-ready: ${overlapBlocker}. Wait for the active task to finish or narrow the new task so it does not edit the same service scope in parallel.`,
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
              controllerSessionKey: normalizedSessionKey || undefined,
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
              ? hasOnDemandWorkerProvisioning(config)
                ? " (pending - waiting for worker provisioning or an available worker)"
                : " (pending - no registered/available worker)"
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
      name: "teamclaw_submit_manifest",
      label: "Submit Controller Manifest",
      description: "Record the structured orchestration manifest for this intake run after role selection and task creation decisions are complete",
      parameters: Type.Object({
        requirementSummary: Type.String({ description: "Brief summary of the requirement the controller is orchestrating" }),
        requiredRoles: Type.Array(
          Type.String({
            description: "Exact TeamClaw role IDs required for this requirement",
          }),
        ),
        clarificationsNeeded: Type.Optional(Type.Boolean({ description: "Whether the controller still needs human clarification" })),
        clarificationQuestions: Type.Optional(
          Type.Array(Type.String({ description: "Concrete clarification questions still waiting on the human" })),
        ),
        createdTasks: Type.Optional(
          Type.Array(
                Type.Object({
                  title: Type.String({ description: "Title of an execution-ready task this controller run created or deliberately reused instead of duplicating" }),
                  assignedRole: Type.Optional(Type.String({ description: "Exact TeamClaw role ID for the created task" })),
                  expectedOutcome: Type.String({ description: "Expected deliverable/result for the created task" }),
                }),
              ),
            ),
        deferredTasks: Type.Optional(
          Type.Array(
            Type.Object({
              title: Type.String({ description: "Title of a task that should wait for later" }),
              assignedRole: Type.Optional(Type.String({ description: "Exact TeamClaw role ID for the deferred task" })),
              blockedBy: Type.String({ description: "Why this deferred task cannot be created yet" }),
              whenReady: Type.String({ description: "Condition that should become true before this deferred task is created" }),
            }),
          ),
        ),
        handoffPlan: Type.Optional(Type.String({ description: "Brief note about how workers should report progress/handoffs across this flow" })),
        notes: Type.Optional(Type.String({ description: "Additional orchestration notes for the human/controller log" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
        if (!normalizedSessionKey) {
          return {
            content: [{
              type: "text" as const,
              text: "Cannot record controller manifest because the current TeamClaw controller session key is missing.",
            }],
          };
        }

        const requirementSummary = String(params.requirementSummary ?? "").trim();
        if (!requirementSummary) {
          return { content: [{ type: "text" as const, text: "requirementSummary is required." }] };
        }

        const manifest: ControllerOrchestrationManifest = {
          version: "1.0",
          requirementSummary,
          requiredRoles: normalizeManifestRoleList(params.requiredRoles),
          clarificationsNeeded: Boolean(params.clarificationsNeeded),
          clarificationQuestions: normalizeManifestStringList(params.clarificationQuestions),
          createdTasks: normalizeManifestCreatedTasks(params.createdTasks),
          deferredTasks: normalizeManifestDeferredTasks(params.deferredTasks),
          handoffPlan: normalizeOptionalManifestText(params.handoffPlan),
          notes: normalizeOptionalManifestText(params.notes),
        };

        try {
          const res = await fetch(`${baseUrl}/api/v1/controller/manifest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionKey: normalizedSessionKey,
              manifest,
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            return { content: [{ type: "text" as const, text: `Failed to record controller manifest: ${err}` }] };
          }

          return {
            content: [{
              type: "text" as const,
              text: `Controller manifest recorded: roles=${manifest.requiredRoles.join(", ") || "none"} created=${manifest.createdTasks.length} deferred=${manifest.deferredTasks.length}`,
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
        summary: Type.Optional(Type.String({ description: "Short structured summary for this coordination message" })),
        details: Type.Optional(Type.String({ description: "Optional extra context for the receiving worker(s)" })),
        requestedAction: Type.Optional(Type.String({ description: "Concrete action expected after reading the message" })),
        needsResponse: Type.Optional(Type.Boolean({ description: "Whether this message expects a direct response" })),
        references: Type.Optional(Type.Array(Type.String({ description: "Relevant task IDs, files, or artifacts" }))),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const content = String(params.content ?? "");
        if (!content) {
          return { content: [{ type: "text" as const, text: "content is required." }] };
        }

        try {
          const normalizedTargetRole = normalizeContractRole(params.toRole);
          const endpoint = params.toRole
            ? `${baseUrl}/api/v1/messages/direct`
            : `${baseUrl}/api/v1/messages/broadcast`;
          const contract = ensureTeamMessageContract(null, {
            type: params.toRole ? "direct" : "broadcast",
            content,
            toRole: normalizedTargetRole,
            taskId: typeof params.taskId === "string" ? params.taskId : undefined,
            summary: typeof params.summary === "string" ? params.summary : undefined,
            details: typeof params.details === "string" ? params.details : undefined,
            requestedAction: typeof params.requestedAction === "string" ? params.requestedAction : undefined,
            needsResponse: typeof params.needsResponse === "boolean" ? params.needsResponse : undefined,
            references: normalizeContractStringList(params.references),
            intent: params.toRole ? undefined : "announcement",
          });

          const body: Record<string, unknown> = {
            from: "controller",
            content,
            taskId: params.taskId ?? null,
            contract,
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

  const laterPhaseBlocker = detectLaterPhasePhrase(text);
  if (laterPhaseBlocker) {
    return laterPhaseBlocker;
  }

  return null;
}

function detectLaterPhasePhrase(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const englishMatch = line.match(ENGLISH_LATER_PHASE_CLAUSE_RE);
    if (englishMatch) {
      const dependencyClause = englishMatch[1] ?? "";
      if (ENGLISH_LATER_PHASE_DEPENDENCY_RE.test(dependencyClause) || SERVICE_NAME_RE.test(dependencyClause)) {
        return "it is described as work for a later phase";
      }
    }

    const chineseMatch = line.match(CHINESE_LATER_PHASE_CLAUSE_RE);
    if (chineseMatch) {
      const dependencyClause = chineseMatch[1] ?? "";
      if (CHINESE_LATER_PHASE_DEPENDENCY_RE.test(dependencyClause) || SERVICE_NAME_RE.test(dependencyClause)) {
        return "it is described as work for a later phase";
      }
    }
  }

  return null;
}

function detectActiveTaskOverlap(title: string, description: string, state: TeamState | null): string | null {
  if (!state) {
    return null;
  }
  const scopeText = `${title}\n${description}`;
  const serviceNames = extractServiceNames(scopeText);
  const repoWideCodeChange = serviceNames.size === 0
    && REPO_WIDE_CODE_CHANGE_RE.test(scopeText)
    && !DOC_ONLY_SCOPE_RE.test(scopeText);
  if (serviceNames.size === 0 && !repoWideCodeChange) {
    return null;
  }

  const overlappingTasks = Object.values(state.tasks).filter((task) => {
    if (!ACTIVE_TASK_STATUSES.has(task.status)) {
      return false;
    }
    const taskScope = `${task.title}\n${task.description}`;
    const taskServiceNames = extractServiceNames(taskScope);
    if (serviceNames.size > 0) {
      return [...serviceNames].some((serviceName) => taskServiceNames.has(serviceName));
    }
    if (taskServiceNames.size > 0) {
      return true;
    }
    return REPO_WIDE_CODE_CHANGE_RE.test(taskScope) && !DOC_ONLY_SCOPE_RE.test(taskScope);
  });
  if (overlappingTasks.length === 0) {
    return null;
  }

  const overlappingServices = new Set<string>();
  for (const task of overlappingTasks) {
    for (const serviceName of extractServiceNames(`${task.title}\n${task.description}`)) {
      overlappingServices.add(serviceName);
    }
  }
  if (overlappingServices.size > 0) {
    return `it overlaps with active TeamClaw work on ${[...overlappingServices].slice(0, 3).join(", ")}`;
  }
  return `it overlaps with active TeamClaw repo-wide code changes (${overlappingTasks[0]?.title ?? "another active task"})`;
}

function extractServiceNames(text: string): Set<string> {
  const normalized = String(text || "");
  return new Set(
    Array.from(normalized.matchAll(SERVICE_NAME_GLOBAL_RE))
      .map((match) => String(match[0] || "").trim().toLowerCase())
      .filter(Boolean),
  );
}
