export type TeamClawMode = "controller" | "worker";

export type WorkerStatus = "idle" | "busy" | "offline";

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "review"
  | "completed"
  | "failed";

export type TaskPriority = "low" | "medium" | "high" | "critical";

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
  systemPrompt: string;
  suggestedNextRoles: RoleId[];
};

export type WorkerInfo = {
  id: string;
  role: RoleId;
  label: string;
  status: WorkerStatus;
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
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  progress?: string;
  result?: string;
  error?: string;
};

export type TeamMessage = {
  id: string;
  from: string;
  fromRole?: RoleId;
  to?: string;
  toRole?: RoleId;
  type: "direct" | "broadcast" | "review-request";
  content: string;
  taskId?: string;
  createdAt: number;
};

export type PluginConfig = {
  mode: TeamClawMode;
  port: number;
  role: RoleId;
  controllerUrl: string;
  teamName: string;
  heartbeatIntervalMs: number;
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
  messages: TeamMessage[];
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

  return { mode, port, role, controllerUrl, teamName, heartbeatIntervalMs };
}

const VALID_ROLES: RoleId[] = [
  "pm", "architect", "developer", "qa",
  "release-engineer", "infra-engineer", "devops", "security-engineer",
  "designer", "marketing",
];
