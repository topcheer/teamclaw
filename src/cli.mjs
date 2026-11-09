#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import JSON5 from "json5";

const require = createRequire(import.meta.url);
const packageMetadata = require("./package.json");
const PACKAGE_ROOT = path.dirname(require.resolve("./package.json"));
const PACKAGE_NAME = packageMetadata.name;
const PACKAGE_VERSION = packageMetadata.version;
const PACKAGE_INSTALL_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
const PLUGIN_ID = "teamclaw";
const DANGEROUS_INSTALL_FLAG = "--dangerously-force-unsafe-install";
const CAPABILITY_CONSENT_FLAG = "--accept-capabilities";

/**
 * OpenClaw 2026.10+ replaced the legacy break-glass install flag (now a
 * deprecated no-op) with a capability-consent flow. When a host enforces
 * that flow, the install fails and asks the user to rerun with
 * --accept-capabilities, so detect that failure and retry once with the
 * consent flag appended. Legacy hosts (<2026.10) succeed on the first
 * attempt with the legacy flag and never hit the retry path.
 */
function isCapabilityConsentRequired(output) {
  return /accept-capabilities|capability[\s-]?consent|CapabilityConsentRequired/i.test(String(output || ""));
}
const DEFAULT_TEAMCLAW_IMAGE = "ghcr.io/topcheer/teamclaw-openclaw:latest";
const DEFAULT_CONTROLLER_PORT = 9527;
const DEFAULT_WORKER_PORT = 9528;
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_TEAM_NAME = "default";
const DEFAULT_TASK_TIMEOUT_MS = 1_800_000;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 2_400;
const LEGACY_DEFAULT_PROVISIONING_ROLES = ["architect", "developer", "qa"];
const TEAMCLAW_AGENT_ID = "teamclaw";
const TEAMCLAW_RECOMMENDED_EXEC_SECURITY = "full";
const TEAMCLAW_RECOMMENDED_EXEC_ASK = "off";
const TEAMCLAW_RECOMMENDED_COMMAND_MODE = "auto";
const AGENT_MODE_OPTIONS = [
  {
    value: "independent",
    label: "Dedicated TeamClaw agent/workspace",
  },
  {
    value: "main",
    label: "Legacy shared main-agent mode",
  },
];

// Installer role options are derived from the packaged role registry
// (dist/src/roles.js, compiled from src/src/roles.ts) instead of a
// hand-maintained copy, so profile-driven role sets flow into the wizard
// without editing this file. dist/ always ships inside the npm package; in a
// dev checkout it appears after `npm --prefix src run build`. The dynamic
// import keeps pre-build tooling (lint, source-level tests) working: this
// file parses without dist present and only the interactive/install paths
// require it.
let ROLE_OPTIONS = [];
let DEFAULT_WORKER_ROLE = "";

async function loadRoleOptions() {
  try {
    const rolesModule = await import("./dist/src/roles.js");
    const roles = Array.isArray(rolesModule.ROLES) ? rolesModule.ROLES : [];
    ROLE_OPTIONS = roles
      .filter((role) => role && typeof role.id === "string" && role.id.trim())
      .map((role) => ({
        value: role.id,
        label: typeof role.label === "string" && role.label.trim() ? role.label : role.id,
      }));
    const registryDefault = rolesModule.DEFAULT_ROLE;
    DEFAULT_WORKER_ROLE = typeof registryDefault === "string" && ROLE_OPTIONS.some((option) => option.value === registryDefault)
      ? registryDefault
      : "";
  } catch {
    // dist not built yet (dev checkout). Keep the registry empty so callers
    // fail with the actionable guidance in ensureRoleOptionsLoaded instead
    // of presenting a stale role list.
    ROLE_OPTIONS = [];
    DEFAULT_WORKER_ROLE = "";
  }
}

function ensureRoleOptionsLoaded() {
  if (ROLE_OPTIONS.length === 0) {
    throw new Error(
      "TeamClaw role registry unavailable (./dist/src/roles.js). Run `npm --prefix src run build` in the repository, or reinstall the @teamclaws/teamclaw package, then retry.",
    );
  }
}

const INSTALL_MODE_OPTIONS = [
  {
    value: "controller-process",
    label: "Controller + on-demand process workers",
    hint: "Recommended first setup on one host.",
  },
  {
    value: "controller-manual",
    label: "Local controller + default on-demand workers",
    hint: "Lean same-host setup; writes workerProvisioningRoles=[] and workerProvisioningMaxPerRole=1.",
  },
  {
    value: "controller-docker",
    label: "Controller + on-demand Docker workers",
    hint: "Launch workers in Docker containers.",
  },
  {
    value: "controller-kubernetes",
    label: "Controller + on-demand Kubernetes workers",
    hint: "Launch workers as Kubernetes pods.",
  },
  {
    value: "worker",
    label: "Dedicated worker node",
    hint: "Join an existing TeamClaw controller.",
  },
];

function printHelp() {
  console.log(`
TeamClaw installer

Usage:
  npx -y @teamclaws/teamclaw install
  npm exec -y @teamclaws/teamclaw install

Commands:
  install                Install/configure TeamClaw for OpenClaw
  pair <controller-url>  Pair this instance with a controller that has device
                         protection enabled (issue #23). Without --code it
                         first tries zero-input LAN auto-pairing.
    --code <code>        One-shot pairing code from the controller owner
                         (web UI: Device security -> New pairing code)
    --name <name>        Device name shown in the controller device list
    --kind <kind>        Device kind: worker, desktop or cli (default cli)
    --config <path>      OpenClaw config path to store the token in
  token reset <controller-url>
                         Revoke ALL paired devices and return the controller
                         to unpaired local mode (loopback host, or --token)
    --token <token>      Device token (required from a non-loopback host)
    --config <path>      OpenClaw config path to clear the stored token from
  help                   Show this help

Options:
  --config <path>         Override the OpenClaw config path
  --yes                   Accept the recommended defaults without prompting
  --install-mode <mode>   Install mode: controller-process, controller-manual, controller-docker, controller-kubernetes, worker
  --controller-url <url>  Worker/manual controller URL override
  --team-name <name>      Team name override
  --worker-role <role>    Worker role override for --install-mode worker
  --agent-mode <mode>     Advanced: "independent" (default) or "main"
  --skip-plugin-install   Only update openclaw.json; skip "openclaw plugins install"
  --dry-run               Show what would happen without writing files
`);
}

function parseArgs(argv) {
  const options = {
    configPath: "",
    yes: false,
    installMode: "",
    controllerUrl: "",
    teamName: "",
    workerRole: "",
    agentMode: "",
    skipPluginInstall: false,
    dryRun: false,
  };
  let command = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!command && !arg.startsWith("--")) {
      command = arg;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      options.configPath = value;
      index += 1;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    if (arg === "--install-mode") {
      const value = argv[index + 1];
      const validModes = new Set(INSTALL_MODE_OPTIONS.map((option) => option.value));
      if (!value || !validModes.has(value)) {
        throw new Error(`--install-mode requires one of: ${INSTALL_MODE_OPTIONS.map((option) => option.value).join(", ")}`);
      }
      options.installMode = value;
      index += 1;
      continue;
    }
    if (arg === "--controller-url") {
      const value = argv[index + 1];
      if (!value || (!value.startsWith("http://") && !value.startsWith("https://"))) {
        throw new Error('--controller-url requires a value starting with "http://" or "https://"');
      }
      options.controllerUrl = value;
      index += 1;
      continue;
    }
    if (arg === "--team-name") {
      const value = argv[index + 1];
      if (!value || !value.trim()) {
        throw new Error("--team-name requires a non-empty value");
      }
      options.teamName = value.trim();
      index += 1;
      continue;
    }
    if (arg === "--worker-role") {
      const value = argv[index + 1];
      ensureRoleOptionsLoaded();
      const validRoles = new Set(ROLE_OPTIONS.map((option) => option.value));
      if (!value || !validRoles.has(value)) {
        throw new Error(`--worker-role requires one of: ${ROLE_OPTIONS.map((option) => option.value).join(", ")}`);
      }
      options.workerRole = value;
      index += 1;
      continue;
    }
    if (arg === "--agent-mode") {
      const value = argv[index + 1];
      if (!value || (value !== "independent" && value !== "main")) {
        throw new Error('--agent-mode requires "independent" or "main"');
      }
      options.agentMode = value;
      index += 1;
      continue;
    }
    if (arg === "--skip-plugin-install") {
      options.skipPluginInstall = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      command = "help";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command: command || "help", options };
}

// ===========================================================================
// Device pairing commands (issue #23, client wave).
//
//   pair <controller-url> [--code] [--name] [--kind]  - exchange a one-shot
//     code (or a LAN auto-pair attempt) for a device token, then store it as
//     plugins.entries.teamclaw.config.securityToken in the OpenClaw config so
//     every later worker/controller API call from this instance carries the
//     X-TeamClaw-Token header automatically.
//   token reset <controller-url> [--token] - revoke all devices (loopback
//     host needs no token) and clear any locally stored token.
// ===========================================================================

const PAIR_DEVICE_KINDS = new Set(["worker", "desktop", "cli"]);
const SECURITY_REQUEST_TIMEOUT_MS = 15_000;

function normalizeControllerUrlArg(raw) {
  let value = String(raw || "").trim();
  if (!value) {
    throw new Error("A controller URL is required (e.g. http://192.168.1.10:9527).");
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    value = `http://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) {
      throw new Error("empty host");
    }
    // Strip any trailing path/slash so endpoint joining stays predictable.
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    throw new Error(`Invalid controller URL: ${raw}`);
  }
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePairArgs(argv) {
  const options = { controllerUrl: "", code: "", name: "", kind: "cli", configPath: "" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options };
    }
    if (arg.startsWith("--")) {
      if (arg === "--code") {
        options.code = readFlagValue(argv, index, arg).trim();
        index += 1;
      } else if (arg === "--name") {
        options.name = readFlagValue(argv, index, arg).trim();
        index += 1;
      } else if (arg === "--kind") {
        const kind = readFlagValue(argv, index, arg).trim();
        if (!PAIR_DEVICE_KINDS.has(kind)) {
          throw new Error(`--kind requires one of: ${[...PAIR_DEVICE_KINDS].join(", ")}`);
        }
        options.kind = kind;
        index += 1;
      } else if (arg === "--config") {
        options.configPath = readFlagValue(argv, index, arg);
        index += 1;
      } else {
        throw new Error(`Unknown argument: ${arg}`);
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error('Usage: teamclaw pair <controller-url> [--code <code>] [--name <name>] [--kind worker|desktop|cli]');
  }
  options.controllerUrl = positional[0];
  return { help: false, options };
}

function parseTokenArgs(argv) {
  const options = { controllerUrl: "", token: "", configPath: "" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options };
    }
    if (arg.startsWith("--")) {
      if (arg === "--token") {
        options.token = readFlagValue(argv, index, arg).trim();
        index += 1;
      } else if (arg === "--config") {
        options.configPath = readFlagValue(argv, index, arg);
        index += 1;
      } else {
        throw new Error(`Unknown argument: ${arg}`);
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0 || positional[0] !== "reset") {
    throw new Error('Usage: teamclaw token reset <controller-url> [--token <token>]');
  }
  if (positional.length !== 2) {
    throw new Error('Usage: teamclaw token reset <controller-url> [--token <token>]');
  }
  options.controllerUrl = positional[1];
  return { help: false, options };
}

async function securityFetch(controllerUrl, pathname, { method = "POST", body, token } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["X-TeamClaw-Token"] = token;
  }
  let response;
  try {
    response = await fetch(`${controllerUrl}/api/v1${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(SECURITY_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not reach the controller at ${controllerUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload };
}

function describeSecurityError(result, fallback) {
  if (result.payload && typeof result.payload === "object") {
    const parts = [result.payload.error, result.payload.hint].filter((part) => typeof part === "string" && part.trim());
    if (parts.length > 0) {
      return parts.join(" - ");
    }
  }
  return `${fallback} (HTTP ${result.status})`;
}

async function upsertTeamClawConfig(configPath, update) {
  const config = await readOpenClawConfig(configPath);
  const plugins = ensureRecord(config, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const teamclawEntry = ensureRecord(entries, PLUGIN_ID);
  const teamclawConfig = ensureRecord(teamclawEntry, "config");
  update(teamclawConfig);
  await writeConfig(configPath, config);
}

async function runPair(options) {
  const controllerUrl = normalizeControllerUrlArg(options.controllerUrl);
  const kind = options.kind;
  const name = options.name || `${os.hostname()} ${kind}`;
  let result;
  if (options.code) {
    result = await securityFetch(controllerUrl, "/security/pair", {
      body: { code: options.code.toUpperCase(), kind, name },
    });
  } else {
    // Zero-input LAN path first (mDNS scenario): a LAN peer pairs without a
    // code while the controller allows auto-pairing.
    result = await securityFetch(controllerUrl, "/security/pair-auto", { body: { kind, name } });
    if (result.status === 403) {
      throw new Error(
        "This controller did not accept zero-input pairing (not a LAN peer, or auto-pairing is disabled). " +
        "Ask the controller owner for a one-shot pairing code (web UI: Device security -> New pairing code) and rerun with --code <code>.",
      );
    }
  }
  if (!result.ok || !result.payload || typeof result.payload.token !== "string") {
    if (result.status === 409) {
      throw new Error(describeSecurityError(result, "Device protection is not enabled on this controller; there is nothing to pair with yet"));
    }
    throw new Error(describeSecurityError(result, "Pairing failed"));
  }
  const configPath = expandUserPath(options.configPath || resolveDefaultOpenClawConfigPath());
  await upsertTeamClawConfig(configPath, (teamclawConfig) => {
    // Same layer as teamName: the worker/controller pipeline reads this and
    // sends X-TeamClaw-Token on every API call automatically.
    teamclawConfig.securityToken = result.payload.token;
    if (!teamclawConfig.controllerUrl) {
      teamclawConfig.controllerUrl = controllerUrl;
    }
  });
  console.log(`Paired with ${controllerUrl}`);
  console.log(`  Device: "${result.payload.device?.name || name}" (kind ${kind}, id ${result.payload.deviceId || result.payload.device?.id || "?"})`);
  console.log(`  Token stored at plugins.entries.teamclaw.config.securityToken in ${configPath}`);
  console.log("  This instance now authenticates automatically. Keep that config file private; the token is shown only once by the controller and cannot be recovered.");
  console.log("Next step: restart this instance (or run `openclaw gateway restart`) so its API calls pick up the token.");
}

async function runTokenReset(options) {
  const controllerUrl = normalizeControllerUrlArg(options.controllerUrl);
  const result = await securityFetch(controllerUrl, "/security/reset", { body: {}, token: options.token });
  if (!result.ok) {
    if (result.status === 401) {
      throw new Error(
        "Reset refused: only the controller host itself (loopback) or an authenticated device may reset. " +
        "Run this on the controller machine, or pass --token <device-token>.",
      );
    }
    throw new Error(describeSecurityError(result, "Token reset failed"));
  }
  // Best effort: drop the now-invalid local token so the next pair starts clean.
  const configPath = expandUserPath(options.configPath || resolveDefaultOpenClawConfigPath());
  try {
    const config = await readOpenClawConfig(configPath);
    const teamclawConfig = getExistingTeamClawConfig(config);
    if (typeof teamclawConfig.securityToken === "string" && teamclawConfig.securityToken) {
      delete teamclawConfig.securityToken;
      const plugins = ensureRecord(config, "plugins");
      const entries = ensureRecord(plugins, "entries");
      const teamclawEntry = ensureRecord(entries, PLUGIN_ID);
      teamclawEntry.config = teamclawConfig;
      await writeConfig(configPath, config);
      console.log(`Cleared the stored device token from ${configPath}`);
    }
  } catch {
    // No local config/token to clear - resetting a remote controller only.
  }
  console.log(`All paired devices on ${controllerUrl} were revoked; the controller is back to unpaired local mode (L0).`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureRecord(parent, key) {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function expandUserPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function resolveDefaultOpenClawHomeDir(env = process.env) {
  const baseHome = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
  return path.resolve(baseHome);
}

function resolveDefaultOpenClawStateDir(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveDefaultOpenClawHomeDir(env), ".openclaw");
}

function resolveDefaultOpenClawConfigPath(env = process.env) {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveDefaultOpenClawStateDir(env), "openclaw.json");
}

function resolveDefaultOpenClawWorkspaceDir(env = process.env) {
  return path.join(resolveDefaultOpenClawStateDir(env), "workspace");
}

function resolveOpenClawStateDirForConfigPath(configPath) {
  return path.dirname(path.resolve(configPath));
}

function resolveOpenClawWorkspaceDirForConfigPath(configPath) {
  return path.join(resolveOpenClawStateDirForConfigPath(configPath), "workspace");
}

function resolveDefaultTeamClawAgentDirForConfigPath(configPath) {
  return path.join(resolveOpenClawStateDirForConfigPath(configPath), "agents", TEAMCLAW_AGENT_ID, "agent");
}

function resolveDefaultTeamClawWorkspaceDir(configPath) {
  return path.join(resolveOpenClawStateDirForConfigPath(configPath), `workspace-${TEAMCLAW_AGENT_ID}`);
}

function resolveMainAgentDirForConfigPath(configPath) {
  return path.join(resolveOpenClawStateDirForConfigPath(configPath), "agents", "main", "agent");
}

async function detectMdnsCapability() {
  try {
    const Bonjour = (await import("bonjour-service")).default;
    const bonjour = new Bonjour();
    try {
      const browser = bonjour.find({ type: "teamclaw" }, () => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      browser?.stop?.();
    } finally {
      bonjour.destroy();
    }
    return { available: true, reason: "" };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readOpenClawConfig(configPath) {
  if (!await pathExists(configPath)) {
    return {};
  }
  const raw = await fs.readFile(configPath, "utf8");
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON5.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("config root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse OpenClaw config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function ensureConfigFile(configPath, dryRun) {
  const exists = await pathExists(configPath);
  if (exists) {
    return false;
  }
  if (dryRun) {
    return true;
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{}\n", "utf8");
  return true;
}

async function createBackup(configPath, dryRun) {
  if (!await pathExists(configPath)) {
    return null;
  }
  if (dryRun) {
    return `${configPath}.teamclaw.bak`;
  }
  let backupPath = `${configPath}.teamclaw.bak`;
  let index = 1;
  while (await pathExists(backupPath)) {
    backupPath = `${configPath}.teamclaw.${index}.bak`;
    index += 1;
  }
  await fs.copyFile(configPath, backupPath);
  return backupPath;
}

async function writeConfig(configPath, config) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getExistingTeamClawConfig(config) {
  if (!isRecord(config)) {
    return {};
  }
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const teamclaw = isRecord(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] : {};
  return isRecord(teamclaw.config) ? teamclaw.config : {};
}

function resolveModelPrimaryValue(model) {
  if (typeof model === "string") {
    return model.trim();
  }
  if (!isRecord(model) || typeof model.primary !== "string") {
    return "";
  }
  return model.primary.trim();
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveConfiguredAgentEntryRecord(config, agentId) {
  const agents = isRecord(config.agents) ? config.agents : {};
  // OpenClaw 2026.10+ keyed agents.entries take precedence over the legacy list.
  const keyed = isRecord(agents.entries) ? agents.entries[agentId] : null;
  if (isRecord(keyed)) {
    return keyed;
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const entry of list) {
    if (!isRecord(entry) || entry.id !== agentId) {
      continue;
    }
    return entry;
  }
  return null;
}

function resolveEffectiveTeamClawModel(config) {
  const teamclawEntry = resolveConfiguredAgentEntryRecord(config, TEAMCLAW_AGENT_ID);
  if (teamclawEntry && teamclawEntry.model != null) {
    return cloneJsonValue(teamclawEntry.model);
  }
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  return defaults.model != null ? cloneJsonValue(defaults.model) : null;
}

async function findExistingAuthProfilesPath(configPath) {
  const candidates = [
    path.join(resolveDefaultTeamClawAgentDirForConfigPath(configPath), "auth-profiles.json"),
    path.join(resolveMainAgentDirForConfigPath(configPath), "auth-profiles.json"),
  ];
  for (const candidatePath of candidates) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }
  return "";
}

async function bootstrapTeamClawAgentAuth(configPath, config) {
  const teamclawEntry = resolveConfiguredAgentEntryRecord(config, TEAMCLAW_AGENT_ID);
  if (!teamclawEntry || typeof teamclawEntry.agentDir !== "string" || !teamclawEntry.agentDir.trim()) {
    return { copied: false, sourcePath: "", targetPath: "", warning: "" };
  }
  const targetPath = path.join(teamclawEntry.agentDir.trim(), "auth-profiles.json");
  const sourcePath = await findExistingAuthProfilesPath(configPath);
  if (!sourcePath) {
    return {
      copied: false,
      sourcePath: "",
      targetPath,
      warning: "No existing OpenClaw auth-profiles.json was found, so TeamClaw can start but cannot work until host auth is configured.",
    };
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    await fs.copyFile(sourcePath, targetPath);
  }
  return { copied: true, sourcePath, targetPath, warning: "" };
}

function applySelectedModel(existingModel, selectedModel) {
  const nextPrimary = typeof selectedModel === "string" ? selectedModel.trim() : "";
  if (!nextPrimary) {
    return existingModel;
  }
  if (!isRecord(existingModel)) {
    return nextPrimary;
  }
  if (resolveModelPrimaryValue(existingModel) === nextPrimary) {
    return existingModel;
  }
  const nextModel = {
    ...existingModel,
    primary: nextPrimary,
  };
  if (Array.isArray(existingModel.fallbacks)) {
    nextModel.fallbacks = dedupeStrings(existingModel.fallbacks).filter((value) => value !== nextPrimary);
  }
  return nextModel;
}

function getCurrentModel(config) {
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  return resolveModelPrimaryValue(defaults.model);
}

function getCurrentWorkspacePath(config) {
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  return typeof defaults.workspace === "string" ? expandUserPath(defaults.workspace) : "";
}

function getCurrentTeamClawAgentWorkspacePath(config) {
  const agents = isRecord(config.agents) ? config.agents : {};
  const keyed = isRecord(agents.entries)
    ? agents.entries[TEAMCLAW_AGENT_ID]
    : null;
  if (isRecord(keyed) && typeof keyed.workspace === "string") {
    return expandUserPath(keyed.workspace);
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const entry of list) {
    if (!isRecord(entry) || entry.id !== TEAMCLAW_AGENT_ID) {
      continue;
    }
    return typeof entry.workspace === "string" ? expandUserPath(entry.workspace) : "";
  }
  return "";
}

function resolveCurrentAgentIsolationMode(config) {
  const existingTeamClaw = getExistingTeamClawConfig(config);
  return existingTeamClaw.agentIsolationMode === "main" ? "main" : "independent";
}

function resolveInstallerWorkspaceDefault(configPath, config, agentIsolationMode) {
  if (agentIsolationMode === "main") {
    const currentWorkspacePath = getCurrentWorkspacePath(config);
    return currentWorkspacePath || resolveOpenClawWorkspaceDirForConfigPath(configPath);
  }
  const currentWorkspacePath = getCurrentTeamClawAgentWorkspacePath(config);
  return currentWorkspacePath || resolveDefaultTeamClawWorkspaceDir(configPath);
}

function dedupeStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())));
}

function hasSameStringSet(left, right) {
  const normalizedLeft = dedupeStrings(left).slice().sort();
  const normalizedRight = dedupeStrings(right).slice().sort();
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function normalizeConfiguredRoleList(raw) {
  return Array.isArray(raw) ? dedupeStrings(raw) : [];
}

function resolveDefaultProvisioningRoles(existingTeamClaw) {
  const existingRoles = normalizeConfiguredRoleList(existingTeamClaw.workerProvisioningRoles);
  return existingRoles.length > 0 && !hasSameStringSet(existingRoles, LEGACY_DEFAULT_PROVISIONING_ROLES)
    ? existingRoles
    : [];
}

function extractModelOptions(config) {
  const currentModel = getCurrentModel(config);
  const models = [];
  const rootModels = isRecord(config.models) ? config.models : {};
  const providers = isRecord(rootModels.providers) ? rootModels.providers : {};

  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider) || !Array.isArray(rawProvider.models)) {
      continue;
    }
    for (const rawModel of rawProvider.models) {
      if (!isRecord(rawModel) || typeof rawModel.id !== "string" || !rawModel.id.trim()) {
        continue;
      }
      const modelId = rawModel.id.trim();
      const value = `${providerId}/${modelId}`;
      const displayName = typeof rawModel.name === "string" && rawModel.name.trim()
        ? rawModel.name.trim()
        : modelId;
      models.push({
        value,
        label: `${displayName} (${value})`,
      });
    }
  }

  models.sort((left, right) => left.label.localeCompare(right.label));

  const deduped = [];
  const seen = new Set();
  for (const option of models) {
    if (seen.has(option.value)) {
      continue;
    }
    deduped.push(option);
    seen.add(option.value);
  }

  if (currentModel && !seen.has(currentModel)) {
    deduped.unshift({
      value: currentModel,
      label: `Keep current default model (${currentModel})`,
    });
  }

  return {
    options: deduped,
    currentModel,
  };
}

class Prompter {
  constructor({ yes }) {
    this.yes = yes;
    this.rl = yes ? null : createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  close() {
    this.rl?.close();
  }

  note(message = "") {
    console.log(message);
  }

  async text({ message, defaultValue = "", allowEmpty = false, validate }) {
    if (this.yes) {
      const value = defaultValue ?? "";
      if (!allowEmpty && !value) {
        throw new Error(`Missing default value for ${message}; rerun without --yes.`);
      }
      console.log(`${message}: ${value || "<empty>"}`);
      return value;
    }

    while (true) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const raw = await this.rl.question(`${message}${suffix}: `);
      const value = raw.trim() || defaultValue || "";
      if (!allowEmpty && !value) {
        console.log("A value is required.");
        continue;
      }
      const error = validate ? validate(value) : "";
      if (error) {
        console.log(error);
        continue;
      }
      return value;
    }
  }

  async number({ message, defaultValue, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }) {
    const raw = await this.text({
      message,
      defaultValue: String(defaultValue),
      validate: (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
          return "Please enter an integer.";
        }
        if (parsed < min) {
          return `Please enter a value >= ${min}.`;
        }
        if (parsed > max) {
          return `Please enter a value <= ${max}.`;
        }
        return "";
      },
    });
    return Number(raw);
  }

  async confirm({ message, defaultValue = true }) {
    if (this.yes) {
      console.log(`${message}: ${defaultValue ? "yes" : "no"}`);
      return defaultValue;
    }

    while (true) {
      const hint = defaultValue ? "Y/n" : "y/N";
      const raw = (await this.rl.question(`${message} [${hint}]: `)).trim().toLowerCase();
      if (!raw) {
        return defaultValue;
      }
      if (raw === "y" || raw === "yes") {
        return true;
      }
      if (raw === "n" || raw === "no") {
        return false;
      }
      console.log('Please answer "y" or "n".');
    }
  }

  async select({ message, options, defaultValue }) {
    if (!Array.isArray(options) || options.length === 0) {
      throw new Error(`No options available for ${message}`);
    }

    const defaultIndex = Math.max(0, options.findIndex((option) => option.value === defaultValue));
    if (this.yes) {
      const choice = options[defaultIndex] ?? options[0];
      console.log(`${message}: ${choice.label}`);
      return choice.value;
    }

    while (true) {
      console.log(`\n${message}`);
      options.forEach((option, index) => {
        const marker = index === defaultIndex ? " (default)" : "";
        const hint = option.hint ? ` — ${option.hint}` : "";
        console.log(`  ${index + 1}. ${option.label}${hint}${marker}`);
      });
      const raw = (await this.rl.question(`Selection [${defaultIndex + 1}]: `)).trim();
      if (!raw) {
        return options[defaultIndex]?.value ?? options[0].value;
      }
      const asNumber = Number(raw);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
        return options[asNumber - 1].value;
      }
      const byValue = options.find((option) => option.value === raw);
      if (byValue) {
        return byValue.value;
      }
      console.log("Please choose one of the listed options.");
    }
  }
}

function parseRoleList(raw) {
  const values = dedupeStrings(String(raw || "").split(",").map((entry) => entry.trim()));
  const validIds = new Set(ROLE_OPTIONS.map((option) => option.value));
  const invalid = values.filter((value) => !validIds.has(value));
  return {
    values,
    invalid,
  };
}

async function promptRoleList(prompter, message, defaultRoles) {
  const defaultValue = defaultRoles.join(",");
  if (!prompter.yes) {
    console.log(`Available roles: ${ROLE_OPTIONS.map((option) => `${option.value} (${option.label})`).join(", ")}`);
  }
  const raw = await prompter.text({
    message,
    defaultValue,
    validate: (value) => {
      const parsed = parseRoleList(value);
      if (parsed.values.length === 0) {
        return "Please choose at least one role.";
      }
      if (parsed.invalid.length > 0) {
        return `Unknown role ids: ${parsed.invalid.join(", ")}`;
      }
      return "";
    },
  });
  return parseRoleList(raw).values;
}

async function promptOptionalRoleList(prompter, message, defaultRoles) {
  const defaultValue = defaultRoles.join(",");
  if (!prompter.yes) {
    console.log(
      `Available roles: ${ROLE_OPTIONS.map((option) => `${option.value} (${option.label})`).join(", ")}. These are preferred defaults only; task-required roles can still launch automatically.`,
    );
  }
  const raw = await prompter.text({
    message,
    defaultValue,
    allowEmpty: true,
    validate: (value) => {
      const parsed = parseRoleList(value);
      if (parsed.invalid.length > 0) {
        return `Unknown role ids: ${parsed.invalid.join(", ")}`;
      }
      return "";
    },
  });
  return parseRoleList(raw).values;
}

function buildStartCommand(configPath) {
  const defaultPath = resolveDefaultOpenClawConfigPath();
  if (path.resolve(configPath) === path.resolve(defaultPath)) {
    return "openclaw gateway run";
  }
  const stateDir = resolveOpenClawStateDirForConfigPath(configPath);
  return `OPENCLAW_STATE_DIR=${shellEscape(stateDir)} OPENCLAW_CONFIG_PATH=${shellEscape(configPath)} openclaw gateway run`;
}

function shellEscape(value) {
  if (!value) {
    return "''";
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isControllerInstallMode(installMode) {
  return installMode !== "worker";
}

function isOnDemandControllerInstallMode(installMode) {
  return installMode === "controller-manual" ||
    installMode === "controller-process" ||
    installMode === "controller-docker" ||
    installMode === "controller-kubernetes";
}

function describeProvisioningRoles(roles) {
  return Array.isArray(roles) && roles.length > 0
    ? `${roles.join(", ")} (plus any task-required roles)`
    : "all TeamClaw roles (controller decides at runtime)";
}

function getLocalUiUrl(port) {
  return `http://127.0.0.1:${port}/ui`;
}

function rankLanAddress(address) {
  if (address.startsWith("192.168.")) {
    return 0;
  }
  if (address.startsWith("10.")) {
    return 1;
  }
  const parts = address.split(".").map((value) => Number.parseInt(value, 10));
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return 2;
  }
  return 3;
}

function parseDefaultRouteInterface(text) {
  const directMatch = String(text || "").match(/(?:^|\n)\s*interface:\s*(\S+)/i);
  if (directMatch && directMatch[1]) {
    return directMatch[1];
  }
  const devMatch = String(text || "").match(/(?:^|\n)default(?:\s+via\s+\S+)?\s+dev\s+(\S+)/i);
  if (devMatch && devMatch[1]) {
    return devMatch[1];
  }
  return "";
}

function resolveDefaultRouteInterface() {
  const candidates = process.platform === "darwin"
    ? [
        { command: "route", args: ["-n", "get", "default"] },
        { command: "ip", args: ["route", "show", "default"] },
      ]
    : [
        { command: "ip", args: ["route", "show", "default"] },
        { command: "route", args: ["-n", "get", "default"] },
      ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, { encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      continue;
    }
    const interfaceName = parseDefaultRouteInterface(result.stdout || "");
    if (interfaceName) {
      return interfaceName;
    }
  }
  return "";
}

function isPrivateLanIpv4(address) {
  if (String(address).startsWith("192.168.") || String(address).startsWith("10.")) {
    return true;
  }
  const parts = String(address).split(".").map((value) => Number.parseInt(value, 10));
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function listLanUiUrls(port) {
  const interfaces = os.networkInterfaces();
  const seen = new Set();
  const orderedAddresses = [];
  const defaultRouteInterface = resolveDefaultRouteInterface();
  if (defaultRouteInterface && Array.isArray(interfaces[defaultRouteInterface])) {
    for (const record of interfaces[defaultRouteInterface] || []) {
      if (!record || record.internal || record.family !== "IPv4") {
        continue;
      }
      if (!seen.has(record.address)) {
        seen.add(record.address);
        orderedAddresses.push(record.address);
      }
    }
  }
  const fallbackAddresses = [];
  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (!record || record.internal || record.family !== "IPv4") {
        continue;
      }
      if (!seen.has(record.address)) {
        seen.add(record.address);
        fallbackAddresses.push(record.address);
      }
    }
  }
  fallbackAddresses.sort((left, right) => {
    const leftScore = isPrivateLanIpv4(left) ? rankLanAddress(left) : 99;
    const rightScore = isPrivateLanIpv4(right) ? rankLanAddress(right) : 99;
    return leftScore - rightScore || left.localeCompare(right);
  });
  return orderedAddresses.concat(fallbackAddresses).map((address) => `http://${address}:${port}/ui`);
}

function installPluginWithCommand(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env,
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ?? null,
    output: `${stdout}\n${stderr}`,
  };
}

function runGatewayCommand(command, args, env) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function inspectInstalledPlugin(configPath) {
  const stateDir = path.dirname(path.resolve(configPath));
  const pluginDir = path.join(stateDir, "extensions", PLUGIN_ID);
  if (!fsSync.existsSync(pluginDir)) {
    return null;
  }
  const manifest = readJsonIfExists(path.join(pluginDir, "openclaw.plugin.json"));
  const packageJson = readJsonIfExists(path.join(pluginDir, "package.json"));
  const version = typeof manifest?.version === "string" && manifest.version.trim()
    ? manifest.version.trim()
    : typeof packageJson?.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "";
  return {
    pluginDir,
    version: version || null,
  };
}

function buildOpenClawCommandEnv(configPath) {
  const stateDir = resolveOpenClawStateDirForConfigPath(configPath);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

function attemptPluginUninstall({ configPath }) {
  const env = buildOpenClawCommandEnv(configPath);
  const candidates = [
    {
      label: "openclaw",
      command: "openclaw",
      args: ["plugins", "uninstall", PLUGIN_ID, "--force"],
    },
    {
      label: "npm exec fallback",
      command: "npm",
      args: ["exec", "-y", "openclaw@latest", "--", "plugins", "uninstall", PLUGIN_ID, "--force"],
    },
  ];
  const failures = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    console.log(`\nRemoving existing ${PLUGIN_ID} plugin with ${candidate.label}...`);
    const result = installPluginWithCommand(candidate.command, candidate.args, env);
    if (result.status === 0 && !result.error) {
      return {
        ok: true,
        method: candidate.label,
      };
    }
    const errorCode = result.error && typeof result.error === "object" ? result.error.code : "";
    const detail = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : `exited with code ${result.status}`;
    failures.push(`${candidate.label} failed: ${detail}`);
    if (errorCode === "ENOENT" && index < candidates.length - 1) {
      console.log(`${candidate.command} was not found. Trying the next uninstall fallback...`);
      continue;
    }
    break;
  }
  return {
    ok: false,
    error: failures.join("; "),
  };
}

function attemptPluginInstall({ configPath }) {
  const env = buildOpenClawCommandEnv(configPath);
  const installedPlugin = inspectInstalledPlugin(configPath);
  if (installedPlugin?.version === PACKAGE_VERSION) {
    console.log(
      `\nFound existing TeamClaw plugin at ${installedPlugin.pluginDir} (version ${installedPlugin.version}). Skipping plugin reinstall.`,
    );
    return {
      ok: true,
      method: `already installed (${installedPlugin.version})`,
      skipped: true,
    };
  }
  if (installedPlugin) {
    const installedVersion = installedPlugin.version ? `version ${installedPlugin.version}` : "an unknown version";
    console.log(
      `\nFound existing TeamClaw plugin at ${installedPlugin.pluginDir} (${installedVersion}). Removing it before install...`,
    );
    const uninstallResult = attemptPluginUninstall({ configPath });
    if (!uninstallResult.ok) {
      return {
        ok: false,
        error: `Could not remove existing TeamClaw plugin at ${installedPlugin.pluginDir}: ${uninstallResult.error}`,
      };
    }
  }
  console.log(
    `\nTeamClaw uses host-level orchestration capabilities, so OpenClaw requires an install consent flag during plugin installation (legacy: ${DANGEROUS_INSTALL_FLAG}; OpenClaw 2026.10+: ${CAPABILITY_CONSENT_FLAG}).`,
  );
  const candidates = [
    {
      label: "openclaw (local package directory)",
      command: "openclaw",
      args: ["plugins", "install", DANGEROUS_INSTALL_FLAG, PACKAGE_ROOT],
      targetDescription: PACKAGE_ROOT,
    },
    {
      label: "npm exec fallback (local package directory)",
      command: "npm",
      args: [
        "exec",
        "-y",
        "openclaw@latest",
        "--",
        "plugins",
        "install",
        DANGEROUS_INSTALL_FLAG,
        PACKAGE_ROOT,
      ],
      targetDescription: PACKAGE_ROOT,
    },
    {
      label: "openclaw (exact version fallback)",
      command: "openclaw",
      args: ["plugins", "install", DANGEROUS_INSTALL_FLAG, PACKAGE_INSTALL_SPEC],
      targetDescription: PACKAGE_INSTALL_SPEC,
    },
    {
      label: "npm exec fallback (exact version fallback)",
      command: "npm",
      args: [
        "exec",
        "-y",
        "openclaw@latest",
        "--",
        "plugins",
        "install",
        DANGEROUS_INSTALL_FLAG,
        PACKAGE_INSTALL_SPEC,
      ],
      targetDescription: PACKAGE_INSTALL_SPEC,
    },
  ];

  const failures = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    console.log(`\nInstalling ${candidate.targetDescription} with ${candidate.label}...`);
    let result = installPluginWithCommand(candidate.command, candidate.args, env);
    if (
      result.status !== 0 &&
      !candidate.args.includes(CAPABILITY_CONSENT_FLAG) &&
      isCapabilityConsentRequired(result.output)
    ) {
      console.log("OpenClaw requires capability consent; retrying with --accept-capabilities...");
      result = installPluginWithCommand(
        candidate.command,
        [...candidate.args, CAPABILITY_CONSENT_FLAG],
        env,
      );
    }
    if (result.status === 0 && !result.error) {
      return {
        ok: true,
        method: candidate.label,
      };
    }
    const errorCode = result.error && typeof result.error === "object" ? result.error.code : "";
    const detail = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : `exited with code ${result.status}`;
    failures.push(`${candidate.label} failed: ${detail}`);
    if (errorCode === "ENOENT" && index < candidates.length - 1) {
      console.log(`${candidate.command} was not found. Trying the next install fallback...`);
      continue;
    }
    if (index < candidates.length - 1) {
      console.log(`${candidate.label} failed (${detail}). Trying the next install fallback...`);
    }
  }
  return {
    ok: false,
    error: failures.length > 0 ? failures.join("; ") : "No install command was available.",
  };
}

function attemptGatewayRestart({ configPath }) {
  const env = buildOpenClawCommandEnv(configPath);
  const candidates = [
    {
      label: "openclaw",
      command: "openclaw",
      args: ["gateway", "restart"],
    },
    {
      label: "npm exec fallback",
      command: "npm",
      args: ["exec", "-y", "openclaw@latest", "--", "gateway", "restart"],
    },
  ];
  const failures = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const result = runGatewayCommand(candidate.command, candidate.args, env);
    if (result.status === 0 && !result.error) {
      return {
        ok: true,
        method: candidate.label,
      };
    }
    const detail = result.error
      ? result.error.message
      : (result.stderr || result.stdout || (result.signal
          ? `terminated by signal ${result.signal}`
          : `exited with code ${result.status}`)).trim();
    failures.push(`${candidate.label} failed: ${detail}`);
    const errorCode = result.error && typeof result.error === "object" ? result.error.code : "";
    if (!(errorCode === "ENOENT" && index < candidates.length - 1)) {
      break;
    }
  }
  return {
    ok: false,
    error: failures.join("; "),
  };
}

async function waitForControllerHealth(port) {
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  const deadline = Date.now() + 120_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.get(
          url,
          {
            agent: false,
            headers: {
              Connection: "close",
            },
          },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk) => {
              body += chunk;
            });
            incoming.on("end", () => {
              resolve({
                statusCode: incoming.statusCode ?? 0,
                body,
              });
            });
          },
        );
        request.setTimeout(5_000, () => {
          request.destroy(new Error("request timed out"));
        });
        request.on("error", reject);
      });
      if (response.statusCode >= 200 && response.statusCode < 300) {
        const payload = JSON.parse(response.body);
        if (payload && payload.status === "ok" && payload.mode === "controller") {
          return {
            ok: true,
            url,
          };
        }
        lastError = "unexpected health payload";
      } else {
        try {
          const payload = JSON.parse(response.body);
          lastError = payload?.status
            ? `HTTP ${response.statusCode} (${payload.status})`
            : `HTTP ${response.statusCode}`;
        } catch {
          lastError = `HTTP ${response.statusCode}`;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return {
    ok: false,
    url,
    error: lastError || "timed out after 120s",
  };
}

async function collectInstallChoices(configPath, config, prompter, options) {
  const existingTeamClaw = getExistingTeamClawConfig(config);
  const existingMode = typeof existingTeamClaw.mode === "string" ? existingTeamClaw.mode.trim() : "";
  const existingProvisioningType =
    typeof existingTeamClaw.workerProvisioningType === "string" ? existingTeamClaw.workerProvisioningType.trim() : "";
  const agentIsolationMode = options.agentMode || resolveCurrentAgentIsolationMode(config);
  let modeDefault = "controller-process";
  if (existingMode === "worker") {
    modeDefault = "worker";
  } else if (existingMode === "controller") {
    if (existingProvisioningType === "docker") {
      modeDefault = "controller-docker";
    } else if (existingProvisioningType === "kubernetes") {
      modeDefault = "controller-kubernetes";
    } else if (existingProvisioningType === "process") {
      modeDefault = "controller-process";
    } else {
      modeDefault = "controller-manual";
    }
  }

  const installMode = options.installMode || await prompter.select({
    message: "Choose an installation mode",
    options: INSTALL_MODE_OPTIONS,
    defaultValue: modeDefault,
  });

  const modelInfo = extractModelOptions(config);
  let selectedModel = modelInfo.currentModel;
  if (modelInfo.options.length > 0) {
    selectedModel = await prompter.select({
      message: "Choose the OpenClaw default model TeamClaw should use",
      options: modelInfo.options,
      defaultValue: modelInfo.currentModel || modelInfo.options[0].value,
    });
  } else {
    selectedModel = await prompter.text({
      message: "Enter the OpenClaw default model (provider/model-id) or leave empty to keep it unchanged",
      defaultValue: modelInfo.currentModel,
      allowEmpty: true,
    });
  }

  const teamName = await prompter.text({
    message: "Team name",
    defaultValue: options.teamName || (
      typeof existingTeamClaw.teamName === "string" && existingTeamClaw.teamName.trim()
        ? existingTeamClaw.teamName.trim()
        : DEFAULT_TEAM_NAME
    ),
  });
  const workspacePath = expandUserPath(await prompter.text({
    message: agentIsolationMode === "main"
      ? "Main OpenClaw workspace directory"
      : "TeamClaw dedicated workspace directory",
    defaultValue: resolveInstallerWorkspaceDefault(configPath, config, agentIsolationMode),
  }));

  if (installMode === "worker") {
    const workerRole = await prompter.select({
      message: "Choose the worker role for this node",
      options: ROLE_OPTIONS,
      defaultValue: options.workerRole || (
        typeof existingTeamClaw.role === "string" && existingTeamClaw.role.trim()
          ? existingTeamClaw.role.trim()
          : DEFAULT_WORKER_ROLE || ROLE_OPTIONS[0].value
      ),
    });
    const workerPort = await prompter.number({
      message: "Worker API port",
      defaultValue:
        typeof existingTeamClaw.port === "number" && existingTeamClaw.port >= 1
          ? existingTeamClaw.port
          : DEFAULT_WORKER_PORT,
      min: 1,
      max: 65535,
    });
    const existingControllerUrl =
      typeof existingTeamClaw.controllerUrl === "string" && existingTeamClaw.controllerUrl.trim()
        ? existingTeamClaw.controllerUrl.trim()
        : "";
    let workerControllerMode = existingControllerUrl ? "manual" : "mdns";
    let mdnsCapability = { available: true, reason: "" };
    if (options.controllerUrl) {
      workerControllerMode = "manual";
    } else if (!prompter.yes) {
      mdnsCapability = await detectMdnsCapability();
      if (mdnsCapability.available) {
        prompter.note("mDNS discovery looks available on this machine.");
        prompter.note("Use LAN auto-registration only when the controller is reachable on the same local network. Otherwise enter the controller URL manually.");
        workerControllerMode = await prompter.select({
          message: "How should this worker find its controller?",
          options: [
            {
              value: "mdns",
              label: "Use LAN auto-registration via mDNS",
              hint: "Best when worker and controller are on the same LAN.",
            },
            {
              value: "manual",
              label: "Enter controller URL manually",
              hint: "Required when controller is outside the LAN or mDNS is blocked.",
            },
          ],
          defaultValue: existingControllerUrl ? "manual" : "mdns",
        });
      } else {
        prompter.note(`mDNS auto-registration is not available on this machine (${mdnsCapability.reason || "probe failed"}).`);
        workerControllerMode = "manual";
      }
    }
    const controllerUrl = workerControllerMode === "manual"
      ? await prompter.text({
          message: "Controller URL",
          defaultValue: options.controllerUrl || existingControllerUrl || "http://127.0.0.1:9527",
          validate: (value) => value.startsWith("http://") || value.startsWith("https://")
            ? ""
            : 'Controller URL must start with "http://" or "https://".',
        })
      : "";
    return {
      installMode,
      agentIsolationMode,
      selectedModel,
      teamName,
      workspacePath,
      workerRole,
      workerPort,
      controllerUrl,
      workerControllerMode,
      mdnsAvailable: mdnsCapability.available,
    };
  }

  const controllerPort = await prompter.number({
    message: "Controller API port",
    defaultValue:
      typeof existingTeamClaw.port === "number" && existingTeamClaw.port >= 1
        ? existingTeamClaw.port
        : DEFAULT_CONTROLLER_PORT,
    min: 1,
    max: 65535,
  });

  if (installMode === "controller-manual") {
    return {
      installMode,
      agentIsolationMode,
      selectedModel,
      teamName,
      workspacePath,
      controllerPort,
    };
  }

  const provisioningRoles = await promptOptionalRoleList(
    prompter,
    `Preferred on-demand roles (comma-separated, leave empty to keep workerProvisioningRoles empty and let startup readiness default to a warm ${DEFAULT_WORKER_ROLE} worker)`,
    resolveDefaultProvisioningRoles(existingTeamClaw),
  );
  const maxPerRole = await prompter.number({
    message: "Maximum on-demand workers per role",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningMaxPerRole === "number" && existingTeamClaw.workerProvisioningMaxPerRole >= 1
        ? existingTeamClaw.workerProvisioningMaxPerRole
        : 10,
    min: 1,
    max: 50,
  });

  if (installMode === "controller-process") {
    return {
      installMode,
      agentIsolationMode,
      selectedModel,
      teamName,
      workspacePath,
      controllerPort,
      provisioningRoles,
      maxPerRole,
    };
  }

  if (installMode === "controller-docker") {
    const controllerUrl = await prompter.text({
      message: "Controller URL visible from Docker containers",
      defaultValue:
        typeof existingTeamClaw.workerProvisioningControllerUrl === "string" && existingTeamClaw.workerProvisioningControllerUrl.trim()
          ? existingTeamClaw.workerProvisioningControllerUrl.trim()
          : "http://host.docker.internal:9527",
      validate: (value) => value.startsWith("http://") || value.startsWith("https://")
        ? ""
        : 'Controller URL must start with "http://" or "https://".',
    });
    const workerImage = await prompter.text({
      message: "Docker/Kubernetes worker image",
      defaultValue:
        typeof existingTeamClaw.workerProvisioningImage === "string" && existingTeamClaw.workerProvisioningImage.trim()
          ? existingTeamClaw.workerProvisioningImage.trim()
          : DEFAULT_TEAMCLAW_IMAGE,
    });
    const dockerWorkspaceVolume = await prompter.text({
      message: "Docker workspace volume or host path (leave empty for isolated ephemeral workspaces)",
      defaultValue:
        typeof existingTeamClaw.workerProvisioningDockerWorkspaceVolume === "string"
          ? existingTeamClaw.workerProvisioningDockerWorkspaceVolume.trim()
          : "",
      allowEmpty: true,
    });
    return {
      installMode,
      agentIsolationMode,
      selectedModel,
      teamName,
      workspacePath,
      controllerPort,
      provisioningRoles,
      maxPerRole,
      controllerUrl,
      workerImage,
      dockerWorkspaceVolume,
    };
  }

  const controllerUrl = await prompter.text({
    message: "Controller URL visible from Kubernetes pods",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningControllerUrl === "string" && existingTeamClaw.workerProvisioningControllerUrl.trim()
        ? existingTeamClaw.workerProvisioningControllerUrl.trim()
        : "http://teamclaw-controller.default.svc.cluster.local:9527",
    validate: (value) => value.startsWith("http://") || value.startsWith("https://")
      ? ""
      : 'Controller URL must start with "http://" or "https://".',
  });
  const workerImage = await prompter.text({
    message: "Docker/Kubernetes worker image",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningImage === "string" && existingTeamClaw.workerProvisioningImage.trim()
        ? existingTeamClaw.workerProvisioningImage.trim()
        : DEFAULT_TEAMCLAW_IMAGE,
  });
  const namespace = await prompter.text({
    message: "Kubernetes namespace",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningKubernetesNamespace === "string" &&
          existingTeamClaw.workerProvisioningKubernetesNamespace.trim()
        ? existingTeamClaw.workerProvisioningKubernetesNamespace.trim()
        : "default",
  });
  const serviceAccount = await prompter.text({
    message: "Kubernetes service account",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningKubernetesServiceAccount === "string" &&
          existingTeamClaw.workerProvisioningKubernetesServiceAccount.trim()
        ? existingTeamClaw.workerProvisioningKubernetesServiceAccount.trim()
        : "teamclaw-worker",
  });
  const kubernetesWorkspacePersistentVolumeClaim = await prompter.text({
    message: "Kubernetes workspace PVC (leave empty for isolated ephemeral workspaces)",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningKubernetesWorkspacePersistentVolumeClaim === "string"
        ? existingTeamClaw.workerProvisioningKubernetesWorkspacePersistentVolumeClaim.trim()
        : "",
    allowEmpty: true,
  });
  return {
    installMode,
    agentIsolationMode,
    selectedModel,
    teamName,
    workspacePath,
    controllerPort,
    provisioningRoles,
    maxPerRole,
    controllerUrl,
    workerImage,
    namespace,
    serviceAccount,
    kubernetesWorkspacePersistentVolumeClaim,
  };
}

function upsertAgentListEntry(agents, agentId, update) {
  const legacyList = Array.isArray(agents.list) ? agents.list.filter(isRecord) : [];
  // OpenClaw 2026.10+ rejects agents.list ("moved to keyed agents.entries").
  // Write the keyed shape whenever the host already uses it, or when there is
  // no legacy list to stay compatible with; only keep the array on hosts that
  // still have one.
  const useKeyedEntries = isRecord(agents.entries) || legacyList.length === 0;
  if (!useKeyedEntries) {
    const existingIndex = legacyList.findIndex((entry) => entry.id === agentId);
    const nextEntry = {
      ...(existingIndex >= 0 ? legacyList[existingIndex] : {}),
      id: agentId,
      ...update,
    };
    if (existingIndex >= 0) {
      legacyList[existingIndex] = nextEntry;
    } else {
      legacyList.push(nextEntry);
    }
    agents.list = legacyList;
    return;
  }
  const entries = isRecord(agents.entries) ? agents.entries : {};
  // Fold legacy list entries into the keyed map once, then drop the list.
  for (const legacyEntry of legacyList) {
    const legacyId = isRecord(legacyEntry) && typeof legacyEntry.id === "string" ? legacyEntry.id : "";
    if (!legacyId || isRecord(entries[legacyId])) {
      continue;
    }
    const migrated = { ...legacyEntry };
    delete migrated.id;
    entries[legacyId] = migrated;
  }
  const existingKeyed = isRecord(entries[agentId]) ? entries[agentId] : {};
  entries[agentId] = {
    ...existingKeyed,
    ...update,
  };
  agents.entries = entries;
  delete agents.list;
  if (Object.keys(entries).length > 1) {
    agents.ownership = "explicit";
  }
}

function removeAgentListEntry(agents, agentId) {
  if (isRecord(agents.entries)) {
    delete agents.entries[agentId];
  }
  if (!Array.isArray(agents.list)) {
    return;
  }
  agents.list = agents.list.filter((entry) => !isRecord(entry) || entry.id !== agentId);
}

function applyTeamClawHostRuntimeDefaults(next) {
  const commands = ensureRecord(next, "commands");
  if (typeof commands.native !== "string" || !commands.native.trim()) {
    commands.native = TEAMCLAW_RECOMMENDED_COMMAND_MODE;
  }
  if (typeof commands.nativeSkills !== "string" || !commands.nativeSkills.trim()) {
    commands.nativeSkills = TEAMCLAW_RECOMMENDED_COMMAND_MODE;
  }
  if (typeof commands.restart !== "boolean") {
    commands.restart = true;
  }
  if (typeof commands.ownerDisplay !== "string" || !commands.ownerDisplay.trim()) {
    commands.ownerDisplay = "raw";
  }

  const tools = ensureRecord(next, "tools");
  const exec = ensureRecord(tools, "exec");
  if (typeof exec.mode === "string" && exec.mode.trim()) {
    // OpenClaw 2026.10+ forbids mixing mode with security/ask in one exec
    // object; mode="full" is the equivalent of security="full" + ask="off".
    delete exec.security;
    delete exec.ask;
  } else {
    if (typeof exec.security !== "string" || !exec.security.trim()) {
      exec.security = TEAMCLAW_RECOMMENDED_EXEC_SECURITY;
    }
    if (typeof exec.ask !== "string" || !exec.ask.trim()) {
      exec.ask = TEAMCLAW_RECOMMENDED_EXEC_ASK;
    }
  }
}

function collectTeamClawHostRuntimeWarnings(config) {
  const warnings = [];
  const commands = isRecord(config.commands) ? config.commands : null;
  const tools = isRecord(config.tools) ? config.tools : null;
  const exec = tools && isRecord(tools.exec) ? tools.exec : null;

  if (typeof exec?.mode === "string" && exec.mode.trim()) {
    // Modern hosts configure tools.exec.mode; mode="full" maps to the
    // recommended security/ask defaults, so only warn on stricter modes.
    if (exec.mode.trim() !== TEAMCLAW_RECOMMENDED_EXEC_SECURITY) {
      warnings.push(
        `tools.exec.mode is set to "${exec.mode.trim()}" (TeamClaw works best with "${TEAMCLAW_RECOMMENDED_EXEC_SECURITY}"; stricter settings can block task execution or trigger repeated approvals).`,
      );
    }
    return warnings;
  }

  const execSecurity = typeof exec?.security === "string" ? exec.security.trim() : "";
  if (execSecurity && execSecurity !== TEAMCLAW_RECOMMENDED_EXEC_SECURITY) {
    warnings.push(
      `tools.exec.security is set to "${execSecurity}" (TeamClaw works best with "${TEAMCLAW_RECOMMENDED_EXEC_SECURITY}"; stricter settings can block task execution).`,
    );
  }

  const execAsk = typeof exec?.ask === "string" ? exec.ask.trim() : "";
  if (execAsk && execAsk !== TEAMCLAW_RECOMMENDED_EXEC_ASK) {
    warnings.push(
      `tools.exec.ask is set to "${execAsk}" (TeamClaw works best with "${TEAMCLAW_RECOMMENDED_EXEC_ASK}"; stricter settings can trigger repeated approvals).`,
    );
  }

  if (commands?.restart === false) {
    warnings.push('commands.restart is disabled, so the installer cannot auto-restart OpenClaw after config changes.');
  }

  return warnings;
}

function applyInstallerChoices(config, choices, configPath) {
  const next = isRecord(config) ? structuredClone(config) : {};
  const gateway = ensureRecord(next, "gateway");
  if (typeof gateway.port !== "number" || gateway.port < 1) {
    gateway.port = DEFAULT_GATEWAY_PORT;
  }
  if (typeof gateway.mode !== "string" || !gateway.mode.trim()) {
    gateway.mode = "local";
  }
  if (typeof gateway.bind !== "string" || !gateway.bind.trim()) {
    gateway.bind = "lan";
  }

  const agents = ensureRecord(next, "agents");
  const agentDefaults = ensureRecord(agents, "defaults");
  if (choices.selectedModel) {
    agentDefaults.model = applySelectedModel(agentDefaults.model, choices.selectedModel);
  }
  if (choices.agentIsolationMode === "main" && choices.workspacePath) {
    agentDefaults.workspace = choices.workspacePath;
  }
  if (choices.agentIsolationMode === "independent") {
    upsertAgentListEntry(agents, TEAMCLAW_AGENT_ID, {
      workspace: choices.workspacePath,
      agentDir: resolveDefaultTeamClawAgentDirForConfigPath(configPath),
      ...(agentDefaults.model != null ? { model: cloneJsonValue(agentDefaults.model) } : {}),
    });
  } else {
    removeAgentListEntry(agents, TEAMCLAW_AGENT_ID);
  }
  const existingTimeout = typeof agentDefaults.timeoutSeconds === "number"
    ? agentDefaults.timeoutSeconds
    : 0;
  if (!Number.isFinite(existingTimeout) || existingTimeout < DEFAULT_AGENT_TIMEOUT_SECONDS) {
    agentDefaults.timeoutSeconds = DEFAULT_AGENT_TIMEOUT_SECONDS;
  }

  const plugins = ensureRecord(next, "plugins");
  plugins.enabled = true;
  const entries = ensureRecord(plugins, "entries");
  const teamclawEntry = ensureRecord(entries, PLUGIN_ID);
  teamclawEntry.enabled = true;
  const teamclawConfig = {
    ...(isRecord(teamclawEntry.config) ? teamclawEntry.config : {}),
  };

  teamclawConfig.teamName = choices.teamName;
  teamclawConfig.heartbeatIntervalMs = typeof teamclawConfig.heartbeatIntervalMs === "number" &&
      teamclawConfig.heartbeatIntervalMs >= 1_000
    ? teamclawConfig.heartbeatIntervalMs
    : 10_000;
  teamclawConfig.taskTimeoutMs = Math.max(
    typeof teamclawConfig.taskTimeoutMs === "number" ? teamclawConfig.taskTimeoutMs : 0,
    DEFAULT_TASK_TIMEOUT_MS,
  );
  teamclawConfig.processModel = "multi";
  teamclawConfig.gitEnabled = typeof teamclawConfig.gitEnabled === "boolean" ? teamclawConfig.gitEnabled : true;
  teamclawConfig.gitDefaultBranch = typeof teamclawConfig.gitDefaultBranch === "string" && teamclawConfig.gitDefaultBranch.trim()
    ? teamclawConfig.gitDefaultBranch.trim()
    : "main";
  teamclawConfig.gitAuthorName = typeof teamclawConfig.gitAuthorName === "string" && teamclawConfig.gitAuthorName.trim()
    ? teamclawConfig.gitAuthorName.trim()
    : "TeamClaw";
  teamclawConfig.gitAuthorEmail = typeof teamclawConfig.gitAuthorEmail === "string" && teamclawConfig.gitAuthorEmail.trim()
    ? teamclawConfig.gitAuthorEmail.trim()
    : "teamclaw@local";
  teamclawConfig.agentIsolationMode = choices.agentIsolationMode;

  teamclawConfig.workerProvisioningMinPerRole = 0;
  teamclawConfig.workerProvisioningIdleTtlMs = typeof teamclawConfig.workerProvisioningIdleTtlMs === "number" &&
      teamclawConfig.workerProvisioningIdleTtlMs >= 1_000
    ? teamclawConfig.workerProvisioningIdleTtlMs
    : 120_000;
  teamclawConfig.workerProvisioningStartupTimeoutMs = typeof teamclawConfig.workerProvisioningStartupTimeoutMs === "number" &&
      teamclawConfig.workerProvisioningStartupTimeoutMs >= 1_000
    ? teamclawConfig.workerProvisioningStartupTimeoutMs
    : 120_000;
  teamclawConfig.workerProvisioningDockerNetwork = typeof teamclawConfig.workerProvisioningDockerNetwork === "string"
    ? teamclawConfig.workerProvisioningDockerNetwork.trim()
    : "";
  teamclawConfig.workerProvisioningDockerMounts = Array.isArray(teamclawConfig.workerProvisioningDockerMounts)
    ? teamclawConfig.workerProvisioningDockerMounts.filter((value) => typeof value === "string" && value.trim())
    : [];
  teamclawConfig.workerProvisioningWorkspaceRoot = typeof teamclawConfig.workerProvisioningWorkspaceRoot === "string"
    ? teamclawConfig.workerProvisioningWorkspaceRoot.trim()
    : "";
  teamclawConfig.workerProvisioningDockerWorkspaceVolume =
    typeof teamclawConfig.workerProvisioningDockerWorkspaceVolume === "string"
      ? teamclawConfig.workerProvisioningDockerWorkspaceVolume.trim()
      : "";
  teamclawConfig.workerProvisioningKubernetesContext =
    typeof teamclawConfig.workerProvisioningKubernetesContext === "string"
      ? teamclawConfig.workerProvisioningKubernetesContext.trim()
      : "";
  teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim =
    typeof teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim === "string"
      ? teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim.trim()
      : "";
  teamclawConfig.workerProvisioningKubernetesLabels = isRecord(teamclawConfig.workerProvisioningKubernetesLabels)
    ? teamclawConfig.workerProvisioningKubernetesLabels
    : {};
  teamclawConfig.workerProvisioningKubernetesAnnotations = isRecord(teamclawConfig.workerProvisioningKubernetesAnnotations)
    ? teamclawConfig.workerProvisioningKubernetesAnnotations
    : {};

  if (choices.installMode === "worker") {
    teamclawConfig.mode = "worker";
    teamclawConfig.port = choices.workerPort;
    teamclawConfig.role = choices.workerRole;
    teamclawConfig.controllerUrl = choices.controllerUrl;
    teamclawConfig.workerProvisioningType = "none";
    teamclawConfig.workerProvisioningDisabled = true;
    teamclawConfig.workerProvisioningControllerUrl = "";
    teamclawConfig.workerProvisioningRoles = [];
    teamclawConfig.workerProvisioningMaxPerRole = 10;
    teamclawConfig.workerProvisioningImage = "";
    teamclawConfig.workerProvisioningPassEnv = [];
    teamclawConfig.workerProvisioningExtraEnv = {};
    teamclawConfig.workerProvisioningWorkspaceRoot = "";
    teamclawConfig.workerProvisioningDockerWorkspaceVolume = "";
    teamclawConfig.workerProvisioningKubernetesNamespace = "default";
    teamclawConfig.workerProvisioningKubernetesServiceAccount = "";
    teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim = "";
  } else {
    teamclawConfig.mode = "controller";
    teamclawConfig.port = choices.controllerPort;
    teamclawConfig.controllerUrl = "";
    delete teamclawConfig.role;

    if (choices.installMode === "controller-manual") {
      teamclawConfig.workerProvisioningType = "process";
      teamclawConfig.workerProvisioningDisabled = false;
      teamclawConfig.workerProvisioningControllerUrl = "";
      teamclawConfig.workerProvisioningRoles = [];
      teamclawConfig.workerProvisioningMaxPerRole = 1;
      teamclawConfig.workerProvisioningImage = "";
      teamclawConfig.workerProvisioningPassEnv = [];
      teamclawConfig.workerProvisioningExtraEnv = {};
      teamclawConfig.workerProvisioningWorkspaceRoot = "";
      teamclawConfig.workerProvisioningDockerWorkspaceVolume = "";
      teamclawConfig.workerProvisioningKubernetesNamespace = "default";
      teamclawConfig.workerProvisioningKubernetesServiceAccount = "";
      teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim = "";
    } else if (choices.installMode === "controller-process") {
      teamclawConfig.workerProvisioningType = "process";
      teamclawConfig.workerProvisioningDisabled = false;
      teamclawConfig.workerProvisioningControllerUrl = "";
      teamclawConfig.workerProvisioningRoles = choices.provisioningRoles;
      teamclawConfig.workerProvisioningMaxPerRole = choices.maxPerRole;
      teamclawConfig.workerProvisioningImage = "";
      teamclawConfig.workerProvisioningPassEnv = [];
      teamclawConfig.workerProvisioningExtraEnv = {};
      teamclawConfig.workerProvisioningWorkspaceRoot = "";
      teamclawConfig.workerProvisioningDockerWorkspaceVolume = "";
      teamclawConfig.workerProvisioningKubernetesNamespace = "default";
      teamclawConfig.workerProvisioningKubernetesServiceAccount = "";
      teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim = "";
    } else if (choices.installMode === "controller-docker") {
      teamclawConfig.workerProvisioningType = "docker";
      teamclawConfig.workerProvisioningDisabled = false;
      teamclawConfig.workerProvisioningControllerUrl = choices.controllerUrl;
      teamclawConfig.workerProvisioningRoles = choices.provisioningRoles;
      teamclawConfig.workerProvisioningMaxPerRole = choices.maxPerRole;
      teamclawConfig.workerProvisioningImage = choices.workerImage;
      teamclawConfig.workerProvisioningPassEnv = ["DOCKER_HOST", "DOCKER_CONFIG", "KUBECONFIG", "NO_PROXY"];
      teamclawConfig.workerProvisioningExtraEnv = {};
      teamclawConfig.workerProvisioningWorkspaceRoot = choices.dockerWorkspaceVolume ? "/workspace-root" : "";
      teamclawConfig.workerProvisioningDockerWorkspaceVolume = choices.dockerWorkspaceVolume;
      teamclawConfig.workerProvisioningKubernetesNamespace = "default";
      teamclawConfig.workerProvisioningKubernetesServiceAccount = "";
      teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim = "";
    } else if (choices.installMode === "controller-kubernetes") {
      teamclawConfig.workerProvisioningType = "kubernetes";
      teamclawConfig.workerProvisioningDisabled = false;
      teamclawConfig.workerProvisioningControllerUrl = choices.controllerUrl;
      teamclawConfig.workerProvisioningRoles = choices.provisioningRoles;
      teamclawConfig.workerProvisioningMaxPerRole = choices.maxPerRole;
      teamclawConfig.workerProvisioningImage = choices.workerImage;
      teamclawConfig.workerProvisioningPassEnv = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
      teamclawConfig.workerProvisioningExtraEnv = {};
      teamclawConfig.workerProvisioningWorkspaceRoot = choices.kubernetesWorkspacePersistentVolumeClaim
        ? "/workspace-root"
        : "";
      teamclawConfig.workerProvisioningDockerWorkspaceVolume = "";
      teamclawConfig.workerProvisioningKubernetesNamespace = choices.namespace;
      teamclawConfig.workerProvisioningKubernetesServiceAccount = choices.serviceAccount;
      teamclawConfig.workerProvisioningKubernetesWorkspacePersistentVolumeClaim =
        choices.kubernetesWorkspacePersistentVolumeClaim;
    }
  }

  teamclawEntry.config = teamclawConfig;
  entries[PLUGIN_ID] = teamclawEntry;
  plugins.entries = entries;
  next.plugins = plugins;
  next.agents = agents;
  applyTeamClawHostRuntimeDefaults(next);
  next.gateway = gateway;
  return next;
}

function buildSummaryLines(params) {
  const lines = [
    `Config path: ${params.configPath}`,
    `Install mode: ${params.choices.installMode}`,
    `Agent isolation: ${params.choices.agentIsolationMode}`,
    `Workspace: ${params.choices.workspacePath}`,
  ];
  if (params.choices.selectedModel) {
    lines.push(`Default model: ${params.choices.selectedModel}`);
  }
  const effectiveTeamClawModel = resolveModelPrimaryValue(resolveEffectiveTeamClawModel(params.nextConfig));
  if (effectiveTeamClawModel) {
    lines.push(`TeamClaw agent model: ${effectiveTeamClawModel}`);
  } else {
    lines.push("Warning: TeamClaw has no effective model configured yet, so it can start but cannot work until a host model is configured.");
  }
  if (params.backupPath) {
    lines.push(`Backup: ${params.backupPath}`);
  }
  if (params.pluginInstallStatus === "installed") {
    lines.push(`Plugin install: completed via ${params.pluginInstallMethod}`);
  } else if (params.pluginInstallStatus === "already-installed") {
    lines.push(`Plugin install: ${params.pluginInstallMethod}`);
  } else if (params.pluginInstallStatus === "skipped") {
    lines.push("Plugin install: skipped");
  } else if (params.pluginInstallError) {
    lines.push(`Plugin install: ${params.pluginInstallError}`);
  }
  if (params.gatewayRestartStatus === "restarted") {
    lines.push(`Gateway restart: completed via ${params.gatewayRestartMethod}`);
  } else if (params.gatewayRestartStatus === "failed") {
    lines.push(`Gateway restart: ${params.gatewayRestartError}`);
  }
  if (params.controllerHealthStatus === "ok") {
    lines.push(`Controller health: ok (${params.controllerHealthUrl})`);
  } else if (params.controllerHealthStatus === "failed") {
    lines.push(`Controller health: ${params.controllerHealthError} (${params.controllerHealthUrl})`);
  }
  if (params.teamclawAuthBootstrap?.copied) {
    lines.push(`TeamClaw auth bootstrap: copied from ${params.teamclawAuthBootstrap.sourcePath}`);
  } else if (params.teamclawAuthBootstrap?.warning) {
    lines.push(`Warning: ${params.teamclawAuthBootstrap.warning}`);
  }
  lines.push(
    `Host exec defaults: security=${TEAMCLAW_RECOMMENDED_EXEC_SECURITY}, ask=${TEAMCLAW_RECOMMENDED_EXEC_ASK} (applied when missing)`,
  );
  lines.push(`Start command: ${buildStartCommand(params.configPath)}`);

  if (isControllerInstallMode(params.choices.installMode)) {
    const lanUiUrls = listLanUiUrls(params.choices.controllerPort);
    if (lanUiUrls.length > 0) {
      lines.push(`Open UI (LAN): ${lanUiUrls[0]}`);
    }
    lines.push(`Open UI (local): ${getLocalUiUrl(params.choices.controllerPort)}`);
  }
  if (params.choices.installMode === "controller-docker" || params.choices.installMode === "controller-kubernetes") {
    lines.push(`Provisioning image: ${params.choices.workerImage}`);
  }
  if (isOnDemandControllerInstallMode(params.choices.installMode)) {
    lines.push(`On-demand roles: ${describeProvisioningRoles(params.choices.provisioningRoles)}`);
  }
  if (params.choices.installMode === "controller-docker" && params.choices.dockerWorkspaceVolume) {
    lines.push(`Docker workspace volume: ${params.choices.dockerWorkspaceVolume}`);
  }
  if (
    params.choices.installMode === "controller-kubernetes" &&
    params.choices.kubernetesWorkspacePersistentVolumeClaim
  ) {
    lines.push(`Kubernetes workspace PVC: ${params.choices.kubernetesWorkspacePersistentVolumeClaim}`);
  }
  if (params.choices.installMode === "worker") {
    lines.push(`Worker role: ${params.choices.workerRole}`);
    if (params.choices.controllerUrl) {
      lines.push(`Controller URL: ${params.choices.controllerUrl}`);
    } else {
      lines.push("Controller discovery: mDNS auto-registration");
      lines.push("Note: mDNS auto-registration only works when the controller is reachable on the same LAN.");
    }
  }
  for (const warning of params.hostRuntimeWarnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  return lines;
}

async function runInstall(options) {
  if (!options.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("Interactive install requires a TTY. Re-run with --yes or in a terminal.");
  }
  ensureRoleOptionsLoaded();

  const prompter = new Prompter({ yes: options.yes });
  try {
    const configPath = expandUserPath(
      options.configPath || await prompter.text({
        message: "OpenClaw config path",
        defaultValue: resolveDefaultOpenClawConfigPath(),
      }),
    );

    if (!configPath) {
      throw new Error("OpenClaw config path is required.");
    }

    let backupPath = null;
    if (await pathExists(configPath)) {
      backupPath = await createBackup(configPath, options.dryRun);
    }
    const configWasCreated = await ensureConfigFile(configPath, options.dryRun);
    if (configWasCreated) {
      prompter.note(options.dryRun
        ? `Would create ${configPath}`
        : `Created ${configPath}`);
    }

    let pluginInstallStatus = "skipped";
    let pluginInstallMethod = "";
    let pluginInstallError = "";
    if (!options.skipPluginInstall && !options.dryRun) {
      const installResult = attemptPluginInstall({ configPath });
      if (installResult.ok) {
        pluginInstallStatus = installResult.skipped ? "already-installed" : "installed";
        pluginInstallMethod = installResult.method;
      } else {
        pluginInstallStatus = "failed";
        pluginInstallError = installResult.error;
        const continueWithoutPluginInstall = await prompter.confirm({
          message: `Plugin installation failed (${installResult.error}). Continue configuring openclaw.json anyway?`,
          defaultValue: true,
        });
        if (!continueWithoutPluginInstall) {
          process.exitCode = 1;
          return;
        }
      }
    }

    const config = await readOpenClawConfig(configPath);
    const choices = await collectInstallChoices(configPath, config, prompter, options);
    const nextConfig = applyInstallerChoices(config, choices, configPath);

    if (options.dryRun) {
      prompter.note("\nDry run only; no files were written.");
    } else {
      await writeConfig(configPath, nextConfig);
    }
    const teamclawAuthBootstrap = options.dryRun
      ? { copied: false, sourcePath: "", targetPath: "", warning: "" }
      : await bootstrapTeamClawAgentAuth(configPath, nextConfig);
    const hostRuntimeWarnings = collectTeamClawHostRuntimeWarnings(nextConfig);

    let gatewayRestartStatus = "skipped";
    let gatewayRestartMethod = "";
    let gatewayRestartError = "";
    let controllerHealthStatus = "skipped";
    let controllerHealthUrl = "";
    let controllerHealthError = "";
    if (!options.dryRun) {
      const restartResult = attemptGatewayRestart({ configPath });
      if (restartResult.ok) {
        gatewayRestartStatus = "restarted";
        gatewayRestartMethod = restartResult.method;
        if (isControllerInstallMode(choices.installMode)) {
          const healthResult = await waitForControllerHealth(choices.controllerPort);
          controllerHealthStatus = healthResult.ok ? "ok" : "failed";
          controllerHealthUrl = healthResult.url;
          controllerHealthError = healthResult.error ?? "";
        }
      } else {
        gatewayRestartStatus = "failed";
        gatewayRestartError = restartResult.error;
      }
    }

    const summaryLines = buildSummaryLines({
      configPath,
      choices,
      backupPath,
      nextConfig,
      teamclawAuthBootstrap,
      hostRuntimeWarnings,
      pluginInstallStatus,
      pluginInstallMethod,
      pluginInstallError,
      gatewayRestartStatus,
      gatewayRestartMethod,
      gatewayRestartError,
      controllerHealthStatus,
      controllerHealthUrl,
      controllerHealthError,
    });

    prompter.note("\nTeamClaw installer summary");
    prompter.note("--------------------------");
    for (const line of summaryLines) {
      prompter.note(`- ${line}`);
    }
    prompter.note("");
    if (choices.installMode === "controller-docker") {
      prompter.note("Before using Docker provisioning, make sure the controller can reach the Docker daemon.");
    } else if (choices.installMode === "controller-kubernetes") {
      prompter.note("Before using Kubernetes provisioning, make sure kubectl, namespace access, and the worker image are ready.");
    } else if (choices.installMode === "controller-manual") {
      prompter.note("Next step: open the local TeamClaw UI and let it provision local workers on demand.");
    } else if (choices.installMode === "worker") {
      prompter.note("Next step: start this worker node so it can register with the controller.");
    }
  } finally {
    prompter.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // Issue #23 pairing commands dispatch before the installer parser (their
  // positional <controller-url> argument is not an installer flag).
  if (argv[0] === "pair") {
    const { help, options } = parsePairArgs(argv.slice(1));
    if (help) {
      printHelp();
      return;
    }
    await runPair(options);
    return;
  }
  if (argv[0] === "token") {
    const { help, options } = parseTokenArgs(argv.slice(1));
    if (help) {
      printHelp();
      return;
    }
    await runTokenReset(options);
    return;
  }
  await loadRoleOptions();
  const { command, options } = parseArgs(argv);
  if (command === "help") {
    printHelp();
    return;
  }
  if (command !== "install") {
    throw new Error(`Unknown command: ${command}`);
  }
  await runInstall(options);
}

main().catch((error) => {
  console.error(`TeamClaw installer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
