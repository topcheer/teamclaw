#!/usr/bin/env node
// Phase 5.2 desktop wizard contract tests (vertical-team-profiles-design.md
// Phase 5 table row 5.2): the "choose team type" step inserted before the
// run-mode step.
//
// Source-level assertions in the test-ui-contracts.mjs style (no Electron):
//   - the six-card data snapshot EXISTS in the renderer and, as the declared
//     maintenance point, matches src/src/profiles/*.json field-by-field
//     (drift guard: roleCount from the roles array, pendingSignoff from the
//     reviewedBy "Human sign-off pending" rule shared with web #201)
//   - default selection is software-rd
//   - the follow-the-controller branch (remote run mode) skips the choice:
//     no teamProfile is written and a follow note explains why
//   - the write path: wizard choice flows into standaloneStart /
//     instanceInstallIntoGlobal and lands as plugins.entries.teamclaw.config
//     .teamProfile with first-write-wins guards (design 2.3: config only
//     bootstraps the FIRST initialization)
//   - reconfigure path echoes the connected controller's active profile
//   - new i18n keys exist in BOTH the en and zh dictionaries

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const rendererAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");
const rendererHtmlPath = path.join(projectRoot, "desktop", "renderer", "index.html");
const rendererI18nPath = path.join(projectRoot, "desktop", "renderer", "i18n.js");
const desktopMainPath = path.join(projectRoot, "desktop", "main.mjs");
const desktopPreloadPath = path.join(projectRoot, "desktop", "preload.mjs");
const profilesDir = path.join(projectRoot, "src", "src", "profiles");

const [appSource, htmlSource, i18nSource, mainSource, preloadSource] = await Promise.all([
  fs.readFile(rendererAppPath, "utf8"),
  fs.readFile(rendererHtmlPath, "utf8"),
  fs.readFile(rendererI18nPath, "utf8"),
  fs.readFile(desktopMainPath, "utf8"),
  fs.readFile(desktopPreloadPath, "utf8"),
]);

// ---------------------------------------------------------------------------
// 1. Six-card data snapshot: existence + drift guard against the pack JSONs.
// ---------------------------------------------------------------------------
function extractWizardTeamProfiles(source) {
  const marker = "const WIZARD_TEAM_PROFILES = [";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "renderer must carry the WIZARD_TEAM_PROFILES snapshot");
  // Balanced scan from the opening bracket; the array is written JSON-strict.
  const open = source.indexOf("[", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(open, i + 1));
    }
  }
  throw new Error("WIZARD_TEAM_PROFILES array is not balanced");
}

const snapshot = extractWizardTeamProfiles(appSource);

const packFiles = (await fs.readdir(profilesDir))
  .filter((f) => f.endsWith(".json") && f !== "schema.json");
const packs = {};
for (const f of packFiles) {
  const pack = JSON.parse(await fs.readFile(path.join(profilesDir, f), "utf8"));
  packs[pack.id] = pack;
}

const EXPECTED_IDS = ["banking", "crossborder-ecom", "insurance", "securities", "software-rd", "trading-co"];
assert.equal(packFiles.length, 6, "src/src/profiles must hold exactly the six built-in packs (schema excluded)");
assert.deepEqual(
  snapshot.map((p) => p.id).sort(),
  [...EXPECTED_IDS].sort(),
  "the wizard snapshot must list exactly the six built-in pack ids",
);
assert.equal(new Set(snapshot.map((p) => p.id)).size, 6, "wizard card ids must be unique");

// Field-by-field drift guard (declared maintenance point in app.js).
for (const card of snapshot) {
  const pack = packs[card.id];
  assert.ok(pack, `snapshot card "${card.id}" must exist in src/src/profiles`);
  assert.equal(card.name, pack.name, `${card.id}: name must match the pack JSON`);
  assert.equal(card.nameZh, pack.nameZh, `${card.id}: nameZh must match the pack JSON`);
  assert.equal(card.icon, pack.icon, `${card.id}: icon must match the pack JSON`);
  assert.equal(card.industry, pack.industry, `${card.id}: industry must match the pack JSON`);
  assert.equal(card.description, pack.description, `${card.id}: description must match the pack JSON`);
  assert.equal(card.version, pack.version, `${card.id}: version must match the pack JSON`);
  assert.equal(
    card.roleCount,
    pack.roles.length,
    `${card.id}: roleCount must equal the pack's roles array length`,
  );
  // Same rule as the web switcher (PR #201): any reviewedBy entry containing
  // "Human sign-off pending" renders the pending badge.
  const pending = (pack.reviewedBy || []).some((entry) => String(entry).includes("Human sign-off pending"));
  assert.equal(
    card.pendingSignoff,
    pending,
    `${card.id}: pendingSignoff must follow the reviewedBy "Human sign-off pending" rule`,
  );
}
// The finance packs (and the trade packs - same reviewedBy trail) carry the
// pending badge; the software-rd baseline does not.
assert.equal(snapshot.find((p) => p.id === "software-rd").pendingSignoff, false);
assert.equal(snapshot.find((p) => p.id === "banking").pendingSignoff, true);

// ---------------------------------------------------------------------------
// 2. Default selection: software-rd, applied at render time.
// ---------------------------------------------------------------------------
assert.match(appSource, /const DEFAULT_TEAM_PROFILE_ID = "software-rd";/);
assert.match(
  appSource,
  /state\.wizardTeamProfileId \|\| DEFAULT_TEAM_PROFILE_ID/,
  "selectedWizardTeamProfile must fall back to the software-rd default",
);
assert.match(
  appSource,
  /name="bootstrap-team-profile"/,
  "cards must render as radios named bootstrap-team-profile",
);
assert.match(
  appSource,
  /\$\{p\.id === selected \? " checked" : ""\}/,
  "the selected card must carry the checked attribute",
);
assert.match(
  appSource,
  /profile-chip pending/,
  "the pending-signoff chip must be rendered on pending packs",
);

// ---------------------------------------------------------------------------
// 3. Wizard structure: team-type step FIRST, four steps total.
// ---------------------------------------------------------------------------
const stepSections = [...htmlSource.matchAll(/data-wizard-step="(\d)"/g)].map((m) => m[1]);
assert.deepEqual(stepSections, ["1", "2", "3", "4"], "wizard must have exactly four renumbered steps");
const stepInds = [...htmlSource.matchAll(/data-step-ind="(\d)"/g)].map((m) => m[1]);
assert.deepEqual(stepInds, ["1", "2", "3", "4"], "step indicator strip must show four steps");
assert.match(htmlSource, /data-step-ind="1"[^>]*data-i18n="wizard\.stepTeam"/, "step 1 indicator is the team step");
assert.match(
  htmlSource,
  /<section class="bootstrap-card" data-wizard-step="1">[\s\S]*?id="bootstrap-profile-grid"/,
  "the team-type section must carry the profile card grid",
);
assert.match(htmlSource, /id="wizard-next-team"/, "team step needs its own Next button");
assert.match(htmlSource, /data-wizard-back="2"/, "the model step's Back button returns to the run-mode step");
assert.match(htmlSource, /id="bootstrap-profile-follow-note"/, "follow-controller note element must exist");
assert.match(
  htmlSource,
  /id="bootstrap-profile-follow-note"[^>]*hidden/,
  "follow-controller note starts hidden (shown only for the remote branch)",
);
assert.match(appSource, /nextTeam\.addEventListener\("click", \(\) => wizardGoStep\(2\)\)/);

// ---------------------------------------------------------------------------
// 4. Follow-the-controller branch (worker semantics, design 2.3): the
//    desktop wizard never installs a worker - "remote" (connect an existing
//    controller) is the branch that skips the team-type choice.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /function wizardTeamProfileForInstall\(\)[\s\S]*?return llmMode\(\) === "remote" \? null : selectedWizardTeamProfile\(\);/,
  "remote (follow-controller) branch must resolve to NO teamProfile write",
);
assert.match(
  appSource,
  /function updateWizardProfileFollowNote\(\)[\s\S]*?note\.hidden = llmMode\(\) !== "remote";/,
  "the follow note must appear exactly when the remote branch is selected",
);

// ---------------------------------------------------------------------------
// 5. Write path: renderer passes the choice; main writes it first-write-wins.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /desktop\.standaloneStart\(\{ teamProfile: wizardTeamProfileForInstall\(\) \|\| undefined \}/,
  "private install path must pass teamProfile through standaloneStart",
);
assert.equal(
  (appSource.match(/desktop\.instanceInstallIntoGlobal\(\{ teamProfile: wizardTeamProfileForInstall\(\) \|\| undefined \}\)/g) || []).length,
  2,
  "both global-install branches must pass teamProfile to instanceInstallIntoGlobal",
);
assert.match(
  preloadSource,
  /instanceInstallIntoGlobal: \(options\) => ipcRenderer\.invoke\("instance:install-into-global", options \|\| \{\}\)/,
  "preload must forward the install options (IPC channel for the wizard choice)",
);
assert.match(
  mainSource,
  /standaloneStart\(options\?\.preferredVendor, options\?\.instance \|\| null, options\?\.teamProfile \|\| null\)/,
  "standalone:start must thread teamProfile into standaloneStart",
);
assert.match(
  mainSource,
  /seedStandaloneConfig\(preferredVendor, ctrlPort, teamProfile\)/,
  "the seed write must receive teamProfile",
);
assert.match(
  mainSource,
  /\.\.\.\(\(teamProfile && !cfg\.plugins\.entries\.teamclaw\?\.config\?\.teamProfile\) \? \{ teamProfile \} : \{\}\)/,
  "private seed writes config.teamProfile only when none exists (first init only, 2.3)",
);
assert.match(
  mainSource,
  /\.\.\.\(\(teamProfile && !prev\.config\?\.teamProfile\) \? \{ teamProfile \} : \{\}\)/,
  "global install writes config.teamProfile only when none exists (first init only, 2.3)",
);

// ---------------------------------------------------------------------------
// 6. Reconfigure path: echo the connected controller's active profile.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /\/api\/v1\/team\/profile/,
  "the wizard must read the active profile from a connected controller",
);
assert.match(appSource, /state\.wizardCurrentProfileId = id;/);
assert.match(appSource, /syncWizardProfileFromController\(\)\.catch\(\(\) => \{\}\);/);

// ---------------------------------------------------------------------------
// 7. i18n: new keys present in BOTH en and zh dictionaries, renumbered steps.
// ---------------------------------------------------------------------------
const zhBlockStart = i18nSource.indexOf("zh: {");
assert.notEqual(zhBlockStart, -1, "i18n must carry the zh dictionary");
const enBlock = i18nSource.slice(0, zhBlockStart);
const zhBlock = i18nSource.slice(zhBlockStart);
const NEW_KEYS = [
  "wizard.stepTeam",
  "wizard.teamTypeLabel",
  "wizard.teamTypeNote",
  "wizard.teamProfileRoleCount",
  "wizard.pendingSignoff",
  "wizard.teamProfileCurrent",
  "wizard.followControllerNote",
];
for (const key of NEW_KEYS) {
  assert.ok(enBlock.includes(`"${key}"`), `en dictionary must define ${key}`);
  assert.ok(zhBlock.includes(`"${key}"`), `zh dictionary must define ${key}`);
}
for (const [key, en, zh] of [
  ["wizard.stepMode", "2 · Mode", "2 · 方式"],
  ["wizard.stepModel", "3 · Model", "3 · 模型"],
  ["wizard.stepLaunch", "4 · Launch", "4 · 启动"],
]) {
  assert.ok(enBlock.includes(`"${key}": "${en}"`), `en ${key} must be renumbered to "${en}"`);
  assert.ok(zhBlock.includes(`"${key}": "${zh}"`), `zh ${key} must be renumbered to "${zh}"`);
}
assert.ok(enBlock.includes('"wizard.teamProfileRoleCount": "{n} roles"'));
assert.ok(zhBlock.includes('"wizard.teamProfileRoleCount": "{n} 个角色"'));

// ---------------------------------------------------------------------------
// 8. Language switch re-renders the cards (bilingual names follow the lang).
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /applyStaticTranslations\(\);\s*\n\s*renderChrome\(\);\s*\n\s*renderWizardTeamProfiles\(\);/,
  "setLanguage must re-render the wizard cards",
);

console.log("test-desktop-wizard: all assertions passed (six cards, default software-rd, follow-controller skip, first-init write path, en/zh i18n pairs)");
