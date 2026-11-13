// W1 of issue #226 (worker-provisioning god-file split): worker config
// synthesis, controller auth-profile copy and the no-proxy env builder,
// extracted VERBATIM from controller/worker-provisioning.ts (zero behavior
// change; only the functions consumed by the facade / process backend gained
// an `export`). This module never imports worker-provisioning.ts or the
// provisioning backends - dependency direction is one-way into it.
import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import type { PluginConfig, RoleId, WorkerProvisioningType } from "../types.js";
import {
  resolveDefaultOpenClawConfigPath,
  resolveDefaultOpenClawStateDir,
  resolveDefaultAgentDir,
  resolveTeamClawAgentDir,
  resolveTeamClawAgentWorkspaceRootDir,
  TEAMCLAW_AGENT_ID,
} from "../openclaw-workspace.js";
import { cloneJson, pathExists, sanitizePathSegment } from "../shared/utils.js";
import os from "node:os";
import fsSync from "node:fs";

/**
 * #task-stuck (13th layer): resolve the teamclaw entry the CONTROLLER is
 * actually loading, so process workers can plugins.load the same physical
 * path. Discovery order: openclaw npm projects generation dirs (newest
 * mtime wins - that is what the host loaded), then the global node_modules
 * install. Returns undefined when nothing resolvable exists.
 */
function resolveControllerTeamclawEntry(): string | undefined {
  const candidates: string[] = [];
  const home = process.env.OPENCLAW_HOME?.trim() || process.env.HOME?.trim() || os.homedir();
  const projectsDir = path.join(home, ".openclaw", "npm", "projects");
  try {
    for (const proj of fsSync.readdirSync(projectsDir)) {
      if (!proj.startsWith("teamclaws-teamclaw")) continue;
      candidates.push(
        path.join(projectsDir, proj, "node_modules", "@teamclaws", "teamclaw", "dist", "index.js"),
      );
    }
  } catch { /* no projects dir */ }
  candidates.push(
    "/opt/homebrew/lib/node_modules/@teamclaws/teamclaw/dist/index.js",
    "/usr/local/lib/node_modules/@teamclaws/teamclaw/dist/index.js",
  );
  let best: { p: string; m: number } | undefined;
  for (const p of candidates) {
    try {
      const m = fsSync.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    } catch { /* candidate absent */ }
  }
  return best?.p;
}

export function buildProvisionedWorkerConfig(
  baseConfig: Record<string, unknown>,
  controllerConfig: PluginConfig,
  spec: {
    role: RoleId;
    controllerUrl: string;
    workerPort: number;
    gatewayPort: number;
    workspaceDir?: string;
  },
): Record<string, unknown> {
  const config = cloneJson(baseConfig);
  delete config.channels;
  const agents = ensureRecord(config.agents);
  const agentDefaults = ensureRecord(agents.defaults);
  delete agentDefaults.repoRoot;
  if (spec.workspaceDir) {
    agentDefaults.workspace = spec.workspaceDir;
  } else {
    delete agentDefaults.workspace;
  }
  // The host controller may run a newer openclaw that persists the keyed
  // agents.entries schema (e.g. agents.entries.teamclaw.model written by the
  // model-configuration feature). Provisioned workers can run an older
  // openclaw that rejects unknown agents keys ("Unrecognized key: entries"),
  // so fold the teamclaw entry's model back into the legacy
  // agents.defaults.model and drop the entries map. New-schema workers also
  // accept agents.defaults, keeping the folded config compatible both ways.
  const agentsRecord = agents as {
    entries?: Record<string, { model?: string }>;
  };
  if (agentsRecord.entries && typeof agentsRecord.entries === "object") {
    const entryModel = agentsRecord.entries[TEAMCLAW_AGENT_ID]?.model;
    if (entryModel && !agentDefaults.model) {
      agentDefaults.model = entryModel;
    }
    // Container backends may run older openclaw runtimes that reject the
    // keyed agents schema ("Unrecognized key: entries") - fold down to
    // legacy defaults there. Process workers share the controller's own
    // runtime, which REQUIRES at least one entry ("agents.entries must
    // contain at least one configured agent" crash-loop, exit 78, observed
    // 2026-11-03 when entries was deleted unconditionally) - keep only the
    // teamclaw worker entry for them.
    const containerized =
      controllerConfig.workerProvisioningType === "docker" ||
      controllerConfig.workerProvisioningType === "kubernetes";
    if (containerized) {
      delete agentsRecord.entries;
    } else {
      agentsRecord.entries = {
        [TEAMCLAW_AGENT_ID]: agentsRecord.entries[TEAMCLAW_AGENT_ID] ?? {},
      };
      // Pruning entries can dangle defaults.heartbeat.agentId /
      // defaults.systemAgent.agentId ("main" no longer exists in the worker
      // config) - remap any dangling agentId reference to the surviving
      // teamclaw entry.
      for (const sectionKey of Object.keys(agentDefaults)) {
        const section = (agentDefaults as Record<string, unknown>)[sectionKey];
        if (
          section &&
          typeof section === "object" &&
          typeof (section as { agentId?: unknown }).agentId === "string" &&
          !agentsRecord.entries[(section as { agentId: string }).agentId]
        ) {
          (section as { agentId: string }).agentId = TEAMCLAW_AGENT_ID;
        }
      }
    }
  }
  agents.defaults = agentDefaults;
  config.agents = agents;

  const gateway = ensureRecord(config.gateway);
  gateway.mode = "local";
  // Workers running inside Docker/K8s containers must bind on all
  // interfaces so the controller (in a sibling container) can reach them.
  gateway.bind =
    controllerConfig.workerProvisioningType === "docker" ||
    controllerConfig.workerProvisioningType === "kubernetes"
      ? "lan"
      : "loopback";
  gateway.port = spec.gatewayPort;
  delete gateway.remote;
  config.gateway = gateway;

  const plugins = ensureRecord(config.plugins);
  plugins.enabled = true;
  if (controllerConfig.workerProvisioningType === "docker" || controllerConfig.workerProvisioningType === "kubernetes") {
    delete plugins.load;
  }
  // #task-stuck (2026-11-13, 13th layer): a PROCESS worker sandbox has NO
  // local teamclaw installation (no extensions dir, no npm registration),
  // and entries.enabled alone does not make the host resolve the plugin -
  // the worker gateway booted as bare openclaw (plugins: anthropic,
  // memory-core) and never registered with the controller, so pending
  // tasks sat unclaimed forever. Point plugins.load at the CONTROLLER's
  // teamclaw entry (the npm project dir the controller itself loads from).
  if (controllerConfig.workerProvisioningType === "process" || !controllerConfig.workerProvisioningType) {
    const controllerEntryPath = resolveControllerTeamclawEntry();
    if (controllerEntryPath) {
      const loadList = ensureRecord(plugins).load;
      const load = Array.isArray(loadList) ? loadList.filter((p) => typeof p === "string") : [];
      if (!load.includes(controllerEntryPath)) load.push(controllerEntryPath);
      plugins.load = load;
    }
  }
  const entries = ensureRecord(plugins.entries);
  const teamclawEntry = ensureRecord(entries.teamclaw);
  teamclawEntry.enabled = true;
  const teamclawConfig = ensureRecord(teamclawEntry.config);
  teamclawConfig.mode = "worker";
  teamclawConfig.processModel = "multi";
  teamclawConfig.role = spec.role;
  teamclawConfig.port = spec.workerPort;
  teamclawConfig.controllerUrl = spec.controllerUrl;
  teamclawConfig.teamName = controllerConfig.teamName;
  teamclawConfig.heartbeatIntervalMs = controllerConfig.heartbeatIntervalMs;
  teamclawConfig.taskTimeoutMs = controllerConfig.taskTimeoutMs;
  teamclawConfig.gitEnabled = controllerConfig.gitEnabled;
  teamclawConfig.gitRemoteUrl = controllerConfig.gitRemoteUrl;
  teamclawConfig.gitDefaultBranch = controllerConfig.gitDefaultBranch;
  teamclawConfig.gitAuthorName = controllerConfig.gitAuthorName;
  teamclawConfig.gitAuthorEmail = controllerConfig.gitAuthorEmail;
  teamclawConfig.workerProvisioningType = "none";
  teamclawConfig.workerProvisioningControllerUrl = "";
  teamclawConfig.workerProvisioningRoles = [];
  teamclawConfig.workerProvisioningMinPerRole = 0;
  teamclawConfig.workerProvisioningMaxPerRole = 10;
  teamclawConfig.workerProvisioningIdleTtlMs = controllerConfig.workerProvisioningIdleTtlMs;
  teamclawConfig.workerProvisioningStartupTimeoutMs = controllerConfig.workerProvisioningStartupTimeoutMs;
  teamclawConfig.workerProvisioningImage = "";
  teamclawConfig.workerProvisioningPassEnv = [];
  teamclawConfig.workerProvisioningExtraEnv = {};
  teamclawConfig.workerProvisioningDockerNetwork = "";
  teamclawConfig.workerProvisioningDockerMounts = [];
  teamclawConfig.workerProvisioningWorkspaceRoot = "";
  teamclawConfig.workerProvisioningDockerWorkspaceVolume = "";
  teamclawConfig.workerProvisioningKubernetesNamespace = "default";
  teamclawConfig.workerProvisioningKubernetesContext = "";
  teamclawConfig.workerProvisioningKubernetesServiceAccount = "";
  teamclawConfig.workerProvisioningKubernetesImagePullSecrets = [];
  teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim = "";
  teamclawConfig.workerProvisioningKubernetesLabels = {};
  teamclawConfig.workerProvisioningKubernetesAnnotations = {};
  teamclawEntry.config = teamclawConfig;
  entries.teamclaw = teamclawEntry;
  plugins.entries = entries;
  config.plugins = plugins;

  return config;
}

export async function loadOpenClawConfig(configPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configPath, "utf8");
  return parseLooseJsonObject(raw, configPath);
}

export async function copyControllerAuthProfiles(stateDir: string): Promise<void> {
  const candidateControllerStateDirs = [
    path.dirname(resolveDefaultOpenClawConfigPath()),
    resolveDefaultOpenClawStateDir(),
  ];
  const candidateAuthProfilePaths = [
    path.join(resolveTeamClawAgentDir(), "auth-profiles.json"),
    path.join(resolveDefaultAgentDir(), "auth-profiles.json"),
    ...candidateControllerStateDirs.flatMap((controllerStateDir) => [
      path.join(controllerStateDir, "agents", TEAMCLAW_AGENT_ID, "agent", "auth-profiles.json"),
      path.join(controllerStateDir, "agents", "main", "agent", "auth-profiles.json"),
    ]),
  ].filter((value, index, values) => values.indexOf(value) === index);
  let controllerAuthProfilesPath: string | undefined;
  for (const candidatePath of candidateAuthProfilePaths) {
    if (await pathExists(candidatePath)) {
      controllerAuthProfilesPath = candidatePath;
      break;
    }
  }
  if (!controllerAuthProfilesPath) {
    return;
  }
  const runtimeAuthProfilePaths = [
    path.join(stateDir, "agents", TEAMCLAW_AGENT_ID, "agent", "auth-profiles.json"),
    path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
  ];
  for (const runtimeAuthProfilesPath of runtimeAuthProfilePaths) {
    await fs.mkdir(path.dirname(runtimeAuthProfilesPath), { recursive: true });
    await fs.copyFile(controllerAuthProfilesPath, runtimeAuthProfilesPath);
  }
}

export function appendNoProxyEntries(env: Record<string, string>, controllerUrl: string): Record<string, string> {
  const requiredEntries = resolveRequiredNoProxyEntries(controllerUrl);
  if (requiredEntries.length === 0) {
    return env;
  }

  const upperBase = env.NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const lowerBase = env.no_proxy ?? process.env.no_proxy ?? env.NO_PROXY ?? process.env.NO_PROXY ?? "";

  env.NO_PROXY = mergeNoProxyEntries(upperBase, requiredEntries);
  env.no_proxy = mergeNoProxyEntries(lowerBase, requiredEntries);
  return env;
}

function resolveRequiredNoProxyEntries(controllerUrl: string): string[] {
  const required = new Set<string>(["localhost", "127.0.0.1", "::1", "[::1]"]);
  try {
    const host = new URL(controllerUrl).hostname.trim();
    if (host) {
      required.add(host);
    }
  } catch {
    // Ignore malformed controller URLs; worker registration will fail separately.
  }
  return Array.from(required);
}

function mergeNoProxyEntries(existing: string, requiredEntries: string[]): string {
  const tokens = new Map<string, string>();
  for (const entry of existing.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    tokens.set(trimmed.toLowerCase(), trimmed);
  }
  for (const entry of requiredEntries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    tokens.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(tokens.values()).join(",");
}

function ensureRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function parseLooseJsonObject(raw: string, configPath: string): Record<string, unknown> {
  try {
    return JSON5.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse OpenClaw config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function buildProvisionedWorkspaceDir(
  provider: WorkerProvisioningType,
  config: PluginConfig,
  role: RoleId,
  workerId: string,
): string {
  // Process-type workers run on the same host — share the controller's workspace
  // so that file artifacts (previews, deliverables) are immediately visible to
  // the controller without requiring git sync or file transfer.
  if (provider === "process") {
    return resolveTeamClawAgentWorkspaceRootDir();
  }

  if (
    (provider !== "docker" && provider !== "kubernetes") ||
    !config.workerProvisioningWorkspaceRoot
  ) {
    return "";
  }

  return path.posix.join(
    config.workerProvisioningWorkspaceRoot,
    sanitizePathSegment(config.teamName),
    sanitizePathSegment(role),
    sanitizePathSegment(workerId),
  );
}

export function getConfiguredWorkerWorkspaceDir(config: Record<string, unknown>): string {
  const agents = ensureRecord(config.agents);
  const defaults = ensureRecord(agents.defaults);
  return typeof defaults.workspace === "string" ? defaults.workspace : "";
}
