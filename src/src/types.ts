import { TEAMCLAW_PUBLISHED_RUNTIME_IMAGE } from "./install-defaults.js";

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

export type TaskExecutionEventType = "lifecycle" | "progress" | "output" | "error";

export type TaskExecutionStatus = "pending" | "running" | "completed" | "failed";

export type GitSyncMode = "shared" | "bundle" | "remote";

export type WorkerProvisioningType = "none" | "process" | "docker" | "kubernetes";

export type ProvisionedWorkerStatus =
  | "launching"
  | "registered"
  | "terminating"
  | "terminated"
  | "failed";

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
  | "marketing";

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
  transport?: "http" | "local";
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
  controllerSessionKey?: string;
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

export type TaskAssignmentPayload = {
  taskId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  recommendedSkills?: string[];
  repo?: RepoSyncInfo;
};

export type ControllerRunSource = "human" | "task_follow_up";

export type WorkerTaskResultOutcome = "completed" | "blocked" | "failed";

export type WorkerTaskResultDeliverable = {
  kind: "file" | "directory" | "command" | "artifact" | "note";
  value: string;
  summary?: string;
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

export type ControllerOrchestrationManifest = {
  version: string;
  requirementSummary: string;
  requiredRoles: RoleId[];
  clarificationsNeeded: boolean;
  clarificationQuestions: string[];
  createdTasks: ControllerManifestCreatedTask[];
  deferredTasks: ControllerManifestDeferredTask[];
  handoffPlan?: string;
  notes?: string;
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
  requestedBy: string;
  requestedByWorkerId?: string;
  requestedByRole?: RoleId;
  question: string;
  blockingReason: string;
  context?: string;
  status: ClarificationStatus;
  answer?: string;
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

export type TeamProvisioningState = {
  workers: Record<string, ProvisionedWorkerRecord>;
};

export type PluginConfig = {
  mode: TeamClawMode;
  port: number;
  role: RoleId;
  controllerUrl: string;
  teamName: string;
  heartbeatIntervalMs: number;
  localRoles: RoleId[];
  taskTimeoutMs: number;
  gitEnabled: boolean;
  gitRemoteUrl: string;
  gitDefaultBranch: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  workerProvisioningType: WorkerProvisioningType;
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
  workerProvisioningKubernetesWorkspacePersistentVolumeClaim: string;
  workerProvisioningKubernetesLabels: Record<string, string>;
  workerProvisioningKubernetesAnnotations: Record<string, string>;
};

export type WorkerIdentity = {
  workerId: string;
  role: RoleId;
  controllerUrl: string;
  registeredAt: number;
};

export type TeamState = {
  teamName: string;
  workers: Record<string, WorkerInfo>;
  tasks: Record<string, TaskInfo>;
  controllerRuns: Record<string, ControllerRunInfo>;
  messages: TeamMessage[];
  clarifications: Record<string, ClarificationRequest>;
  repo?: GitRepoState;
  provisioning?: TeamProvisioningState;
  createdAt: number;
  updatedAt: number;
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

export function parsePluginConfig(raw: Record<string, unknown> = {}): PluginConfig {
  const mode = (typeof raw.mode === "string" && (raw.mode === "controller" || raw.mode === "worker"))
    ? raw.mode
    : "worker" as TeamClawMode;

  const port = typeof raw.port === "number" && raw.port > 0 && raw.port < 65536
    ? raw.port
    : 9527;

  const role = typeof raw.role === "string" && VALID_ROLES.includes(raw.role as RoleId)
    ? raw.role as RoleId
    : "developer" as RoleId;

  const controllerUrl = typeof raw.controllerUrl === "string"
    ? raw.controllerUrl.trim()
    : "";

  const teamName = typeof raw.teamName === "string" && raw.teamName.trim()
    ? raw.teamName.trim()
    : "default";

  const heartbeatIntervalMs = typeof raw.heartbeatIntervalMs === "number" && raw.heartbeatIntervalMs >= 1000
    ? raw.heartbeatIntervalMs
    : 10000;

  const localRoles = parseRoleList(raw.localRoles);

  const taskTimeoutMs = typeof raw.taskTimeoutMs === "number" && raw.taskTimeoutMs >= 1000
    ? raw.taskTimeoutMs
    : 1_800_000;

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

  const workerProvisioningType = parseProvisioningType(raw.workerProvisioningType);
  const workerProvisioningControllerUrl = typeof raw.workerProvisioningControllerUrl === "string"
    ? raw.workerProvisioningControllerUrl.trim()
    : "";
  const workerProvisioningRoles = parseRoleList(raw.workerProvisioningRoles);
  const workerProvisioningMinPerRole = typeof raw.workerProvisioningMinPerRole === "number" && raw.workerProvisioningMinPerRole >= 0
    ? Math.floor(raw.workerProvisioningMinPerRole)
    : 0;
  const rawProvisioningMaxPerRole = typeof raw.workerProvisioningMaxPerRole === "number" && raw.workerProvisioningMaxPerRole >= 1
    ? Math.floor(raw.workerProvisioningMaxPerRole)
    : 1;
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

  return {
    mode,
    port,
    role,
    controllerUrl,
    teamName,
    heartbeatIntervalMs,
    localRoles,
    taskTimeoutMs,
    gitEnabled,
    gitRemoteUrl,
    gitDefaultBranch,
    gitAuthorName,
    gitAuthorEmail,
    workerProvisioningType,
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
    workerProvisioningKubernetesWorkspacePersistentVolumeClaim,
    workerProvisioningKubernetesLabels,
    workerProvisioningKubernetesAnnotations,
  };
}

function parseRoleList(raw: unknown): RoleId[] {
  return Array.isArray(raw)
    ? [...new Set(raw
        .filter((entry): entry is RoleId => typeof entry === "string" && VALID_ROLES.includes(entry as RoleId))
        .map((entry) => entry as RoleId))]
    : [];
}

function parseProvisioningType(raw: unknown): WorkerProvisioningType {
  return typeof raw === "string" && VALID_PROVISIONING_TYPES.includes(raw as WorkerProvisioningType)
    ? raw as WorkerProvisioningType
    : "none";
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

const VALID_ROLES: RoleId[] = [
  "pm", "architect", "developer", "qa",
  "release-engineer", "infra-engineer", "devops", "security-engineer",
  "designer", "marketing",
];
