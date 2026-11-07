#!/usr/bin/env node
// Phase 0.1 (vertical-team-profiles-design.md): role-inference CJK routing fix.
//
// Pins four contracts:
// a. Mixed CJK/ASCII task texts route via 2-char ASCII tokens ("qa"/"pm").
//    The previous `token.length > 2` filter dropped these tokens, so any
//    Chinese task text without a lucky 3+ char English word fell through to
//    the developer fallback.
// b. Pure-Chinese texts infer `null` and rely on DEFAULT_ROLE. The current
//    role registry is English-only, so no CJK token can hit — this is the
//    intended Phase 0.1 semantics (bilingual labels arrive in P1/P2).
// c. Existing English routing must not regress, including boundary guards:
//    2-char tokens must not match inside longer ASCII runs ("npm" must not
//    hit "pm", "build"/"guide" must not hit "ui").
// d. extractRoleTokens white-box behavior (ASCII >= 2, CJK runs >= 2 chars,
//    kept whole).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const inferenceMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "role-inference.js")
).catch(() => null);
assert.ok(inferenceMod, "role-inference module must be built (run npm --prefix src run build first)");
const { inferTaskRole, extractRoleTokens } = inferenceMod;
assert.equal(typeof inferTaskRole, "function", "inferTaskRole must stay exported for testing");
assert.equal(typeof extractRoleTokens, "function", "extractRoleTokens must stay exported for testing");

const rolesMod = await import(
  path.join(projectRoot, "src", "dist", "src", "roles.js")
).catch(() => null);
assert.ok(rolesMod, "roles module must be built (run npm --prefix src run build first)");
const { DEFAULT_ROLE } = rolesMod;
assert.equal(DEFAULT_ROLE, "developer", "DEFAULT_ROLE must keep the current developer fallback value");

function infer(title, description = "") {
  return inferTaskRole({ assignedRole: undefined, title, description });
}

// --- a. mixed CJK/ASCII texts route via 2-char ASCII tokens (core fix) ---
assert.equal(infer("处理QA登录问题"), "qa", "mixed text: standalone QA must route to qa (was null before Phase 0.1)");
assert.equal(infer("QA验证登录流程"), "qa", "mixed text: leading QA must route to qa");
assert.equal(infer("作为PM我想新增导出功能"), "pm", "mixed text: standalone PM must route to pm (was null before Phase 0.1)");
assert.equal(infer("修复CI流水线失败"), "release-engineer", "mixed text: standalone CI hits ci/cd tokens; registry-order tie-break keeps release-engineer ahead of devops");

// --- b. pure-Chinese text infers null; callers fall back to DEFAULT_ROLE ---
assert.equal(infer("核保规则调整", "根据新监管要求调整核保规则"), null, "pure-Chinese task must infer null (English-only role registry; bilingual labels are P1/P2 scope)");
assert.equal(DEFAULT_ROLE, "developer", "null inference resolves to DEFAULT_ROLE=developer under software-rd");

// --- c. existing English routing must not regress ---
assert.equal(infer("Fix the failing login test"), "qa", "english regression: login test still routes to qa");
assert.equal(infer("Design the database schema for the orders service"), "architect", "english regression: database schema still routes to architect");
assert.equal(infer("Set up the deployment pipeline"), "release-engineer", "english regression: deployment pipeline still routes to release-engineer");
assert.equal(infer("处理 qa 环境配置"), "qa", "spaced lowercase qa still routes to qa");
// boundary guards: 2-char tokens must not match inside longer ASCII runs
assert.equal(infer("npm install fails with exit 1"), null, "boundary guard: 'pm' inside 'npm' must not route to pm");
assert.equal(infer("Build a guide page for payments"), null, "boundary guard: 'ui' inside 'build'/'guide' must not route to designer");
assert.equal(infer("qaprovider 参数错误"), null, "boundary guard: 'qa' glued into 'qaprovider' must not route to qa");
// assignedRole passthrough is unchanged
assert.equal(inferTaskRole({ assignedRole: "qa", title: "whatever", description: "" }), "qa", "assignedRole passthrough unchanged");

// --- d. extractRoleTokens white-box behavior ---
assert.deepEqual(extractRoleTokens("QA Engineer"), ["qa", "engineer"], "2-char ASCII tokens are kept");
assert.deepEqual(extractRoleTokens("ci-cd"), ["ci", "cd"], "kebab pieces of 2 chars are kept");
assert.deepEqual(extractRoleTokens("UI/UX Designer"), ["ui", "ux", "designer"], "slash-separated short tokens are kept");
assert.deepEqual(extractRoleTokens("deployment"), ["deployment"], "long ASCII runs unchanged");
assert.deepEqual(extractRoleTokens("a b cd"), ["cd"], "single ASCII characters are still filtered");
assert.deepEqual(extractRoleTokens("核保规则"), ["核保规则"], "CJK run is kept whole (>= 2 chars)");
assert.deepEqual(extractRoleTokens("数据工程师 data-engineer"), ["data", "engineer", "数据工程师"], "CJK run and ASCII tokens are extracted from mixed entry");
assert.deepEqual(extractRoleTokens("核"), [], "single CJK character is filtered");
assert.deepEqual(extractRoleTokens("核 保"), [], "isolated single CJK characters are filtered");

// --- source-level pins: the three hardcoded developer fallbacks use DEFAULT_ROLE ---
const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

const provisioningSource = readSource(path.join("src", "src", "controller", "worker-provisioning.ts"));
assert.match(
  provisioningSource,
  /import \{ getActiveRoleIds, getActiveDefaultRole \} from "\.\.\/profile-loader\.js";/,
  "worker-provisioning imports the profile default role (Phase 1.3 active TeamProfile face)",
);
assert.doesNotMatch(provisioningSource, /return \["developer"\];/, "worker-provisioning startup fallback must not hardcode developer");

const httpServerSource = readSource(path.join("src", "src", "controller", "http-server.ts"));
assert.match(
  httpServerSource,
  /import \{[\s\S]*?getActiveDefaultRole,[\s\S]*?\} from "\.\.\/profile-loader\.js";/,
  "http-server imports the profile default role from the profile loader (Phase 1.3)",
);
assert.match(httpServerSource, /assignedRole === getActiveDefaultRole\(\)/, "http-server fallback title check uses the profile default role");

const typesSource = readSource(path.join("src", "src", "types.ts"));
assert.match(typesSource, /import \{ DEFAULT_ROLE \} from "\.\/roles\.js";/, "types.ts imports DEFAULT_ROLE from the role registry");
assert.doesNotMatch(typesSource, /"developer" as RoleId/, "types.ts parsePluginConfig fallback must not hardcode developer");

const rolesSource = readSource(path.join("src", "src", "roles.ts"));
assert.match(rolesSource, /export const DEFAULT_ROLE: RoleId = "developer";/, "roles.ts declares DEFAULT_ROLE as the single fallback source");

console.log("Role inference CJK routing smoke passed.");
