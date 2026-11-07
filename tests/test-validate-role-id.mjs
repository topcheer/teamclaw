#!/usr/bin/env node
// Phase 0.3 (vertical-team-profiles-design.md): converge `as RoleId` casts
// into a single validateRoleId()/validateRoleIdList() guard exported from
// roles.ts.
//
// Pins three contracts:
// a. validateRoleId white-box behavior: registered ids pass (after trim),
//    everything else (unknown strings, non-strings, blank) returns undefined;
//    never throws.
// b. validateRoleIdList white-box behavior: array filtering with order
//    preservation and first-occurrence dedup; non-arrays return [].
// c. Source-level pins that the two pre-existing guards delegate to the
//    shared function with zero behavior change: interaction-contracts.ts
//    normalizeContractRole and orchestration-manifest.ts
//    normalizeManifestRoleList.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const rolesModulePath = path.join(projectRoot, "src", "dist", "src", "roles.js");
const rolesMod = await import(rolesModulePath).catch(() => null);
assert.ok(rolesMod, "roles module must be built (run npm --prefix src run build first)");
const { ROLES, ROLE_IDS, validateRoleId, validateRoleIdList } = rolesMod;
assert.equal(typeof validateRoleId, "function", "roles.ts must export validateRoleId (Phase 0.3)");
assert.equal(typeof validateRoleIdList, "function", "roles.ts must export validateRoleIdList (Phase 0.3)");

// --- a. validateRoleId: legal values ---
for (const roleId of ROLE_IDS) {
  assert.equal(validateRoleId(roleId), roleId, `validateRoleId must accept registered role ${roleId}`);
}
assert.equal(validateRoleId("  pm  "), "pm", "validateRoleId must trim surrounding whitespace");
assert.equal(validateRoleId("data-engineer"), "data-engineer", "validateRoleId must accept the newest role id");

// --- a. validateRoleId: illegal values -> undefined (never throws) ---
assert.equal(validateRoleId("sre"), undefined, "unknown role ids must be rejected");
assert.equal(validateRoleId("Product Manager"), undefined, "role labels are not role ids");
assert.equal(validateRoleId("PM"), undefined, "role ids are case-sensitive");
assert.equal(validateRoleId(""), undefined, "empty string must be rejected");
assert.equal(validateRoleId("   "), undefined, "whitespace-only string must be rejected");
assert.equal(validateRoleId(42), undefined, "numbers must be rejected");
assert.equal(validateRoleId(null), undefined, "null must be rejected");
assert.equal(validateRoleId(undefined), undefined, "undefined must be rejected");
assert.equal(validateRoleId(true), undefined, "booleans must be rejected");
assert.equal(validateRoleId({ id: "pm" }), undefined, "objects must be rejected");
assert.equal(validateRoleId(["pm"]), undefined, "arrays must be rejected");
assert.equal(validateRoleId(Symbol("pm")), undefined, "symbols must be rejected");

// --- b. validateRoleIdList ---
assert.deepEqual(validateRoleIdList(undefined), [], "non-array input (undefined) must yield []");
assert.deepEqual(validateRoleIdList(null), [], "non-array input (null) must yield []");
assert.deepEqual(validateRoleIdList("pm"), [], "non-array input (string) must yield []");
assert.deepEqual(validateRoleIdList({}), [], "non-array input (object) must yield []");
assert.deepEqual(validateRoleIdList([]), [], "empty array must yield []");
assert.deepEqual(
  validateRoleIdList(["pm", 42, "sre", " qa ", "pm", null, "data-engineer", "", "Product Manager"]),
  ["pm", "qa", "data-engineer"],
  "list validation must filter non-strings/unknowns/blank, trim, and dedupe",
);
assert.deepEqual(
  validateRoleIdList(["qa", "pm", "qa", "developer", "pm"]),
  ["qa", "pm", "developer"],
  "list validation must keep first-occurrence order when deduping",
);
assert.deepEqual(
  validateRoleIdList(ROLE_IDS),
  ROLE_IDS,
  "a fully valid list must round-trip unchanged",
);
assert.equal(
  validateRoleIdList(["pm", "pm"]).length,
  1,
  "duplicate entries must collapse",
);
assert.equal(ROLE_IDS.length, ROLES.length, "ROLE_IDS must stay derived from ROLES");

// --- c. Source-level pins: the two migrated guards keep their behavior by delegating ---
const [rolesSource, interactionContractsSource, manifestSource] = await Promise.all([
  fs.readFile(path.join(projectRoot, "src", "src", "roles.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "interaction-contracts.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "orchestration-manifest.ts"), "utf8"),
]);

assert.match(
  rolesSource,
  /export function validateRoleId\(raw: unknown\): RoleId \| undefined/,
  "roles.ts must export validateRoleId with the unknown -> RoleId | undefined contract",
);
assert.match(
  rolesSource,
  /export function validateRoleIdList\(raw: unknown\): RoleId\[\]/,
  "roles.ts must export validateRoleIdList with the unknown -> RoleId[] contract",
);

assert.match(
  interactionContractsSource,
  /import \{ validateRoleId \} from "\.\/roles\.js";/,
  "interaction-contracts.ts must import the shared role validator",
);
assert.match(
  interactionContractsSource,
  /export function normalizeContractRole\(raw: unknown\): RoleId \| undefined \{[\s\S]*?return validateRoleId\(raw\);/,
  "normalizeContractRole must delegate to validateRoleId (guard behavior unchanged)",
);
assert.doesNotMatch(
  interactionContractsSource,
  /const ROLE_IDS = new Set/,
  "interaction-contracts.ts must no longer keep its own role id set copy",
);

assert.match(
  manifestSource,
  /import \{ validateRoleIdList \} from "\.\.\/roles\.js";/,
  "orchestration-manifest.ts must import the shared role list validator",
);
assert.match(
  manifestSource,
  /export function normalizeManifestRoleList\(raw: unknown\): RoleId\[\] \{[\s\S]*?return validateRoleIdList\(raw\);/,
  "normalizeManifestRoleList must delegate to validateRoleIdList (guard behavior unchanged)",
);
assert.match(
  manifestSource,
  /const TEAMCLAW_ROLE_IDS = new Set<RoleId>\(\[/,
  "the hand-written TEAMCLAW_ROLE_IDS copy stays in place until Phase 1.2 removes it",
);

console.log("validateRoleId / validateRoleIdList smoke passed.");
