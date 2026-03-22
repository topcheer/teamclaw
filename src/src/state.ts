import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { TeamState, WorkerIdentity } from "./types.js";

const STATE_DIR = path.join(os.homedir(), ".openclaw", "plugins", "teamclaw");

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
    if (!Array.isArray(parsed.messages)) {
      parsed.messages = [];
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
