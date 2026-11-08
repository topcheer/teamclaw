#!/usr/bin/env node
// Issue #192 (Phase 3 prerequisite): worker-side role parsing must not fold
// industry profile roles to developer.
//
// Before the fix, parsePluginConfig (src/src/types.ts) validated config.role
// against the software registry's validateRoleId: any role id outside the 11
// software seeds (e.g. minimal-bank's "credit-officer") was silently folded
// to developer, so a worker provisioned under an industry profile registered
// with the WRONG role against its controller (mismatch, or 400 once the
// controller's active profile does not include developer).
//
// Contracts pinned here (issue fix direction 1 - lenient accept, controller
// adjudicates):
// a. An industry role string survives parsePluginConfig verbatim; final
//    legitimacy stays with the controller's validateActiveRoleId at
//    registration (active profile is the single source of truth).
// b. Software registry roles parse exactly as before (incl. trim).
// c. DEFAULT_ROLE fallback is unchanged: missing, non-string, or blank role
//    still resolves to the software-rd default (developer).
// d. Source anchors: the role field no longer goes through registry
//    validateRoleId, and the controller register endpoint answers an
//    unknown-role 400 with an actionable message (issue direction 3).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const typesMod = await import(
  path.join(projectRoot, "src", "dist", "src", "types.js")
).catch(() => null);
assert.ok(typesMod, "types module must be built (run npm --prefix src run build first)");
const { parsePluginConfig } = typesMod;
assert.equal(typeof parsePluginConfig, "function", "parsePluginConfig must stay exported");

// ── Contract a: industry roles are preserved verbatim ───────────────────────
{
  const preserved = parsePluginConfig({ mode: "worker", role: "credit-officer" });
  assert.equal(preserved.role, "credit-officer", "industry profile role must survive parsing verbatim (was folded to developer before #192)");

  const trimmed = parsePluginConfig({ mode: "worker", role: " risk-reviewer " });
  assert.equal(trimmed.role, "risk-reviewer", "industry role keeps the registry trim semantics");

  const arbitrary = parsePluginConfig({ mode: "worker", role: "future-industry-role" });
  assert.equal(arbitrary.role, "future-industry-role", "unknown role strings stay lenient-accepted; the controller register endpoint adjudicates them");
}

// ── Contract b: software registry roles parse exactly as before ─────────────
{
  const SOFTWARE_ROLES = [
    "pm", "architect", "developer", "qa", "release-engineer",
    "infra-engineer", "devops", "security-engineer", "designer",
    "marketing", "data-engineer",
  ];
  for (const role of SOFTWARE_ROLES) {
    assert.equal(parsePluginConfig({ mode: "worker", role }).role, role, `software role ${role} must parse unchanged`);
  }
  assert.equal(parsePluginConfig({ mode: "worker", role: " qa " }).role, "qa", "software role trim behavior unchanged");
}

// ── Contract c: DEFAULT_ROLE fallback unchanged ─────────────────────────────
{
  assert.equal(parsePluginConfig({}).role, "developer", "missing role still falls back to DEFAULT_ROLE");
  assert.equal(parsePluginConfig({ role: undefined }).role, "developer", "undefined role still falls back to DEFAULT_ROLE");
  assert.equal(parsePluginConfig({ role: 42 }).role, "developer", "non-string role still falls back to DEFAULT_ROLE");
  assert.equal(parsePluginConfig({ role: "" }).role, "developer", "empty role string still falls back to DEFAULT_ROLE");
  assert.equal(parsePluginConfig({ role: "   " }).role, "developer", "whitespace-only role still falls back to DEFAULT_ROLE");
}

// ── Contract d: source anchors ──────────────────────────────────────────────
{
  const typesSource = await fs.promises.readFile(
    path.join(projectRoot, "src", "src", "types.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    typesSource,
    /validateRoleId\(raw\.role\)/,
    "parsePluginConfig must not fold config.role through the registry validator (issue #192 root cause)",
  );

  // PR-C of issue #204: the worker register handler moved from
  // http-server.ts into controller/worker-routes.ts - pin the new home.
  const workerRoutesSource = await fs.promises.readFile(
    path.join(projectRoot, "src", "src", "controller", "worker-routes.ts"),
    "utf8",
  );
  assert.match(
    workerRoutesSource,
    /is not part of the active team profile/,
    "worker register endpoint must answer unknown-role 400s with an actionable profile-aware message (issue #192 direction 3)",
  );
}

console.log("test-worker-role-parse: all assertions passed (issue #192 lenient role parse, software/DEFAULT_ROLE semantics unchanged)");
