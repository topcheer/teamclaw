#!/usr/bin/env node
// Phase 2.4 (vertical-team-profiles-design.md sections 2.1/2.4): the
// domainInstructions replacement semantics.
//
// Pins four contracts against the built dist modules (run
// `npm --prefix src run build` first):
//
//   1. Replacement, not addition: when the active profile carries
//      domainInstructions, the controller and worker prompt pipelines embed
//      those lines as the "## TeamClaw Operating Contract" section and NONE
//      of the software engineering operating rules from
//      buildRoleOperatingRules (design: "软件规范不残留").
//   2. Assembly point: the worker pipeline assembles the domain contract
//      directly after the role systemPrompt; the controller pipeline
//      assembles it directly after the role catalog.
//   3. software-rd zero drift: the baseline profile has no
//      domainInstructions, the injectors add nothing, and the prompt byte
//      goldens still reproduce exactly after switching profiles away and
//      back (the fork is keyed on the active profile, not on module state).
//   4. Loader consumption: the schema validates the field (string arrays,
//      non-empty items) and the loader cross-validation makes
//      domainInstructions-on-software-rd a fatal load error (the baseline
//      keeps its rules pre-composed in the role systemPrompts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// The fixture profile (minimal-bank) is merged in via the Phase 2.1 test
// hook; the env var must be set before the first dist import.
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-domain-instr-"));

const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

const loader = await dist("profile-loader.js");
const { parsePluginConfig } = await dist("types.js");
const { createControllerPromptInjector } = await dist("controller/prompt-injector.js");
const { createWorkerPromptInjector } = await dist("worker/prompt-injector.js");
const { MessageQueue } = await dist("worker/message-queue.js");

assert.equal(loader.hasProfile("minimal-bank"), true, "fixture profile must be merged via TEAMCLAW_EXTRA_PROFILES_DIR");

// Signature sentences of the software engineering operating rules
// (buildRoleOperatingRules software branch). A banking prompt containing any
// of these would mean the software rules leaked past the replacement.
const SOFTWARE_RULE_ANCHORS = [
  "You are a team member, not the controller. Complete the current task yourself.",
  "Stay within your assigned role. Do not switch roles unless the task explicitly asks for cross-role analysis.",
  "Use exact TeamClaw role IDs when collaborating:",
  "Prefer open-source/free tools and services when they can satisfy the task.",
  "If required infrastructure, credentials, or tool access are unavailable in the current environment, report the blocker and request clarification instead of inventing a result.",
];
const DOMAIN_ANCHOR_LINE = "Banking operating contract: every artifact you produce is an internal working draft";

function assertNoSoftwareRules(prompt, label) {
  for (const anchor of SOFTWARE_RULE_ANCHORS) {
    assert.ok(!prompt.includes(anchor), `${label} must not contain the software operating-rule anchor: ${JSON.stringify(anchor.slice(0, 60))}...`);
  }
}

// ---------------------------------------------------------------------------
// 1 + 2. Replacement semantics and assembly point on the minimal-bank fixture.
// ---------------------------------------------------------------------------
loader.setActiveProfileId("minimal-bank");
assert.ok(
  loader.getActiveDomainInstructions()?.[0]?.startsWith(DOMAIN_ANCHOR_LINE),
  "getActiveDomainInstructions must expose the active profile's guardrails",
);

const workerInjector = createWorkerPromptInjector(
  parsePluginConfig({
    mode: "worker",
    role: "credit-officer",
    teamName: "Domain Bank",
    controllerUrl: "http://127.0.0.1:9527",
  }),
  () => ({
    workerId: "worker-bank-1",
    role: "credit-officer",
    controllerUrl: "http://127.0.0.1:9527",
    registeredAt: 1730000000000,
  }),
  new MessageQueue(),
);
const bankingWorkerPrompt = workerInjector()?.prependSystemContext ?? "";
assert.ok(bankingWorkerPrompt.length > 0, "worker injector must render under the banking profile");
assert.ok(bankingWorkerPrompt.includes("## TeamClaw Operating Contract"), "banking worker prompt keeps the Operating Contract section header (content replaced)");
assert.ok(bankingWorkerPrompt.includes(DOMAIN_ANCHOR_LINE), "banking worker prompt embeds the domainInstructions lines");
assertNoSoftwareRules(bankingWorkerPrompt, "banking worker prompt");
// Assembly point: the domain contract sits directly after the role
// systemPrompt, before the session rules section.
const systemPromptEnd = bankingWorkerPrompt.indexOf("Never issue a formal approval opinion.");
const domainContractAt = bankingWorkerPrompt.indexOf("## TeamClaw Operating Contract");
const sessionRulesAt = bankingWorkerPrompt.indexOf("## Current Session Rules");
assert.ok(systemPromptEnd !== -1 && domainContractAt !== -1 && sessionRulesAt !== -1, "worker prompt must contain systemPrompt, domain contract, and session rules");
assert.ok(systemPromptEnd < domainContractAt && domainContractAt < sessionRulesAt, "domain contract must be assembled after the role systemPrompt and before the session rules");

const controllerInjector = createControllerPromptInjector({
  config: parsePluginConfig({ mode: "controller", teamName: "Domain Bank", port: 9527, maxConcurrentTasks: 5 }),
  getTeamState: () => null,
});
const bankingControllerPrompt = controllerInjector()?.prependSystemContext ?? "";
assert.ok(bankingControllerPrompt.length > 0, "controller injector must render under the banking profile");
assert.ok(bankingControllerPrompt.includes("## TeamClaw Operating Contract"), "banking controller prompt keeps the Operating Contract section header (content replaced)");
assert.ok(bankingControllerPrompt.includes(DOMAIN_ANCHOR_LINE), "banking controller prompt embeds the domainInstructions lines");
assertNoSoftwareRules(bankingControllerPrompt, "banking controller prompt");
// Assembly point: right after the role catalog.
const rolesSectionAt = bankingControllerPrompt.indexOf("### Available Roles");
const controllerContractAt = bankingControllerPrompt.indexOf("## TeamClaw Operating Contract");
const projectsSectionAt = bankingControllerPrompt.indexOf("### Existing Projects in Workspace");
assert.ok(rolesSectionAt !== -1 && projectsSectionAt !== -1, "controller prompt must contain the role catalog and projects sections");
assert.ok(rolesSectionAt < controllerContractAt && controllerContractAt < projectsSectionAt, "controller domain contract must sit between the role catalog and the projects section");

// ---------------------------------------------------------------------------
// 3. software-rd zero drift: switch back and reproduce the prompt goldens.
// ---------------------------------------------------------------------------
loader.setActiveProfileId("software-rd");
assert.equal(loader.getActiveDomainInstructions(), undefined, "software-rd carries no domainInstructions");

// The credit-officer identity no longer resolves under software-rd (the
// injector correctly returns null for unknown roles), so prove the
// profile-keying with a software-rd role identity instead.
const softwareWorkerInjector = createWorkerPromptInjector(
  parsePluginConfig({ mode: "worker", role: "qa", teamName: "Domain Bank", controllerUrl: "http://127.0.0.1:9527" }),
  () => ({
    workerId: "worker-srd-1",
    role: "qa",
    controllerUrl: "http://127.0.0.1:9527",
    registeredAt: 1730000000000,
  }),
  new MessageQueue(),
);
const softwareWorkerPrompt = softwareWorkerInjector()?.prependSystemContext ?? "";
assert.ok(softwareWorkerPrompt.length > 0, "worker injector must render under software-rd");
assert.ok(!softwareWorkerPrompt.includes(DOMAIN_ANCHOR_LINE), "software-rd worker prompt must not embed the banking domain contract");
assert.ok(
  softwareWorkerPrompt.includes("You are a team member, not the controller. Complete the current task yourself."),
  "software-rd worker prompt keeps the pre-composed software operating rules (zero drift)",
);

const { renderGoldenPrompts } = await import("./golden/regen-prompt-golden.mjs");
const { controllerPrompt, workerPrompt } = await renderGoldenPrompts();
const readGolden = (name) => fs.readFileSync(path.join(scriptDir, "golden", name), "utf8");
assert.equal(controllerPrompt, readGolden("controller-prompt.txt"), "controller prompt golden must stay byte-identical after the Phase 2.4 fork (software-rd path unchanged)");
assert.equal(workerPrompt, readGolden("worker-prompt.txt"), "worker prompt golden must stay byte-identical after the Phase 2.4 fork (software-rd path unchanged)");

// ---------------------------------------------------------------------------
// 4. Loader/schema consumption of domainInstructions.
// ---------------------------------------------------------------------------
const schema = JSON.parse(await fs.promises.readFile(path.join(projectRoot, "src", "src", "profiles", "schema.json"), "utf8"));
const fixturePackage = JSON.parse(await fs.promises.readFile(path.join(scriptDir, "fixtures", "profiles", "minimal-bank.json"), "utf8"));
loader.validateProfilePackage(fixturePackage, schema, "minimal-bank.json");

function expectFatal(mutate, label) {
  const broken = JSON.parse(JSON.stringify(fixturePackage));
  mutate(broken);
  assert.throws(
    () => loader.validateProfilePackage(broken, schema, `${label}.json`),
    /refusing to start|has dangling role references|supports only/,
    `${label} must be a fatal validation error`,
  );
}
expectFatal((p) => { p.domainInstructions = "single string, wrong shape"; }, "domain-instructions-not-an-array");
expectFatal((p) => { p.domainInstructions = ["ok", ""]; }, "domain-instructions-empty-item");
expectFatal((p) => { p.domainInstructions = [42]; }, "domain-instructions-non-string-item");

const softwareRdPackage = JSON.parse(await fs.promises.readFile(path.join(projectRoot, "src", "src", "profiles", "software-rd.json"), "utf8"));
assert.throws(
  () => {
    const withDomain = JSON.parse(JSON.stringify(softwareRdPackage));
    withDomain.domainInstructions = ["must be rejected on the baseline"];
    loader.validateProfilePackage(withDomain, schema, "software-rd.json");
  },
  /must not set domainInstructions/,
  "software-rd + domainInstructions must be a fatal cross-validation error (replacement semantics would double-inject)",
);

console.log("domainInstructions replacement-injection smoke passed.");
