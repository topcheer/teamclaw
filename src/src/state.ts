import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { TeamProvisioningState, TeamState, WorkerIdentity } from "./types.js";

function resolvePluginStateDir(): string {
  const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) {
    return path.join(explicitStateDir, "plugins", "teamclaw");
  }

  const explicitHome = process.env.OPENCLAW_HOME?.trim() || process.env.HOME?.trim();
  const homeDir = explicitHome ? path.resolve(explicitHome) : os.homedir();
  return path.join(homeDir, ".openclaw", "plugins", "teamclaw");
}

const STATE_DIR = resolvePluginStateDir();

function createEmptyProvisioningState(): TeamProvisioningState {
  return {
    workers: {},
  };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function loadTeamState(teamName: string): Promise<TeamState | null> {
  const filePath = path.join(STATE_DIR, `${teamName}-team-state.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as TeamState;
    if (
      typeof parsed.teamName !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      !parsed.workers ||
      !parsed.tasks
    ) {
      return null;
    }
    if (!parsed.controllerRuns || typeof parsed.controllerRuns !== "object") {
      parsed.controllerRuns = {};
    }
    if (!Array.isArray(parsed.messages)) {
      parsed.messages = [];
    }
    if (!parsed.clarifications || typeof parsed.clarifications !== "object") {
      parsed.clarifications = {};
    }
    if (parsed.repo && typeof parsed.repo !== "object") {
      delete parsed.repo;
    }
    if (!parsed.provisioning || typeof parsed.provisioning !== "object") {
      parsed.provisioning = createEmptyProvisioningState();
    }
    if (!parsed.provisioning.workers || typeof parsed.provisioning.workers !== "object") {
      parsed.provisioning.workers = {};
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveTeamState(state: TeamState): Promise<void> {
  await ensureDir(STATE_DIR);
  const filePath = path.join(STATE_DIR, `${state.teamName}-team-state.json`);
  state.updatedAt = Date.now();
  state.provisioning = state.provisioning && typeof state.provisioning === "object"
    ? state.provisioning
    : createEmptyProvisioningState();
  state.provisioning.workers = state.provisioning.workers && typeof state.provisioning.workers === "object"
    ? state.provisioning.workers
    : {};
  state.controllerRuns = state.controllerRuns && typeof state.controllerRuns === "object"
    ? state.controllerRuns
    : {};
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function loadWorkerIdentity(): Promise<WorkerIdentity | null> {
  const filePath = path.join(STATE_DIR, "worker-identity.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WorkerIdentity;
    if (
      typeof parsed.workerId !== "string" ||
      typeof parsed.role !== "string" ||
      typeof parsed.controllerUrl !== "string" ||
      typeof parsed.registeredAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveWorkerIdentity(identity: WorkerIdentity): Promise<void> {
  await ensureDir(STATE_DIR);
  const filePath = path.join(STATE_DIR, "worker-identity.json");
  await fs.writeFile(filePath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

async function clearWorkerIdentity(): Promise<void> {
  const filePath = path.join(STATE_DIR, "worker-identity.json");
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

export {
  STATE_DIR,
  loadTeamState,
  saveTeamState,
  loadWorkerIdentity,
  saveWorkerIdentity,
  clearWorkerIdentity,
};
