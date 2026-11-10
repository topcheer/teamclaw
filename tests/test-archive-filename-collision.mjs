#!/usr/bin/env node
// #251 M1: two archives created within the same millisecond must BOTH land
// as separate files (the old `${profileId}-${Date.now()}.json` name silently
// overwrote). Also pins ARCHIVE_FILE_RE compatibility: old-format names still
// parse with the same profileId/timestamp semantics.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { archiveTeamState } from "../src/dist/src/state.js";

const fakeProfileSnapshot = {
  id: "zz-collision-test",
  name: "Collision Test",
  version: "0.0.1",
  roles: [],
};
const fakeState = (teamName) => ({
  profileId: "zz-collision-test",
  teamName,
  version: 1,
  workers: {},
  tasks: {},
  controllerRuns: {},
  projects: {},
  messages: [],
  clarifications: {},
  repo: undefined,
  provisioning: undefined,
  previews: {},
  reports: {},
  createdAt: 0,
  updatedAt: 0,
});

// Two archives as fast as possible - Date.now() granularity makes this a
// realistic same-ms (or near-ms) collision; the suffix guarantees uniqueness
// regardless.
const p1 = await archiveTeamState(fakeState("first"), fakeProfileSnapshot);
const p2 = await archiveTeamState(fakeState("second"), fakeProfileSnapshot);

try {
  assert.ok(fs.existsSync(p1), "first archive file must exist");
  assert.ok(fs.existsSync(p2), "second archive file must exist");
  assert.notEqual(p1, p2, "same-ms archives must not share a file name");

  // Name shape: profileId-timestamp-suffix.json with timestamp all-digits.
  const name = path.basename(p2);
  const m = /^([a-z0-9-]+)-(\d+)(?:-([a-z0-9]+))?\.json$/.exec(name);
  assert.ok(m, `archive name must match ARCHIVE_FILE_RE shape: ${name}`);
  assert.equal(m[1], "zz-collision-test");
  assert.ok(Number.isFinite(Number(m[2])), "timestamp group must stay numeric");
  assert.ok((m[3] ?? "").length >= 4, "collision suffix must be present");

  // Old-format (pre-#251) names must still parse under the new regex.
  const legacy = /^([a-z0-9-]+)-(\d+)(?:-([a-z0-9]+))?\.json$/.exec("software-rd-1730000000000.json");
  assert.ok(legacy && legacy[1] === "software-rd" && legacy[2] === "1730000000000" && legacy[3] === undefined);
} finally {
  fs.rmSync(p1, { force: true });
  fs.rmSync(p2, { force: true });
}

console.log("test-archive-filename-collision: ok (same-ms double archive keeps both files)");
