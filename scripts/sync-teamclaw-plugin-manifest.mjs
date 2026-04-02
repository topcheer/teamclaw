#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";

const TEAMCLAW_ROLE_IDS = [
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
];

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
    ROLE_IDS: TEAMCLAW_ROLE_IDS,
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
const expectedManifest = {
  id: TEAMCLAW_MANIFEST_ID,
  name: TEAMCLAW_MANIFEST_NAME,
  description: TEAMCLAW_MANIFEST_DESCRIPTION,
  version: pkg.version,
  skills: ["./skills"],
  uiHints: expectedConfigSchema.uiHints,
  configSchema: expectedConfigSchema.jsonSchema,
};

writeFileSync(manifestPath, `${JSON.stringify(expectedManifest, null, 2)}\n`, "utf8");
console.log(`Updated ${manifestPath}`);
