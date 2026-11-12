// Regression test for issue #270: team-state "bouncing overwrites". Multiple
// gateway processes share one store; each saved its startup snapshot with a
// full-file write, so keys created by another process evaporated on every
// save (155/81 -> 135/72 bouncing). Fix under test: lazy merge-on-write -
// saveTeamState detects a disk file newer than this process's last observed
// mtime and folds foreign keys back in before writing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-270-"));
process.env.OPENCLAW_STATE_DIR = stateDir; // must be set BEFORE importing state.js (STATE_DIR evaluates at module load)

const stateMod = await import(
  path.join(projectRoot, "src", "dist", "src", "state.js")
).catch(() => null);
assert.ok(stateMod, "state module must be built (run npm --prefix src run build first)");

const storeFile = path.join(stateDir, "plugins", "teamclaw", "team-state.json");
const readDisk = async () => JSON.parse(await fs.promises.readFile(storeFile, "utf8"));

const baseState = () => ({
  profileId: "software-rd",
  teamName: "dev-ui",
  workers: {},
  tasks: {},
  controllerRuns: {},
  projects: {},
  messages: [],
  clarifications: {},
});

// ── Pass 1 (process A saves its own task) ──────────────────────────────────
{
  const a = baseState();
  a.tasks["task-a1"] = { id: "task-a1", status: "completed", title: "A1" };
  await stateMod.saveTeamState(a);
  const disk = await readDisk();
  assert.equal(disk.tasks["task-a1"].status, "completed", "pass 1: A's task persisted");
}

// ── Pass 2 (foreign process B writes task-b2 + message; A holds no knowledge) ─
{
  const disk = await readDisk();
  disk.tasks["task-b2"] = { id: "task-b2", status: "pending", title: "B2" };
  disk.tasks["task-a1"].status = "failed"; // B mutates A's key too (conflict)
  disk.messages.push({ id: "msg-b", from: "b", type: "broadcast", content: "x" });
  await fs.promises.writeFile(storeFile, JSON.stringify(disk, null, 2), "utf8");
}

// ── Pass 3 (A saves again from ITS snapshot + a new task-a3) ────────────────
let a2; // shared with pass 4 (steady-state re-save of the accumulated object)
{
  a2 = baseState();
  a2.tasks["task-a1"] = { id: "task-a1", status: "completed", title: "A1" };
  a2.tasks["task-a3"] = { id: "task-a3", status: "pending", title: "A3" };
  a2.messages = [{ id: "msg-a", from: "a", type: "broadcast", content: "y" }];
  await stateMod.saveTeamState(a2);
  const disk = await readDisk();
  assert.ok(disk.tasks["task-b2"], "#270 fix: foreign task-b2 SURVIVES A's save (old code: evaporated)");
  assert.ok(disk.tasks["task-a3"], "A's new task-a3 persisted");
  assert.equal(disk.tasks["task-a1"].status, "completed", "same-key conflict resolves to the LOCAL writer (A)");
  const msgIds = disk.messages.map((m) => m.id).sort();
  assert.deepEqual(msgIds, ["msg-a", "msg-b"], "messages union by id - both survive");
}

// ── Pass 4 (steady state: SAME accumulated object saves again, no foreign
// write). NOTE the boundary: the mtime gate guards CROSS-PROCESS evaporation
// only - saving a FRESH object that omits previously-merged keys would still
// drop them (that is the pre-existing single-writer contract: callers hold
// the accumulated state object, as controller-service and teamauto both do).
{
  await stateMod.saveTeamState(a2); // a2 was merged in-place during pass 3
  const disk = await readDisk();
  assert.ok(disk.tasks["task-b2"], "steady-state saves keep the merged keys");
  assert.ok(disk.tasks["task-a3"], "and A's own keys");
}

console.log("test-team-state-merge: all assertions passed (#270 lazy merge-on-write)");

await fs.promises.rm(stateDir, { recursive: true, force: true }).catch(() => {});
