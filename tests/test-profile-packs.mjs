#!/usr/bin/env node
// Phase 3 industry profile pack contract tests
// (vertical-team-profiles-design.md section 3, Phase 3 "common requirements
// for all six packs"), run against the source packages and the built dist
// loader (run `npm --prefix src run build` first).
//
// The test is auto-discovering: it iterates EVERY package dropped into
// src/src/profiles/ (except schema.json and the software-rd baseline, whose
// shape is pinned byte-for-byte by test-software-rd-golden.mjs instead) so
// the finance packs (banking/securities/insurance) are covered automatically
// once they merge. Per pack it asserts:
//
//   1. Real-loader validation: loader.validateProfilePackage accepts the
//      package as-is (schema subset + cross-field role references; a failure
//      here is a FATAL load error in production, design 2.2), and the
//      built-in load path picked the pack up from dist/src/profiles.
//   2. Role ids are unique and match the RoleId slug pattern.
//   3. Every role carries a non-empty labelZh (bilingual display, Phase 3
//      common requirement - no fallback-only roles in the industry packs).
//   4. warmupRoles references only this pack's role ids and holds 1-4
//      entries (cost control, design 2.1/2.3).
//   5. The capabilities object carries exactly the four software switches.
//   6. Finance packs (id in banking/securities/insurance) must set
//      outputConstraints.tailnote (design Phase 3: mandatory disclaimers
//      force-appended by the prompt injector).
//   7. reviewedBy is non-empty (domain review sign-off trail; the drafting
//      agent records itself while review is pending).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const SOURCE_PROFILES_DIR = path.join(projectRoot, "src", "src", "profiles");

// --- discovery: every packaged profile except schema.json and software-rd ---
const packFiles = fs.readdirSync(SOURCE_PROFILES_DIR)
  .filter((name) => name.endsWith(".json") && name !== "schema.json" && name !== "software-rd.json")
  .sort();
assert.ok(
  packFiles.length >= 2,
  "the Phase 3 industry packs (crossborder-ecom, trading-co) must be discovered in src/src/profiles",
);
assert.ok(
  packFiles.includes("crossborder-ecom.json") && packFiles.includes("trading-co.json"),
  "the two Phase 3 ecom/trading packs must be present",
);

// --- real loader: importing the dist module has ALREADY run the fatal load
// pipeline over every pack in dist/src/profiles at module init (design 2.2);
// validateProfilePackage then re-checks each source package individually so
// a failure attributes to one file. No TEAMCLAW_EXTRA_PROFILES_DIR here -
// this exercises the production built-in path. ---
const loader = await import(path.join(projectRoot, "src", "dist", "src", "profile-loader.js"));
const schema = JSON.parse(
  await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, "schema.json"), "utf8"),
);

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_SWITCHES = ["git", "teamauto", "runnablePreview", "deliveryReview"];
const FINANCE_PROFILE_IDS = new Set(["banking", "securities", "insurance"]);
const PHASE3_ROLE_COUNTS = { "crossborder-ecom": 9, "trading-co": 7 };

for (const file of packFiles) {
  const raw = JSON.parse(await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, file), "utf8"));

  // 1. The real loader pipeline must accept the package (fatal in production).
  loader.validateProfilePackage(raw, schema, file);

  // 1b. The built-in load path discovered the pack (stale-dist guard: the
  // build copies src/src/profiles into dist/src/profiles).
  assert.ok(
    loader.BUILTIN_PROFILES.has(raw.id),
    `pack ${file} (id "${raw.id}") must be present in the loader's built-in registry - run \`npm --prefix src run build\``,
  );

  // 2. Role ids: unique + RoleId slug pattern.
  const roleIds = raw.roles.map((role) => role.id);
  assert.equal(
    new Set(roleIds).size,
    roleIds.length,
    `pack ${file} must not have duplicate role ids`,
  );
  for (const role of raw.roles) {
    assert.match(
      role.id,
      ROLE_ID_PATTERN,
      `pack ${file} role id "${role.id}" must match the RoleId slug pattern`,
    );
    // 3. labelZh full coverage (Phase 3 common requirement).
    assert.ok(
      typeof role.labelZh === "string" && role.labelZh.trim().length > 0,
      `pack ${file} role "${role.id}" must carry a non-empty labelZh (bilingual display)`,
    );
  }

  // 4. warmupRoles: subset of this pack's roles, 1-4 entries.
  assert.ok(
    Array.isArray(raw.warmupRoles) && raw.warmupRoles.length >= 1 && raw.warmupRoles.length <= 4,
    `pack ${file} warmupRoles must hold 1-4 entries (cost control, design 2.1)`,
  );
  for (const roleId of raw.warmupRoles) {
    assert.ok(
      roleIds.includes(roleId),
      `pack ${file} warmupRoles entry "${roleId}" must be a role of this pack`,
    );
  }

  // 5. The four software capability switches exist.
  for (const key of CAPABILITY_SWITCHES) {
    assert.ok(
      key in raw.capabilities,
      `pack ${file} capabilities must declare the "${key}" switch`,
    );
  }

  // 6. Finance packs must carry the mandatory disclaimer tailnote. Written
  // now; activates automatically when the banking/securities/insurance
  // packages merge into this directory.
  if (FINANCE_PROFILE_IDS.has(raw.id)) {
    assert.ok(
      typeof raw.outputConstraints?.tailnote === "string" && raw.outputConstraints.tailnote.trim().length > 0,
      `finance pack ${file} ("${raw.id}") must set outputConstraints.tailnote (design Phase 3 hard requirement)`,
    );
  }

  // 7. reviewedBy non-empty (drafting trail until domain review signs off).
  assert.ok(
    Array.isArray(raw.reviewedBy) && raw.reviewedBy.length > 0
      && raw.reviewedBy.every((entry) => typeof entry === "string" && entry.trim().length > 0),
    `pack ${file} must carry a non-empty reviewedBy record (drafting or sign-off trail)`,
  );

  // Phase 3 design-table pin for this workstream's own packs.
  const expectedRoleCount = PHASE3_ROLE_COUNTS[raw.id];
  if (expectedRoleCount !== undefined) {
    assert.equal(
      raw.roles.length,
      expectedRoleCount,
      `pack ${file} must match the Phase 3 role table (${expectedRoleCount} roles)`,
    );
  }
}

console.log(`profile pack contracts passed (${packFiles.length} packs: ${packFiles.join(", ")}).`);
