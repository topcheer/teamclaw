#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
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
const DEFAULT_TEAMCLAW_IMAGE = "ghcr.io/topcheer/teamclaw-openclaw:latest";
const DEFAULT_CONTROLLER_PORT = 9527;
const DEFAULT_WORKER_PORT = 9528;
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_TEAM_NAME = "default";
const DEFAULT_TASK_TIMEOUT_MS = 1_800_000;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 2_400;
const DEFAULT_LOCAL_ROLES = ["architect", "developer", "qa"];
const DEFAULT_PROVISIONING_ROLES = ["architect", "developer", "qa"];

const ROLE_OPTIONS = [
  { value: "pm", label: "Product Manager" },
  { value: "architect", label: "Software Architect" },
  { value: "developer", label: "Developer" },
  { value: "qa", label: "QA Engineer" },
  { value: "release-engineer", label: "Release Engineer" },
  { value: "infra-engineer", label: "Infrastructure Engineer" },
  { value: "devops", label: "DevOps Engineer" },
  { value: "security-engineer", label: "Security Engineer" },
  { value: "designer", label: "UI/UX Designer" },
  { value: "marketing", label: "Marketing Specialist" },
];

const INSTALL_MODE_OPTIONS = [
  {
    value: "single-local",
    label: "Single machine controller + localRoles",
    hint: "Recommended for first-time setup.",
  },
  {
    value: "controller-manual",
    label: "Controller only (manual distributed workers)",
    hint: "Use separate OpenClaw installs for workers.",
  },
  {
    value: "controller-process",
    label: "Controller + on-demand process workers",
    hint: "Launch workers as child processes on the same host.",
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
  help                    Show this help

Options:
  --config <path>         Override the OpenClaw config path
  --yes                   Accept the recommended defaults without prompting
  --skip-plugin-install   Only update openclaw.json; skip "openclaw plugins install"
  --dry-run               Show what would happen without writing files
`);
}

function parseArgs(argv) {
  const options = {
    configPath: "",
    yes: false,
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

function dedupeStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())));
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

function buildStartCommand(configPath) {
  const defaultPath = resolveDefaultOpenClawConfigPath();
  if (path.resolve(configPath) === path.resolve(defaultPath)) {
    return "openclaw gateway run";
  }
  return `OPENCLAW_CONFIG_PATH=${shellEscape(configPath)} openclaw gateway run`;
}

function shellEscape(value) {
  if (!value) {
    return "''";
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function installPluginWithCommand(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
  });
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ?? null,
  };
}

function createPackageTarball(env) {
  let tempDir = "";
  try {
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "teamclaw-installer-pack-"));
    const result = spawnSync(
      "npm",
      ["pack", PACKAGE_ROOT, "--pack-destination", tempDir, "--json", "--ignore-scripts"],
      {
        env,
        encoding: "utf8",
      },
    );
    if (result.status !== 0 || result.error) {
      const detail = result.error
        ? result.error.message
        : (result.stderr || result.stdout || `exited with code ${result.status}`).trim();
      throw new Error(detail || "npm pack failed");
    }
    const payload = JSON.parse(result.stdout);
    const filename = Array.isArray(payload) && payload[0] && typeof payload[0].filename === "string"
      ? payload[0].filename.trim()
      : "";
    if (!filename) {
      throw new Error("npm pack did not report a tarball filename");
    }
    const tarballPath = path.join(tempDir, filename);
    if (!fsSync.existsSync(tarballPath)) {
      throw new Error(`tarball was not created at ${tarballPath}`);
    }
    return {
      ok: true,
      tempDir,
      tarballPath,
    };
  } catch (error) {
    if (tempDir) {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function attemptPluginInstall({ configPath }) {
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const candidates = [];
  const tarballResult = createPackageTarball(env);
  if (tarballResult.ok) {
    console.log(
      `\nPacked ${PACKAGE_INSTALL_SPEC} into ${path.basename(tarballResult.tarballPath)} for local plugin install.`,
    );
    candidates.push(
      {
        label: "openclaw (local tarball)",
        command: "openclaw",
        args: ["plugins", "install", tarballResult.tarballPath],
        targetDescription: tarballResult.tarballPath,
      },
      {
        label: "npm exec fallback (local tarball)",
        command: "npm",
        args: ["exec", "-y", "openclaw@latest", "--", "plugins", "install", tarballResult.tarballPath],
        targetDescription: tarballResult.tarballPath,
      },
    );
  } else {
    console.log(
      `\nCould not pack ${PACKAGE_INSTALL_SPEC} into a local tarball (${tarballResult.error}). Falling back to registry install...`,
    );
  }
  candidates.push(
    {
      label: "openclaw (exact version fallback)",
      command: "openclaw",
      args: ["plugins", "install", PACKAGE_INSTALL_SPEC],
      targetDescription: PACKAGE_INSTALL_SPEC,
    },
    {
      label: "npm exec fallback (exact version fallback)",
      command: "npm",
      args: ["exec", "-y", "openclaw@latest", "--", "plugins", "install", PACKAGE_INSTALL_SPEC],
      targetDescription: PACKAGE_INSTALL_SPEC,
    },
  );

  try {
    const failures = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      console.log(`\nInstalling ${candidate.targetDescription} with ${candidate.label}...`);
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
  } finally {
    if (tarballResult.ok) {
      fsSync.rmSync(tarballResult.tempDir, { recursive: true, force: true });
    }
  }
}

async function collectInstallChoices(config, prompter) {
  const existingTeamClaw = getExistingTeamClawConfig(config);
  const existingMode = typeof existingTeamClaw.mode === "string" ? existingTeamClaw.mode.trim() : "";
  const modeDefault = existingMode === "worker" ? "worker" : "single-local";

  const installMode = await prompter.select({
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
    defaultValue:
      typeof existingTeamClaw.teamName === "string" && existingTeamClaw.teamName.trim()
        ? existingTeamClaw.teamName.trim()
        : DEFAULT_TEAM_NAME,
  });
  const workspacePath = expandUserPath(await prompter.text({
    message: "OpenClaw workspace directory",
    defaultValue: getCurrentWorkspacePath(config) || resolveDefaultOpenClawWorkspaceDir(),
  }));

  if (installMode === "worker") {
    const workerRole = await prompter.select({
      message: "Choose the worker role for this node",
      options: ROLE_OPTIONS,
      defaultValue:
        typeof existingTeamClaw.role === "string" && existingTeamClaw.role.trim()
          ? existingTeamClaw.role.trim()
          : "developer",
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
    const controllerUrl = await prompter.text({
      message: "Controller URL",
      defaultValue:
        typeof existingTeamClaw.controllerUrl === "string" && existingTeamClaw.controllerUrl.trim()
          ? existingTeamClaw.controllerUrl.trim()
          : "http://127.0.0.1:9527",
      validate: (value) => value.startsWith("http://") || value.startsWith("https://")
        ? ""
        : 'Controller URL must start with "http://" or "https://".',
    });
    return {
      installMode,
      selectedModel,
      teamName,
      workspacePath,
      workerRole,
      workerPort,
      controllerUrl,
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

  if (installMode === "single-local") {
    const localRoles = await promptRoleList(
      prompter,
      "Local roles to run in this OpenClaw instance (comma-separated)",
      Array.isArray(existingTeamClaw.localRoles) && existingTeamClaw.localRoles.length > 0
        ? existingTeamClaw.localRoles
        : DEFAULT_LOCAL_ROLES,
    );
    return {
      installMode,
      selectedModel,
      teamName,
      workspacePath,
      controllerPort,
      localRoles,
    };
  }

  if (installMode === "controller-manual") {
    return {
      installMode,
      selectedModel,
      teamName,
      workspacePath,
      controllerPort,
    };
  }

  const provisioningRoles = await promptRoleList(
    prompter,
    "On-demand roles to launch (comma-separated)",
    Array.isArray(existingTeamClaw.workerProvisioningRoles) && existingTeamClaw.workerProvisioningRoles.length > 0
      ? existingTeamClaw.workerProvisioningRoles
      : DEFAULT_PROVISIONING_ROLES,
  );
  const maxPerRole = await prompter.number({
    message: "Maximum on-demand workers per role",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningMaxPerRole === "number" && existingTeamClaw.workerProvisioningMaxPerRole >= 1
        ? existingTeamClaw.workerProvisioningMaxPerRole
        : 2,
    min: 1,
    max: 50,
  });

  if (installMode === "controller-process") {
    return {
      installMode,
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
      message: "Docker workspace volume or host path (leave empty for ephemeral workspaces)",
      defaultValue:
        typeof existingTeamClaw.workerProvisioningDockerWorkspaceVolume === "string"
          ? existingTeamClaw.workerProvisioningDockerWorkspaceVolume.trim()
          : "teamclaw-workspaces",
      allowEmpty: true,
    });
    return {
      installMode,
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
    message: "Kubernetes workspace PVC (leave empty for ephemeral workspaces)",
    defaultValue:
      typeof existingTeamClaw.workerProvisioningKubernetesWorkspacePersistentVolumeClaim === "string"
        ? existingTeamClaw.workerProvisioningKubernetesWorkspacePersistentVolumeClaim.trim()
        : "",
    allowEmpty: true,
  });
  return {
    installMode,
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

function applyInstallerChoices(config, choices) {
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
  if (choices.workspacePath) {
    agentDefaults.workspace = choices.workspacePath;
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
    teamclawConfig.localRoles = [];
    teamclawConfig.workerProvisioningType = "none";
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
  } else {
    teamclawConfig.mode = "controller";
    teamclawConfig.port = choices.controllerPort;
    teamclawConfig.controllerUrl = "";
    delete teamclawConfig.role;

    if (choices.installMode === "single-local") {
      teamclawConfig.localRoles = choices.localRoles;
      teamclawConfig.workerProvisioningType = "none";
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
    } else if (choices.installMode === "controller-manual") {
      teamclawConfig.localRoles = [];
      teamclawConfig.workerProvisioningType = "none";
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
      teamclawConfig.localRoles = [];
      teamclawConfig.workerProvisioningType = "process";
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
      teamclawConfig.localRoles = [];
      teamclawConfig.workerProvisioningType = "docker";
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
      teamclawConfig.localRoles = [];
      teamclawConfig.workerProvisioningType = "kubernetes";
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
  next.gateway = gateway;
  return next;
}

function buildSummaryLines(params) {
  const lines = [
    `Config path: ${params.configPath}`,
    `Install mode: ${params.choices.installMode}`,
    `Workspace: ${params.choices.workspacePath}`,
  ];
  if (params.choices.selectedModel) {
    lines.push(`Default model: ${params.choices.selectedModel}`);
  }
  if (params.backupPath) {
    lines.push(`Backup: ${params.backupPath}`);
  }
  if (params.pluginInstallStatus === "installed") {
    lines.push(`Plugin install: completed via ${params.pluginInstallMethod}`);
  } else if (params.pluginInstallStatus === "skipped") {
    lines.push("Plugin install: skipped");
  } else if (params.pluginInstallError) {
    lines.push(`Plugin install: ${params.pluginInstallError}`);
  }
  lines.push(`Start command: ${buildStartCommand(params.configPath)}`);

  if (params.choices.installMode === "single-local") {
    lines.push(`Open UI: http://127.0.0.1:${params.choices.controllerPort}/ui`);
  }
  if (params.choices.installMode === "controller-docker" || params.choices.installMode === "controller-kubernetes") {
    lines.push(`Provisioning image: ${params.choices.workerImage}`);
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
    lines.push(`Controller URL: ${params.choices.controllerUrl}`);
  }
  return lines;
}

async function runInstall(options) {
  if (!options.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("Interactive install requires a TTY. Re-run with --yes or in a terminal.");
  }

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
        pluginInstallStatus = "installed";
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
    const choices = await collectInstallChoices(config, prompter);
    const nextConfig = applyInstallerChoices(config, choices);

    if (options.dryRun) {
      prompter.note("\nDry run only; no files were written.");
    } else {
      await writeConfig(configPath, nextConfig);
    }

    const summaryLines = buildSummaryLines({
      configPath,
      choices,
      backupPath,
      pluginInstallStatus,
      pluginInstallMethod,
      pluginInstallError,
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
      prompter.note("Next step: run this installer again on your worker nodes with the dedicated worker mode.");
    } else if (choices.installMode === "worker") {
      prompter.note("Next step: start this worker node so it can register with the controller.");
    }
  } finally {
    prompter.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
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
