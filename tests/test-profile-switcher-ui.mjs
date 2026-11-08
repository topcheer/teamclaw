#!/usr/bin/env node
// Phase 5.1 + 5.3 web UI contract tests for the team profile switcher
// (docs/vertical-team-profiles-design.md Phase 5 rows 5.1/5.3).
//
// Source-level assertions in the test-ui-contracts.mjs style (no browser):
//   - header mini-button + modal elements exist in index.html
//   - /profiles, /team/profile, /archived-teams fetch wiring in app.js
//   - two-step switch flow (cards -> archive-consequence confirm -> POST)
//   - 202 + team.switch_started/completed/failed WS tracking, 409 transition
//     notice
//   - capability-gated teamauto tab hidden (not removed) + CSS hidden rule
//   - reviewedBy "Human sign-off pending" badge rendering
//   - teamProfile.* i18n keys present in BOTH the en and zh inline dicts
//   - existing UI behavior preserved (team-name span, full 7-tab DOM set)

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const uiHtmlPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const uiStylePath = path.join(projectRoot, "src", "src", "ui", "style.css");

const [appSource, htmlSource, styleSource] = await Promise.all([
  fs.readFile(uiAppPath, "utf8"),
  fs.readFile(uiHtmlPath, "utf8"),
  fs.readFile(uiStylePath, "utf8"),
]);

// ---------------------------------------------------------------------------
// 1. Header entry point + modal shell (model-settings-modal precedent).
// ---------------------------------------------------------------------------
assert.match(
  htmlSource,
  /<button id="team-profile-toggle" class="header-mini-btn[^"]*"/,
  "header must carry the team profile mini-button (v1.2 entry decision)",
);
assert.match(
  htmlSource,
  /<div id="team-profile-modal" class="workspace-prompt-modal"/,
  "switcher modal must reuse the workspace-prompt-modal structure",
);
assert.match(
  htmlSource,
  /<div class="workspace-prompt-backdrop" data-team-profile-close><\/div>/,
  "modal backdrop must close via the data-team-profile-close convention",
);
for (const id of [
  "team-profile-title",
  "team-profile-list",
  "team-profile-confirm",
  "team-profile-confirm-body",
  "team-profile-confirm-btn",
  "team-profile-confirm-back",
  "team-profile-switch-status",
  "team-profile-transition",
  "team-profile-archives",
]) {
  assert.ok(htmlSource.includes(`id="${id}"`), `index.html must define #${id}`);
}
assert.match(
  htmlSource,
  /id="team-profile-modal"[\s\S]*?role="dialog" aria-modal="true"/,
  "switcher modal must be an aria dialog like the other modals",
);
assert.match(
  htmlSource,
  /data-i18n="teamProfile\.archivedTitle"/,
  "archived teams section must be translated via the inline dictionary",
);
assert.match(
  appSource,
  /\$\("#team-profile-toggle"\)[\s\S]*?addEventListener\("click", openTeamProfileModal\)/,
  "header button click must open the switcher modal",
);

// ---------------------------------------------------------------------------
// 2. Endpoint wiring (response shapes pinned by http-server.ts handlers).
// ---------------------------------------------------------------------------
assert.match(appSource, /apiGet\("\/profiles"\)/, "modal must fetch GET /api/v1/profiles");
assert.match(appSource, /apiGet\("\/team\/profile"\)/, "refresh must fetch GET /api/v1/team/profile");
assert.match(appSource, /apiGet\("\/archived-teams"\)/, "modal must fetch GET /api/v1/archived-teams");
assert.match(
  appSource,
  /fetch\(API_BASE \+ "\/team\/profile", \{[\s\S]*?method: "POST"[\s\S]*?body: JSON\.stringify\(\{ profileId: profileId \}\)/,
  "switch must POST { profileId } to /api/v1/team/profile",
);
assert.match(
  appSource,
  /activeTeamProfile = await apiGet\("\/team\/profile"\);/,
  "refreshAll must mirror the active team profile",
);

// ---------------------------------------------------------------------------
// 3. Two-step flow: cards -> confirm (archive consequences) -> POST.
// ---------------------------------------------------------------------------
assert.match(appSource, /function renderTeamProfileCards/, "cards renderer must exist");
assert.match(appSource, /function showTeamProfileConfirmStep/, "confirm step must exist");
assert.match(
  appSource,
  /t\("teamProfile\.confirmArchive", \{ n: taskCount \}\)/,
  "confirm step must spell out the archive consequence",
);
assert.match(
  appSource,
  /var taskCount = \(teamState\.tasks \|\| \[\]\)\.length;/,
  "confirm task count must come from the live team state",
);
assert.match(
  appSource,
  /data-profile-id=/,
  "profile cards must carry data-profile-id for click delegation",
);
assert.match(
  appSource,
  /aria-current="true"/,
  "the active profile card must be highlighted",
);
// reviewedBy sign-off badge: finance packs pending human countersignature.
assert.match(
  appSource,
  /"Human sign-off pending"/,
  "reviewedBy human sign-off pending must render as a badge",
);
assert.match(
  appSource,
  /teamProfile\.pendingSignoff/,
  "the pending sign-off badge must use its i18n key",
);

// ---------------------------------------------------------------------------
// 4. Switch tracking: 202 + WS events + 409 transition notice.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /case "team\.switch_started":/,
  "WS team.switch_started must be handled",
);
assert.match(
  appSource,
  /case "team\.switch_completed":/,
  "WS team.switch_completed must be handled",
);
assert.match(
  appSource,
  /case "team\.switch_completed":[\s\S]*?refreshAll\(\);[\s\S]*?finishTeamProfileSwitch\(/,
  "completion must trigger a full refresh and close the modal",
);
// Phase 2 follow-up (#201 review): server-side switch failure feedback. The
// loading/confirm state must be released by the explicit team.switch_failed
// event (toast + full refresh), not left to the reconcile timeout.
assert.match(
  appSource,
  /case "team\.switch_failed":/,
  "WS team.switch_failed must be handled",
);
assert.match(
  appSource,
  /case "team\.switch_failed":[\s\S]*?refreshAll\(\);[\s\S]*?releaseTeamProfileSwitchUi\(\);[\s\S]*?showNotice\(/,
  "failure must trigger a full refresh, release the loading state, and toast",
);
assert.match(
  appSource,
  /t\("teamProfile\.switchFailed", \{ name: teamProfileDisplayNameById\(failedTargetId\) \}\)/,
  "failure toast must name the failed target profile",
);
assert.match(
  appSource,
  /String\(failedData\.reason \|\| ""\)/,
  "failure toast body must surface the server-provided reason verbatim",
);
assert.match(
  appSource,
  /result\.status === 202/,
  "202 response must enter the WS-tracked waiting state",
);
assert.match(
  appSource,
  /result\.status === 409/,
  "409 response must be handled explicitly",
);
assert.match(
  appSource,
  /result\.data && result\.data\.transition/,
  "409 handling must read the transition payload",
);
assert.match(
  appSource,
  /teamProfile\.transitionPending", \{\s*name: teamProfileDisplayNameById\(tr\.targetProfileId\)/,
  "transition notice must name the target profile from the transition",
);
assert.match(
  appSource,
  /button\.textContent = t\("teamProfile\.switching"\);/,
  "confirm button must show a loading state while switching",
);

// ---------------------------------------------------------------------------
// 5. Capability gating (P2.3 UI contract): hidden, not removed.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /function applyCapabilitiesVisibility/,
  "capabilities from /team/profile must drive UI visibility",
);
assert.match(
  appSource,
  /teamautoTab\.hidden = !teamautoEnabled;/,
  "the teamauto tab must be hidden via the hidden property, not removed",
);
assert.match(
  appSource,
  /caps\.teamauto !== false/,
  "missing capabilities must default to visible (software-rd keeps prior behavior)",
);
assert.ok(
  htmlSource.includes('data-tab="teamauto"'),
  "index.html must KEEP the teamauto tab node (DOM contract)",
);
assert.match(
  styleSource,
  /\.tab\[hidden\]\s*\{\s*display:\s*none;/,
  "style.css must enforce display:none for hidden tabs (.tab sets inline-flex)",
);
for (const tab of ["planning", "tasks", "workspace", "clarifications", "messages", "teamauto", "create-task"]) {
  assert.ok(htmlSource.includes(`data-tab="${tab}"`), `tab DOM set must keep "${tab}" (7-tab contract)`);
}

// ---------------------------------------------------------------------------
// 6. i18n (5.3 subset): every teamProfile.* key in BOTH en and zh dicts.
// ---------------------------------------------------------------------------
const definedKeys = new Map();
for (const match of appSource.matchAll(/"(teamProfile\.[A-Za-z]+)":/g)) {
  definedKeys.set(match[1], (definedKeys.get(match[1]) || 0) + 1);
}
const expectedKeys = [
  "teamProfile.kicker",
  "teamProfile.title",
  "teamProfile.headerButtonTitle",
  "teamProfile.current",
  "teamProfile.pendingSignoff",
  "teamProfile.roleCount",
  "teamProfile.loadFailed",
  "teamProfile.confirmArchive",
  "teamProfile.confirmWorkers",
  "teamProfile.confirmButton",
  "teamProfile.cancel",
  "teamProfile.switching",
  "teamProfile.switchStarted",
  "teamProfile.transitionPending",
  "teamProfile.switchCompleted",
  "teamProfile.switchFailed",
  "teamProfile.archivedTitle",
  "teamProfile.archivedEmpty",
  "teamProfile.archivedTasks",
];
for (const key of expectedKeys) {
  assert.equal(definedKeys.get(key), 2, `i18n key ${key} must exist in both en and zh dictionaries`);
}
assert.match(
  appSource,
  /"teamProfile\.confirmArchive": "[^"]*\{n\}[^"]*"/,
  "en confirmArchive must interpolate the task count",
);
assert.match(
  appSource,
  /"teamProfile\.confirmArchive": "[^"]*归档[^"]*"/,
  "zh confirmArchive must state the archiving consequence in Chinese",
);
assert.match(
  appSource,
  /"teamProfile\.pendingSignoff": "待人工签署"/,
  "zh pendingSignoff badge text must be 待人工签署",
);

// ---------------------------------------------------------------------------
// 7. Behavior preservation: existing entries stay untouched.
// ---------------------------------------------------------------------------
assert.ok(htmlSource.includes('id="team-name"'), "the legacy #team-name span must remain");
assert.equal(
  (htmlSource.match(/class="workspace-prompt-modal"/g) || []).length,
  3,
  "the two pre-existing workspace-prompt modals stay plus the new switcher",
);

console.log("Team profile switcher UI contract passed.");
