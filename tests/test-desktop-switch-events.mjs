#!/usr/bin/env node
// #255 P0-3: desktop follows web-side team profile switches via WS events.
//
// Defect: desktop/renderer/app.js's WS onmessage switch had no
// team.switch_started / team.switch_completed branches (they fell into
// default:break), and refreshAll pulled neither /roles nor /team/profile -
// after a web-side switch the connected desktop stayed fully stale until a
// disconnect/reconnect. Design Phase 5.2 / section 2.3 promised the desktop
// follows.
//
// Source-level assertions in the test-desktop-wizard.mjs style (no Electron):
//   - handleWsEvent carries BOTH switch branches, started and completed;
//   - started: banner state + system toast + full refresh;
//   - completed: toast + FULL refresh incl. the two profile-scoped endpoints
//     and the profile-scoped surfaces rebuilt;
//   - refreshAll now pulls GET /roles and GET /team/profile (tolerated, last
//     known values kept - same semantics as the web refreshAll);
//   - the switching banner outranks model readiness while a switch drains,
//     and is re-derived from the /team/profile transition object so a
//     desktop that missed the WS event (relaunch mid-switch) still shows it;
//   - new i18n keys exist in BOTH the en and zh dictionaries;
//   - follow-only boundary (P2): the desktop renderer must NOT initiate a
//     switch (no POST /team/profile through its apiPost channel).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const rendererAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");
const rendererI18nPath = path.join(projectRoot, "desktop", "renderer", "i18n.js");

const [appSource, i18nSource] = await Promise.all([
  fs.readFile(rendererAppPath, "utf8"),
  fs.readFile(rendererI18nPath, "utf8"),
]);

// Balanced-brace extraction in the test-i18n-parity.mjs style: pull one
// named function's body so assertions cannot accidentally match elsewhere.
function extractFunctionBody(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `renderer must define ${name}()`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

const wsHandlerBody = extractFunctionBody(appSource, "handleWsEvent");
const refreshAllBody = extractFunctionBody(appSource, "refreshAll");
const runtimeAlertBody = extractFunctionBody(appSource, "renderRuntimeAlert");
const applyProfileBody = extractFunctionBody(appSource, "applyActiveTeamProfile");

// ---------------------------------------------------------------------------
// 1. Both WS branches exist (they previously fell into default:break).
// ---------------------------------------------------------------------------
for (const evt of ["team.switch_started", "team.switch_completed"]) {
  assert.ok(
    wsHandlerBody.includes(`case "${evt}":`),
    `handleWsEvent must handle ${evt} (#255 P0-3: the event fell into default:break before)`,
  );
}

const startedAt = wsHandlerBody.indexOf('case "team.switch_started":');
const completedAt = wsHandlerBody.indexOf('case "team.switch_completed":');
assert.ok(startedAt !== -1 && completedAt !== -1 && startedAt < completedAt, "switch branches must be ordered started before completed");

// ---------------------------------------------------------------------------
// 2. switch_started: banner + system toast + refresh (drain phase).
// ---------------------------------------------------------------------------
const startedBranch = wsHandlerBody.slice(startedAt, completedAt);
assert.match(startedBranch, /state\.teamSwitchInFlight = true/, "started must raise the in-flight banner state");
assert.match(startedBranch, /state\.teamSwitchTargetId = String\(data\.profileId \|\| ""\)/, "started must remember the target profile id for the banner name");
assert.match(startedBranch, /renderRuntimeAlert\(\)/, "started must paint the switching banner immediately");
assert.match(
  startedBranch,
  /t\("teamSwitch\.started", \{ name: teamProfileDisplayName\(state\.teamSwitchTargetId\)/,
  "started toast/banner copy must carry the target profile display name",
);
assert.match(
  startedBranch,
  /upsertNotification\(\{[\s\S]*?id: "team-switch:started"[\s\S]*?desktopAlert: true/,
  "started must surface a desktop toast (notification with desktopAlert)",
);
assert.match(startedBranch, /refreshAll\(true\)\.catch\(\(\) => \{\}\)/, "started must re-pull controller state");

// ---------------------------------------------------------------------------
// 3. switch_completed: toast + FULL refresh + profile-scoped rebuild.
// ---------------------------------------------------------------------------
const completedBranch = wsHandlerBody.slice(completedAt, wsHandlerBody.indexOf("default:", completedAt));
assert.match(completedBranch, /state\.teamSwitchInFlight = false/, "completed must clear the in-flight banner state");
assert.match(
  completedBranch,
  /t\("teamSwitch\.completed", \{ name: teamProfileDisplayName\(data\.profileId\)/,
  "completed toast must carry the new profile display name",
);
assert.match(
  completedBranch,
  /id: "team-switch:completed"[\s\S]*?desktopAlert: true/,
  "completed must surface a desktop toast under its own card id (upsertNotification raises the OS alert only for NEW cards - sharing the started id would mute it)",
);
assert.match(
  completedBranch,
  /state\.notifications\.filter\(\(entry\) => entry\.id !== "team-switch:started"\)/,
  "completed must drop the transient switching card instead of stacking a second one",
);
assert.match(completedBranch, /refreshAll\(true\)\.catch\(\(\) => \{\}\)/, "completed must trigger a full refresh");
assert.match(
  completedBranch,
  /if \(state\.currentView === "controller"\) \{\s*\n\s*renderControllerSettings\(\);/,
  "completed must rebuild the per-role model panel when the controller view is open (catalog.roles is profile-scoped)",
);

// ---------------------------------------------------------------------------
// 4. refreshAll scope: the two profile-scoped endpoints are re-pulled on
//    every refresh, with the last known values kept on failure.
// ---------------------------------------------------------------------------
assert.match(refreshAllBody, /apiGet\("\/roles"\)/, "refreshAll must pull GET /api/v1/roles (#255 P0-3)");
assert.match(refreshAllBody, /apiGet\("\/team\/profile"\)/, "refreshAll must pull GET /api/v1/team/profile (#255 P0-3)");
assert.match(refreshAllBody, /state\.roleRegistry = normalizeArray\(rolesData\.roles\)/, "the /roles mirror must land in state.roleRegistry");
assert.match(refreshAllBody, /state\.roleDefaultId = typeof rolesData\.defaultRole === "string" \? rolesData\.defaultRole : ""/, "the default role id must mirror /roles.defaultRole");
assert.match(refreshAllBody, /applyActiveTeamProfile\(await apiGet\("\/team\/profile"\)\)/, "the profile mirror must funnel through applyActiveTeamProfile");
// Tolerated pulls: the switch-follow refresh must not hard-fail (and wipe
// state) when an older controller lacks either endpoint.
const rolesPullCount = (refreshAllBody.match(/apiGet\("\/roles"\);/g) || []).length;
assert.equal(rolesPullCount, 1, "the /roles pull must sit in its own try/catch (tolerated like the web refreshAll)");
assert.match(refreshAllBody, /catch \{ \/\* keep the last known role registry \*\/ \}/, "a failed /roles pull keeps the last known registry");
assert.match(refreshAllBody, /catch \{ \/\* keep the last known active team profile \*\/ \}/, "a failed /team/profile pull keeps the last known profile");

// ---------------------------------------------------------------------------
// 5. Banner semantics: switching outranks model readiness; the in-flight
//    state is re-derived from the /team/profile transition object so a
//    relaunch mid-switch (missed WS event) still shows it.
// ---------------------------------------------------------------------------
assert.match(
  runtimeAlertBody,
  /if \(state\.teamSwitchInFlight\) \{[\s\S]*?t\("teamSwitch\.started"/,
  "renderRuntimeAlert must show the switching banner while a switch drains",
);
const bannerGuardAt = runtimeAlertBody.indexOf("if (state.teamSwitchInFlight)");
const readinessAt = runtimeAlertBody.indexOf("state.teamStatus.modelReadiness");
assert.ok(bannerGuardAt !== -1 && readinessAt !== -1 && bannerGuardAt < readinessAt, "the switch banner must be checked before model readiness");
assert.match(applyProfileBody, /state\.teamSwitchInFlight = Boolean\(transition\)/, "the in-flight banner state must be re-derived from profileInfo.transition");
assert.match(applyProfileBody, /state\.wizardCurrentProfileId = id;/, "the wizard current-profile chip must follow the active profile mirror");
assert.match(applyProfileBody, /renderWizardTeamProfiles\(\);/, "the wizard cards must re-render when the active profile changes");

// ---------------------------------------------------------------------------
// 6. i18n: the two new keys exist in BOTH dictionaries with pinned values.
// ---------------------------------------------------------------------------
const zhBlockStart = i18nSource.indexOf("zh: {");
assert.notEqual(zhBlockStart, -1, "i18n must carry the zh dictionary");
const enBlock = i18nSource.slice(0, zhBlockStart);
const zhBlock = i18nSource.slice(zhBlockStart);
for (const [key, en, zh] of [
  ["teamSwitch.started", "Switching team profile to {name}…", "正在切换到 {name}…"],
  ["teamSwitch.completed", "Team profile switched to {name}", "团队画像已切换到 {name}"],
]) {
  assert.ok(enBlock.includes(`"${key}": "${en}"`), `en dictionary must define ${key} as "${en}"`);
  assert.ok(zhBlock.includes(`"${key}": "${zh}"`), `zh dictionary must define ${key} as "${zh}"`);
}

// ---------------------------------------------------------------------------
// 7. Follow-only boundary (#255 P0-3 scope): the desktop follows, never
//    initiates - no switch POST through its own api channel.
// ---------------------------------------------------------------------------
assert.doesNotMatch(
  appSource,
  /apiPost\(\s*["']\/team\/profile/,
  "the desktop renderer must not POST /team/profile (switcher entry point is P2; this wave is follow-only)",
);

console.log("test-desktop-switch-events: all assertions passed (WS started/completed branches, refreshAll pulls /roles + /team/profile, banner + toast, en/zh i18n pairs, follow-only boundary)");
