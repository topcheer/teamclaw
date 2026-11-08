#!/usr/bin/env node
// Phase 0.1 + Phase 2.5 (vertical-team-profiles-design.md section 2.3):
// role-inference CJK routing and tiered-confidence contracts.
//
// Pins six contracts:
// a. Mixed CJK/ASCII task texts route via 2-char ASCII tokens ("qa"/"pm").
//    The previous `token.length > 2` filter dropped these tokens, so any
//    Chinese task text without a lucky 3+ char English word fell through to
//    the developer fallback.
// b. Pure-Chinese texts infer `null` under software-rd and rely on the
//    profile default role. The software-rd registry itself stays
//    English-only; bilingual routing comes from profile roles carrying
//    labelZh / Chinese capability tokens (see e).
// c. Existing English routing must not regress, including boundary guards:
//    2-char tokens must not match inside longer ASCII runs ("npm" must not
//    hit "pm", "build"/"guide" must not hit "ui").
// d. extractRoleTokens white-box behavior (ASCII >= 2, CJK runs >= 2 chars,
//    kept whole).
// e. Phase 2.5 tiered bilingual scoring on a profile fixture (minimal-bank
//    via TEAMCLAW_EXTRA_PROFILES_DIR): labelZh full-phrase and distinctive
//    Chinese business tokens route pure-Chinese texts; a token carried by
//    more than 1/3 of the profile's roles (合规) becomes a stopword so
//    all-hands generic texts stop misrouting; ties escalate instead of using
//    registry order ("核保规则调整" -> credit-officer is the product goal).
// f. Phase 2.5 LLM fallback wiring: inferTaskRoleWithConfidence reports why
//    the token fast path refused, and resolveTaskRoleWithLlmFallback
//    (kickoff-orchestrator) delegates to an injected LLM judge callback,
//    validates its answer against the active profile, and degrades to the
//    profile defaultRole when no judge is wired. No real LLM is called.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// The bilingual fixture profile must be merged before the first dist import.
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");

const inferenceMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "role-inference.js")
).catch(() => null);
assert.ok(inferenceMod, "role-inference module must be built (run npm --prefix src run build first)");
const { inferTaskRole, inferTaskRoleWithConfidence, extractRoleTokens } = inferenceMod;
assert.equal(typeof inferTaskRole, "function", "inferTaskRole must stay exported for testing");
assert.equal(typeof inferTaskRoleWithConfidence, "function", "inferTaskRoleWithConfidence must stay exported for testing (Phase 2.5)");
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
// Phase 2.5 behavior change (honest record): this text hits only the shared
// "ci" capability token of release-engineer and devops at the same tier, a
// 1:1 tie. Phase 0.1 broke ties by registry order (release-engineer first);
// Phase 2.5 escalates ties to the LLM fallback instead, so inferTaskRole
// returns null and the caller (kickoff/controller LLM pass or defaultRole)
// owns the decision.
assert.equal(infer("修复CI流水线失败"), null, "Phase 2.5: capability-tier tie (ci: release-engineer vs devops) must escalate to the LLM fallback, not registry order");
{
  const verdict = inferTaskRoleWithConfidence({ assignedRole: undefined, title: "修复CI流水线失败", description: "" });
  assert.equal(verdict.needsLlmFallback, true, "CI tie verdict must demand the LLM fallback");
  assert.equal(verdict.reason, "tie", "CI tie verdict reason");
  assert.equal(verdict.role, "release-engineer", "fast-path winner is still reported for the LLM prompt");
  assert.equal(verdict.runnerUp, "devops", "CI tie runner-up is devops");
}

// --- b. pure-Chinese text infers null under software-rd; callers fall back to DEFAULT_ROLE ---
assert.equal(infer("核保规则调整", "根据新监管要求调整核保规则"), null, "pure-Chinese task stays null under software-rd (its registry carries no bilingual tokens; profile-level bilingual routing is proven in section e)");
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

// --- e. Phase 2.5 tiered bilingual scoring on the minimal-bank fixture ---
const loaderMod = await import(
  path.join(projectRoot, "src", "dist", "src", "profile-loader.js")
).catch(() => null);
assert.ok(loaderMod, "profile-loader module must be built (run npm --prefix src run build first)");
assert.equal(loaderMod.hasProfile("minimal-bank"), true, "minimal-bank fixture must be merged for bilingual inference");

loaderMod.setActiveProfileId("minimal-bank");

// Product goal of this wave: pure-Chinese banking tasks route via the
// fixture's bilingual capability tokens (核保 -> credit-officer).
assert.equal(infer("核保规则调整", "根据新监管要求调整核保规则"), "credit-officer", "核保规则调整 must route to credit-officer via the distinctive 核保 token (P2.5 product goal)");
assert.equal(infer("调整押品估值口径"), "risk-reviewer", "押品估值 must route to risk-reviewer");
assert.equal(infer("准备贷审会材料"), "approver", "贷审会 must route to approver");
// labelZh full-phrase tier: the highest tier routes even without capability hits.
assert.equal(infer("客户经理走访记录归档"), "credit-officer", "labelZh full phrase 客户经理 must route to credit-officer");
{
  const verdict = inferTaskRoleWithConfidence({ assignedRole: undefined, title: "客户经理走访记录归档", description: "" });
  assert.equal(verdict.reason, "confident", "labelZh phrase verdict is confident");
  assert.equal(verdict.topScore, 8, "labelZh phrase scores at the top tier weight");
}

// Rarity stopwords (design 2.3): 合规 is carried by ALL 3 fixture roles
// (> 1/3), so a text whose only hit is 合规 must not route anywhere - the
// pre-P2.5 scorer tied 1:1:1 and picked the first registry role.
assert.equal(infer("合规审查制度更新"), null, "all-hands generic token 合规 must be a stopword: no arbitrary routing");
{
  const verdict = inferTaskRoleWithConfidence({ assignedRole: undefined, title: "合规审查制度更新", description: "" });
  assert.equal(verdict.reason, "all-zero", "generic-only text verdict is all-zero after stopwording");
}
// The stopword is profile-relative: 合规 disappears from scoring, but the
// same profile's distinctive tokens keep working in the same text.
assert.equal(infer("合规审查制度更新", "同步更新押品估值流程"), "risk-reviewer", "distinctive token 押品估值 must still win a text that also carries the 合规 stopword");

// Ties escalate instead of "并列取数组靠前" (design 2.3).
assert.equal(infer("核保与押品估值复核"), null, "cross-role capability tie (核保 vs 押品估值) must escalate to the LLM fallback");
{
  const verdict = inferTaskRoleWithConfidence({ assignedRole: undefined, title: "核保与押品估值复核", description: "" });
  assert.equal(verdict.reason, "tie", "cross-role tie verdict reason");
  assert.equal(verdict.needsLlmFallback, true, "tie must demand the LLM fallback");
}

// assignedRole passthrough keeps working under the fixture profile.
assert.equal(inferTaskRole({ assignedRole: "approver", title: "whatever", description: "" }), "approver", "assignedRole passthrough unchanged under fixture profile");

loaderMod.setActiveProfileId("software-rd");

// --- f. Phase 2.5 LLM fallback wiring (fake injected callback, no real LLM) ---
const kickoffMod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "kickoff-orchestrator.js")
).catch(() => null);
assert.ok(kickoffMod, "kickoff-orchestrator module must be built (run npm --prefix src run build first)");
assert.equal(typeof kickoffMod.resolveTaskRoleWithLlmFallback, "function", "resolveTaskRoleWithLlmFallback must be exported for the Phase 2.5 fallback wiring");

// f1. Fast path confident -> the LLM judge is not consulted.
{
  let judgeCalls = 0;
  const role = await kickoffMod.resolveTaskRoleWithLlmFallback(
    { assignedRole: undefined, title: "处理QA登录问题", description: "" },
    { llmRoleJudge: async () => { judgeCalls += 1; return "pm"; } },
  );
  assert.equal(role, "qa", "confident fast path resolves without the LLM judge");
  assert.equal(judgeCalls, 0, "LLM judge must not be called when the fast path is confident");
}

// f2. Tie -> the LLM judge decides; its answer is validated against the active profile.
{
  const seen = [];
  const role = await kickoffMod.resolveTaskRoleWithLlmFallback(
    { assignedRole: undefined, title: "修复CI流水线失败", description: "" },
    {
      llmRoleJudge: async ({ verdict }) => {
        seen.push(verdict.reason);
        return "devops";
      },
    },
  );
  assert.equal(role, "devops", "tie escalates to the LLM judge and adopts its role");
  assert.deepEqual(seen, ["tie"], "the judge must see the tie verdict");
}

// f3. assignedRole passthrough short-circuits before the fast path.
{
  let judgeCalls = 0;
  const role = await kickoffMod.resolveTaskRoleWithLlmFallback(
    { assignedRole: "architect", title: "anything", description: "" },
    { llmRoleJudge: async () => { judgeCalls += 1; return "qa"; } },
  );
  assert.equal(role, "architect", "assignedRole passthrough wins over the LLM fallback");
  assert.equal(judgeCalls, 0, "LLM judge must not be called for assigned tasks");
}

// f4. Judge returns a role outside the active profile -> defaultRole.
assert.equal(
  await kickoffMod.resolveTaskRoleWithLlmFallback(
    { assignedRole: undefined, title: "修复CI流水线失败", description: "" },
    { llmRoleJudge: async () => "bogus-role" },
  ),
  "developer",
  "invalid LLM judge output must degrade to the profile defaultRole",
);

// f5. Judge throws -> defaultRole (never fail the caller on fallback errors).
assert.equal(
  await kickoffMod.resolveTaskRoleWithLlmFallback(
    { assignedRole: undefined, title: "修复CI流水线失败", description: "" },
    { llmRoleJudge: async () => { throw new Error("llm down"); } },
  ),
  "developer",
  "LLM judge failure must degrade to the profile defaultRole",
);

// f6. No judge wired -> defaultRole (Phase 0.1 configurable fallback).
assert.equal(
  await kickoffMod.resolveTaskRoleWithLlmFallback({ assignedRole: undefined, title: "修复CI流水线失败", description: "" }),
  "developer",
  "without an LLM judge the unconfident verdict degrades to the profile defaultRole",
);

// --- source-level pins: the three hardcoded developer fallbacks use DEFAULT_ROLE ---
const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

const provisioningSource = readSource(path.join("src", "src", "controller", "worker-provisioning.ts"));
assert.match(
  provisioningSource,
  /import \{ getActiveRoleIds, getActiveDefaultRole \} from "\.\.\/profile-loader\.js";/,
  "worker-provisioning imports the profile default role (Phase 1.3 active TeamProfile face)",
);
assert.doesNotMatch(provisioningSource, /return \["developer"\];/, "worker-provisioning startup fallback must not hardcode developer");

// PR-C of issue #204: the fallback title builder moved from http-server.ts
// into controller/controller-planning.ts - pin the new home.
const controllerPlanningSource = readSource(path.join("src", "src", "controller", "controller-planning.ts"));
assert.match(
  controllerPlanningSource,
  /import \{[\s\S]*?getActiveDefaultRole,[\s\S]*?\} from "\.\.\/profile-loader\.js";/,
  "controller-planning imports the profile default role from the profile loader (Phase 1.3)",
);
assert.match(controllerPlanningSource, /assignedRole === getActiveDefaultRole\(\)/, "fallback title check uses the profile default role");

const typesSource = readSource(path.join("src", "src", "types.ts"));
assert.match(typesSource, /import \{ DEFAULT_ROLE \} from "\.\/roles\.js";/, "types.ts imports DEFAULT_ROLE from the role registry");
assert.doesNotMatch(typesSource, /"developer" as RoleId/, "types.ts parsePluginConfig fallback must not hardcode developer");

const rolesSource = readSource(path.join("src", "src", "roles.ts"));
assert.match(rolesSource, /export const DEFAULT_ROLE: RoleId = "developer";/, "roles.ts declares DEFAULT_ROLE as the single fallback source");

console.log("Role inference CJK routing smoke passed.");
