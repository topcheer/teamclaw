#!/usr/bin/env node
// i18n parity between the web UI and the desktop renderer (chore-i18n-parity).
//
// The two dictionaries evolved independently since desktop/renderer/i18n.js
// was extracted from src/src/ui/app.js ("Extracted from app.js"). This test
// locks the alignment so drift is caught instead of re-accumulating:
//
//   A. each side's en/zh dictionaries are complete pairs (same key sets);
//   B. inventory counts are pinned (reproducible audit numbers):
//        web 203 keys, desktop 294 keys, 60 shared,
//        143 web-only, 234 desktop-only;
//   C. shared keys carry identical en AND zh values, except the explicit
//      VALUE_ALLOWED allowlist below (one reason per entry);
//   D. single-side keys match the explicit WEB_ONLY/DESKTOP_ONLY groups
//      exactly (any unlisted new single-side key fails, any removed key
//      fails) — adding a key to one side requires updating this test and
//      deciding whether the other side needs it too;
//   E. allowlist hygiene: every VALUE_ALLOWED entry still exists and still
//      differs (no dead entries masking future fixes).
//
// Parsing follows the source-level dictionary assertions of
// test-profile-switcher-ui.mjs (regex over the literal, no imports), extended
// with brace matching so the zh block cannot swallow code after the object
// literal (a naive to-EOF slice once captured renderer code as fake keys).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const webAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const desktopI18nPath = path.join(projectRoot, "desktop", "renderer", "i18n.js");

// Matches "key": "value" including escaped characters inside values
// (e.g. empty.noTasksWithStatus en value contains a literal \"{status}\").
const ENTRY_RE = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function unescapeJsString(raw) {
  return raw.replace(/\\(.)/g, "$1");
}

function balancedBlock(source, fromIndex) {
  let depth = 0;
  for (let i = fromIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(fromIndex, i + 1);
    }
  }
  throw new Error("unbalanced braces while extracting dictionary block");
}

function parseLanguageBlock(source, label) {
  const at = source.search(new RegExp(`\\b${label}:\\s*\\{`));
  assert.ok(at >= 0, `dictionary must contain a ${label}: { ... } block`);
  const block = balancedBlock(source, source.indexOf("{", at));
  const entries = new Map();
  for (const match of block.matchAll(ENTRY_RE)) {
    const key = match[1];
    assert.ok(!entries.has(key), `duplicate i18n key "${key}" in ${label} block`);
    entries.set(key, unescapeJsString(match[2]));
  }
  return entries;
}

async function parseDictionary(filePath, name) {
  const source = await fs.readFile(filePath, "utf8");
  return {
    name,
    en: parseLanguageBlock(source, "en"),
    zh: parseLanguageBlock(source, "zh"),
  };
}

const web = await parseDictionary(webAppPath, "web(src/src/ui/app.js)");
const desktop = await parseDictionary(desktopI18nPath, "desktop(desktop/renderer/i18n.js)");

// ---------------------------------------------------------------------------
// A. Internal completeness: en and zh key sets are exact pairs, per side.
// ---------------------------------------------------------------------------
for (const dict of [web, desktop]) {
  assert.deepEqual(
    [...dict.zh.keys()].sort(),
    [...dict.en.keys()].sort(),
    `${dict.name}: every key must exist in BOTH en and zh (single-side translations are incomplete)`,
  );
}

// ---------------------------------------------------------------------------
// B. Pinned inventory counts (audit numbers from the chore-i18n-parity pass).
// ---------------------------------------------------------------------------
assert.equal(web.en.size, 203, "web dictionary must carry exactly 203 keys (update alongside deliberate additions)");
assert.equal(desktop.en.size, 294, "desktop dictionary must carry exactly 294 keys (update alongside deliberate additions)");

const webKeys = new Set(web.en.keys());
const desktopKeys = new Set(desktop.en.keys());
const sharedKeys = [...webKeys].filter((k) => desktopKeys.has(k)).sort();
const webOnlyKeys = [...webKeys].filter((k) => !desktopKeys.has(k)).sort();
const desktopOnlyKeys = [...desktopKeys].filter((k) => !webKeys.has(k)).sort();

assert.equal(sharedKeys.length, 60, "exactly 60 keys are shared between web and desktop");
assert.equal(webOnlyKeys.length, 143, "exactly 143 keys are web-only");
assert.equal(desktopOnlyKeys.length, 234, "exactly 234 keys are desktop-only");

// ---------------------------------------------------------------------------
// C. Shared keys must carry identical values on both sides (en and zh
//    separately), except for the allowlist below. Every entry carries the
//    reason it is allowed to keep differing.
// ---------------------------------------------------------------------------
const VALUE_ALLOWED = new Map([
  // Web labels use Title Case for detail fields; desktop standardized its
  // whole UI on sentence case in its 2026-04 rewrite (d06fab1). Same wording,
  // capitalization style only — deliberate per-side label style.
  ["planning.controllerOutput|en", "web Title Case labels vs desktop sentence-case labels (per-side style, same meaning)"],
  ["planning.originalRequest|en", "web Title Case labels vs desktop sentence-case labels (per-side style, same meaning)"],
  ["planning.requiredRoles|en", "web Title Case labels vs desktop sentence-case labels (per-side style, same meaning)"],
  ["planning.deferredTasks|en", "web Title Case labels vs desktop sentence-case labels (per-side style, same meaning)"],
  ["planning.clarificationsNeeded|en", "web Title Case labels vs desktop sentence-case labels (per-side style, same meaning)"],
]);

for (const lang of ["en", "zh"]) {
  const drifted = sharedKeys.filter((k) => web[lang].get(k) !== desktop[lang].get(k));
  const unallowed = drifted.filter((k) => !VALUE_ALLOWED.has(`${k}|${lang}`));
  assert.deepEqual(
    unallowed,
    [],
    `shared keys with diverging ${lang} values outside the allowlist (pick the correct side and align, or add a reasoned allowlist entry): ${unallowed.join(", ")}`,
  );
}

// E(1). Allowlist hygiene: entries must reference real keys and real drift.
for (const entryKey of VALUE_ALLOWED.keys()) {
  const [key, lang] = entryKey.split("|");
  assert.ok(webKeys.has(key) && desktopKeys.has(key), `VALUE_ALLOWED entry "${entryKey}" must reference a shared key (stale entry — remove it)`);
  assert.notEqual(
    web[lang].get(key),
    desktop[lang].get(key),
    `VALUE_ALLOWED entry "${entryKey}" no longer differs (values were aligned — remove the stale entry)`,
  );
}

// ---------------------------------------------------------------------------
// D. Single-side keys must match the explicit groups exactly.
//    Consuming-surface classification from the chore-i18n-parity audit; when
//    a key legitimately becomes shared, move it out of these groups.
// ---------------------------------------------------------------------------
const WEB_ONLY_GROUPS = [
  { prefix: "action", reason: "web generic action-bar buttons; desktop equivalents live under its own namespaces (connection.refresh / worker.copy) with matching values", keys: [
    "action.close",
    "action.copied",
    "action.copyCommand",
    "action.copyToken",
    "action.dismiss",
    "action.refresh"
  ] },
  { prefix: "clarification", reason: "web clarification modal kicker/title; desktop answer panel uses its own detail keys", keys: [
    "clarification.kicker",
    "clarification.title"
  ] },
  { prefix: "detail", reason: "web task-detail kicker label", keys: [
    "detail.kicker"
  ] },
  { prefix: "empty", reason: "web-only empty states (worker list, toast-driven task feed, workspace tree, messages/planning panels)", keys: [
    "empty.copiedControllerReply",
    "empty.noClarifications",
    "empty.noControllerActivity",
    "empty.noKickoffData",
    "empty.noMessages",
    "empty.noPlanningSessions",
    "empty.noTasks",
    "empty.noTasksWithStatus",
    "empty.noWorkers",
    "empty.noWorkspaceFiles",
    "empty.selectFilePreview",
    "empty.selectFileSource",
    "empty.selectTask",
    "empty.taskDetail",
    "empty.taskHistory",
    "empty.taskMessages",
    "empty.workspaceLoading"
  ] },
  { prefix: "filter", reason: "web task status filter chips; desktop task list has no filter chips", keys: [
    "filter.all",
    "filter.assigned",
    "filter.blocked",
    "filter.completed",
    "filter.failed",
    "filter.in_progress",
    "filter.pending"
  ] },
  { prefix: "gh", reason: "web header GitHub login button; desktop equivalent is ctl.gh.login (same values, different namespace)", keys: [
    "gh.login"
  ] },
  { prefix: "live", reason: "web worker live-status pill", keys: [
    "live.idle"
  ] },
  { prefix: "manualTask", reason: "web manual task injection form; desktop has no manual task UI", keys: [
    "manualTask.assignedRole",
    "manualTask.autoAssign",
    "manualTask.create",
    "manualTask.description",
    "manualTask.descriptionPlaceholder",
    "manualTask.note",
    "manualTask.priority",
    "manualTask.skills",
    "manualTask.skillsPlaceholder",
    "manualTask.title",
    "manualTask.titlePlaceholder"
  ] },
  { prefix: "messages", reason: "web messages panel note; desktop folds activity into the mission panel", keys: [
    "messages.panelNote"
  ] },
  { prefix: "planning", reason: "web planning session-panel fields (sessions list + kickoff overview); desktop planning is a run-detail panel with its own field set", keys: [
    "planning.description",
    "planning.kickoff",
    "planning.plannedTasks",
    "planning.sessions",
    "planning.title"
  ] },
  { prefix: "security", reason: "web device-pairing security surfaces (issue #23 client wave): suggestion banner, one-shot pairing-code modal, device management section; desktop pairs via its own wizard keys (bootstrap.pairingCode*) and has no banner/device manager", keys: [
    "security.bannerTitle",
    "security.bannerHint",
    "security.enableAction",
    "security.pairTitle",
    "security.pairHint",
    "security.pairExpiresIn",
    "security.pairExpired",
    "security.pairNewCode",
    "security.devicesTitle",
    "security.statusOn",
    "security.statusOff",
    "security.revoke",
    "security.selfRevokeWarn",
    "security.selfRevoked",
    "security.resetAll",
    "security.resetConfirm",
    "security.resetDone",
    "security.devicesUnavailable",
    "security.noDevices"
  ] },
  { prefix: "priority", reason: "web manual-task priority select (desktop has no manual task form)", keys: [
    "priority.critical",
    "priority.high",
    "priority.low",
    "priority.medium"
  ] },
  { prefix: "sidebar", reason: "web sidebar section titles", keys: [
    "sidebar.roles",
    "sidebar.workers"
  ] },
  { prefix: "tab", reason: "web-only tabs (messages feed, manual task); desktop has no equivalent surfaces", keys: [
    "tab.manualTask",
    "tab.messages"
  ] },
  { prefix: "tasks", reason: "web task keyword filter and show-more affordances", keys: [
    "tasks.noMatch",
    "tasks.searchPlaceholder",
    "tasks.showMore"
  ] },
  { prefix: "teamProfile", reason: "web team-profile switcher modal (Phase 5.3); desktop intentionally has no switcher — wizard.teamTypeNote routes users to the controller's switcher", keys: [
    "teamProfile.archivedEmpty",
    "teamProfile.archivedTasks",
    "teamProfile.archivedTitle",
    "teamProfile.cancel",
    "teamProfile.capabilityRestartHint",
    "teamProfile.confirmArchive",
    "teamProfile.confirmButton",
    "teamProfile.confirmWorkers",
    "teamProfile.current",
    "teamProfile.headerButtonTitle",
    "teamProfile.kicker",
    "teamProfile.loadFailed",
    "teamProfile.pendingSignoff",
    "teamProfile.roleCount",
    "teamProfile.switchCompleted",
    "teamProfile.switchFailed",
    "teamProfile.switchStarted",
    "teamProfile.switching",
    "teamProfile.title",
    "teamProfile.transitionPending"
  ] },
  { prefix: "teamauto", reason: "web TeamAuto config extras: cron schedule hint text and config tab; desktop binds with a single schedule input and one combined tab", keys: [
    "teamauto.scheduleHint",
    "teamauto.tabConfig"
  ] },
  { prefix: "toast", reason: "web toast notification center; desktop renders notifications as delivery cards", keys: [
    "toast.clarificationAnswered",
    "toast.clarificationRequested",
    "toast.disableAll",
    "toast.enableAll",
    "toast.freqClarification",
    "toast.freqMessageNew",
    "toast.freqTaBind",
    "toast.freqTaProvision",
    "toast.freqTaSweep",
    "toast.freqTaTask",
    "toast.freqTaWriteback",
    "toast.freqTaskCompleted",
    "toast.freqTaskCreated",
    "toast.freqTaskUpdated",
    "toast.freqTeamauto",
    "toast.freqWorker",
    "toast.messageNew",
    "toast.settingsTitle",
    "toast.taBind",
    "toast.taProvision",
    "toast.taSweep",
    "toast.taTask",
    "toast.taWriteback",
    "toast.taskCompleted",
    "toast.taskCreated",
    "toast.taskFailed",
    "toast.taskUpdated",
    "toast.teamautoPrefix",
    "toast.workerOffline",
    "toast.workerOnline"
  ] },
  { prefix: "workspace", reason: "web workspace viewer chrome (preview/source toggle, raw link, files header)", keys: [
    "workspace.files",
    "workspace.openRaw",
    "workspace.preview",
    "workspace.source"
  ] },
  { prefix: "workflow", reason: "web workflow template button group + running badges (design 2.4 / PR #243 UI wave); desktop renders no workflow quick actions", keys: [
    "workflow.badgeRound",
    "workflow.sectionTitle",
    "workflow.startFailed",
    "workflow.started",
    "workflow.stepsTooltip"
  ] },
];

const DESKTOP_ONLY_GROUPS = [
  { prefix: "action", reason: "desktop in-app language toggle labels; web renders the toggle text directly in setLanguage()", keys: [
    "action.languageToggleEn",
    "action.languageToggleZh"
  ] },
  { prefix: "boot", reason: "desktop boot splash", keys: [
    "boot.connecting",
    "boot.startingInstance"
  ] },
  { prefix: "bootstrap", reason: "desktop first-run bootstrap / install screens (no web equivalent: web is served by an already-running controller)", keys: [
    "bootstrap.autoStarting",
    "bootstrap.command",
    "bootstrap.componentsLabel",
    "bootstrap.connectRemote",
    "bootstrap.connecting",
    "bootstrap.copied",
    "bootstrap.copyInstall",
    "bootstrap.failed",
    "bootstrap.installNow",
    "bootstrap.installing",
    "bootstrap.logs",
    "bootstrap.manualMode",
    "bootstrap.manualModeHint",
    "bootstrap.manualWarning",
    "bootstrap.mode",
    "bootstrap.modeWarning",
    "bootstrap.openclawDetected",
    "bootstrap.openclawDetectedDegraded",
    "bootstrap.openclawInstallLabel",
    "bootstrap.openclawInstallNow",
    "bootstrap.openclawMissingSubtitle",
    "bootstrap.openclawMissingTitle",
    "bootstrap.openclawQuickstartLabel",
    "bootstrap.processMode",
    "bootstrap.processModeHint",
    "bootstrap.pairedNote",
    "bootstrap.pairingCodeLabel",
    "bootstrap.pairingCodePlaceholder",
    "bootstrap.pairingFailed",
    "bootstrap.remoteHint",
    "bootstrap.remoteTitle",
    "bootstrap.remoteUrl",
    "bootstrap.startCommand",
    "bootstrap.startLocal",
    "bootstrap.startingLocal",
    "bootstrap.status",
    "bootstrap.subtitle",
    "bootstrap.teamclawDetectedSubtitle",
    "bootstrap.teamclawDetectedTitle",
    "bootstrap.teamclawInstallLabel",
    "bootstrap.title",
    "bootstrap.wizardSubtitle",
    "bootstrap.wizardTitle"
  ] },
  { prefix: "clarification", reason: "desktop clarification answer panel fields and queue counters", keys: [
    "clarification.answer",
    "clarification.answerPlaceholder",
    "clarification.context",
    "clarification.historyEmpty",
    "clarification.humanInput",
    "clarification.later",
    "clarification.needed",
    "clarification.openPlanning",
    "clarification.openTask",
    "clarification.project",
    "clarification.question",
    "clarification.queue.many",
    "clarification.queue.one",
    "clarification.task",
    "clarification.whyBlocked"
  ] },
  { prefix: "clarifications", reason: "desktop clarifications tab empty state", keys: [
    "clarifications.none"
  ] },
  { prefix: "connection", reason: "desktop connection status bar and server switching UI", keys: [
    "connection.changeServer",
    "connection.connect",
    "connection.connected",
    "connection.connectedTo",
    "connection.connecting",
    "connection.controller",
    "connection.disconnected",
    "connection.done",
    "connection.edit",
    "connection.noSummary",
    "connection.notConnected",
    "connection.privateGroup",
    "connection.privateNote",
    "connection.privateStart",
    "connection.privateStop",
    "connection.prodGroup",
    "connection.reconnecting",
    "connection.refresh",
    "connection.retrying",
    "connection.setup",
    "connection.title",
    "connection.waiting"
  ] },
  { prefix: "ctl", reason: "desktop controller settings panes (models / github / tunnel / workspace). The web UI has equivalent surfaces (model-settings modal, tunnel popover) but they are still hardcoded HTML not yet wired to the dictionary — migrating them should REUSE these values, not fork new keys", keys: [
    "ctl.gh.current",
    "ctl.gh.failed",
    "ctl.gh.hint",
    "ctl.gh.loggedOut",
    "ctl.gh.login",
    "ctl.gh.logout",
    "ctl.gh.pageOpened",
    "ctl.gh.signedOut",
    "ctl.gh.title",
    "ctl.gh.validUntil",
    "ctl.models.default",
    "ctl.models.failed",
    "ctl.models.hint",
    "ctl.models.save",
    "ctl.models.saved",
    "ctl.models.title",
    "ctl.models.useDefault",
    "ctl.notConnected",
    "ctl.tab.github",
    "ctl.tab.models",
    "ctl.tab.tunnel",
    "ctl.tab.workspace",
    "ctl.tunnel.actionFailed",
    "ctl.tunnel.errNotConnected",
    "ctl.tunnel.gateToken",
    "ctl.tunnel.hint",
    "ctl.tunnel.install",
    "ctl.tunnel.installing",
    "ctl.tunnel.live",
    "ctl.tunnel.loading",
    "ctl.tunnel.notInstalled",
    "ctl.tunnel.off",
    "ctl.tunnel.share",
    "ctl.tunnel.starting",
    "ctl.tunnel.stop",
    "ctl.tunnel.stopped",
    "ctl.tunnel.title",
    "ctl.ws.apply",
    "ctl.ws.current",
    "ctl.ws.default",
    "ctl.ws.failed",
    "ctl.ws.hint",
    "ctl.ws.inputLabel",
    "ctl.ws.needAbsolute",
    "ctl.ws.saved",
    "ctl.ws.title"
  ] },
  { prefix: "mission", reason: "desktop mission panel (requirement input, notifications, summary)", keys: [
    "mission.connectHint",
    "mission.newRequirement",
    "mission.noConversation",
    "mission.notifications",
    "mission.recentInteraction",
    "mission.requirement",
    "mission.summary",
    "mission.title"
  ] },
  { prefix: "planning", reason: "desktop planning-run detail fields (run list, assessments, risks, status groups)", keys: [
    "planning.assessments",
    "planning.candidateRoles",
    "planning.complexity",
    "planning.consensus",
    "planning.createdTasks",
    "planning.dependencies",
    "planning.empty",
    "planning.groupActive",
    "planning.groupBlockedFailed",
    "planning.groupCompleted",
    "planning.groupPending",
    "planning.handoffPlan",
    "planning.noOutput",
    "planning.none",
    "planning.questions",
    "planning.risks",
    "planning.runFallback",
    "planning.runs",
    "planning.scope",
    "planning.suggestedTasks"
  ] },
  { prefix: "reports", reason: "desktop delivery reports tab", keys: [
    "reports.deliveryTitle",
    "reports.none",
    "reports.projectFallback"
  ] },
  { prefix: "summary", reason: "desktop mission summary stat cards", keys: [
    "summary.blocked",
    "summary.completed",
    "summary.pending",
    "summary.workers"
  ] },
  { prefix: "tab", reason: "desktop-only tabs (controller settings, reports)", keys: [
    "tab.controller",
    "tab.reports"
  ] },
  { prefix: "task", reason: "desktop task detail panel (timeline/messages/detail chrome)", keys: [
    "task.auto",
    "task.details",
    "task.failedLoadDetail",
    "task.filter.none",
    "task.groupProject",
    "task.loadingDetail",
    "task.messages",
    "task.selectHint",
    "task.timeline",
    "task.title"
  ] },
  { prefix: "teamauto", reason: "desktop TeamAuto combined tab label", keys: [
    "teamauto.tabRepos"
  ] },
  { prefix: "wizard", reason: "desktop first-run setup wizard (no web equivalent)", keys: [
    "wizard.advModeLabel",
    "wizard.advMulti",
    "wizard.advMultiDesc",
    "wizard.advSimple",
    "wizard.advSimpleDesc",
    "wizard.advanced",
    "wizard.back",
    "wizard.cancel",
    "wizard.followControllerNote",
    "wizard.install",
    "wizard.keyHint",
    "wizard.lifecycleApp",
    "wizard.lifecycleLabel",
    "wizard.lifecyclePersistent",
    "wizard.llmEndpoint",
    "wizard.llmLabel",
    "wizard.llmLabelRequired",
    "wizard.llmLater",
    "wizard.llmNote",
    "wizard.llmUseConfigured",
    "wizard.llmUseCustom",
    "wizard.modeGlobalDesc",
    "wizard.modeGlobalTitle",
    "wizard.modePrivateDesc",
    "wizard.modePrivateTitle",
    "wizard.modeRemoteDesc",
    "wizard.modeRemoteTitle",
    "wizard.needKey",
    "wizard.needModel",
    "wizard.needProvider",
    "wizard.next",
    "wizard.pendingSignoff",
    "wizard.preparing",
    "wizard.progress",
    "wizard.refreshModels",
    "wizard.restart",
    "wizard.runMode",
    "wizard.sourceLabel",
    "wizard.srcArtifact",
    "wizard.srcAuto",
    "wizard.srcBundled",
    "wizard.srcOfficial",
    "wizard.stepLaunch",
    "wizard.stepMode",
    "wizard.stepModel",
    "wizard.stepTeam",
    "wizard.teamProfileCurrent",
    "wizard.teamProfileRoleCount",
    "wizard.teamTypeLabel",
    "wizard.teamTypeNote"
  ] },
  { prefix: "worker", reason: "desktop worker-card copy button labels; web uses action.copyCommand/action.copied for the same control", keys: [
    "worker.copied",
    "worker.copy"
  ] },
  { prefix: "workspace", reason: "desktop workspace viewer hints (selected file label, empty state)", keys: [
    "workspace.none",
    "workspace.selectHint",
    "workspace.selectedFile"
  ] },
];

// E(2). Group hygiene: declared prefixes must match their keys (typo guard).
for (const [groups, side] of [[WEB_ONLY_GROUPS, "WEB_ONLY"], [DESKTOP_ONLY_GROUPS, "DESKTOP_ONLY"]]) {
  for (const group of groups) {
    for (const key of group.keys) {
      assert.equal(
        key.split(".")[0],
        group.prefix,
        `${side} group "${group.prefix}" contains key "${key}" whose prefix does not match (move it to the right group)`,
      );
    }
  }
}

const allowedWebOnly = WEB_ONLY_GROUPS.flatMap((g) => g.keys).sort();
const allowedDesktopOnly = DESKTOP_ONLY_GROUPS.flatMap((g) => g.keys).sort();

assert.deepEqual(
  webOnlyKeys,
  allowedWebOnly,
  "web-only key set drifted from the explicit allowlist: " +
    `unexpected new web-only keys [${webOnlyKeys.filter((k) => !allowedWebOnly.includes(k)).join(", ")}] ` +
    `(either the UI is web-only by design — add a reasoned group entry — or the key belongs on desktop too — add it there); ` +
    `missing keys [${allowedWebOnly.filter((k) => !webOnlyKeys.includes(k)).join(", ")}]`,
);
assert.deepEqual(
  desktopOnlyKeys,
  allowedDesktopOnly,
  "desktop-only key set drifted from the explicit allowlist: " +
    `unexpected new desktop-only keys [${desktopOnlyKeys.filter((k) => !allowedDesktopOnly.includes(k)).join(", ")}] ` +
    `(either the UI is desktop-only by design — add a reasoned group entry — or the key belongs on web too — add it there); ` +
    `missing keys [${allowedDesktopOnly.filter((k) => !desktopOnlyKeys.includes(k)).join(", ")}]`,
);

console.log("i18n parity passed: web 203 / desktop 294 keys, 60 shared aligned, 143+234 single-side keys allowlisted.");
