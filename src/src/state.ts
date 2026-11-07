import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  RoleDefinition,
  RoleId,
  StartupProvisioningReadiness,
  TeamProvisioningState,
  TeamState,
  WorkerIdentity,
} from "./types.js";
import { validateRoleIdList } from "./roles.js";
// Phase 1.6: the legacy-state profileId migration defaults to the loader's
// software-rd baseline id (single literal source). profile-loader has no
// runtime edge back into this module, so no cycle.
import { SOFTWARE_RD_PROFILE_ID } from "./profile-loader.js";

const STATE_VERSION = 2;

function migrateState(raw: unknown): TeamState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const state = raw as Record<string, unknown>;

  // Basic structural guard — same checks as the old loadTeamState
  if (
    typeof state.teamName !== "string" ||
    typeof state.createdAt !== "number" ||
    typeof state.updatedAt !== "number" ||
    !state.workers ||
    !state.tasks
  ) {
    return null;
  }

  // Ensure required nested objects exist (defensive, same as before)
  if (!state.controllerRuns || typeof state.controllerRuns !== "object") {
    state.controllerRuns = {};
  }
  if (!state.projects || typeof state.projects !== "object") {
    state.projects = {};
  }
  if (!Array.isArray(state.messages)) {
    state.messages = [];
  }
  if (!state.clarifications || typeof state.clarifications !== "object") {
    state.clarifications = {};
  }
  if (state.repo && typeof state.repo !== "object") {
    delete state.repo;
  }
  if (!state.provisioning || typeof state.provisioning !== "object") {
    state.provisioning = createEmptyProvisioningState();
  } else {
    const prov = state.provisioning as Record<string, unknown>;
    if (!prov.workers || typeof prov.workers !== "object") {
      prov.workers = {};
    }
    prov.startupReadiness = normalizeStartupReadiness(prov.startupReadiness);
  }

  const version = typeof state.version === "number" ? state.version : 1;

  if (version > STATE_VERSION) {
    throw new Error(
      `Saved team state is version ${version}, but this software only supports up to version ${STATE_VERSION}. ` +
      "Please update TeamClaw to a newer version that supports this state format.",
    );
  }

  // Version 1 → 2: no new required fields beyond `version` itself.
  // startupReadiness was already optional and handled by normalizeStartupReadiness above.
  state.version = STATE_VERSION;

  // Phase 1.6 (design 2.3): legacy states carry no profileId; default them
  // to the software-rd baseline. Idempotent - states saved by this build
  // already carry the field and pass through unchanged.
  if (typeof state.profileId !== "string" || !state.profileId.trim()) {
    state.profileId = SOFTWARE_RD_PROFILE_ID;
  }

  // Phase 2.1: a malformed persisted transition is dropped (treated as "no
  // switch in progress"). Aborting a corrupt switch keeps the previous team
  // fully intact - the safe failure mode; the user can re-issue the switch.
  if (state.transition !== undefined) {
    const transition = state.transition as Record<string, unknown>;
    const phaseOk = transition?.phase === "draining" || transition?.phase === "archiving" || transition?.phase === "warming";
    const targetOk = typeof transition?.targetProfileId === "string" && Boolean(transition.targetProfileId.trim());
    const startedAtOk = typeof transition?.startedAt === "number";
    if (!phaseOk || !targetOk || !startedAtOk) {
      delete state.transition;
    }
  }

  return state as unknown as TeamState;
}

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
const writeQueues = new Map<string, Promise<void>>();

function createEmptyProvisioningState(): TeamProvisioningState {
  return {
    workers: {},
  };
}

function normalizeStartupReadiness(value: unknown): StartupProvisioningReadiness | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const status = record.status === "checking" || record.status === "ready" || record.status === "degraded"
    ? record.status
    : undefined;
  const startedAt = typeof record.startedAt === "number" ? record.startedAt : undefined;
  const checkedAt = typeof record.checkedAt === "number" ? record.checkedAt : undefined;
  const attempts = typeof record.attempts === "number" && record.attempts >= 0 ? Math.floor(record.attempts) : 0;
  // Phase 0.3: persisted requiredRoles are untrusted; filter through the
  // shared guard so corrupted state cannot inject arbitrary role strings.
  const requiredRoles = validateRoleIdList(record.requiredRoles);
  const readyWorkerIds = Array.isArray(record.readyWorkerIds)
    ? record.readyWorkerIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const message = typeof record.message === "string" && record.message.trim() ? record.message : undefined;
  if (!status || startedAt === undefined || checkedAt === undefined) {
    return undefined;
  }
  return {
    status,
    startedAt,
    checkedAt,
    attempts,
    requiredRoles,
    readyWorkerIds,
    message,
  };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, contents, "utf8");
  await fs.rename(tmpPath, filePath);
}

function enqueueAtomicWrite(filePath: string, contents: string): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeFileAtomically(filePath, contents));
  writeQueues.set(filePath, next);
  return next.finally(() => {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  });
}

// Phase 1.6 (design section 2.3): the persisted state file name is decoupled
// from teamName. TeamClaw is single-instance-single-team per state dir, so a
// fixed instance-scoped file name IS the instance identity - renaming a team
// no longer orphans the old `<teamName>-team-state.json` (the collision risk
// called out in the design). The legacy teamName-named file is still read as
// a one-time migration source; the next save writes the new name and the
// legacy file is simply never consulted again.
const TEAM_STATE_FILE = "team-state.json";

function teamStateFilePath(): string {
  return path.join(STATE_DIR, TEAM_STATE_FILE);
}

function legacyTeamStateFilePath(teamName: string): string {
  return path.join(STATE_DIR, `${teamName}-team-state.json`);
}

function isFileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadTeamState(teamName: string): Promise<TeamState | null> {
  // Review fix (Phase 1.6): the instance-scoped team-state.json is the
  // primary state file, and when it EXISTS it is authoritative. A
  // present-but-corrupt primary is a fatal error, never a silent fallback to
  // the legacy snapshot - falling back would rewind the team to the
  // pre-migration state and lose everything saved since. Only a MISSING
  // primary (ENOENT) falls through to the one-time legacy read.
  let primaryRaw: string | null = null;
  try {
    primaryRaw = await fs.readFile(teamStateFilePath(), "utf8");
  } catch (error) {
    if (!isFileMissing(error)) {
      throw new Error(
        `TeamClaw cannot read the persisted team state ${teamStateFilePath()}: ${errorMessage(error)}`,
      );
    }
  }

  if (primaryRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(primaryRaw);
    } catch (error) {
      throw new Error(
        `TeamClaw team state file ${teamStateFilePath()} is not valid JSON (${errorMessage(error)}). `
        + "Refusing to start with a fresh team over a corrupt state file - fix or remove the file manually.",
      );
    }
    const migrated = migrateState(parsed);
    if (!migrated) {
      throw new Error(
        `TeamClaw team state file ${teamStateFilePath()} exists but is not a valid team state. `
        + "Refusing to start with a fresh team over an unusable state file - fix or remove the file manually.",
      );
    }
    return migrated;
  }

  // Primary absent: one-time legacy fallback (pre-Phase-1.6 file name).
  // Lenient by design, matching the pre-Phase-1.6 single-file behavior: a
  // missing or corrupt legacy file simply means first initialization, and a
  // corrupt legacy file is never overwritten (saves go to the new name).
  try {
    const legacyRaw = await fs.readFile(legacyTeamStateFilePath(teamName), "utf8");
    return migrateState(JSON.parse(legacyRaw));
  } catch {
    return null;
  }
}

async function saveTeamState(state: TeamState): Promise<void> {
  await ensureDir(STATE_DIR);
  const filePath = teamStateFilePath();
  state.version = STATE_VERSION;
  state.updatedAt = Date.now();
  state.provisioning = state.provisioning && typeof state.provisioning === "object"
    ? state.provisioning
    : createEmptyProvisioningState();
  state.provisioning.workers = state.provisioning.workers && typeof state.provisioning.workers === "object"
    ? state.provisioning.workers
    : {};
  state.provisioning.startupReadiness = normalizeStartupReadiness(state.provisioning.startupReadiness);
  state.controllerRuns = state.controllerRuns && typeof state.controllerRuns === "object"
    ? state.controllerRuns
    : {};
  state.projects = state.projects && typeof state.projects === "object"
    ? state.projects
    : {};
  await enqueueAtomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Team profile switch archive (Phase 2.1, design section 2.3 step 3).
//
// Switching profiles seals the WHOLE previous TeamState (tasks,
// clarifications, messages, previews, repo, projects, controllerRuns,
// reports) into state-dir/archived/<profileId>-<timestamp>.json together with
// an embedded snapshot of the profile's roles - so an archived banking team
// keeps its original role vocabulary even after the profile package evolves
// (design 2.2: archive queries must not suffer terminology drift). v1 only
// lists archive metadata; the full payload stays queryable offline.
// ---------------------------------------------------------------------------

const ARCHIVED_TEAMS_DIR_NAME = "archived";
const ARCHIVE_FILE_RE = /^([a-z0-9-]+)-(\d+)\.json$/;

/** Embedded profile snapshot stored alongside the archived team state. */
export type ArchivedTeamProfileSnapshot = {
  id: string;
  name: string;
  nameZh?: string;
  version: string;
  roles: RoleDefinition[];
};

export type ArchivedTeamEnvelope = {
  archivedAt: number;
  profile: ArchivedTeamProfileSnapshot;
  team: TeamState;
};

export type ArchivedTeamSummary = {
  /** Archive file name (unique id for v1 metadata listing purposes). */
  file: string;
  profileId: string;
  profileName: string;
  teamName: string;
  archivedAt: number;
  taskCount: number;
};

function archivedTeamsDirPath(): string {
  return path.join(STATE_DIR, ARCHIVED_TEAMS_DIR_NAME);
}

function parseArchiveFileName(name: string): { profileId: string; timestamp: number } | null {
  const match = ARCHIVE_FILE_RE.exec(name);
  if (!match) {
    return null;
  }
  const timestamp = Number(match[2]);
  return Number.isFinite(timestamp) ? { profileId: match[1]!, timestamp } : null;
}

/**
 * Seal the given TeamState into the archive directory (design 2.3 step 3).
 * Returns the archive file path. The write is atomic; the envelope embeds the
 * profile snapshot so the archive is self-contained.
 */
async function archiveTeamState(
  state: TeamState,
  profileSnapshot: ArchivedTeamProfileSnapshot,
): Promise<string> {
  const dir = archivedTeamsDirPath();
  await ensureDir(dir);
  const fileName = `${state.profileId}-${Date.now()}.json`;
  const filePath = path.join(dir, fileName);
  const envelope: ArchivedTeamEnvelope = {
    archivedAt: Date.now(),
    profile: profileSnapshot,
    team: state,
  };
  await enqueueAtomicWrite(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  return filePath;
}

/** List archived teams (newest first). Unreadable entries are skipped. */
async function listArchivedTeams(): Promise<ArchivedTeamSummary[]> {
  let files: string[];
  try {
    files = await fs.readdir(archivedTeamsDirPath());
  } catch {
    return [];
  }
  const summaries: ArchivedTeamSummary[] = [];
  for (const name of files.sort().reverse()) {
    if (!name.endsWith(".json") || !parseArchiveFileName(name)) {
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(archivedTeamsDirPath(), name), "utf8");
      const parsed = JSON.parse(raw) as ArchivedTeamEnvelope;
      if (!parsed?.team || typeof parsed.team !== "object") {
        continue;
      }
      summaries.push({
        file: name,
        profileId: parsed.profile?.id ?? parsed.team.profileId ?? "unknown",
        profileName: parsed.profile?.name ?? "",
        teamName: typeof parsed.team.teamName === "string" ? parsed.team.teamName : "",
        archivedAt: typeof parsed.archivedAt === "number" ? parsed.archivedAt : 0,
        taskCount: parsed.team.tasks && typeof parsed.team.tasks === "object"
          ? Object.keys(parsed.team.tasks).length
          : 0,
      });
    } catch {
      // Skip unreadable/corrupt archive files - listing must never fail the API.
    }
  }
  return summaries;
}

/**
 * Crash-resume helper (design 2.3): find an archive file written for the
 * given (source) profileId at or after `startedAt` - the persisted
 * transition.startedAt. Existence of such a file means the switch already got
 * past the archive step, so a restart must jump straight to building the new
 * team instead of re-draining.
 */
async function findTeamSwitchArchive(profileId: string, startedAt: number): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.readdir(archivedTeamsDirPath());
  } catch {
    return null;
  }
  for (const name of files.sort().reverse()) {
    const parsed = parseArchiveFileName(name);
    if (parsed && parsed.profileId === profileId && parsed.timestamp >= startedAt) {
      return path.join(archivedTeamsDirPath(), name);
    }
  }
  return null;
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
  await enqueueAtomicWrite(filePath, `${JSON.stringify(identity, null, 2)}\n`);
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
  archiveTeamState,
  listArchivedTeams,
  findTeamSwitchArchive,
  loadWorkerIdentity,
  saveWorkerIdentity,
  clearWorkerIdentity,
};
