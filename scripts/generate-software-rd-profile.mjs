#!/usr/bin/env node
// Phase 1.3 (vertical-team-profiles-design.md sections 1.3/2.2): generate
// src/src/profiles/software-rd.json - the built-in TeamProfile package that
// transplants the current 11-role software registry from src/src/roles.ts.
//
// Pattern (modeled on scripts/sync-teamclaw-plugin-manifest.mjs): reuse the
// built dist. Importing dist/src/roles.js snapshots the registry AFTER the
// module-init operating-rules composition, so the generated systemPrompt
// values are byte-identical to what the runtime served pre-Phase-1.3.
// tests/test-software-rd-golden.mjs deep-compares the generated JSON with
// the dist registry on every run, so forgetting to regenerate after editing
// roles.ts fails the golden test instead of drifting silently.
//
// Run after changing roles.ts (or role-ids.ts):
//   npm --prefix src run build && npm --prefix src run profile:sync

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PROFILE_SCHEMA_VERSION = 1;
const SOFTWARE_RD_ROLE_FIELDS = [
  "id",
  "label",
  "icon",
  "description",
  "capabilities",
  "recommendedSkills",
  "systemPrompt",
  "suggestedNextRoles",
];

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

async function loadBuiltRoles(packageDir) {
  const rolesPath = path.resolve(packageDir, "dist", "src", "roles.js");
  if (!existsSync(rolesPath)) {
    throw new Error(`dist roles module not found at ${rolesPath} - run \`npm --prefix ${packageDir} run build\` first`);
  }
  const rolesModule = await import(`file://${rolesPath}`);
  const roles = rolesModule.ROLES;
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error(`ROLES at ${rolesPath} must be a non-empty array`);
  }
  for (const role of roles) {
    for (const field of SOFTWARE_RD_ROLE_FIELDS) {
      if (role[field] === undefined) {
        throw new Error(`Role ${role?.id} is missing the "${field}" field required by the profile snapshot`);
      }
    }
  }
  return { roles, defaultRole: rolesModule.DEFAULT_ROLE };
}

const packageDir = parseArgs(process.argv.slice(2));
const { roles, defaultRole } = await loadBuiltRoles(packageDir);

// The software-rd baseline currently warms exactly the fallback role:
// WorkerProvisioningManager.determineStartupReadinessRoles() falls back to
// [DEFAULT_ROLE] when config workerProvisioningRoles is empty.
const profile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  id: "software-rd",
  name: "Software R&D Team",
  nameZh: "软件研发团队",
  industry: "software",
  icon: "\uD83D\uDCBB",
  version: "1.0.0",
  description:
    "Baseline software R&D team: the 11-role roles.ts registry transplanted field-by-field as the behavior-parity reference profile (Phase 1.3).",
  roles: roles.map((role) => {
    const snapshot = {};
    for (const field of SOFTWARE_RD_ROLE_FIELDS) {
      snapshot[field] = role[field];
    }
    return snapshot;
  }),
  capabilities: {
    git: true,
    teamauto: true,
    runnablePreview: true,
    deliveryReview: true,
  },
  warmupRoles: [defaultRole],
  defaultRole,
};

const targetPath = path.resolve(packageDir, "src", "profiles", "software-rd.json");

// ASCII-escape non-ASCII (emoji, nameZh) the same way the manifest generator
// does, so the committed file diffs stay stable regardless of tooling.
const serialized = JSON.stringify(profile, null, 2).replace(
  /[\u0080-\uFFFF]/g,
  (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
);

writeFileSync(targetPath, `${serialized}\n`, "utf8");
console.log(`Updated ${targetPath} (${roles.length} roles, defaultRole "${defaultRole}")`);

// Guard the generator's own output shape: the JSON must round-trip through
// JSON.parse with the exact role ids in registry order.
const written = JSON.parse(readFileSync(targetPath, "utf8"));
if (written.roles.length !== roles.length || written.roles.some((role, index) => role.id !== roles[index].id)) {
  throw new Error(`Generated ${targetPath} does not round-trip the registry role order - investigate before committing`);
}
