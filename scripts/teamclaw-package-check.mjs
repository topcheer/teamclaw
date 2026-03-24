#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
  let githubOutput = process.env.GITHUB_OUTPUT || "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--github-output") {
      githubOutput = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    packageDir = arg;
  }

  return { packageDir, githubOutput };
}

function normalizeRepoUrl(value) {
  let normalized = String(value || "").trim();
  normalized = normalized.replace(/^git\+/, "");
  normalized = normalized.replace(/^git@github\.com:/, "https://github.com/");
  normalized = normalized.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  normalized = normalized.replace(/^https?:\/\/[^@]+@github\.com\//, "https://github.com/");
  normalized = normalized.replace(/\/+$/, "");
  if (normalized && !normalized.endsWith(".git")) {
    normalized += ".git";
  }
  return normalized;
}

function readOriginUrl() {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function writeGithubOutputs(filePath, outputs) {
  if (!filePath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
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

const { packageDir, githubOutput } = parseArgs(process.argv.slice(2));
const packageJsonPath = path.resolve(packageDir, "package.json");
const manifestPath = path.resolve(packageDir, "openclaw.plugin.json");

if (!existsSync(packageJsonPath)) {
  throw new Error(`package.json not found at ${packageJsonPath}`);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const repo = pkg.repository || {};
const errors = [];
const expectedDir = path.normalize(packageDir).replace(/\\/g, "/");

if (!pkg.name || typeof pkg.name !== "string") {
  errors.push("package.json name must be a non-empty string.");
}
if (pkg.name !== "@teamclaws/teamclaw") {
  errors.push(`package.json name must be "@teamclaws/teamclaw"; found "${pkg.name ?? "<missing>"}".`);
}
if (pkg.bin !== "./cli.mjs") {
  errors.push(`package.json bin must be "./cli.mjs"; found "${pkg.bin ?? "<missing>"}".`);
}
if (!Array.isArray(pkg.files) || !pkg.files.includes("cli.mjs")) {
  errors.push('package.json files must include "cli.mjs".');
}
if (!Array.isArray(pkg.files) || !pkg.files.includes("openclaw.plugin.json")) {
  errors.push('package.json files must include "openclaw.plugin.json".');
}
if (typeof pkg.dependencies?.openclaw !== "string" || !pkg.dependencies.openclaw.trim()) {
  errors.push('package.json dependencies.openclaw must be set so installed plugins can resolve the OpenClaw plugin SDK.');
}
if (pkg.peerDependencies?.openclaw) {
  errors.push('package.json peerDependencies.openclaw must not be used for the published plugin package; keep OpenClaw as a direct dependency.');
}
if (pkg.private === true) {
  errors.push("package.json private must not be true.");
}
if (!pkg.version || !/^\d{4}\.\d{1,2}\.\d{1,2}(?:-beta\.\d+)?$/.test(pkg.version)) {
  errors.push(
    `package.json version must match YYYY.M.D or YYYY.M.D-beta.N; found "${pkg.version ?? "<missing>"}".`,
  );
}
if (!Array.isArray(pkg.openclaw?.extensions) || pkg.openclaw.extensions.length === 0) {
  errors.push("openclaw.extensions must contain at least one entry.");
}
if (pkg.openclaw?.release?.publishToNpm !== true) {
  errors.push("openclaw.release.publishToNpm must be true.");
}
if (repo.type !== "git") {
  errors.push(`package.json repository.type must be "git"; found "${repo.type ?? "<missing>"}".`);
}
if (!repo.url) {
  errors.push("package.json repository.url must be set for npm trusted publishing.");
}
if (repo.directory !== expectedDir) {
  errors.push(
    `package.json repository.directory must be "${expectedDir}" for this package; found "${repo.directory ?? "<missing>"}".`,
  );
}
if (pkg.publishConfig?.access !== "public") {
  errors.push(`publishConfig.access must be "public"; found "${pkg.publishConfig?.access ?? "<missing>"}".`);
}

if (!manifest) {
  errors.push(`openclaw.plugin.json not found at ${manifestPath}.`);
} else {
  try {
    const expectedConfigSchema = loadBuildConfigSchema(packageDir);
    const expectedManifest = {
      id: TEAMCLAW_MANIFEST_ID,
      name: TEAMCLAW_MANIFEST_NAME,
      description: TEAMCLAW_MANIFEST_DESCRIPTION,
      version: pkg.version,
      uiHints: expectedConfigSchema.uiHints,
      configSchema: expectedConfigSchema.jsonSchema,
    };
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
      errors.push(
        "openclaw.plugin.json is out of sync with src/src/config.ts or package.json version; regenerate/update the manifest.",
      );
    }
  } catch (error) {
    errors.push(
      `Unable to validate openclaw.plugin.json against src/src/config.ts: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
}

const originUrl = readOriginUrl();
if (!originUrl) {
  errors.push("git remote origin.url is missing; cannot validate package repository metadata.");
} else if (normalizeRepoUrl(repo.url) !== normalizeRepoUrl(originUrl)) {
  errors.push(
    `package.json repository.url (${repo.url}) does not match git remote origin (${originUrl}).`,
  );
}

if (errors.length > 0) {
  console.error("TeamClaw package metadata validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const publishTag = String(pkg.version).includes("-beta.") ? "beta" : "latest";
const summary = {
  packageDir: expectedDir,
  packageName: pkg.name,
  packageVersion: pkg.version,
  publishTag,
  repositoryUrl: repo.url,
  repositoryDirectory: repo.directory,
};

console.log(JSON.stringify(summary, null, 2));
writeGithubOutputs(githubOutput, {
  package_dir: summary.packageDir,
  package_name: summary.packageName,
  package_version: summary.packageVersion,
  publish_tag: summary.publishTag,
});
