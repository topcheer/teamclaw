#!/usr/bin/env node
// #251 P1: the four role-list prompt injections must derive from the
// ACTIVE team profile. Under software-rd they stay byte-identical to the
// software-11 list; under a non-software profile (banking) no software-only
// role ID may leak into worker/task/controller prompts.
import assert from "node:assert/strict";
import {
  buildRoleOperatingRules,
  buildWorkerSessionRules,
  buildTaskExecutionRules,
  buildControllerDisciplineRules,
} from "../src/dist/src/prompt-policy.js";
import { setActiveProfileId, getActiveProfileId } from "../src/dist/src/profile-loader.js";

const SOFTWARE_ONLY = ["architect", "release-engineer", "security-engineer", "data-engineer"];

function promptTexts() {
  return [
    buildRoleOperatingRules({ suggestedRoles: [], recommendedSkills: [] }).join("\n"),
    buildWorkerSessionRules().join("\n"),
    buildTaskExecutionRules("WAITING").join("\n"),
    buildControllerDisciplineRules({ canProvisionWithoutWorkers: false }).join("\n"),
  ];
}

// 1. Baseline: software-rd (loader default) keeps the software-11 vocabulary.
assert.equal(getActiveProfileId(), "software-rd", "loader must default to software-rd");
for (const text of promptTexts()) {
  assert.ok(text.includes("architect"), "software-rd prompt must list architect");
}

// 2. Banking profile: software-only role IDs must NOT appear; banking
// roles must appear in every role-list injection.
try {
  setActiveProfileId("banking");
  const texts = promptTexts();
  assert.equal(texts.length, 4);
  for (const [i, text] of texts.entries()) {
    for (const id of SOFTWARE_ONLY) {
      assert.ok(!text.includes(id), `banking prompt #${i} must not mention "${id}"`);
    }
    assert.ok(text.includes("credit-officer"), `banking prompt #${i} must list credit-officer`);
    assert.ok(text.includes("aml-analyst"), `banking prompt #${i} must list aml-analyst`);
  }
} finally {
  setActiveProfileId("software-rd");
}

console.log("test-prompt-policy-profile-roles: ok (4 injections derive from active profile)");
