#!/usr/bin/env node
// Phase 1.7 (vertical-team-profiles-design.md section 1.7): the software-rd
// profile is the behavior-parity baseline of the Phase 1.3 profile-loader
// refactor. This test locks three contracts:
//
//   1. Zero generator drift: src/src/profiles/software-rd.json equals the
//      built roles.ts registry field by field (systemPrompt byte for byte),
//      and the dist copy of the JSON equals the committed source, so editing
//      roles.ts without `npm --prefix src run profile:sync` fails here.
//   2. Prompt byte goldens: the controller and worker prompt injectors
//      reproduce tests/golden/*.txt byte for byte. Those files were captured
//      on origin/main @ b076f25 BEFORE the refactor (generator:
//      tests/golden/regen-prompt-golden.mjs); any diff is a behavior change
//      and must be a deliberate regeneration with review.
//   3. Loader semantics: legal package loads and mirrors the registry face;
//      schema violations are fatal throws (design 2.2: refuse to start);
//      the schemaVersion evolution hook is reserved; the /roles endpoint
//      advertises defaultRole (the Phase 1.4 UI hook).
//
// Run `npm --prefix src run build` first (the runtime pins import dist).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const readSource = (rel) => fs.readFile(path.join(projectRoot, rel), "utf8");

// The exact per-role field set the generator snapshots (design 1.3): id,
// label, icon, description, capabilities, recommendedSkills, systemPrompt,
// suggestedNextRoles. labelZh and future RoleDefinition fields are Phase 2+
// and intentionally excluded from the v1 snapshot.
const SNAPSHOT_FIELDS = [
  "id",
  "label",
  "icon",
  "description",
  "capabilities",
  "recommendedSkills",
  "systemPrompt",
  "suggestedNextRoles",
];

async function importDist(rel, name) {
  try {
    return await import(path.join(projectRoot, "src", "dist", "src", rel));
  } catch (error) {
    assert.fail(
      `${name} module failed to load (run npm --prefix src run build first; for profile-loader a load failure also means a packaged profile failed fatal validation: ${error?.message})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. software-rd.json <-> roles.ts registry: zero generator drift.
// ---------------------------------------------------------------------------
const profileJsonText = await readSource("src/src/profiles/software-rd.json");
const profile = JSON.parse(profileJsonText);
const rolesMod = await importDist("roles.js", "roles");

assert.equal(profile.id, "software-rd", "the v1 built-in baseline profile must be software-rd");
assert.equal(profile.schemaVersion, 1, "software-rd must declare schemaVersion 1");
assert.equal(
  profile.roles.length,
  rolesMod.ROLES.length,
  "software-rd roles count must equal the registry count (run npm --prefix src run profile:sync after registry changes)",
);

rolesMod.ROLES.forEach((role, index) => {
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    snapshot[field] = role[field];
  }
  assert.deepEqual(
    profile.roles[index],
    snapshot,
    `software-rd role ${role.id} must deep-equal the registry snapshot (field-for-field, same order); regenerate with npm --prefix src run profile:sync`,
  );
  assert.ok(
    Buffer.compare(
      Buffer.from(profile.roles[index].systemPrompt, "utf8"),
      Buffer.from(role.systemPrompt, "utf8"),
    ) === 0,
    `software-rd ${role.id} systemPrompt must be byte-identical to roles.ts (composed value)`,
  );
});

assert.equal(
  profile.defaultRole,
  rolesMod.DEFAULT_ROLE,
  "software-rd defaultRole must equal the registry DEFAULT_ROLE",
);
assert.deepEqual(
  profile.warmupRoles,
  [rolesMod.DEFAULT_ROLE],
  "software-rd warmupRoles must be the current default warmup set [DEFAULT_ROLE] (worker-provisioning startup fallback)",
);
assert.deepEqual(
  profile.capabilities,
  { git: true, teamauto: true, runnablePreview: true, deliveryReview: true },
  "software-rd capabilities must be all-on (Phase 2 wires the switches)",
);

// The committed JSON must be what the generator emits (ASCII-escaped like the
// manifest generator): no hand edits that the next profile:sync would revert.
const generatorSource = await readSource("scripts/generate-software-rd-profile.mjs");
assert.match(generatorSource, /JSON\.stringify\(profile, null, 2\)/, "the generator must keep deterministic 2-space JSON output");
const distProfileText = await fs.readFile(
  path.join(projectRoot, "src", "dist", "src", "profiles", "software-rd.json"),
  "utf8",
).catch(() => null);
assert.ok(distProfileText, "dist/src/profiles/software-rd.json must exist (the build copies src/profiles into dist)");
assert.equal(distProfileText, profileJsonText, "the dist profile copy must equal the committed source JSON");

const pkgJson = JSON.parse(await readSource("src/package.json"));
assert.equal(
  pkgJson.scripts["profile:sync"],
  "cd .. && node scripts/generate-software-rd-profile.mjs src",
  "profile:sync must stay wired to the generator (manifest:sync pattern)",
);
assert.match(
  pkgJson.scripts.build,
  /cpSync\('src\/profiles','dist\/src\/profiles'/,
  "the build must copy src/profiles into dist so the loader resolves packages in the built tree",
);

// ---------------------------------------------------------------------------
// 2. Prompt byte goldens (baselines captured pre-refactor on main @ b076f25).
// ---------------------------------------------------------------------------
const { renderGoldenPrompts } = await import("./golden/regen-prompt-golden.mjs");
const { controllerPrompt, workerPrompt } = await renderGoldenPrompts();

function assertByteGolden(actual, goldenFile) {
  const expected = fs.readFile(path.join(scriptDir, "golden", goldenFile), "utf8").then(
    (text) => assertByteGoldenSync(actual, text, goldenFile),
    () => assert.fail(`missing golden file tests/golden/${goldenFile} (run node tests/golden/regen-prompt-golden.mjs and commit the result)`),
  );
  return expected;
}

function assertByteGoldenSync(actual, expected, goldenFile) {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (Buffer.compare(actualBytes, expectedBytes) === 0) {
    return;
  }
  let offset = 0;
  while (offset < actualBytes.length && offset < expectedBytes.length && actualBytes[offset] === expectedBytes[offset]) {
    offset++;
  }
  assert.fail(
    `${goldenFile} byte mismatch at offset ${offset} (actual ${actualBytes.length} bytes, golden ${expectedBytes.length} bytes).\n` +
    `  actual: ${JSON.stringify(actualBytes.subarray(offset, offset + 60).toString("utf8"))}\n` +
    `  golden: ${JSON.stringify(expectedBytes.subarray(offset, offset + 60).toString("utf8"))}\n` +
    "If the prompt change is intentional, regenerate with `npm --prefix src run build && node tests/golden/regen-prompt-golden.mjs` and review the diff.",
  );
}

await assertByteGolden(controllerPrompt, "controller-prompt.txt");
await assertByteGolden(workerPrompt, "worker-prompt.txt");

// ---------------------------------------------------------------------------
// 3. Loader semantics.
// ---------------------------------------------------------------------------
const loader = await importDist("profile-loader.js", "profile-loader");

// 3a. Legal load: active profile mirrors the registry face.
assert.equal(loader.getActiveProfileId(), "software-rd", "v1 boots on the software-rd baseline");
assert.deepEqual(loader.getActiveRoles(), rolesMod.ROLES, "active profile roles must deep-equal the registry (Phase 1.3 parity)");
assert.deepEqual(loader.getActiveRoleIds(), rolesMod.ROLE_IDS, "active role ids must equal the registry order");
assert.equal(loader.getActiveDefaultRole(), rolesMod.DEFAULT_ROLE, "active defaultRole must equal the registry default");
assert.equal(loader.getActiveRole("qa")?.label, "QA Engineer", "getActiveRole resolves profile roles");
assert.equal(loader.hasProfile("software-rd"), true, "software-rd must be a built-in profile");
assert.equal(loader.hasProfile("banking"), true, "banking is a built-in Phase 3 finance package");

// validateActiveRoleId mirrors validateRoleId over the active profile set.
const { validateRoleId } = rolesMod;
for (const roleId of rolesMod.ROLE_IDS) {
  assert.equal(loader.validateActiveRoleId(roleId), validateRoleId(roleId), `validateActiveRoleId must accept ${roleId} like validateRoleId`);
  assert.equal(loader.validateActiveRoleId(`  ${roleId}  `), roleId, `validateActiveRoleId must trim ${roleId}`);
}
assert.equal(loader.validateActiveRoleId("sre"), undefined, "unknown role ids must be rejected");
assert.equal(loader.validateActiveRoleId(42), undefined, "non-strings must be rejected");
assert.equal(loader.validateActiveRoleId(null), undefined, "null must be rejected");
assert.deepEqual(
  loader.resolveActiveRoleSkills("designer", ["find-skills", " Find-Skills ", "", "ui-ux-pro-max"]),
  ["ui-ux-pro-max", "find-skills"],
  "resolveActiveRoleSkills must keep registry-first order and normalize like the registry helper",
);

// Review adoption: roles.ts keeps its own registry-layer copy of the
// recommended-skills helpers; lock the two implementations together over the
// whole registry (plus the no-role and raw-normalizer variants) so the
// intentional duplication can never drift.
const SKILL_PARITY_SAMPLE = ["find-skills", " Find-Skills ", "", "Extra Skill", "ui-ux-pro-max"];
for (const role of rolesMod.ROLES) {
  assert.deepEqual(
    loader.resolveActiveRoleSkills(role.id, SKILL_PARITY_SAMPLE),
    rolesMod.resolveRecommendedSkillsForRole(role.id, SKILL_PARITY_SAMPLE),
    `resolveActiveRoleSkills("${role.id}") must equal the registry resolveRecommendedSkillsForRole`,
  );
}
assert.deepEqual(
  loader.resolveActiveRoleSkills(undefined, SKILL_PARITY_SAMPLE),
  rolesMod.resolveRecommendedSkillsForRole(undefined, SKILL_PARITY_SAMPLE),
  "roleId-less skill resolution must stay identical across both implementations",
);
assert.deepEqual(
  loader.normalizeRecommendedSkills(SKILL_PARITY_SAMPLE),
  rolesMod.normalizeRecommendedSkills(SKILL_PARITY_SAMPLE),
  "normalizeRecommendedSkills implementations must agree",
);

// setActiveProfileId refuses unknown ids (programming error) and switches.
assert.throws(() => loader.setActiveProfileId("nope"), /not a built-in profile/);
loader.setActiveProfileId("software-rd");

// 3b. Fatal schema violations (design 2.2: refuse to start, never warn-fallback).
const schema = JSON.parse(await readSource("src/src/profiles/schema.json"));
const legalPackage = JSON.parse(profileJsonText);

function expectFatal(mutate, label) {
  const broken = JSON.parse(JSON.stringify(legalPackage));
  mutate(broken);
  assert.throws(
    () => loader.validateProfilePackage(broken, schema, `${label}.json`),
    /refusing to start|has dangling role references|supports only/,
    `${label} must be a fatal validation error`,
  );
}

expectFatal((p) => delete p.warmupRoles, "missing-required-field");
expectFatal((p) => p.roles[0] && delete p.roles[0].systemPrompt, "role-missing-systemPrompt");
expectFatal((p) => { p.roles[0].surprise = true; }, "unknown-role-property");
expectFatal((p) => { p.surprise = true; }, "unknown-profile-property");
expectFatal((p) => { p.warmupRoles = ["not-a-role"]; }, "dangling-warmup-role");
expectFatal((p) => { p.roles[1].suggestedNextRoles = ["ghost"]; }, "dangling-suggested-next-role");
expectFatal((p) => { p.capabilities.git = "yes"; }, "wrong-capability-type");

// 3c. Reserved schema evolution hook: an unsupported format version is fatal.
{
  const future = JSON.parse(JSON.stringify(legalPackage));
  future.schemaVersion = 2;
  assert.throws(
    () => loader.validateProfilePackage(future, schema, "future.json"),
    /schemaVersion|supports only/,
    "a future profile schemaVersion must be a hard stop for this build",
  );
}

// The legal package itself keeps validating (guard against an over-eager schema).
loader.validateProfilePackage(legalPackage, schema, "software-rd.json");

// 3d. /roles advertises the profile defaultRole (Phase 1.4 UI hook waits on it).
// PR-D of issue #204: the roles route shell moved from http-server.ts into
// controller/route-table.ts; W2 of issue #226 moved the handler body on into
// controller/status-routes.ts - pin the new home (body unchanged).
const statusRoutesSource = await readSource(path.join("src", "src", "controller", "status-routes.ts"));
assert.match(
  statusRoutesSource,
  /sendJson\(res, 200, \{ roles: getActiveRoles\(\), defaultRole: getActiveDefaultRole\(\) \}\);/,
  "GET /api/v1/roles must return { roles: <profile roles>, defaultRole } (the UI reads res.defaultRole)",
);

// 3e. Restoring a team state whose profileId is not a built-in profile is
// FATAL at the controller layer (design 2.2 red line - a banking team must
// never silently run the software baseline). The dist-level construction of
// controller-service needs the full plugin runtime stack, so this is pinned
// at source level: the restore branch's first statement must be the throw
// (runtime persistence behavior is covered by test-state-migration.mjs).
const controllerServiceSource = await readSource(path.join("src", "src", "controller", "controller-service.ts"));
assert.match(
  controllerServiceSource,
  /if \(!hasProfile\(teamState\.profileId\)\) \{\s*throw new Error\(/,
  "controller-service must throw (not warn+fallback) when a restored TeamState.profileId is not a built-in profile (design 2.2)",
);

console.log("software-rd profile golden smoke passed.");
