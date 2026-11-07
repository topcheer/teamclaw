#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const rolesPath = path.join(projectRoot, "src", "src", "roles.ts");
const typesPath = path.join(projectRoot, "src", "src", "types.ts");
const configPath = path.join(projectRoot, "src", "src", "config.ts");
const workerPromptPath = path.join(projectRoot, "src", "src", "worker", "prompt-injector.ts");
const taskExecutorPath = path.join(projectRoot, "src", "src", "task-executor.ts");
const controllerPromptPath = path.join(projectRoot, "src", "src", "controller", "prompt-injector.ts");
const manifestPath = path.join(projectRoot, "src", "src", "controller", "orchestration-manifest.ts");
const managedGatewayProcessPath = path.join(projectRoot, "src", "src", "controller", "managed-gateway-process.ts");
const controllerToolsPath = path.join(projectRoot, "src", "src", "controller", "controller-tools.ts");
const workerToolsPath = path.join(projectRoot, "src", "src", "worker", "tools.ts");
const cliPath = path.join(projectRoot, "src", "cli.mjs");
const uiIndexPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const pluginJsonPath = path.join(projectRoot, "src", "openclaw.plugin.json");
const readmePath = path.join(projectRoot, "README.md");
const sitePath = path.join(projectRoot, "docs", "index.html");

const expectedRoles = [
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

async function runRoleRegistrySmoke() {
  const [
    rolesSource,
    typesSource,
    configSource,
    workerPromptSource,
    taskExecutorSource,
    controllerPromptSource,
    manifestSource,
    managedGatewayProcessSource,
    controllerToolsSource,
    workerToolsSource,
    cliSource,
    uiIndexSource,
    uiAppSource,
    pluginJsonSource,
    readmeSource,
    siteSource,
  ] = await Promise.all([
    fs.readFile(rolesPath, "utf8"),
    fs.readFile(typesPath, "utf8"),
    fs.readFile(configPath, "utf8"),
    fs.readFile(workerPromptPath, "utf8"),
    fs.readFile(taskExecutorPath, "utf8"),
    fs.readFile(controllerPromptPath, "utf8"),
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(managedGatewayProcessPath, "utf8"),
    fs.readFile(controllerToolsPath, "utf8"),
    fs.readFile(workerToolsPath, "utf8"),
    fs.readFile(cliPath, "utf8"),
    fs.readFile(uiIndexPath, "utf8"),
    fs.readFile(uiAppPath, "utf8"),
    fs.readFile(pluginJsonPath, "utf8"),
    fs.readFile(readmePath, "utf8"),
    fs.readFile(sitePath, "utf8"),
  ]);

  for (const role of expectedRoles) {
    assert.match(rolesSource, new RegExp(`id:\\s*"${role}"`), `roles.ts should define ${role}`);
    assert.match(typesSource, new RegExp(`\\|\\s*"${role}"`), `types.ts RoleId union should include ${role}`);
    assert.match(typesSource, new RegExp(`"${role}"`), `types.ts VALID_ROLES should include ${role}`);
    assert.match(readmeSource, new RegExp("`" + role + "`"), `README supported roles table should mention ${role}`);
  }

  // Phase 1.4 minimal sync: the installer CLI and the web manual-task form no
  // longer hardcode the role table — both derive it from the role registry
  // (dist/src/roles.js for the CLI, GET /api/v1/roles for the UI), so the
  // per-file "must contain <role id>" assertions above were replaced by
  // data-driven wiring assertions. Deep coverage lives in
  // tests/test-untyped-role-render.mjs.
  assert.match(
    cliSource,
    /import\("\.\/dist\/src\/roles\.js"\)/,
    "installer CLI should load its role table from the packaged role registry",
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

  assert.match(
    rolesSource,
    /const TEAMCLAW_ROLE_IDS_TEXT = \[/,
    "roles.ts should keep a centralized TeamClaw role ID text list",
  );
  assert.match(
    configSource,
    /import \{ ROLE_IDS \} from "\.\/roles\.js";[\s\S]*workerProvisioningRoles:\s*\{[\s\S]*items:\s*\{[\s\S]*enum:\s*ROLE_IDS,/,
    "config schema should validate provisioned role values against ROLE_IDS",
  );
  assert.match(
    workerPromptSource,
    /import \{ getRole \} from "\.\.\/roles\.js";[\s\S]*const TEAMCLAW_ROLE_IDS_TEXT = \[/,
    "worker prompt should reuse shared role lookup and expose the TeamClaw role list text",
  );
  assert.match(
    controllerPromptSource,
    /import \{ ROLES \} from "\.\.\/roles\.js";[\s\S]*const TEAMCLAW_ROLE_IDS_TEXT = \[/,
    "controller prompt should reuse shared roles and expose the TeamClaw role list text",
  );
  assert.match(
    taskExecutorSource,
    /import \{ getRole \} from "\.\/roles\.js";[\s\S]*const TEAMCLAW_ROLE_IDS_TEXT = \[/,
    "task executor should reuse shared role lookup and expose the TeamClaw role list text",
  );
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
  assert.match(
    controllerToolsSource,
    /Exact target role ID \(pm, architect, developer, qa, release-engineer, infra-engineer, devops, security-engineer, designer, marketing, data-engineer\)/,
    "controller tools should describe target roles using the supported TeamClaw role IDs",
  );
  const validRoleIdsMatch = controllerToolsSource.match(/const VALID_ROLE_IDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(validRoleIdsMatch, "controller tools should keep a VALID_ROLE_IDS allowlist");
  const validRoleIds = validRoleIdsMatch[1].match(/"[^"]+"/g).map((entry) => entry.slice(1, -1));
  assert.equal(validRoleIds.length, 11, "VALID_ROLE_IDS should cover all 11 TeamClaw roles");
  assert.ok(validRoleIds.includes("data-engineer"), "VALID_ROLE_IDS should include data-engineer");
  assert.match(
    workerToolsSource,
    /Exact target role ID \(pm, architect, developer, qa, release-engineer, infra-engineer, devops, security-engineer, designer, marketing, data-engineer\)/,
    "worker tools should describe target roles using the supported TeamClaw role IDs",
  );

  const pluginJson = JSON.parse(pluginJsonSource);
  const provisionRoleEnum = pluginJson.configSchema.properties.workerProvisioningRoles.items.enum;
  for (const role of expectedRoles) {
    assert.ok(provisionRoleEnum.includes(role), `openclaw.plugin.json workerProvisioningRoles enum should include ${role}`);
  }

  assert.match(
    siteSource,
    /data-n="11"[^>]*>0<\/div>\s*<div class="lbl">Roles on the team<\/div>/,
    "GitHub Pages site should reflect the expanded role count",
  );

  console.log("Role registry smoke passed.");
}

await runRoleRegistrySmoke();
