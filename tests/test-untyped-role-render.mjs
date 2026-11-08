#!/usr/bin/env node

// Phase 1.4 (vertical-team-profiles-design.md): the untyped role surfaces —
// web UI (src/src/ui/), desktop renderer, and the installer CLI — must render
// their role tables from the single role registry instead of hardcoded role
// ids, so a profile-driven role set (Phase 1.3: /roles returns profile
// content) surfaces in all three with zero source changes. This test asserts
// no software-rd role id survives as a render literal in those files, and —
// when the dist registry is built — that the derived CLI table is identical
// to the pre-refactor hardcoded one (behavior-preservation pin).
//
// Intentional role-id residuals OUTSIDE this test's scope (semantic, kept):
// - src/cli.mjs LEGACY_DEFAULT_PROVISIONING_ROLES: migration sentinel that
//   must keep matching the literal set old installer versions wrote.
// - i18n copy / placeholder examples that mention a role by name (e.g. the
//   "/assign task-id developer" command placeholder in ui/index.html).
// - desktop roleTone(): substring buckets for CSS tone classes over arbitrary
//   role strings — presentation fallback, not a role registry table.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const uiIndexPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const desktopAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");
const httpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
// PR-D of issue #204: the team-status handler (buildExternalWorkerInstallInfo)
// moved from http-server.ts into controller/route-table.ts.
const routeTablePath = path.join(projectRoot, "src", "src", "controller", "route-table.ts");
const cliPath = path.join(projectRoot, "src", "cli.mjs");
const distRolesPath = path.join(projectRoot, "src", "dist", "src", "roles.js");

// The software-rd role table as it was hardcoded before Phase 1.4. Used as a
// pin: the registry-derived tables must reproduce it exactly (order + ids +
// labels for the CLI wizard) while the sources themselves carry no literals.
const PRE_REFROLE_ROLE_TABLE = [
  { value: "pm", label: "Product Manager" },
  { value: "architect", label: "Software Architect" },
  { value: "developer", label: "Developer" },
  { value: "qa", label: "QA Engineer" },
  { value: "release-engineer", label: "Release Engineer" },
  { value: "infra-engineer", label: "Infrastructure Engineer" },
  { value: "devops", label: "DevOps Engineer" },
  { value: "security-engineer", label: "Security Engineer" },
  { value: "designer", label: "UI/UX Designer" },
  { value: "marketing", label: "Marketing Specialist" },
  { value: "data-engineer", label: "Data Engineer" },
];
const ROLE_IDS = PRE_REFROLE_ROLE_TABLE.map((entry) => entry.value);

const roleOptionLiteralPattern = new RegExp(
  `(value:\\s*["']|<option value=")(?:${ROLE_IDS.join("|")})(["'>])`,
);

async function runUntypedRoleRenderSmoke() {
  const [uiIndex, uiApp, desktopApp, routeTableSource, cliSource] = await Promise.all([
    fs.readFile(uiIndexPath, "utf8"),
    fs.readFile(uiAppPath, "utf8"),
    fs.readFile(desktopAppPath, "utf8"),
    fs.readFile(routeTablePath, "utf8"),
    fs.readFile(cliPath, "utf8"),
  ]);

  // --- Web UI: manual-task role options are data-driven -----------------
  for (const roleId of ROLE_IDS) {
    assert.doesNotMatch(
      uiIndex,
      new RegExp(`<option value="${roleId}">`),
      `ui/index.html must not hardcode the ${roleId} option (rendered from /roles)`,
    );
  }
  assert.match(
    uiIndex,
    /<option value="" data-i18n="manualTask\.autoAssign">Auto-assign<\/option>/,
    "manual-task select must keep the static Auto-assign placeholder",
  );
  assert.match(
    uiApp,
    /function renderTaskRoleOptions/,
    "app.js must render manual-task role options",
  );
  assert.match(
    uiApp,
    /roleRegistry = Array\.isArray\(rolesRes\.roles\) \? rolesRes\.roles : \[\];/,
    "renderTaskRoleOptions must be fed by the /roles response",
  );

  // --- Web UI: no hardcoded role default / icon map ----------------------
  assert.doesNotMatch(
    uiApp,
    /selectedExternalWorkerRole\s*=\s*["'][a-z-]+["']/,
    "external-worker default role must not be a hardcoded role id",
  );
  assert.doesNotMatch(
    uiApp,
    /ROLE_ICONS/,
    "the per-UI ROLE_ICONS map must be gone (icons come from the registry)",
  );
  assert.match(
    uiApp,
    /function roleIcon\(roleId\)/,
    "app.js must resolve role icons from the /roles registry",
  );
  assert.match(
    uiApp,
    /function resolveDefaultRoleId\(roles, payloadDefaultId\)/,
    "external-worker default must resolve from the advertised payload default",
  );
  assert.match(
    uiApp,
    /resolveDefaultRoleId\(roles, info\.defaultRole\)/,
    "external-worker card must pass the externalWorkerInstall payload default through",
  );

  // --- Desktop: no hardcoded external-worker role ------------------------
  assert.doesNotMatch(
    desktopApp,
    /externalWorkerRole\s*:\s*["'][a-z-]+["']/,
    "desktop externalWorkerRole initial value must not be a hardcoded role id",
  );
  assert.match(
    desktopApp,
    /state\.externalWorkerRole = validDefault \? payloadDefaultRole : roles\[0\]\.id;/,
    "desktop must prefer the payload-advertised default over the first registry entry",
  );
  assert.match(
    desktopApp,
    /typeof info\.defaultRole === 'string' \? info\.defaultRole : ''/,
    "desktop must read the external-worker default from the install payload",
  );

  // --- Backend: install payload advertises the active profile default role --
  // PR-D of issue #204: buildExternalWorkerInstallInfo moved to route-table.ts.
  assert.match(
    routeTableSource,
    /defaultRole: getActiveDefaultRole\(\),/,
    "buildExternalWorkerInstallInfo must expose the active profile defaultRole so UIs restore the developer default (Phase 1.3)",
  );

  // --- CLI: role table derived from the packaged registry ----------------
  assert.doesNotMatch(
    cliSource,
    roleOptionLiteralPattern,
    "cli.mjs must not hardcode role option entries (table comes from dist/src/roles.js)",
  );
  assert.match(
    cliSource,
    /import\("\.\/dist\/src\/roles\.js"\)/,
    "cli.mjs must load the role registry from the packaged dist build",
  );
  assert.match(
    cliSource,
    /DEFAULT_WORKER_ROLE \|\| ROLE_OPTIONS\[0\]\.value/,
    "worker-role wizard default must derive from the registry default, not a literal",
  );
  assert.match(
    cliSource,
    /const LEGACY_DEFAULT_PROVISIONING_ROLES = \["architect", "developer", "qa"\];/,
    "legacy migration sentinel role set must stay pinned (documented retention)",
  );

  // --- Behavior pin: derived CLI table equals the pre-refactor table -----
  // Skipped (with a notice) when dist has not been built yet; the acceptance
  // flow runs `npm --prefix src run build` first.
  const distRoles = await import(distRolesPath).catch(() => null);
  if (!distRoles) {
    console.log("Untyped role render smoke passed (dist registry not built - derivation pin skipped).");
    return;
  }
  const derived = distRoles.ROLES.map((role) => ({ value: role.id, label: role.label }));
  assert.deepEqual(
    derived,
    PRE_REFROLE_ROLE_TABLE,
    "registry-derived CLI role table must exactly match the pre-refactor hardcoded table",
  );
  assert.equal(
    distRoles.DEFAULT_ROLE,
    "developer",
    "registry DEFAULT_ROLE must keep the pre-refactor installer default",
  );

  console.log("Untyped role render smoke passed.");
}

await runUntypedRoleRenderSmoke();
