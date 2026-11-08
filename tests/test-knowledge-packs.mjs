#!/usr/bin/env node
// Phase 4 knowledge packs (vertical-team-profiles-design.md sections 2.1/2.2
// knowledge/ + Phase 4 zero-cost exception): static reference packs shipped
// with a profile, injected into worker prompts to ground stable domain
// concepts while time-sensitive figures stay TBD-driven.
//
// Run against the built dist modules (run `npm --prefix src run build`
// first). Asserts five contract families:
//
//   1. Pack file hygiene: the three knowledge/*.md files exist in the source
//      tree AND the built dist copy, each opens with an "As of:" date and a
//      "verify against authoritative sources" notice, and none carries a
//      percentage figure (the no-volatile-numbers design rule; the only
//      money figures allowed are the two explicitly as-of-marked EUR
//      examples inside vat-principles.md).
//   2. Wiring: trading-co declares [incoterms-2020, hs-structure] and
//      crossborder-ecom declares [vat-principles, incoterms-2020]; the
//      finance packs and software-rd declare none; the six-card metadata
//      fields (name/version/role count) are untouched so the desktop wizard
//      snapshot keeps passing.
//   3. Loader red line: validateProfilePackage accepts the real packs and
//      makes a dangling pack reference (missing file, empty reference,
//      duplicate reference, path-shaped reference, non-array shape) a FATAL
//      validation error, mirroring the role-reference red line.
//   4. Loader consumption: getActiveKnowledgePacks returns declaration-order
//      {name, content} pairs whose content equals the shipped file bytes,
//      and [] for software-rd.
//   5. Injection: worker prompts under trading-co/crossborder-ecom carry the
//      "## Reference Packs" section AFTER the operating contract and BEFORE
//      the session rules, one "### <pack>" per declared pack in order, and
//      the hard-rule line verbatim; software-rd injects nothing, and the
//      Phase 1.7 prompt goldens stay byte-identical (zero drift).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ----------------------
// No TEAMCLAW_EXTRA_PROFILES_DIR: this suite exercises the production
// built-in load path (dist/src/profiles, knowledge included) exclusively.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-knowledge-packs-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
fs.mkdirSync(path.join(stateRoot, "plugins", "teamclaw"), { recursive: true });
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-knowledge-ws-"));

const loader = await dist("profile-loader.js");
const { parsePluginConfig } = await dist("types.js");
const { createWorkerPromptInjector } = await dist("worker/prompt-injector.js");
const { MessageQueue } = await dist("worker/message-queue.js");

const SOURCE_PROFILES_DIR = path.join(projectRoot, "src", "src", "profiles");
const KNOWLEDGE_DIR = path.join(SOURCE_PROFILES_DIR, "knowledge");
const DIST_KNOWLEDGE_DIR = path.join(projectRoot, "src", "dist", "src", "profiles", "knowledge");
const PACK_FILES = ["incoterms-2020.md", "hs-structure.md", "vat-principles.md"];
const HARD_RULE_TEXT = "When answering, prefer these pack definitions over memory; "
  + "for anything time-sensitive (rates, thresholds, regulations), direct the user to current "
  + "authoritative sources and mark TBD.";

// ---------------------------------------------------------------------------
// 1. Pack file hygiene.
// ---------------------------------------------------------------------------
const incotermsText = fs.readFileSync(path.join(KNOWLEDGE_DIR, "incoterms-2020.md"), "utf8");
const hsText = fs.readFileSync(path.join(KNOWLEDGE_DIR, "hs-structure.md"), "utf8");
const vatText = fs.readFileSync(path.join(KNOWLEDGE_DIR, "vat-principles.md"), "utf8");

for (const [name, text] of [["incoterms-2020.md", incotermsText], ["hs-structure.md", hsText], ["vat-principles.md", vatText]]) {
  const head = text.slice(0, 800)
    .replace(/^>\s*/gm, "") // drop blockquote markers so wrapped notices still match
    .toLowerCase()
    .replace(/\s+/g, " ");
  assert.match(head, /as of: 20\d\d-\d\d-\d\d/, `knowledge/${name} must open with an "As of:" date`);
  assert.ok(
    head.includes("verify against authoritative sources"),
    `knowledge/${name} must open with a "verify against authoritative sources" notice`,
  );
  assert.ok(text.trim().length > 0, `knowledge/${name} must not be empty (empty packs are a fatal loader error)`);
  // The design rule: packs carry stable reference material, never volatile
  // numbers. Percentage-shaped figures are banned outright in all three.
  assert.doesNotMatch(
    text,
    /\d+(\.\d+)?\s*%/,
    `knowledge/${name} must not carry percentage figures (volatile numbers stay out of packs by design)`,
  );
  // Dist sync: the build copies src/profiles into dist/src/profiles
  // recursively; the loader reads the dist copy, so stale dist = fatal load.
  const distCopy = fs.readFileSync(path.join(DIST_KNOWLEDGE_DIR, name), "utf8");
  assert.equal(distCopy, text, `dist knowledge/${name} must equal the committed source file (run npm --prefix src run build)`);
}

// Incoterms pack completeness: all eleven Incoterms 2020 terms, one section each.
for (const term of ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"]) {
  assert.match(incotermsText, new RegExp(`^## ${term} - `, "m"), `incoterms-2020.md must carry the ${term} section`);
}

// hs pack: the rebate discipline exists and stays figure-free by design.
assert.match(hsText, /ZERO rate figures/i, "hs-structure.md must state the no-rebate-figures rule explicitly");
assert.match(hsText, /ESSENTIAL CHARACTER/i, "hs-structure.md must carry the GRI 3 essential-character logic");

// vat pack: thresholds only as as-of examples, flagged as expirable.
assert.match(vatText, /One Stop Shop/, "vat-principles.md must explain OSS");
assert.match(vatText, /Import One Stop Shop/, "vat-principles.md must explain IOSS");
assert.match(vatText, /deemed supplier/i, "vat-principles.md must explain the EU deemed-supplier concept");
assert.match(vatText, /marketplace-facilitator/i, "vat-principles.md must explain the marketplace-facilitator model");
const euroParagraphs = vatText.split(/\n\s*\n/).filter((para) => /EUR \d/.test(para));
assert.ok(
  euroParagraphs.length >= 2,
  "vat-principles.md must present its example threshold/ceiling figures (EUR 10,000 / EUR 150)",
);
assert.ok(euroParagraphs.length <= 4, "vat-principles.md must keep money figures to the two as-of examples (not a threshold table)");
for (const para of euroParagraphs) {
  assert.match(
    para,
    /as of|illustrative|example|will expire|dated/i,
    `every EUR-figure paragraph in vat-principles.md must be marked as an as-of example: ${JSON.stringify(para.trim().slice(0, 80))}...`,
  );
}
assert.match(vatText, /will expire/i, "vat-principles.md must state that the example figures expire");

// ---------------------------------------------------------------------------
// 2. Wiring: who declares which packs; six-card metadata untouched.
// ---------------------------------------------------------------------------
function readPack(file) {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_PROFILES_DIR, file), "utf8"));
}
const tradingCo = readPack("trading-co.json");
const crossborderEcom = readPack("crossborder-ecom.json");
assert.deepEqual(tradingCo.knowledgePacks, ["incoterms-2020.md", "hs-structure.md"], "trading-co declares incoterms + hs-structure");
assert.deepEqual(crossborderEcom.knowledgePacks, ["vat-principles.md", "incoterms-2020.md"], "crossborder-ecom declares vat-principles + incoterms");
for (const file of ["banking.json", "securities.json", "insurance.json", "software-rd.json"]) {
  assert.equal(readPack(file).knowledgePacks, undefined, `${file} must not declare knowledgePacks in this wave`);
}

// The knowledge pack wiring must not touch the desktop-wizard six-card
// metadata (name/version/roles) - the wizard snapshot locks them field-wise.
assert.equal(tradingCo.version, "1.0.0", "trading-co version must stay 1.0.0 (wizard card pins it)");
assert.equal(crossborderEcom.version, "1.0.0", "crossborder-ecom version must stay 1.0.0 (wizard card pins it)");
assert.equal(tradingCo.roles.length, 7, "trading-co role count unchanged");
assert.equal(crossborderEcom.roles.length, 9, "crossborder-ecom role count unchanged");

// The built-in registry loaded the wired packs (importing the dist loader has
// already run the fatal pipeline over the knowledge references).
assert.deepEqual(loader.BUILTIN_PROFILES.get("trading-co").knowledgePacks, ["incoterms-2020.md", "hs-structure.md"]);
assert.deepEqual(loader.BUILTIN_PROFILES.get("crossborder-ecom").knowledgePacks, ["vat-principles.md", "incoterms-2020.md"]);

// ---------------------------------------------------------------------------
// 3. Loader red line: dangling references are fatal (design 2.2 style).
// ---------------------------------------------------------------------------
const schema = JSON.parse(fs.readFileSync(path.join(SOURCE_PROFILES_DIR, "schema.json"), "utf8"));
loader.validateProfilePackage(tradingCo, schema, "trading-co.json");

function expectFatal(mutate, label, pattern) {
  const broken = JSON.parse(JSON.stringify(tradingCo));
  mutate(broken);
  assert.throws(
    () => loader.validateProfilePackage(broken, schema, `${label}.json`),
    pattern,
    `${label} must be a fatal validation error`,
  );
}
expectFatal((p) => { p.knowledgePacks = ["no-such-pack.md"]; }, "knowledge-pack-missing-file", /references knowledge pack "no-such-pack\.md"/);
expectFatal((p) => { p.knowledgePacks = ["no-such-pack.md"]; }, "knowledge-pack-missing-file-refusing", /refusing to start/);
expectFatal((p) => { p.knowledgePacks = ["nested/no-such-pack.md"]; }, "knowledge-pack-path-shaped", /does not match pattern/);
expectFatal((p) => { p.knowledgePacks = ["../schema.json"]; }, "knowledge-pack-traversal", /does not match pattern/);
expectFatal((p) => { p.knowledgePacks = ["UPPER-CASE.md"]; }, "knowledge-pack-uppercase", /does not match pattern/);
expectFatal((p) => { p.knowledgePacks = [""]; }, "knowledge-pack-empty-item", /shorter than minLength/);
expectFatal((p) => { p.knowledgePacks = ["incoterms-2020.md", "incoterms-2020.md"]; }, "knowledge-pack-duplicate", /not unique/);
expectFatal((p) => { p.knowledgePacks = "incoterms-2020.md"; }, "knowledge-pack-not-an-array", /expected "array"/);

// The legal wired package keeps validating end-to-end (guard against an
// over-eager schema), and finance/baseline packages stay legal without packs.
loader.validateProfilePackage(crossborderEcom, schema, "crossborder-ecom.json");
loader.validateProfilePackage(readPack("banking.json"), schema, "banking.json");

// ---------------------------------------------------------------------------
// 4. Loader consumption: getActiveKnowledgePacks.
// ---------------------------------------------------------------------------
loader.setActiveProfileId("trading-co");
{
  const packs = loader.getActiveKnowledgePacks();
  assert.deepEqual(packs.map((p) => p.name), ["incoterms-2020.md", "hs-structure.md"], "trading-co packs in declaration order");
  assert.equal(packs[0].content, incotermsText, "pack content must equal the shipped file bytes");
  assert.equal(packs[1].content, hsText, "pack content must equal the shipped file bytes");
}
loader.setActiveProfileId("crossborder-ecom");
{
  const packs = loader.getActiveKnowledgePacks();
  assert.deepEqual(packs.map((p) => p.name), ["vat-principles.md", "incoterms-2020.md"], "crossborder-ecom packs in declaration order");
  assert.equal(packs[0].content, vatText);
  assert.equal(packs[1].content, incotermsText);
}
loader.setActiveProfileId("software-rd");
assert.deepEqual(loader.getActiveKnowledgePacks(), [], "software-rd carries no knowledge packs (zero injection drift)");

// ---------------------------------------------------------------------------
// 5. Injection: Reference Packs section on/off + prompt golden zero drift.
// ---------------------------------------------------------------------------
function renderWorkerPrompt(profileId, roleId) {
  loader.setActiveProfileId(profileId);
  const injector = createWorkerPromptInjector(
    parsePluginConfig({
      mode: "worker",
      role: roleId,
      teamName: "Knowledge Pack Test",
      controllerUrl: "http://127.0.0.1:9527",
    }),
    () => ({
      workerId: `worker-kp-${profileId}-1`,
      role: roleId,
      controllerUrl: "http://127.0.0.1:9527",
      registeredAt: 1730000000000,
    }),
    new MessageQueue(),
  );
  return injector()?.prependSystemContext ?? "";
}

// trading-co: both packs + the hard rule, assembled between the operating
// contract and the session rules, pack order following the declaration.
{
  const prompt = renderWorkerPrompt("trading-co", "order-merchandiser");
  assert.ok(prompt.length > 0, "trading-co worker prompt must render");
  assert.ok(prompt.includes("## Reference Packs"), "trading-co worker prompt carries the Reference Packs section");
  assert.ok(prompt.includes("### incoterms-2020.md"), "trading-co prompt names the incoterms pack");
  assert.ok(prompt.includes("### hs-structure.md"), "trading-co prompt names the hs-structure pack");
  assert.ok(prompt.includes("DPU - Delivered at Place Unloaded"), "trading-co prompt embeds incoterms pack content");
  assert.ok(prompt.includes("ESSENTIAL CHARACTER"), "trading-co prompt embeds hs-structure pack content");
  assert.ok(prompt.includes(HARD_RULE_TEXT), "trading-co prompt carries the knowledge-pack hard rule verbatim");
  const contractAt = prompt.indexOf("## TeamClaw Operating Contract");
  const packsAt = prompt.indexOf("## Reference Packs");
  const sessionAt = prompt.indexOf("## Current Session Rules");
  assert.ok(contractAt !== -1 && packsAt !== -1 && sessionAt !== -1, "trading-co prompt has contract, packs, and session sections");
  assert.ok(contractAt < packsAt && packsAt < sessionAt, "Reference Packs must sit AFTER the operating contract and BEFORE the session rules");
  assert.ok(
    prompt.indexOf("### incoterms-2020.md") < prompt.indexOf("### hs-structure.md"),
    "trading-co pack sections follow the knowledgePacks declaration order",
  );
}

// crossborder-ecom: vat pack first, incoterms second (declaration order).
{
  const prompt = renderWorkerPrompt("crossborder-ecom", "store-ops");
  assert.ok(prompt.includes("## Reference Packs"), "crossborder-ecom worker prompt carries the Reference Packs section");
  assert.ok(prompt.includes("### vat-principles.md"), "crossborder-ecom prompt names the vat pack");
  assert.ok(prompt.includes("### incoterms-2020.md"), "crossborder-ecom prompt names the incoterms pack");
  assert.ok(prompt.includes("One Stop Shop"), "crossborder-ecom prompt embeds vat pack content");
  assert.ok(prompt.includes("Free on Board"), "crossborder-ecom prompt embeds incoterms pack content");
  assert.ok(prompt.includes(HARD_RULE_TEXT), "crossborder-ecom prompt carries the hard rule verbatim");
  assert.ok(
    prompt.indexOf("### vat-principles.md") < prompt.indexOf("### incoterms-2020.md"),
    "crossborder-ecom pack sections follow the knowledgePacks declaration order",
  );
}

// software-rd: zero injection - no section, no pack names, no hard rule, and
// the Phase 1.7 prompt goldens reproduce byte for byte (the wave's hardest
// constraint; renderGoldenPrompts renders under software-rd).
{
  const prompt = renderWorkerPrompt("software-rd", "qa");
  assert.ok(prompt.length > 0, "software-rd worker prompt must render");
  assert.ok(!prompt.includes("## Reference Packs"), "software-rd worker prompt must NOT carry the Reference Packs section");
  assert.ok(!prompt.includes("### incoterms-2020.md"), "software-rd worker prompt must not name any pack");
  assert.ok(!prompt.includes(HARD_RULE_TEXT), "software-rd worker prompt must not carry the knowledge-pack hard rule");

  const { renderGoldenPrompts } = await import("./golden/regen-prompt-golden.mjs");
  const { controllerPrompt, workerPrompt } = await renderGoldenPrompts();
  const readGolden = (name) => fs.readFileSync(path.join(scriptDir, "golden", name), "utf8");
  assert.equal(
    Buffer.compare(Buffer.from(controllerPrompt, "utf8"), Buffer.from(readGolden("controller-prompt.txt"), "utf8")),
    0,
    "controller prompt golden must stay byte-identical (knowledge packs are inactive on software-rd)",
  );
  assert.equal(
    Buffer.compare(Buffer.from(workerPrompt, "utf8"), Buffer.from(readGolden("worker-prompt.txt"), "utf8")),
    0,
    "worker prompt golden must stay byte-identical (knowledge packs are inactive on software-rd)",
  );
}

// Restore the baseline active profile for anything importing this process later.
loader.setActiveProfileId("software-rd");

console.log("knowledge packs smoke passed (3 packs: file hygiene + trading-co/crossborder-ecom wiring + fatal reference validation + injection with software-rd zero drift).");
