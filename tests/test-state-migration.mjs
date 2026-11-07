#!/usr/bin/env node
// Phase 1.6 review follow-up: persistence-contract tests for state.ts, run
// against the built dist modules (run `npm --prefix src run build` first).
//
// Locks the reviewed semantics:
//   a. team-state.json is the primary file: when it exists it wins over any
//      legacy <teamName>-team-state.json; only its ABSENCE (ENOENT) falls
//      through to the one-time legacy migration read.
//   b. A legacy state without profileId migrates to the software-rd baseline,
//      idempotently; the first save lands on the fixed file name.
//   c. The persisted file name is decoupled from teamName: no
//      <teamName>-team-state.json is ever created, and the single instance
//      state is found under any teamName.
//   d. A present-but-corrupt primary is FATAL (invalid JSON or non-state
//      structure) - the loader must never silently fall back to the legacy
//      snapshot (state rewind / data loss) or to a fresh team.
//   e. The controller-side fatal on an unknown restored profileId is pinned
//      at source level in tests/test-software-rd-golden.mjs (spinning the
//      full controller-service at dist level needs the plugin runtime stack;
//      see the report note).
//
// state.ts resolves its STATE_DIR once at module init from OPENCLAW_STATE_DIR,
// so each scenario imports the module fresh (a query string busts the ESM
// cache) against its own private state directory.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const stateModulePath = path.join(projectRoot, "src", "dist", "src", "state.js");

let importCounter = 0;
async function importStateModule() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-state-migration-"));
  process.env.OPENCLAW_STATE_DIR = tempDir;
  const mod = await import(`${pathToFileURL(stateModulePath).href}?case=${importCounter++}`);
  const stateDir = path.join(tempDir, "plugins", "teamclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  return { mod, stateDir };
}

function validState(overrides = {}) {
  return {
    version: 2,
    teamName: "Some Team",
    workers: {},
    tasks: {},
    controllerRuns: {},
    projects: {},
    messages: [],
    clarifications: {},
    createdAt: 1730000000000,
    updatedAt: 1730000000001,
    ...overrides,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// a. Primary wins when both files exist; only ENOENT falls to legacy.
// ---------------------------------------------------------------------------
{
  const { mod, stateDir } = await importStateModule();
  writeJson(path.join(stateDir, "LegacyCo-team-state.json"), validState({ teamName: "LegacyCo" }));
  writeJson(path.join(stateDir, "team-state.json"), validState({ teamName: "Primary Team", profileId: "software-rd" }));

  const loaded = await mod.loadTeamState("LegacyCo");
  assert.ok(loaded, "state must load when both files exist");
  assert.equal(loaded.teamName, "Primary Team", "the primary team-state.json must win over the legacy snapshot");
  assert.equal(loaded.profileId, "software-rd", "the primary profileId must be preserved");
}

// b+c. Legacy-only: profileId migration, idempotency, fixed save name.
{
  const { mod, stateDir } = await importStateModule();
  const legacyPath = path.join(stateDir, "OldCo-team-state.json");
  writeJson(legacyPath, validState({ teamName: "OldCo" })); // no profileId field
  const legacyText = fs.readFileSync(legacyPath, "utf8");

  assert.equal(
    await mod.loadTeamState("Completely Different Name"),
    null,
    "with no primary file and no matching legacy file, first initialization must see null",
  );

  const first = await mod.loadTeamState("OldCo");
  assert.ok(first, "the legacy teamName-named file must be read when the primary is absent");
  assert.equal(first.profileId, "software-rd", "a legacy state without profileId migrates to the software-rd baseline");
  assert.equal(first.teamName, "OldCo", "migration preserves teamName");

  await mod.saveTeamState(first);
  const primaryPath = path.join(stateDir, "team-state.json");
  assert.ok(fs.existsSync(primaryPath), "the first save lands on the fixed instance file name");

  const second = await mod.loadTeamState("OldCo");
  assert.equal(second.profileId, "software-rd", "re-loading the migrated state keeps profileId (idempotent migration)");
  assert.equal(second.teamName, "OldCo", "re-loading the migrated state keeps teamName");
  assert.equal(fs.readFileSync(legacyPath, "utf8"), legacyText, "the legacy file is left byte-identical (never rewritten or deleted)");
}

// c. teamName decoupling: renames never create or orphan state files.
{
  const { mod, stateDir } = await importStateModule();
  const state = validState({ teamName: "First Name", profileId: "software-rd" });
  await mod.saveTeamState(state);
  state.teamName = "Renamed Team";
  await mod.saveTeamState(state);

  const files = fs.readdirSync(stateDir).sort();
  assert.deepEqual(files, ["team-state.json"], "saves must only ever write the fixed team-state.json (no teamName-derived files)");
  const reloaded = await mod.loadTeamState("Renamed Team");
  assert.equal(reloaded?.teamName, "Renamed Team", "the single instance state is found under the current teamName");
  const reloadedOther = await mod.loadTeamState("Any Other Name");
  assert.equal(reloadedOther?.teamName, "Renamed Team", "the single instance state is found under any teamName (single-instance contract, design 2.3)");
}

// d. Present-but-corrupt primary is fatal - no legacy fallback, no fresh team.
{
  const { mod, stateDir } = await importStateModule();
  writeJson(path.join(stateDir, "LegacyCo-team-state.json"), validState({ teamName: "LegacyCo" }));
  fs.writeFileSync(path.join(stateDir, "team-state.json"), '{"version": 2, "teamName": "broken'); // truncated JSON
  await assert.rejects(
    () => mod.loadTeamState("LegacyCo"),
    /not valid JSON.*Refusing to start/s,
    "a corrupt primary state file must be fatal even when a healthy legacy snapshot exists (fallback would rewind the team)",
  );
  assert.equal(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8"), '{"version": 2, "teamName": "broken', "the corrupt file must be left untouched for manual repair");
}
{
  const { mod, stateDir } = await importStateModule();
  writeJson(path.join(stateDir, "team-state.json"), { hello: "world" }); // valid JSON, not a team state
  await assert.rejects(
    () => mod.loadTeamState("Anything"),
    /not a valid team state.*Refusing to start/s,
    "a primary state file with valid JSON but no team-state structure must be fatal",
  );
}
{
  // Non-ENOENT read failure on an existing primary is fatal as well (same
  // "file exists but cannot be used" class). Simulated by making the file a
  // directory: readFile yields EISDIR on every platform.
  const { mod, stateDir } = await importStateModule();
  fs.mkdirSync(path.join(stateDir, "team-state.json"));
  await assert.rejects(
    () => mod.loadTeamState("Anything"),
    /cannot read the persisted team state/,
    "an existing-but-unreadable primary state file must be fatal, not treated as absent",
  );
}

console.log("State migration contract smoke passed.");
