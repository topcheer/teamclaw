#!/usr/bin/env node
// Phase 1.2 (vertical-team-profiles-design.md section 1.1): the role id list
// must have a single source of truth. The canonical list lives in
// src/src/role-ids.ts (dependency-free leaf); the ROLES registry in roles.ts
// asserts agreement at module init; every former copy derives from one of
// them. This test pins both the derivation wiring (source level) and the
// exact runtime values (golden level) so convergence can never change
// behavior.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const readSource = (rel) => fs.readFile(path.join(projectRoot, rel), "utf8");

// Golden values captured from the pre-Phase-1.2 hand-written constants.
// They double as the behavior-freeze contract: derivation must reproduce
// them byte for byte.
const GOLDEN_ROLE_IDS = [
  "pm",
  "architect",
  "developer",
  "qa",
  "release-engineer",
  "infra-engineer",
  "devops",
  "security-engineer",
  "designer",
  "marketing",
  "data-engineer",
];
const GOLDEN_ROLE_IDS_TEXT =
  "pm, architect, developer, qa, release-engineer, infra-engineer, devops, security-engineer, designer, marketing, data-engineer";
const GOLDEN_PROMPT_ROLE_LINES = {
  operatingRules: `- Use exact TeamClaw role IDs when collaborating: ${GOLDEN_ROLE_IDS_TEXT}.`,
  workerSession: `10. Valid TeamClaw role IDs: ${GOLDEN_ROLE_IDS_TEXT}.`,
  taskExecution: `- When naming a role, use exact TeamClaw role IDs: ${GOLDEN_ROLE_IDS_TEXT}.`,
  controllerDiscipline: `- Use exact TeamClaw role IDs only: ${GOLDEN_ROLE_IDS_TEXT}.`,
};
const GOLDEN_ROLE_CATALOG = [
  { id: "pm", label: "Project Manager" },
  { id: "architect", label: "Architect" },
  { id: "developer", label: "Developer" },
  { id: "qa", label: "QA Engineer" },
  { id: "release-engineer", label: "Release Engineer" },
  { id: "infra-engineer", label: "Infra Engineer" },
  { id: "devops", label: "DevOps Engineer" },
  { id: "security-engineer", label: "Security Engineer" },
  { id: "designer", label: "Designer" },
  { id: "marketing", label: "Marketing" },
  { id: "data-engineer", label: "Data Engineer" },
];

// ---------------------------------------------------------------------------
// 1. Source-level derivation pins.
// ---------------------------------------------------------------------------
const [
  roleIdsSource,
  rolesSource,
  promptPolicySource,
  typesSource,
  controllerToolsSource,
  workspaceSource,
  taskExecutorSource,
  controllerPromptSource,
  workerPromptSource,
  orchestrationManifestSource,
  manifestGeneratorSource,
  pluginJsonSource,
] = await Promise.all([
  readSource("src/src/role-ids.ts"),
  readSource("src/src/roles.ts"),
  readSource("src/src/prompt-policy.ts"),
  readSource("src/src/types.ts"),
  readSource("src/src/controller/controller-tools.ts"),
  readSource("src/src/openclaw-workspace.ts"),
  readSource("src/src/task-executor.ts"),
  readSource("src/src/controller/prompt-injector.ts"),
  readSource("src/src/worker/prompt-injector.ts"),
  readSource("src/src/controller/orchestration-manifest.ts"),
  readSource("scripts/sync-teamclaw-plugin-manifest.mjs"),
  readSource("src/openclaw.plugin.json"),
]);

// 1a. role-ids.ts is the canonical leaf: dependency-free except types, and
// its ROLE_IDS literal parses to the golden list (the manifest generator
// regex-extracts this same literal).
assert.match(
  roleIdsSource,
  /import type \{ RoleId \} from "\.\/types\.js";/,
  "role-ids.ts must keep roles.ts/prompt-policy.ts compatible via a type-only import (no runtime dependency)",
);
assert.doesNotMatch(
  roleIdsSource,
  /^import (?!type)/m,
  "role-ids.ts must not have runtime imports - it is the dependency-free leaf below prompt-policy.ts",
);
const roleIdsLiteral = roleIdsSource.match(/export\s+const\s+ROLE_IDS[^=]*=\s*(\[[\s\S]*?\])\s*;/);
assert.ok(roleIdsLiteral, "role-ids.ts must export ROLE_IDS as an array literal the manifest generator can extract");
assert.deepEqual(
  JSON.parse(roleIdsLiteral[1].replace(/,\s*\]/g, "]").replace(/'/g, '"')),
  GOLDEN_ROLE_IDS,
  "role-ids.ts ROLE_IDS literal must equal the golden role list",
);

// 1b. roles.ts derives ROLE_IDS from the ROLES registry and guards drift
// against the canonical list.
assert.match(
  rolesSource,
  /import \{ ROLE_IDS as CANONICAL_ROLE_IDS \} from "\.\/role-ids\.js";/,
  "roles.ts must import the canonical list from role-ids.js",
);
assert.match(
  rolesSource,
  /const ROLE_IDS: RoleId\[\] = ROLES\.map\(\(r\) => r\.id\);/,
  "roles.ts must keep ROLE_IDS derived from the ROLES registry",
);
assert.match(
  rolesSource,
  /CANONICAL_ROLE_IDS\.length[^}]+drifted apart/,
  "roles.ts must fail fast at module init when ROLES ids and role-ids.ts drift apart",
);

// 1c. prompt-policy.ts derives TEAMCLAW_ROLE_IDS instead of listing roles.
assert.match(
  promptPolicySource,
  /import \{ ROLE_IDS \} from "\.\/role-ids\.js";[\s\S]*export const TEAMCLAW_ROLE_IDS: RoleId\[\] = ROLE_IDS;/,
  "prompt-policy.ts must derive TEAMCLAW_ROLE_IDS from role-ids.js (value-importing roles.ts would cycle)",
);
assert.doesNotMatch(
  promptPolicySource,
  /"(security-engineer|data-engineer|infra-engineer)"/,
  "prompt-policy.ts must no longer hand-write role id literals",
);

// 1d. types.ts VALID_ROLES is derived from the registry.
assert.match(
  typesSource,
  /import \{ ROLE_IDS \} from "\.\/roles\.js";[\s\S]*const VALID_ROLES: RoleId\[\] = ROLE_IDS;/,
  "types.ts VALID_ROLES must derive from roles.ts ROLE_IDS",
);
assert.doesNotMatch(
  typesSource,
  /const VALID_ROLES: RoleId\[\] = \[/,
  "types.ts must not keep a hand-written VALID_ROLES array",
);

// 1e. controller-tools.ts validates tool role inputs against the ACTIVE
// TeamProfile (Phase 2.1 debt item 1 from the P1 closeout handover): the old
// registry-set check would silently kill every non-software role once a team
// switches profiles. The software-rd behavior is unchanged (active set ==
// registry set); the registry import itself is gone.
assert.match(
  controllerToolsSource,
  /import \{ validateActiveRoleId \} from "\.\.\/profile-loader\.js";/,
  "controller-tools.ts must validate candidate roles via validateActiveRoleId from the profile loader",
);
assert.match(
  controllerToolsSource,
  /validateActiveRoleId\(String\(r \?\? ""\)\.trim\(\)\.toLowerCase\(\)\)/,
  "controller-tools.ts kickoff candidateRoles must be filtered through validateActiveRoleId",
);
assert.doesNotMatch(
  controllerToolsSource,
  /ROLE_IDS|VALID_ROLE_IDS/,
  "controller-tools.ts must not keep a registry-set role copy (Phase 2.1 debt 1 removed it)",
);

// 1f. openclaw-workspace.ts derives the catalog id/order from role-ids.ts.
assert.match(
  workspaceSource,
  /import \{ ROLE_IDS \} from "\.\/role-ids\.js";[\s\S]*TEAMCLAW_ROLE_CATALOG[^=]*= ROLE_IDS\.map\(/,
  "openclaw-workspace.ts must derive TEAMCLAW_ROLE_CATALOG ids/order from role-ids.js",
);

// 1g. The dead per-file TEAMCLAW_ROLE_IDS_TEXT copies stay gone.
for (const [name, source] of [
  ["task-executor.ts", taskExecutorSource],
  ["controller/prompt-injector.ts", controllerPromptSource],
  ["worker/prompt-injector.ts", workerPromptSource],
]) {
  assert.doesNotMatch(
    source,
    /const TEAMCLAW_ROLE_IDS_TEXT/,
    `${name} must not re-introduce a local TEAMCLAW_ROLE_IDS_TEXT copy (Phase 1.2 removed the dead copies; the shared text lives in prompt-policy.ts)`,
  );
}

// 1g'. The orchestration-manifest role id Set that Phase 0.3 kept "until
// Phase 1.2 removes it" is removed; normalizeManifestRoleList delegates to
// validateRoleIdList and must not regain a hand-written copy.
assert.doesNotMatch(
  orchestrationManifestSource,
  /const TEAMCLAW_ROLE_IDS = new Set/,
  "orchestration-manifest.ts must not re-introduce a hand-written role id Set (removed by Phase 1.2; validateRoleIdList is the guard)",
);

// 1h. The manifest generator derives the role list from role-ids.ts instead
// of embedding its own copy.
assert.match(
  manifestGeneratorSource,
  /readTeamClawRoleIds[\s\S]*role-ids\.ts/,
  "scripts/sync-teamclaw-plugin-manifest.mjs must read ROLE_IDS from role-ids.ts",
);
assert.doesNotMatch(
  manifestGeneratorSource,
  /"(security-engineer|data-engineer|infra-engineer)"/,
  "the manifest generator must not embed role id literals",
);
assert.match(
  manifestGeneratorSource,
  /"teamclaw_teamauto_status"/,
  "the manifest generator must declare the teamauto agent tools the controller registers (parity with the committed manifest)",
);

// 1i. The committed manifest itself carries the golden enum and default.
const pluginJson = JSON.parse(pluginJsonSource);
assert.deepEqual(
  pluginJson.configSchema.properties.workerProvisioningRoles.items.enum,
  GOLDEN_ROLE_IDS,
  "openclaw.plugin.json workerProvisioningRoles enum must equal the golden role list",
);
assert.equal(
  pluginJson.configSchema.properties.role.default,
  "developer",
  "openclaw.plugin.json role default must stay the schema default (developer)",
);

// ---------------------------------------------------------------------------
// 2. Runtime golden pins (import the built dist modules, like
//    test-validate-role-id.mjs - run npm --prefix src run build first).
// ---------------------------------------------------------------------------
const rolesMod = await import(
  new URL(`./../src/dist/src/roles.js`, `file://${scriptDir}/`).href
).catch(() => null);
assert.ok(rolesMod, "roles module must be built (run npm --prefix src run build first)");
const promptPolicyMod = await import(
  new URL(`./../src/dist/src/prompt-policy.js`, `file://${scriptDir}/`).href
).catch(() => null);
assert.ok(promptPolicyMod, "prompt-policy module must be built (run npm --prefix src run build first)");
const workspaceMod = await import(
  new URL(`./../src/dist/src/openclaw-workspace.js`, `file://${scriptDir}/`).href
).catch(() => null);
assert.ok(workspaceMod, "openclaw-workspace module must be built (run npm --prefix src run build first)");

// 2a. Registry-derived values equal the golden list (set, order, membership).
assert.deepEqual(rolesMod.ROLE_IDS, GOLDEN_ROLE_IDS, "roles.ts ROLE_IDS must equal the golden role list");
assert.deepEqual(
  rolesMod.ROLES.map((role) => role.id),
  GOLDEN_ROLE_IDS,
  "ROLES ids must equal the golden role list",
);
assert.equal(new Set(rolesMod.ROLE_IDS).size, GOLDEN_ROLE_IDS.length, "role ids must be unique");

// 2b. prompt-policy constants are derived and byte-identical.
assert.deepEqual(
  promptPolicyMod.TEAMCLAW_ROLE_IDS,
  GOLDEN_ROLE_IDS,
  "prompt-policy TEAMCLAW_ROLE_IDS must equal the golden role list",
);
assert.equal(
  promptPolicyMod.TEAMCLAW_ROLE_IDS_TEXT,
  GOLDEN_ROLE_IDS_TEXT,
  "prompt-policy TEAMCLAW_ROLE_IDS_TEXT must be the exact pre-Phase-1.2 joined text",
);

// 2c. The four prompt-injection sites embed the exact golden role lines.
assert.ok(
  promptPolicyMod
    .buildRoleOperatingRules({ suggestedRoles: [], recommendedSkills: [] })
    .includes(GOLDEN_PROMPT_ROLE_LINES.operatingRules),
  "buildRoleOperatingRules must embed the exact golden role id line",
);
assert.ok(
  promptPolicyMod.buildWorkerSessionRules().includes(GOLDEN_PROMPT_ROLE_LINES.workerSession),
  "buildWorkerSessionRules must embed the exact golden role id line (rule 10)",
);
assert.ok(
  promptPolicyMod
    .buildTaskExecutionRules("TEAMCLAW_STILL_WAITING")
    .includes(GOLDEN_PROMPT_ROLE_LINES.taskExecution),
  "buildTaskExecutionRules must embed the exact golden role id line",
);
assert.ok(
  promptPolicyMod
    .buildControllerDisciplineRules({ canProvisionWithoutWorkers: true })
    .includes(GOLDEN_PROMPT_ROLE_LINES.controllerDiscipline),
  "buildControllerDisciplineRules must embed the exact golden role id line",
);
assert.ok(
  rolesMod.ROLES[0].systemPrompt.includes(GOLDEN_PROMPT_ROLE_LINES.operatingRules),
  "composed role systemPrompt (worker prompts) must embed the exact golden role id line",
);

// 2d. The derived workspace catalog equals the exact pre-Phase-1.2 value.
assert.deepEqual(
  workspaceMod.TEAMCLAW_ROLE_CATALOG,
  GOLDEN_ROLE_CATALOG,
  "openclaw-workspace TEAMCLAW_ROLE_CATALOG must equal the exact pre-Phase-1.2 hand-written catalog (ids, order, and compact labels)",
);

console.log("Role single-source-of-truth smoke passed.");

// Issue #204 P2: normalizeSessionRole must live in one place (session-roles.ts).
{
  const httpServerSrc = await readSource("src/src/controller/http-server.ts");
  const taskExecutorSrc = await readSource("src/src/task-executor.ts");
  const sharedSrc = await readSource("src/src/session-roles.ts");
  assert.match(sharedSrc, /export function normalizeSessionRole/, "shared session-roles.ts exports normalizeSessionRole");
  assert.doesNotMatch(httpServerSrc, /function normalizeSessionRole/, "http-server must not redefine normalizeSessionRole");
  assert.doesNotMatch(taskExecutorSrc, /function normalizeSessionRole/, "task-executor must not redefine normalizeSessionRole");
  assert.match(httpServerSrc, /from "\.\.\/session-roles\.js"/, "http-server imports the shared normalizer");
  assert.match(taskExecutorSrc, /from "\.\/session-roles\.js"/, "task-executor imports the shared normalizer");
}
