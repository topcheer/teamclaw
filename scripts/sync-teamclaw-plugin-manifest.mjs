#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";

// Phase 1.2: the role id list is no longer duplicated here. It is read from
// the canonical src/src/role-ids.ts leaf module (the same list roles.ts
// asserts its ROLES registry against), so the manifest enum cannot drift
// from the registry.
function readTeamClawRoleIds(packageDir) {
  const roleIdsPath = path.resolve(packageDir, "src", "role-ids.ts");
  if (!existsSync(roleIdsPath)) {
    throw new Error(`role-ids.ts not found at ${roleIdsPath}`);
  }
  const source = readFileSync(roleIdsPath, "utf8");
  const match = source.match(/export\s+const\s+ROLE_IDS[^=]*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) {
    throw new Error(`Could not read the ROLE_IDS array literal from ${roleIdsPath}`);
  }
  const roleIds = vm.runInNewContext(`(${match[1]})`);
  if (!Array.isArray(roleIds) || roleIds.length === 0 || roleIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`ROLE_IDS at ${roleIdsPath} must be a non-empty array of non-empty role id strings`);
  }
  return roleIds;
}

const TEAMCLAW_MANIFEST_ID = "teamclaw";
const TEAMCLAW_MANIFEST_NAME = "TeamClaw";
const TEAMCLAW_MANIFEST_DESCRIPTION =
  "Virtual team collaboration - multiple OpenClaw instances form a virtual software company with role-based task routing.";

function parseArgs(argv) {
  let packageDir = "src";
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    packageDir = arg;
  }
  return packageDir;
}

function readPublishedRuntimeImage(packageDir) {
  const defaultsPath = path.resolve(packageDir, "src", "install-defaults.ts");
  if (!existsSync(defaultsPath)) {
    throw new Error(`install-defaults.ts not found at ${defaultsPath}`);
  }
  const source = readFileSync(defaultsPath, "utf8");
  const match = source.match(/TEAMCLAW_PUBLISHED_RUNTIME_IMAGE\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`Could not read TEAMCLAW_PUBLISHED_RUNTIME_IMAGE from ${defaultsPath}`);
  }
  return match[1];
}

function loadBuildConfigSchema(packageDir) {
  const configPath = path.resolve(packageDir, "src", "config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`config.ts not found at ${configPath}`);
  }

  let source = readFileSync(configPath, "utf8");
  source = source.replace(/^import\s+[^;]+;\n/gm, "");
  source = source.replace(/ as const/g, "");
  source = source.replace(/ as Record<string, unknown>/g, "");
  source = source.replace(/parse\(raw: unknown\): PluginConfig \{/g, "parse(raw) {");
  source = source.replace(/^export\s*\{\s*buildConfigSchema\s*\};\s*$/m, "");
  source += "\nglobalThis.__teamclawBuildConfigSchema = buildConfigSchema;\n";

  const context = {
    ROLE_IDS: readTeamClawRoleIds(packageDir),
    // Phase 1.3: config.ts derives the workerProvisioningRoles enum from the
    // active TeamProfile loader; stand in with the same role-ids.ts leaf the
    // software-rd profile snapshots, so the generated manifest enum is
    // unchanged.
    getActiveRoleIds: () => readTeamClawRoleIds(packageDir),
    // Phase 1.6: config.ts reads the software-rd baseline id from the loader.
    SOFTWARE_RD_PROFILE_ID: "software-rd",
    TEAMCLAW_PUBLISHED_RUNTIME_IMAGE: readPublishedRuntimeImage(packageDir),
    parsePluginConfig: (raw) => raw,
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: configPath });
  if (typeof context.__teamclawBuildConfigSchema !== "function") {
    throw new Error(`Failed to evaluate buildConfigSchema() from ${configPath}`);
  }
  return context.__teamclawBuildConfigSchema();
}

const packageDir = parseArgs(process.argv.slice(2));
const packageJsonPath = path.resolve(packageDir, "package.json");
const manifestPath = path.resolve(packageDir, "openclaw.plugin.json");

if (!existsSync(packageJsonPath)) {
  throw new Error(`package.json not found at ${packageJsonPath}`);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const expectedConfigSchema = loadBuildConfigSchema(packageDir);
// Agent tool names registered via api.registerTool - openclaw 2026.10 hosts
// require them to be declared in manifest contracts.tools.
const TEAMCLAW_AGENT_TOOL_NAMES = [
  "teamclaw_ask_peer",
  "teamclaw_assign_task",
  "teamclaw_broadcast",
  "teamclaw_create_task",
  "teamclaw_get_team_status",
  "teamclaw_list_tasks",
  "teamclaw_report_progress",
  "teamclaw_request_clarification",
  "teamclaw_request_kickoff",
  "teamclaw_request_parallel_help",
  "teamclaw_request_review",
  "teamclaw_send_message",
  "teamclaw_submit_manifest",
  "teamclaw_submit_result_contract",
  "teamclaw_suggest_handoff",
  // TeamAuto agent-facing tools registered by controller-tools.ts
  // (feat(teamauto) 80c3572 declared them in the manifest; the generator
  // list had drifted and would drop them on regeneration).
  "teamclaw_teamauto_propose",
  "teamclaw_teamauto_status",
  "teamclaw_teamauto_sweep",
];
const expectedManifest = {
  id: TEAMCLAW_MANIFEST_ID,
  name: TEAMCLAW_MANIFEST_NAME,
  description: TEAMCLAW_MANIFEST_DESCRIPTION,
  version: pkg.version,
  activation: { onStartup: true },
  contracts: { tools: TEAMCLAW_AGENT_TOOL_NAMES },
  skills: ["./skills"],
  uiHints: expectedConfigSchema.uiHints,
  configSchema: expectedConfigSchema.jsonSchema,
};

// The committed manifest is pure ASCII (non-ASCII help text is stored as
// \uXXXX escapes); plain JSON.stringify would emit literal characters and
// produce a spurious diff on every sync, so escape non-ASCII the same way.
const serializedManifest = JSON.stringify(expectedManifest, null, 2).replace(
  /[\u0080-\uFFFF]/g,
  (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
);

writeFileSync(manifestPath, `${serializedManifest}\n`, "utf8");
console.log(`Updated ${manifestPath}`);
