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
const localWorkerManagerPath = path.join(projectRoot, "src", "src", "controller", "local-worker-manager.ts");
const managedGatewayProcessPath = path.join(projectRoot, "src", "src", "controller", "managed-gateway-process.ts");
const controllerToolsPath = path.join(projectRoot, "src", "src", "controller", "controller-tools.ts");
const workerToolsPath = path.join(projectRoot, "src", "src", "worker", "tools.ts");
const cliPath = path.join(projectRoot, "src", "cli.mjs");
const uiIndexPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const pluginJsonPath = path.join(projectRoot, "src", "openclaw.plugin.json");
const readmePath = path.join(projectRoot, "README.md");
const sitePath = path.join(projectRoot, "docs", "index.html");

const expectedRoles = [
  "data-engineer",
  "sre",
  "technical-writer",
  "solution-engineer",
  "support-engineer",
  "compliance-engineer",
  "privacy-engineer",
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
    localWorkerManagerSource,
    managedGatewayProcessSource,
    controllerToolsSource,
    workerToolsSource,
    cliSource,
    uiIndexSource,
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
    fs.readFile(localWorkerManagerPath, "utf8"),
    fs.readFile(managedGatewayProcessPath, "utf8"),
    fs.readFile(controllerToolsPath, "utf8"),
    fs.readFile(workerToolsPath, "utf8"),
    fs.readFile(cliPath, "utf8"),
    fs.readFile(uiIndexPath, "utf8"),
    fs.readFile(pluginJsonPath, "utf8"),
    fs.readFile(readmePath, "utf8"),
    fs.readFile(sitePath, "utf8"),
  ]);

  for (const role of expectedRoles) {
    assert.match(rolesSource, new RegExp(`id:\\s*"${role}"`), `roles.ts should define ${role}`);
    assert.match(typesSource, new RegExp(`\\|\\s*"${role}"`), `types.ts RoleId union should include ${role}`);
    assert.match(typesSource, new RegExp(`"${role}"`), `types.ts VALID_ROLES should include ${role}`);
    assert.match(cliSource, new RegExp(`value:\\s*"${role}"`), `installer CLI should offer ${role}`);
    assert.match(uiIndexSource, new RegExp(`<option value="${role}">`), `UI manual-task form should offer ${role}`);
    assert.match(readmeSource, new RegExp("`" + role + "`"), `README supported roles table should mention ${role}`);
  }

  assert.match(
    rolesSource,
    /const ROLE_IDS_TEXT = ROLE_IDS\.join\(", "\);/,
    "roles.ts should derive ROLE_IDS_TEXT from the central role list",
  );
  assert.match(
    rolesSource,
    /function isRoleId\(value: string\): value is RoleId/,
    "roles.ts should expose a reusable isRoleId helper",
  );
  assert.match(
    configSource,
    /role:\s*\{[\s\S]*enum:\s*ROLE_IDS[\s\S]*default:\s*"developer"/,
    "config schema should validate worker role values against ROLE_IDS",
  );
  assert.match(
    workerPromptSource,
    /import \{ getRole, ROLE_IDS_TEXT \} from "\.\.\/roles\.js";/,
    "worker prompt should import ROLE_IDS_TEXT from the shared role registry",
  );
  assert.match(
    controllerPromptSource,
    /import \{ ROLES, ROLE_IDS_TEXT \} from "\.\.\/roles\.js";/,
    "controller prompt should import ROLE_IDS_TEXT from the shared role registry",
  );
  assert.match(
    taskExecutorSource,
    /import \{ getRole, ROLE_IDS_TEXT \} from "\.\/roles\.js";/,
    "task executor should import ROLE_IDS_TEXT from the shared role registry",
  );
  assert.match(
    manifestSource,
    /import \{ isRoleId \} from "\.\.\/roles\.js";/,
    "manifest normalization should reuse the shared role helper",
  );
  assert.match(
    localWorkerManagerSource,
    /import \{ getRole, isRoleId \} from "\.\.\/roles\.js";[\s\S]*import \{ spawnManagedGatewayProcess, stopManagedGatewayProcess \} from "\.\/managed-gateway-process\.js";/,
    "local worker manager should reuse the shared role helper",
  );
  assert.match(
    localWorkerManagerSource,
    /spawnManagedGatewayProcess\(\{[\s\S]*OPENCLAW_SKIP_CHANNELS:\s*"1"[\s\S]*OPENCLAW_DISABLE_BONJOUR:\s*"1"/,
    "controller-managed local child workers should skip OpenClaw channel startup, disable bonjour when the controller already knows the worker URL, and launch through the managed gateway wrapper so orphaned runtimes do not accumulate after controller restarts",
  );
  assert.match(
    localWorkerManagerSource,
    /stopManagedGatewayProcess\(child,\s*LOCAL_WORKER_STOP_TIMEOUT_MS/,
    "controller-managed local child workers should stop through the shared gateway cleanup helper instead of only signaling a single PID",
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
    /Exact target role ID \(\$\{ROLE_IDS_TEXT\}\)/,
    "controller tools should describe target roles using the shared role text",
  );
  assert.match(
    workerToolsSource,
    /Exact target role ID \(\$\{ROLE_IDS_TEXT\}\)/,
    "worker tools should describe target roles using the shared role text",
  );

  const pluginJson = JSON.parse(pluginJsonSource);
  const roleEnum = pluginJson.configSchema.properties.role.enum;
  const localRoleEnum = pluginJson.configSchema.properties.localRoles.items.enum;
  const provisionRoleEnum = pluginJson.configSchema.properties.workerProvisioningRoles.items.enum;
  for (const role of expectedRoles) {
    assert.ok(roleEnum.includes(role), `openclaw.plugin.json role enum should include ${role}`);
    assert.ok(localRoleEnum.includes(role), `openclaw.plugin.json localRoles enum should include ${role}`);
    assert.ok(provisionRoleEnum.includes(role), `openclaw.plugin.json workerProvisioningRoles enum should include ${role}`);
  }

  assert.match(
    siteSource,
    />17<\/strong>\s*<span>available role types<\/span>/,
    "GitHub Pages site should reflect the expanded role count",
  );

  console.log("Role registry smoke passed.");
}

await runRoleRegistrySmoke();
