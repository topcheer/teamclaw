import { TEAMCLAW_PUBLISHED_RUNTIME_IMAGE } from "./install-defaults.js";
import { DEFAULT_GITHUB_CLIENT_ID } from "./controller/github-auth.js";
// Safe value import: roles.js only pulls prompt-policy.js -> openclaw-workspace.js
// at runtime (its types.js import is type-only), so no module cycle is formed.
import { DEFAULT_ROLE } from "./roles.js";
import { validateRoleId, validateRoleIdList } from "./roles.js";
import { ROLE_IDS } from "./roles.js";
// Phase 1.6: profile-loader has no runtime edge back into this module (its
// types.js import is type-only), so the software-rd baseline id stays a
// single literal shared with the loader.
import { SOFTWARE_RD_PROFILE_ID } from "./profile-loader.js";

export type TeamClawMode = "controller" | "worker";

export type WorkerStatus = "idle" | "busy" | "offline";

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "review"
  | "completed"
  | "failed";

export type TaskPriority = "low" | "medium" | "high" | "critical";

export type TaskExecutionEventType = "lifecycle" | "progress" | "output" | "error" | "warning";

export type TaskExecutionStatus = "pending" | "running" | "completed" | "failed";

export type GitSyncMode = "shared" | "bundle" | "remote";

export type WorkerProvisioningType = "none" | "process" | "docker" | "kubernetes";

export type ProcessModel = "multi";

export type AgentIsolationMode = "independent" | "main";

export type ProvisionedWorkerStatus =
  | "launching"
  | "registered"
  | "terminating"
  | "terminated"
  | "failed";

export type ProvisioningReadinessStatus =
  | "checking"
  | "ready"
  | "degraded";

export type GitRepoState = {
  enabled: boolean;
  mode: GitSyncMode;
  defaultBranch: string;
  remoteUrl?: string;
  remoteReady: boolean;
  headCommit?: string;
  headSummary?: string;
  dirty: boolean;
  lastPreparedAt: number;
  error?: string;
};

export type RepoSyncInfo = {
  enabled: boolean;
  mode: GitSyncMode;
  defaultBranch: string;
  remoteUrl?: string;
  bundleUrl?: string;
  importUrl?: string;
  headCommit?: string;
  headSummary?: string;
};

/**
 * Phase 1.1 (vertical-team-profiles-design.md v1.3): RoleId is an open
 * branded string so future TeamProfiles can carry arbitrary role sets;
 * runtime legitimacy of a role id is enforced by validateRoleId/
 * validateRoleIdList in roles.ts (Phase 0.3), not by the compiler.
 *
 * Hybrid form ruling (design v1.3, section 1.5 errata + section 6
 * decision): TS 5.9 - the repo-locked compiler - rejects direct assignment
 * of string literals to `string & { __roleId: true }` (the #33050
 * unsoundness fix), while the role definitions in roles.ts/role-ids.ts
 * are pure JS array literals that the manifest generator regex-extracts
 * and evaluates, and their RoleId[] annotations are pinned by
 * tests/test-role-single-source.mjs. The software-rd seed ids therefore
 * stay as a literal arm; any other string must pass validateRoleId or an
 * explicit cast to enter the branded arm.
 */
export type RoleId =
  | "pm"
  | "architect"
  | "developer"
  | "qa"
  | "release-engineer"
  | "infra-engineer"
  | "devops"
  | "security-engineer"
  | "designer"
  | "marketing"
  | "data-engineer"
  | (string & { __roleId: true });

export type RoleDefinition = {
  id: RoleId;
  label: string;
  icon: string;
  description: string;
  capabilities: string[];
  recommendedSkills: string[];
  systemPrompt: string;
  suggestedNextRoles: RoleId[];
};

export type WorkerInfo = {
  id: string;
  role: RoleId;
  label: string;
  status: WorkerStatus;
  transport?: "http";
  url: string;
  lastHeartbeat: number;
  capabilities: string[];
  currentTaskId?: string;
  registeredAt: number;
};

export type TaskInfo = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedRole?: RoleId;
  assignedWorkerId?: string;
  createdBy: string;
  recommendedSkills?: string[];
  controllerRunId?: string;
  controllerSessionKey?: string;
  projectId?: string;
  projectDir?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  progress?: string;
  progressContract?: WorkerProgressContract;
  result?: string;
  resultContract?: WorkerTaskResultContract;
  error?: string;
  lastHandoff?: TaskHandoffContract;
  clarificationRequestId?: string;
  execution?: TaskExecution;
  /** Collaboration contract: read-only tasks never mutate the checkout; write tasks run in a dedicated git worktree and deliver via PR. */
  writeMode?: "read-only" | "write";
  /** Surviving progress snapshot for interrupted executions (resume support). */
  checkpoint?: TaskCheckpoint;
  resumeAttempt?: number;
};

export type TaskExecutionEvent = {
  id: string;
  type: TaskExecutionEventType;
  createdAt: number;
  message: string;
  phase?: string;
  source?: "controller" | "worker" | "subagent";
  stream?: string;
  role?: RoleId;
  workerId?: string;
};

export type TaskCheckpoint = {
  /** Epoch ms of the last checkpoint update. */
  updatedAt: number;
  /** Monotonic resume counter; controller increments on each orphan reset. */
  attempt: number;
  /** OpenClaw session key hosting the persisted conversation for this task. */
  sessionKey: string;
  /** Last assistant message observed before the interruption. */
  lastAssistantMessage: string;
  /** Human-readable notes of verified work already done (latest last). */
  progressNotes: string[];
};

export type TaskAssignmentPayload = {
  taskId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  recommendedSkills?: string[];
  projectDir?: string;
  executionSessionKey?: string;
  executionIdempotencyKey?: string;
  /** Present when this assignment resumes an interrupted execution. */
  checkpoint?: TaskCheckpoint;
  resumeAttempt?: number;
  repo?: RepoSyncInfo;
  teamContext?: {
    requirementSummary?: string;
    projectName?: string;
    requiredRoles?: RoleId[];
    activeTasks?: Array<{ id: string; title: string; assignedRole?: RoleId; status: TaskStatus; summary?: string }>;
    blockedTasks?: Array<{ id: string; title: string; assignedRole?: RoleId; status: TaskStatus; summary?: string }>;
    recentCompletedTasks?: Array<{ id: string; title: string; assignedRole?: RoleId; status: TaskStatus; summary?: string }>;
    pendingClarifications?: Array<{ question: string; blockingReason?: string }>;
    answeredClarifications?: Array<{ question: string; answer: string; answeredBy?: string; blockingReason?: string }>;
    handoffPlan?: string;
    notes?: string;
    kickoffSummary?: string;
  };
};

export type ControllerRunSource = "human" | "task_follow_up";

export type WorkerTaskResultOutcome = "completed" | "blocked" | "failed";

export type WorkerTaskResultDeliverable = {
  kind: "file" | "directory" | "command" | "artifact" | "note";
  value: string;
  summary?: string;
  artifactType?: "web-app" | "static-site" | "rest-api" | "binary" | "document";
  previewCommand?: string;
  previewCwd?: string;
  previewReadyPath?: string;
  liveUrl?: string;
};

export type DynamicPreviewRecord = {
  id: string;
  taskId: string;
  deliverableIndex: number;
  deliverableValue: string;
  targetPort: number;
  previewCommand: string;
  previewCwd: string;
  previewReadyPath: string;
  liveUrl: string;
  status: "launching" | "starting" | "healthy" | "stopped" | "failed";
  pid?: number;
  createdAt: number;
  updatedAt: number;
  lastHealthCheckAt?: number;
  lastError?: string;
};

export type WorkerTaskResultFollowUp = {
  type: "review" | "handoff" | "clarification" | "downstream-task";
  targetRole?: RoleId;
  reason: string;
};

export type WorkerTaskResultContract = {
  version: string;
  outcome: WorkerTaskResultOutcome;
  summary: string;
  deliverables: WorkerTaskResultDeliverable[];
  keyPoints: string[];
  blockers: string[];
  followUps: WorkerTaskResultFollowUp[];
  questions: string[];
  notes?: string;
  /** Reusable codebase patterns discovered during this task (consolidated into workspace memory). */
  discoveredPatterns?: string[];
};

export type WorkerProgressContract = {
  version: string;
  summary: string;
  status: "in_progress" | "review";
  currentStep?: string;
  nextStep?: string;
  blockers: string[];
};

export type TaskHandoffContract = {
  version: string;
  summary: string;
  reason: string;
  targetRole?: RoleId;
  expectedNextStep?: string;
  artifacts: string[];
};

export type TeamMessageIntent =
  | "question"
  | "announcement"
  | "handoff"
  | "review-request"
  | "review-response"
  | "update"
  | "coordination";

export type TeamMessageContract = {
  version: string;
  intent: TeamMessageIntent;
  summary: string;
  details?: string;
  requestedAction?: string;
  requestedRole?: RoleId;
  needsResponse: boolean;
  references: string[];
};

export type KickoffAssessment = {
  role: RoleId;
  needed: boolean;
  scope: string;
  suggestedTasks: string[];
  dependencies: string[];
  risks: string[];
  questions: string[];
};

export type KickoffPlan = {
  /** Complexity level determined by controller's initial analysis. */
  complexity: "simple" | "medium" | "complex";
  /** Roles invited to the kickoff meeting. */
  candidateRoles: RoleId[];
  /** Collected assessments from each role (populated after kickoff). */
  assessments: KickoffAssessment[];
  /** Whether the kickoff phase has completed. */
  completed: boolean;
  /** Optional controller summary captured after the kickoff phase. */
  summary?: string;
  /** Timestamp (ms) recording when the kickoff phase was triggered. */
  triggeredAt?: number;
};

export type ControllerManifestCreatedTask = {
  title: string;
  assignedRole?: RoleId;
  expectedOutcome: string;
};

export type ControllerManifestDeferredTask = {
  title: string;
  assignedRole?: RoleId;
  blockedBy: string;
  whenReady: string;
};

export type ControllerManifestCompletionOpportunity = {
  title: string;
  value: string;
  summary: string;
};

export type ClarificationQuestionKind = "single-select" | "multi-select" | "number" | "text";

export type ClarificationQuestionOption = {
  value: string;
  label: string;
  hint?: string;
};

export type ClarificationQuestionSchema = {
  kind: ClarificationQuestionKind;
  title: string;
  description?: string;
  required?: boolean;
  options?: ClarificationQuestionOption[];
  allowOther?: boolean;
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
};

export type ControllerOrchestrationManifest = {
  version: string;
  /** Short, filesystem-safe project name chosen by the controller (e.g. "todo-rest-api", "stripe-payment-integration"). */
  projectName?: string;
  requirementSummary: string;
  requiredRoles: RoleId[];
  clarificationsNeeded: boolean;
  clarificationQuestions: string[];
  clarificationSchemas?: ClarificationQuestionSchema[];
  createdTasks: ControllerManifestCreatedTask[];
  deferredTasks: ControllerManifestDeferredTask[];
  handoffPlan?: string;
  notes?: string;
  completionOpportunities?: ControllerManifestCompletionOpportunity[];
  /** Controller signals that the entire human requirement is fully satisfied — no more tasks or follow-ups needed. */
  requirementFullyComplete?: boolean;
  /** Team kickoff plan — populated when controller uses collaborative planning. */
  kickoffPlan?: KickoffPlan;
};

export type ControllerRunInfo = {
  id: string;
  title: string;
  sessionKey: string;
  runId?: string;
  source: ControllerRunSource;
  sourceTaskId?: string;
  sourceTaskTitle?: string;
  request: string;
  reply?: string;
  error?: string;
  projectId?: string;
  projectDir?: string;
  createdTaskIds: string[];
  manifest?: ControllerOrchestrationManifest;
  status: TaskExecutionStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  execution?: TaskExecution;
};

export type TaskExecution = {
  status: TaskExecutionStatus;
  runId?: string;
  sessionKey?: string;
  startedAt?: number;
  endedAt?: number;
  lastUpdatedAt?: number;
  events: TaskExecutionEvent[];
};

export type TaskExecutionSummary = {
  status: TaskExecutionStatus;
  runId?: string;
  startedAt?: number;
  endedAt?: number;
  lastUpdatedAt?: number;
  eventCount: number;
  lastEvent?: TaskExecutionEvent;
};

export type TaskExecutionEventInput = {
  type: TaskExecutionEventType;
  message: string;
  createdAt?: number;
  phase?: string;
  source?: "controller" | "worker" | "subagent";
  stream?: string;
  role?: RoleId;
  workerId?: string;
  runId?: string;
  sessionKey?: string;
  status?: TaskExecutionStatus;
};

export type ClarificationStatus = "pending" | "answered";

export type ClarificationRequest = {
  id: string;
  taskId: string;
  controllerRunId?: string;
  controllerSessionKey?: string;
  requestedBy: string;
  requestedByWorkerId?: string;
  requestedByRole?: RoleId;
  question: string;
  questionSchema?: ClarificationQuestionSchema;
  blockingReason: string;
  context?: string;
  status: ClarificationStatus;
  answer?: string;
  answerValue?: string;
  answerValues?: string[];
  answerNumber?: number;
  answerComment?: string;
  answeredBy?: string;
  createdAt: number;
  updatedAt: number;
  answeredAt?: number;
};

export type TeamMessage = {
  id: string;
  from: string;
  fromRole?: RoleId;
  to?: string;
  toRole?: RoleId;
  type: "direct" | "broadcast" | "review-request";
  content: string;
  contract?: TeamMessageContract;
  taskId?: string;
  createdAt: number;
};

export type ProvisionedWorkerRecord = {
  workerId: string;
  role: RoleId;
  provider: WorkerProvisioningType;
  status: ProvisionedWorkerStatus;
  launchToken: string;
  requestedAt: number;
  updatedAt: number;
  registeredAt?: number;
  idleSince?: number;
  instanceId?: string;
  instanceName?: string;
  runtimeHomeDir?: string;
  lastError?: string;
};

export type StartupProvisioningReadiness = {
  status: ProvisioningReadinessStatus;
  startedAt: number;
  checkedAt: number;
  attempts: number;
  requiredRoles: RoleId[];
  readyWorkerIds: string[];
  message?: string;
};

export type TeamProvisioningState = {
  workers: Record<string, ProvisionedWorkerRecord>;
  startupReadiness?: StartupProvisioningReadiness;
};

export type PluginConfig = {
  mode: TeamClawMode;
  port: number;
  role: RoleId;
  controllerUrl: string;
  teamName: string;
  /**
   * Phase 1.6 (vertical-team-profiles-design.md section 2.3): the team
   * profile package id. Bootstrap value for FIRST initialization only -
   * once a TeamState exists, TeamState.profileId is the single runtime
   * truth and config changes have no effect (profile switching lands in
   * Phase 2).
   */
  teamProfile: string;
  heartbeatIntervalMs: number;
  processModel: ProcessModel;
  /**
   * Optional per-role model overrides as "provider/model" strings. When set,
   * task execution for that role passes provider/model to subagent.run;
   * otherwise the teamclaw agent entry model applies.
   */
  roleModelOverrides?: Partial<Record<RoleId, string>>;
  taskTimeoutMs: number;
  gitEnabled: boolean;
  gitRemoteUrl: string;
  gitDefaultBranch: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** GitHub App OAuth client ID used by the GitHub login feature. */
  githubClientId: string;
  /**
   * GitHub App OAuth client secret. The TEAMCLAW_GITHUB_CLIENT_SECRET
   * environment variable takes precedence when set.
   */
  githubClientSecret: string;
  agentIsolationMode: AgentIsolationMode;
  workerProvisioningType: WorkerProvisioningType;
  workerProvisioningDisabled: boolean;
  workerProvisioningControllerUrl: string;
  workerProvisioningRoles: RoleId[];
  workerProvisioningMinPerRole: number;
  workerProvisioningMaxPerRole: number;
  workerProvisioningIdleTtlMs: number;
  workerProvisioningStartupTimeoutMs: number;
  workerProvisioningImage: string;
  workerProvisioningPassEnv: string[];
  workerProvisioningExtraEnv: Record<string, string>;
  workerProvisioningDockerNetwork: string;
  workerProvisioningDockerMounts: string[];
  workerProvisioningWorkspaceRoot: string;
  workerProvisioningDockerWorkspaceVolume: string;
  workerProvisioningKubernetesNamespace: string;
  workerProvisioningKubernetesContext: string;
  workerProvisioningKubernetesServiceAccount: string;
  workerProvisioningKubernetesImagePullSecrets: string[];
  workerProvisioningKubernetesWorkspacePersistentVolumeClaim: string;
  workerProvisioningKubernetesLabels: Record<string, string>;
  workerProvisioningKubernetesAnnotations: Record<string, string>;
  maxConcurrentTasks: number;
};

export type WorkerIdentity = {
  workerId: string;
  role: RoleId;
  controllerUrl: string;
  registeredAt: number;
};

export type TeamState = {
  /** Schema version for forward-compatible state migration. */
  version?: number;
  /**
   * Phase 1.6 (design section 2.3): the active TeamProfile id. Single
   * runtime truth - config teamProfile only seeds first initialization.
   * Legacy states without this field migrate to the software-rd baseline.
   */
  profileId: string;
  teamName: string;
  workers: Record<string, WorkerInfo>;
  tasks: Record<string, TaskInfo>;
  controllerRuns: Record<string, ControllerRunInfo>;
  projects: Record<string, TeamProjectInfo>;
  messages: TeamMessage[];
  clarifications: Record<string, ClarificationRequest>;
  repo?: GitRepoState;
  provisioning?: TeamProvisioningState;
  previews?: Record<string, DynamicPreviewRecord>;
  reports?: Record<string, DeliveryReportRecord>;
  createdAt: number;
  updatedAt: number;
};

export type TeamProjectInfo = {
  id: string;
  projectDir: string;
  aliases: string[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export type DeliveryReportRecord = {
  id: string;
  sessionKey: string;
  generatedAt: number;
  projectName: string;
  requirementSummary: string;
  status: "completed" | "partial" | "failed";
  taskCount: number;
  deliverableCount: number;
  previewCount: number;
};

export type DiscoveryResult = {
  name: string;
  host: string;
  port: number;
  teamName: string;
};

export type RegistrationRequest = {
  workerId: string;
  role: RoleId;
  label: string;
  url: string;
  capabilities: string[];
  launchToken?: string;
};

export type HeartbeatPayload = {
  workerId: string;
  status: WorkerStatus;
  currentTaskId?: string;
  timestamp: number;
};

function parseRoleModelOverrides(raw: unknown): Partial<Record<RoleId, string>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const result: Partial<Record<RoleId, string>> = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const roleKey = validateRoleId(key);
    if (roleKey && typeof value === "string" && value.trim()) {
      result[roleKey] = value.trim();
      hasAny = true;
    }
  }
  return hasAny ? result : undefined;
}

export function parsePluginConfig(raw: Record<string, unknown> = {}): PluginConfig {
  const mode = (typeof raw.mode === "string" && (raw.mode === "controller" || raw.mode === "worker"))
    ? raw.mode
    : "worker" as TeamClawMode;

  const port = typeof raw.port === "number" && raw.port > 0 && raw.port < 65536
    ? raw.port
    : 9527;

  const role = validateRoleId(raw.role) ?? DEFAULT_ROLE;

  const controllerUrl = typeof raw.controllerUrl === "string"
    ? raw.controllerUrl.trim()
    : "";

  const teamName = typeof raw.teamName === "string" && raw.teamName.trim()
    ? raw.teamName.trim()
    : "TeamClaw";

  // Phase 1.6: first-initialization bootstrap value. Existence of the id is
  // checked by the controller startup chain (unknown ids fall back to the
  // software-rd baseline with a warning); here we only normalize the shape.
  const teamProfile = typeof raw.teamProfile === "string" && raw.teamProfile.trim()
    ? raw.teamProfile.trim()
    : SOFTWARE_RD_PROFILE_ID;

  const heartbeatIntervalMs = typeof raw.heartbeatIntervalMs === "number" && raw.heartbeatIntervalMs >= 1000
    ? raw.heartbeatIntervalMs
    : 10000;

  const processModel = parseProcessModel(raw.processModel);

  const taskTimeoutMs = typeof raw.taskTimeoutMs === "number" && raw.taskTimeoutMs >= 1000
    ? raw.taskTimeoutMs
    : 600_000;

  const gitEnabled = typeof raw.gitEnabled === "boolean" ? raw.gitEnabled : true;

  const gitRemoteUrl = typeof raw.gitRemoteUrl === "string"
    ? raw.gitRemoteUrl.trim()
    : "";

  const gitDefaultBranch = typeof raw.gitDefaultBranch === "string" && raw.gitDefaultBranch.trim()
    ? raw.gitDefaultBranch.trim()
    : "main";

  const gitAuthorName = typeof raw.gitAuthorName === "string" && raw.gitAuthorName.trim()
    ? raw.gitAuthorName.trim()
    : "TeamClaw";

  const gitAuthorEmail = typeof raw.gitAuthorEmail === "string" && raw.gitAuthorEmail.trim()
    ? raw.gitAuthorEmail.trim()
    : "teamclaw@local";

  const githubClientId = typeof raw.githubClientId === "string" && raw.githubClientId.trim()
    ? raw.githubClientId.trim()
    : DEFAULT_GITHUB_CLIENT_ID;

  const githubClientSecret = typeof raw.githubClientSecret === "string"
    ? raw.githubClientSecret.trim()
    : "";

  const agentIsolationMode: AgentIsolationMode =
    typeof raw.agentIsolationMode === "string" && (raw.agentIsolationMode === "independent" || raw.agentIsolationMode === "main")
      ? raw.agentIsolationMode
      : "independent";

  const rawWorkerProvisioningType = parseProvisioningType(raw.workerProvisioningType);
  const workerProvisioningDisabled = raw.workerProvisioningDisabled === true;
  // Legacy local installs often persisted workerProvisioningType="none" without
  // distinguishing "manual/no provisioning" from "same-host local controller".
  // Keep an explicit escape hatch via workerProvisioningDisabled, but otherwise
  // default multi-process controllers back to process provisioning.
  const workerProvisioningType: WorkerProvisioningType =
    mode === "controller" &&
    rawWorkerProvisioningType === "none" &&
    processModel === "multi" &&
    !workerProvisioningDisabled
      ? "process"
      : rawWorkerProvisioningType;
  const workerProvisioningControllerUrl = typeof raw.workerProvisioningControllerUrl === "string"
    ? raw.workerProvisioningControllerUrl.trim()
    : "";
  const workerProvisioningRoles = parseRoleList(raw.workerProvisioningRoles);
  const workerProvisioningMinPerRole = typeof raw.workerProvisioningMinPerRole === "number" && raw.workerProvisioningMinPerRole >= 0
    ? Math.floor(raw.workerProvisioningMinPerRole)
    : 0;
  const rawProvisioningMaxPerRole = typeof raw.workerProvisioningMaxPerRole === "number" && raw.workerProvisioningMaxPerRole >= 1
    ? Math.floor(raw.workerProvisioningMaxPerRole)
    : 3;
  const workerProvisioningMaxPerRole = Math.max(rawProvisioningMaxPerRole, workerProvisioningMinPerRole);
  const workerProvisioningIdleTtlMs = typeof raw.workerProvisioningIdleTtlMs === "number" && raw.workerProvisioningIdleTtlMs >= 1000
    ? raw.workerProvisioningIdleTtlMs
    : 120_000;
  const workerProvisioningStartupTimeoutMs =
    typeof raw.workerProvisioningStartupTimeoutMs === "number" && raw.workerProvisioningStartupTimeoutMs >= 1000
      ? raw.workerProvisioningStartupTimeoutMs
      : 120_000;
  const rawWorkerProvisioningImage = typeof raw.workerProvisioningImage === "string"
    ? raw.workerProvisioningImage.trim()
    : "";
  const workerProvisioningImage = rawWorkerProvisioningImage ||
    (workerProvisioningType === "docker" || workerProvisioningType === "kubernetes"
      ? TEAMCLAW_PUBLISHED_RUNTIME_IMAGE
      : "");
  const workerProvisioningPassEnv = parseStringArray(raw.workerProvisioningPassEnv);
  const workerProvisioningExtraEnv = parseStringRecord(raw.workerProvisioningExtraEnv);
  const workerProvisioningDockerNetwork = typeof raw.workerProvisioningDockerNetwork === "string"
    ? raw.workerProvisioningDockerNetwork.trim()
    : "";
  const workerProvisioningDockerMounts = parseStringArray(raw.workerProvisioningDockerMounts);
  const rawWorkerProvisioningWorkspaceRoot = typeof raw.workerProvisioningWorkspaceRoot === "string"
    ? raw.workerProvisioningWorkspaceRoot.trim()
    : "";
  const workerProvisioningDockerWorkspaceVolume = typeof raw.workerProvisioningDockerWorkspaceVolume === "string"
    ? raw.workerProvisioningDockerWorkspaceVolume.trim()
    : "";
  const workerProvisioningKubernetesNamespace = typeof raw.workerProvisioningKubernetesNamespace === "string" &&
      raw.workerProvisioningKubernetesNamespace.trim()
    ? raw.workerProvisioningKubernetesNamespace.trim()
    : "default";
  const workerProvisioningKubernetesContext = typeof raw.workerProvisioningKubernetesContext === "string"
    ? raw.workerProvisioningKubernetesContext.trim()
    : "";
  const workerProvisioningKubernetesServiceAccount = typeof raw.workerProvisioningKubernetesServiceAccount === "string"
    ? raw.workerProvisioningKubernetesServiceAccount.trim()
    : "";
  const workerProvisioningKubernetesImagePullSecrets = parseStringArray(raw.workerProvisioningKubernetesImagePullSecrets);
  const workerProvisioningKubernetesWorkspacePersistentVolumeClaim =
    typeof raw.workerProvisioningKubernetesWorkspacePersistentVolumeClaim === "string"
      ? raw.workerProvisioningKubernetesWorkspacePersistentVolumeClaim.trim()
      : "";
  const workerProvisioningWorkspaceRoot = rawWorkerProvisioningWorkspaceRoot ||
    (workerProvisioningDockerWorkspaceVolume || workerProvisioningKubernetesWorkspacePersistentVolumeClaim
      ? "/workspace-root"
      : "");
  const workerProvisioningKubernetesLabels = parseStringRecord(raw.workerProvisioningKubernetesLabels);
  const workerProvisioningKubernetesAnnotations = parseStringRecord(raw.workerProvisioningKubernetesAnnotations);

  const rawMaxConcurrentTasks = raw.maxConcurrentTasks;
  let maxConcurrentTasks: number;
  if (rawMaxConcurrentTasks === undefined) {
    maxConcurrentTasks = 5;
  } else if (typeof rawMaxConcurrentTasks !== "number" || !Number.isInteger(rawMaxConcurrentTasks)) {
    throw new Error(`maxConcurrentTasks must be an integer between 1 and 50, got ${rawMaxConcurrentTasks}`);
  } else if (rawMaxConcurrentTasks < 1) {
    throw new Error(`maxConcurrentTasks must be an integer between 1 and 50, got ${rawMaxConcurrentTasks}`);
  } else if (rawMaxConcurrentTasks > 50) {
    throw new Error(`maxConcurrentTasks must be an integer between 1 and 50, got ${rawMaxConcurrentTasks}`);
  } else {
    maxConcurrentTasks = rawMaxConcurrentTasks;
  }

  return {
    mode,
    port,
    role,
    controllerUrl,
    teamName,
    teamProfile,
    heartbeatIntervalMs,
    processModel,
    roleModelOverrides: parseRoleModelOverrides(raw.roleModelOverrides),
    taskTimeoutMs,
    gitEnabled,
    gitRemoteUrl,
    gitDefaultBranch,
    gitAuthorName,
    gitAuthorEmail,
    githubClientId,
    githubClientSecret,
    agentIsolationMode,
    workerProvisioningType,
    workerProvisioningDisabled,
    workerProvisioningControllerUrl,
    workerProvisioningRoles,
    workerProvisioningMinPerRole,
    workerProvisioningMaxPerRole,
    workerProvisioningIdleTtlMs,
    workerProvisioningStartupTimeoutMs,
    workerProvisioningImage,
    workerProvisioningPassEnv,
    workerProvisioningExtraEnv,
    workerProvisioningDockerNetwork,
    workerProvisioningDockerMounts,
    workerProvisioningWorkspaceRoot,
    workerProvisioningDockerWorkspaceVolume,
    workerProvisioningKubernetesNamespace,
    workerProvisioningKubernetesContext,
    workerProvisioningKubernetesServiceAccount,
    workerProvisioningKubernetesImagePullSecrets,
    workerProvisioningKubernetesWorkspacePersistentVolumeClaim,
    workerProvisioningKubernetesLabels,
    workerProvisioningKubernetesAnnotations,
    maxConcurrentTasks,
  };
}

function parseRoleList(raw: unknown): RoleId[] {
  // Phase 0.3: delegates to the shared validateRoleIdList guard in roles.ts
  // (same filter + first-occurrence dedup semantics as before).
  return validateRoleIdList(raw);
}

function parseProvisioningType(raw: unknown): WorkerProvisioningType {
  return typeof raw === "string" && VALID_PROVISIONING_TYPES.includes(raw as WorkerProvisioningType)
    ? raw as WorkerProvisioningType
    : "none";
}

function parseProcessModel(raw: unknown): ProcessModel {
  return typeof raw === "string" && raw.trim() === "multi"
    ? "multi"
    : "multi";
}

function parseStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean))]
    : [];
}

function parseStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      continue;
    }
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

const VALID_PROVISIONING_TYPES: WorkerProvisioningType[] = [
  "none",
  "process",
  "docker",
  "kubernetes",
];

// Not referenced at runtime anymore: role validation goes through
// validateRoleId/validateRoleIdList in roles.ts (Phase 0.3). Phase 1.2 folds
// the former hand-written copy into the registry: the value now derives from
// roles.ts ROLE_IDS so it can never drift from the single source of truth.
const VALID_ROLES: RoleId[] = ROLE_IDS;
