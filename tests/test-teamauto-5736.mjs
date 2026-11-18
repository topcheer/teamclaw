#!/usr/bin/env node
// Regression anchors for ggcode #5736 (teamclaw orphan-result alarm).
//
// The #5725 -> #5736 -> #5738 chain kept re-learning one store invariant:
// loadTeamAutoStore() rebuilds the store field-by-field from emptyStore(), so
// a persistence field that is not in the loader's copy list is dropped on
// EVERY 20s settle reload even though saveTeamAutoStore() writes it to disk.
// At 8631eb6 the loader still dropped all three alarm-persistence fields,
// which silently DISARMED the alarm:
//   - deliveredResultsInit dropped => the one-time #5738 migration re-ran
//     every pass and pardoned every completed in-window task, so a genuine
//     #5725-class registration loss could never alarm again
//   - deliveredResults dropped     => prune-time delivery records evaporated
//     on reload and normal deliveries re-entered the alarm domain
//   - orphanResultAlarms dropped   => the once-per-task gate reset (the
//     99-lines-in-80s repeat-alarm storm #5738 tried to fix)
// Live evidence at 8631eb6 deploy time: teamauto.json on disk carried
// deliveredResultsInit=true and 26 deliveredResults entries while
// orphanResultAlarms was empty - the audit re-ran the migration every pass.
//
// Part 1 pins the loader copies as source contracts (runs without a build).
// Part 2 round-trips a save -> load through the built dist when available.

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const storeSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "store.ts"), "utf8");
  const schedulerSrc = await fsp.readFile(path.join(projectRoot, "src", "src", "teamauto", "scheduler.ts"), "utf8");

  // --- Part 1: source contracts (no build required) ---

  const loaderStart = storeSrc.indexOf("export async function loadTeamAutoStore");
  assert.ok(loaderStart >= 0, "loadTeamAutoStore not found in store.ts");
  const loaderEnd = storeSrc.indexOf("export async function saveTeamAutoStore");
  assert.ok(loaderEnd > loaderStart, "saveTeamAutoStore must follow loadTeamAutoStore in store.ts");
  const loaderBody = storeSrc.slice(loaderStart, loaderEnd);

  assert.match(
    loaderBody,
    /store\.orphanResultAlarms\s*=\s*parsed\.orphanResultAlarms/,
    "#5736: loadTeamAutoStore must copy orphanResultAlarms - otherwise the once-per-task alarm gate resets on every 20s settle reload and re-alarms (99 lines / 80s live)",
  );
  assert.match(
    loaderBody,
    /store\.deliveredResults\s*=\s*parsed\.deliveredResults/,
    "#5736: loadTeamAutoStore must copy deliveredResults - otherwise prune-time delivery records evaporate on reload and normal deliveries re-enter the alarm domain",
  );
  assert.match(
    loaderBody,
    /store\.deliveredResultsInit\s*=\s*parsed\.deliveredResultsInit/,
    "#5738: loadTeamAutoStore must copy deliveredResultsInit - otherwise the one-time migration re-runs every pass and pardons genuine orphans (alarm disarmed)",
  );

  // emptyStore scaffolding for the same fields (the other half of the invariant).
  assert.match(storeSrc, /orphanResultAlarms:\s*\{\}/, "emptyStore must scaffold orphanResultAlarms");
  assert.match(storeSrc, /deliveredResults:\s*\{\}/, "emptyStore must scaffold deliveredResults");

  // #5736 core semantics stay in place: the alarm consults the durable ledger
  // (entry present OR ledger hit) and never the rolling activity ring.
  // #5770/#5772 evolution: the ledger hit now EXCLUDES migration artifacts
  // (deliveredAt within 2s of completedAt is a forged stamp, not evidence)
  // and the entry check is expressed via the deliveredAt variable.
  assert.match(
    schedulerSrc,
    /const hasEntry = s\.writebacks\.some\(\(w\) => w\.taskId === task\.id\) \|\| \(deliveredAt !== undefined && !ledgerIsArtifact\)/,
    "#5736: hasEntry must consult the durable deliveredResults ledger (artifact-filtered, #5770)",
  );
  assert.match(
    schedulerSrc,
    /Math\.abs\(deliveredAt - task\.completedAt\) < 2000/,
    "#5770: a ledger stamp within 2s of completedAt is a migration artifact and must not count as delivery",
  );
  assert.doesNotMatch(
    schedulerSrc,
    /slice\(-400\)/,
    "#5736: the activity ring must no longer be an alarm data source",
  );
  assert.match(
    schedulerSrc,
    /s\.deliveredResults\[w\.taskId\]\s*=\s*w\.doneAt/,
    "#5736: doneAt deliveries must be recorded into the ledger BEFORE the prune",
  );
  assert.match(
    schedulerSrc,
    /!s\.deliveredResultsInit && Object\.keys\(s\.deliveredResults\)\.length === 0/,
    "#5738/#5770: the ledger migration must stay one-time (flag AND empty table - flag loss alone must not re-run it)",
  );
  assert.match(
    schedulerSrc,
    /6 \* 3600_000/,
    "#5772: the audit window is 6h - restart replays over historical tasks are the storm population",
  );
  assert.match(
    schedulerSrc,
    /alarmedThisPass >= 1/,
    "#5772: at most ONE orphan alarm per settle pass (storm cap)",
  );

  // --- Part 2: behavioral save -> load round-trip (requires the build) ---

  const distStorePath = path.join(projectRoot, "src", "dist", "src", "teamauto", "store.js");
  if (!fs.existsSync(distStorePath)) {
    console.log("test-teamauto-5736: ok (source contracts; dist not built - skipping round-trip)");
    return;
  }
  const storeMod = await import(pathToFileURL(distStorePath).href);
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tc5736-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const s = await storeMod.loadTeamAutoStore();
  s.deliveredResults = { "teamauto-5736-delivered": 1731780000000 };
  s.orphanResultAlarms = { "teamauto-5736-gated": 1731780001000 };
  s.deliveredResultsInit = true;
  await storeMod.saveTeamAutoStore(s);

  const reloaded = await storeMod.loadTeamAutoStore();
  assert.equal(
    reloaded.deliveredResults?.["teamauto-5736-delivered"],
    1731780000000,
    "#5736: deliveredResults must survive a save -> load round-trip (the 20s settle reload)",
  );
  assert.equal(
    reloaded.orphanResultAlarms?.["teamauto-5736-gated"],
    1731780001000,
    "#5738/#5725: the once-per-task alarm gate must survive a save -> load round-trip",
  );
  assert.equal(
    reloaded.deliveredResultsInit,
    true,
    "#5738: the one-time migration marker must survive a save -> load round-trip",
  );

  await fsp.rm(stateDir, { recursive: true, force: true });
  console.log("test-teamauto-5736: ok");
}

main().catch((err) => {
  console.error("test-teamauto-5736 failed:", err);
  process.exit(1);
});
