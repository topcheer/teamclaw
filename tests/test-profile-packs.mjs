#!/usr/bin/env node
// Phase 3 industry profile pack contract tests
// (vertical-team-profiles-design.md section 3, Phase 3 "common requirements
// for all six packs"), run against the source packages and the built dist
// loader (run `npm --prefix src run build` first).
//
// The test is auto-discovering: it iterates EVERY package dropped into
// src/src/profiles/ (except schema.json and the software-rd baseline, whose
// shape is pinned byte-for-byte by test-software-rd-golden.mjs instead) so
// the finance packs (banking/securities/insurance) are covered automatically
// once they merge. Per pack it asserts:
//
//   1. Real-loader validation: loader.validateProfilePackage accepts the
//      package as-is (schema subset + cross-field role references; a failure
//      here is a FATAL load error in production, design 2.2), and the
//      built-in load path picked the pack up from dist/src/profiles.
//   2. Role ids are unique and match the RoleId slug pattern.
//   3. Every role carries a non-empty labelZh (bilingual display, Phase 3
//      common requirement - no fallback-only roles in the industry packs).
//   4. warmupRoles references only this pack's role ids and holds 1-4
//      entries (cost control, design 2.1/2.3).
//   5. The capabilities object carries exactly the four software switches.
//   6. Finance packs (id in banking/securities/insurance) must set
//      outputConstraints.tailnote (design Phase 3: mandatory disclaimers
//      force-appended by the prompt injector).
//   7. reviewedBy is non-empty (domain review sign-off trail; the drafting
//      agent records itself while review is pending).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const SOURCE_PROFILES_DIR = path.join(projectRoot, "src", "src", "profiles");

// --- discovery: every packaged profile except schema.json and software-rd ---
const packFiles = fs.readdirSync(SOURCE_PROFILES_DIR)
  .filter((name) => name.endsWith(".json") && name !== "schema.json" && name !== "software-rd.json")
  .sort();
assert.ok(
  packFiles.length >= 2,
  "the Phase 3 industry packs (crossborder-ecom, trading-co) must be discovered in src/src/profiles",
);
assert.ok(
  packFiles.includes("crossborder-ecom.json") && packFiles.includes("trading-co.json"),
  "the two Phase 3 ecom/trading packs must be present",
);

// --- real loader: importing the dist module has ALREADY run the fatal load
// pipeline over every pack in dist/src/profiles at module init (design 2.2);
// validateProfilePackage then re-checks each source package individually so
// a failure attributes to one file. No TEAMCLAW_EXTRA_PROFILES_DIR here -
// this exercises the production built-in path. ---
const loader = await import(path.join(projectRoot, "src", "dist", "src", "profile-loader.js"));
const schema = JSON.parse(
  await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, "schema.json"), "utf8"),
);

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_SWITCHES = ["git", "teamauto", "runnablePreview", "deliveryReview"];
const FINANCE_PROFILE_IDS = new Set(["banking", "securities", "insurance"]);
const PHASE3_ROLE_COUNTS = { "crossborder-ecom": 9, "trading-co": 7 };

for (const file of packFiles) {
  const raw = JSON.parse(await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, file), "utf8"));

  // 1. The real loader pipeline must accept the package (fatal in production).
  loader.validateProfilePackage(raw, schema, file);

  // 1b. The built-in load path discovered the pack (stale-dist guard: the
  // build copies src/src/profiles into dist/src/profiles).
  assert.ok(
    loader.BUILTIN_PROFILES.has(raw.id),
    `pack ${file} (id "${raw.id}") must be present in the loader's built-in registry - run \`npm --prefix src run build\``,
  );

  // 2. Role ids: unique + RoleId slug pattern.
  const roleIds = raw.roles.map((role) => role.id);
  assert.equal(
    new Set(roleIds).size,
    roleIds.length,
    `pack ${file} must not have duplicate role ids`,
  );
  for (const role of raw.roles) {
    assert.match(
      role.id,
      ROLE_ID_PATTERN,
      `pack ${file} role id "${role.id}" must match the RoleId slug pattern`,
    );
    // 3. labelZh full coverage (Phase 3 common requirement).
    assert.ok(
      typeof role.labelZh === "string" && role.labelZh.trim().length > 0,
      `pack ${file} role "${role.id}" must carry a non-empty labelZh (bilingual display)`,
    );
  }

  // 4. warmupRoles: subset of this pack's roles, 1-4 entries.
  assert.ok(
    Array.isArray(raw.warmupRoles) && raw.warmupRoles.length >= 1 && raw.warmupRoles.length <= 4,
    `pack ${file} warmupRoles must hold 1-4 entries (cost control, design 2.1)`,
  );
  for (const roleId of raw.warmupRoles) {
    assert.ok(
      roleIds.includes(roleId),
      `pack ${file} warmupRoles entry "${roleId}" must be a role of this pack`,
    );
  }

  // 5. The four software capability switches exist.
  for (const key of CAPABILITY_SWITCHES) {
    assert.ok(
      key in raw.capabilities,
      `pack ${file} capabilities must declare the "${key}" switch`,
    );
  }

  // 6. Finance packs must carry the mandatory disclaimer tailnote. Written
  // now; activates automatically when the banking/securities/insurance
  // packages merge into this directory.
  if (FINANCE_PROFILE_IDS.has(raw.id)) {
    assert.ok(
      typeof raw.outputConstraints?.tailnote === "string" && raw.outputConstraints.tailnote.trim().length > 0,
      `finance pack ${file} ("${raw.id}") must set outputConstraints.tailnote (design Phase 3 hard requirement)`,
    );
  }

  // 7. reviewedBy non-empty (drafting trail until domain review signs off).
  assert.ok(
    Array.isArray(raw.reviewedBy) && raw.reviewedBy.length > 0
      && raw.reviewedBy.every((entry) => typeof entry === "string" && entry.trim().length > 0),
    `pack ${file} must carry a non-empty reviewedBy record (drafting or sign-off trail)`,
  );

  // 8. Design 2.4 workflow templates: a pack that ships workflows must keep
  // every step's role inside the pack (the loader makes violations FATAL -
  // test-workflows.mjs exercises that pipeline directly) and every on-jump
  // value must resolve to an existing step id or "next".
  if (raw.workflows !== undefined) {
    assert.ok(Array.isArray(raw.workflows), `pack ${file} workflows must be an array when present`);
    const workflowIds = new Set();
    for (const workflow of raw.workflows) {
      assert.ok(
        typeof workflow.id === "string" && ROLE_ID_PATTERN.test(workflow.id),
        `pack ${file} workflow id "${workflow.id}" must be a slug`,
      );
      assert.equal(workflowIds.has(workflow.id), false, `pack ${file} workflow ids must be unique`);
      workflowIds.add(workflow.id);
      const stepIds = new Set(workflow.steps.map((step) => String(step.id)));
      for (const step of workflow.steps) {
        assert.ok(
          roleIds.includes(step.role),
          `pack ${file} workflow "${workflow.id}" step ${JSON.stringify(step.id)} role "${step.role}" must be a role of this pack`,
        );
        for (const [jumpConclusion, target] of Object.entries(step.on ?? {})) {
          assert.ok(
            (step.conclusion ?? []).includes(jumpConclusion),
            `pack ${file} workflow "${workflow.id}" step ${JSON.stringify(step.id)} on-key "${jumpConclusion}" must come from the step's conclusion enum`,
          );
          assert.ok(
            target === "next" || stepIds.has(String(target)),
            `pack ${file} workflow "${workflow.id}" step ${JSON.stringify(step.id)} on-jump "${jumpConclusion}" must target a step id or "next"`,
          );
        }
        for (const inputKey of step.inputs ?? []) {
          assert.ok(
            workflow.steps.some((s) => (s.outputs ?? []).some((output) => output.key === inputKey)),
            `pack ${file} workflow "${workflow.id}" step ${JSON.stringify(step.id)} input "${inputKey}" must be a declared output key`,
          );
        }
      }
    }
  }

  // 8b. Banking workflow pin: the credit-approval template from design
  // section 2.4, carried since 0.1.2 (steps 0/1/2 numeric spine + committee
  // branch; step 1 additionally declares its reviewOpinion output so both
  // downstream inputs[] keys resolve).
  if (raw.id === "banking") {
    assert.ok(Array.isArray(raw.workflows) && raw.workflows.length === 1,
      "banking must carry exactly the credit-approval workflow template (design 2.4)");
    const workflow = raw.workflows[0];
    assert.equal(workflow.id, "credit-approval");
    assert.equal(workflow.name, "信贷审批流（对公）");
    assert.deepEqual(
      workflow.steps.map((step) => step.id),
      [0, 1, 2, "committee"],
      "credit-approval must keep the design 2.4 step structure (0 尽调 / 1 风险审查 / 2 审批 / committee 贷审会)",
    );
    assert.deepEqual(workflow.steps[0].conclusion, ["材料齐全", "需补充材料"]);
    assert.deepEqual(workflow.steps[1].conclusion, ["通过", "退回补充材料", "超权限上会"]);
    assert.deepEqual(workflow.steps[1].on, { 退回补充材料: 0, 超权限上会: "committee", 通过: 2 });
    assert.deepEqual(workflow.steps[0].outputs, [{ key: "dueDiligenceReport", name: "尽调报告" }]);
    assert.deepEqual(workflow.steps[2].inputs, ["dueDiligenceReport", "reviewOpinion"]);
    assert.equal(workflow.steps[3].role, "approver");
  }

  // Phase 3 design-table pin for this workstream's own packs.
  const expectedRoleCount = PHASE3_ROLE_COUNTS[raw.id];
  if (expectedRoleCount !== undefined) {
    assert.equal(
      raw.roles.length,
      expectedRoleCount,
      `pack ${file} must match the Phase 3 role table (${expectedRoleCount} roles)`,
    );
  }
}

console.log(`profile pack contracts passed (${packFiles.length} packs: ${packFiles.join(", ")}).`);
