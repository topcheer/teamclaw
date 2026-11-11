#!/usr/bin/env node
// Phase 1.5 (vertical-team-profiles-design.md section 1.5): the historical
// per-file regex pins (15 files, one "must contain <role id>" pattern each)
// are retired. They broke on every mechanical convergence step (Phase 1.2
// removed the dead per-file TEAMCLAW_ROLE_IDS_TEXT copies, Phase 1.4 made the
// UI/CLI/desktop role tables data-driven) and they would break again for
// every profile-driven role set. This rewrite asserts the registry itself:
//
//   1. role-ids.ts is the only literal anchor - its ROLE_IDS array is the
//      expected list everywhere else in this test (no second copy here).
//   2. Runtime invariants via the dist build: 11 unique ids, registry,
//      leaf, and ROLES entries all agree (test-side twin of the roles.ts
//      module-init drift guard).
//   3. Derived surfaces (openclaw.plugin.json enum, config schema enum,
//      tool descriptions) carry exactly that role set - compared as sets at
//      runtime / after JSON.parse, never as source regex pins, so refactors
//      of the surrounding code cannot break these assertions.
//   4. The untyped role surfaces (web UI app.js, installer CLI, desktop
//      renderer) stay literal-free: no quoted role id may appear in them,
//      with the two documented exemptions (cli.mjs migration sentinel,
//      desktop roleTone() tone buckets). Adding a role to the registry must
//      not require touching any of these files.
//   5. The Phase 1.4 wiring pins are kept (registry-fed option rendering).
//   6. The gateway lifecycle pins that used to live in this file are kept:
//      they are unrelated to roles but this was their only coverage.
//
// types.ts is read only for the RoleId union MEMBER set (section 2 asserts
// it equals the leaf list: tsc guards the leaf->union direction because the
// role-ids.ts array literal must stay assignable to RoleId[], while this
// test guards the union->leaf direction - a stale seed member would widen
// the cast-free compile-time role whitelist beyond the runtime registry).
// The union's FORM (closed set vs hybrid branded string, design v1.3) is
// deliberately not pinned; test-role-single-source.mjs owns the types.ts
// VALID_ROLES derivation pins.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const readSource = (rel) => fs.readFile(path.join(projectRoot, rel), "utf8");

// Import a dist module, failing with a message that distinguishes "dist not
// built yet" from "the roles.ts init drift guard fired at module load".
async function importDist(rel, name) {
  try {
    return await import(path.join(projectRoot, "src", "dist", "src", rel));
  } catch (error) {
    assert.fail(
      `${name} module failed to load (run npm --prefix src run build first; if the build is current, the roles.ts registry/leaf drift guard fired at module init: ${error?.message})`,
    );
  }
}

// Phase 1.5 pins the software-rd baseline role count as a conscious gate:
// a role addition/removal must update this pin (and the Phase 1.2 golden
// list in test-role-single-source.mjs) until TeamProfile makes the registry
// profile-driven (design doc Phase 2+).
const EXPECTED_ROLE_COUNT = 11;

// Compare role collections as sets: membership is the contract, order of
// derived surfaces is not (the registry order stays pinned by the deepEqual
// checks in section 2 below).
function assertSameRoleSet(actual, expected, message) {
  assert.ok(Array.isArray(actual), `${message}: expected an array, got ${typeof actual}`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

// Extract the parenthesized id list from a tool parameter description
// ("Exact target role ID (pm, architect, ...)"). These descriptions are
// hand-written source strings today; when they become generated from the
// registry this extraction should be replaced by a runtime assertion.
function extractDescribedRoleIds(source, name) {
  const match = source.match(/Exact target role ID \(([^)]*)\)/);
  assert.ok(
    match,
    `${name} must keep describing the target-role parameter with the parenthesized role id list (keep it in sync with the registry role ids)`,
  );
  return match[1].split(",").map((part) => part.trim()).filter(Boolean);
}

async function runRoleRegistrySmoke() {
  // -------------------------------------------------------------------------
  // 1. Canonical literal anchor: the ROLE_IDS array in src/src/role-ids.ts.
  // -------------------------------------------------------------------------
  const roleIdsSource = await readSource("src/src/role-ids.ts");
  const roleIdsLiteral = roleIdsSource.match(/export\s+const\s+ROLE_IDS[^=]*=\s*(\[[\s\S]*?\])\s*;/);
  assert.ok(
    roleIdsLiteral,
    "role-ids.ts must export ROLE_IDS as an array literal (the single source this test and the manifest generator extract)",
  );
  const leafRoleIds = JSON.parse(roleIdsLiteral[1].replace(/,\s*\]/g, "]").replace(/'/g, '"'));

  // -------------------------------------------------------------------------
  // 2. Runtime registry invariants (import the built dist modules, like
  //    test-role-single-source.mjs - run npm --prefix src run build first).
  // -------------------------------------------------------------------------
  const rolesMod = await importDist("roles.js", "roles");
  const roleIdsMod = await importDist("role-ids.js", "role-ids");
  const configMod = await importDist("config.js", "config");

  assert.equal(
    rolesMod.ROLE_IDS.length,
    EXPECTED_ROLE_COUNT,
    `registry must expose exactly ${EXPECTED_ROLE_COUNT} roles (baseline pin - a deliberate role add/remove updates this)`,
  );
  assert.equal(
    new Set(rolesMod.ROLE_IDS).size,
    rolesMod.ROLE_IDS.length,
    "role ids must be unique within the registry",
  );
  for (const roleId of rolesMod.ROLE_IDS) {
    assert.match(
      roleId,
      /^[a-z][a-z0-9-]*$/,
      "role ids must be lowercase slugs (they are used as CLI/UI tokens and quoted-literal scan needles)",
    );
  }
  assert.deepEqual(rolesMod.ROLE_IDS, leafRoleIds, "roles.ts ROLE_IDS must equal the role-ids.ts literal (test-side twin of the roles.ts init guard)");
  assert.deepEqual(roleIdsMod.ROLE_IDS, leafRoleIds, "role-ids.ts dist export must equal its own source literal");
  assert.deepEqual(
    rolesMod.ROLES.map((role) => role.id),
    leafRoleIds,
    "ROLES registry ids must equal the role-ids.ts literal (same order)",
  );
  for (const role of rolesMod.ROLES) {
    assert.ok(
      typeof role.label === "string" && role.label.length > 0,
      `role ${role.id} must carry a non-empty label (untyped UI surfaces render labels from the registry)`,
    );
  }

  // 2b. Seed-union membership equals the leaf list (form-tolerant: collect
  //     the quoted literals of the `export type RoleId = ...;` declaration,
  //     whatever the surrounding union shape - closed set or hybrid branded
  //     arm, which contributes no quoted literal). tsc already rejects a
  //     role id added to role-ids.ts without a matching union member; this
  //     closes the reverse gap where a union member added without a leaf
  //     entry compiles cleanly and widens the cast-free RoleId whitelist.
  const typesSource = await readSource("src/src/types.ts");
  const roleIdDeclaration = typesSource.match(/export type RoleId =([\s\S]*?);/);
  assert.ok(
    roleIdDeclaration,
    "types.ts must declare the RoleId type as `export type RoleId = ...;` (membership asserted against the role-ids.ts leaf)",
  );
  const unionMembers = [...roleIdDeclaration[1].matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(unionMembers.length > 0, "types.ts RoleId declaration must list its seed members as quoted literals");
  assertSameRoleSet(
    unionMembers,
    leafRoleIds,
    "types.ts RoleId seed-union members must equal the role-ids.ts role set (a member without a registry entry silently widens the cast-free compile-time role whitelist)",
  );

  // -------------------------------------------------------------------------
  // 3. Derived surfaces carry exactly the registry role set.
  // -------------------------------------------------------------------------
  const [pluginJsonSource, controllerToolsSource, workerToolsSource] = await Promise.all([
    readSource("src/openclaw.plugin.json"),
    readSource("src/src/controller/controller-tools.ts"),
    readSource("src/src/worker/tools.ts"),
  ]);

  // 3a. openclaw.plugin.json workerProvisioningRoles enum (JSON.parse, not regex).
  const pluginJson = JSON.parse(pluginJsonSource);
  assertSameRoleSet(
    pluginJson.configSchema.properties.workerProvisioningRoles.items.enum,
    leafRoleIds,
    "openclaw.plugin.json workerProvisioningRoles enum must equal the registry role set (run scripts/sync-teamclaw-plugin-manifest.mjs after registry changes)",
  );

  // 3b. config schema workerProvisioningRoles enum (runtime import).
  const configSchema = configMod.buildConfigSchema();
  assertSameRoleSet(
    configSchema.jsonSchema.properties.workerProvisioningRoles.items.enum,
    leafRoleIds,
    "config schema workerProvisioningRoles enum must equal the registry role set",
  );

  // 3c. Tool parameter descriptions list the registry roles (source-level
  //     extraction until the descriptions are generated from the registry).
  assertSameRoleSet(
    extractDescribedRoleIds(controllerToolsSource, "controller-tools.ts"),
    leafRoleIds,
    "controller-tools.ts assignedRole description must list exactly the registry roles",
  );
  assertSameRoleSet(
    extractDescribedRoleIds(workerToolsSource, "worker/tools.ts"),
    leafRoleIds,
    "worker/tools.ts targetRole description must list exactly the registry roles",
  );

  // -------------------------------------------------------------------------
  // 4. Untyped role surfaces stay data-driven: no quoted role id literal.
  //    Exemptions (same scope as tests/test-untyped-role-render.mjs):
  //    - cli.mjs LEGACY_DEFAULT_PROVISIONING_ROLES: migration sentinel that
  //      must keep matching the literal set old installer versions wrote.
  //    - desktop roleTone(): substring buckets for CSS tone classes over
  //      arbitrary role strings - presentation fallback, not a role table.
  //    Prose/i18n copy and the ui/index.html command placeholder example
  //      mention roles unquoted and are out of this scan's scope.
  // -------------------------------------------------------------------------
  const [cliSource, uiAppSource, desktopAppSource] = await Promise.all([
    readSource("src/cli.mjs"),
    readSource("src/src/ui/app.js"),
    readSource("desktop/renderer/app.js"),
  ]);
  const cliScannable = cliSource.replace(/const LEGACY_DEFAULT_PROVISIONING_ROLES = \[[^\]]*\];/g, "");
  const roleToneBlock = desktopAppSource.match(/function roleTone\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
  const desktopScannable = roleToneBlock ? desktopAppSource.replace(roleToneBlock[0], "") : desktopAppSource;

  for (const [name, source] of [
    ["src/src/ui/app.js", uiAppSource],
    ["src/cli.mjs", cliScannable],
    ["desktop/renderer/app.js", desktopScannable],
  ]) {
    for (const roleId of leafRoleIds) {
      const literalPattern = new RegExp('["\'`]' + roleId + '["\'`]');
      assert.doesNotMatch(
        source,
        literalPattern,
        `${name} must not hardcode the "${roleId}" role id literal (role tables render from the registry; see tests/test-untyped-role-render.mjs)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. Data-driven wiring pins (carried over from the Phase 1.4 minimal-sync
  //    assertions): the installer CLI and the web manual-task form derive
  //    their role tables from the registry instead of source literals.
  // -------------------------------------------------------------------------
  const uiIndexSource = await readSource("src/src/ui/index.html");
  assert.match(
    cliSource,
    /ROLE_MODULE_CANDIDATES = \["\.\/dist\/src\/roles\.js", "\.\/index\.js"\]/,
    "installer CLI should load its role table from the packaged role registry (layout-adaptive candidates, #253)",
  );
  assert.match(
    cliSource,
    /value:\s*role\.id,/,
    "installer CLI role options should be derived from registry role entries",
  );
  assert.match(
    uiIndexSource,
    /<option value="" data-i18n="manualTask\.autoAssign">Auto-assign<\/option>/,
    "UI manual-task form should keep the Auto-assign placeholder option",
  );
  assert.match(
    uiAppSource,
    /function renderTaskRoleOptions/,
    "UI manual-task role options should be rendered from /roles data",
  );

  // -------------------------------------------------------------------------
  // 6. Gateway lifecycle pins (retained from the pre-rewrite file; this was
  //    their only coverage and they are orthogonal to the role registry).
  // -------------------------------------------------------------------------
  const managedGatewayProcessSource = await readSource("src/src/controller/managed-gateway-process.ts");
  assert.match(
    managedGatewayProcessSource,
    /TEAMCLAW_PARENT_PID:\s*String\(process\.pid\)/,
    "managed gateway wrapper should tag child runtimes with the controller parent PID so orphaned gateways can detect parent death",
  );
  assert.match(
    managedGatewayProcessSource,
    /process\.kill\(-pid,\s*signal\)/,
    "managed gateway cleanup should signal the whole process group on Unix so wrapper + gateway descendants stop together",
  );
  assert.match(
    managedGatewayProcessSource,
    /process\.kill\(parentPid,\s*0\)/,
    "managed gateway wrapper should monitor the controller PID and self-terminate when the parent disappears",
  );

  console.log("Role registry smoke passed.");
}

await runRoleRegistrySmoke();
