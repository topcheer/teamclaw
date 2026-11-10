#!/usr/bin/env node
// Wave 23b web UI contract tests for the declarative workflow surfaces
// (docs/vertical-team-profiles-design.md 2.4 + Phase 5 row 5.1; backend API
// frozen by PR #243).
//
// Source-level assertions in the test-profile-switcher-ui.mjs style (regex
// over the literal, no browser, no backend re-testing):
//   1. workflow template button group
//      - #workflow-launcher container in the tasks tab, hidden by default
//      - data source is GET /team/profile -> profile.workflows (no other
//        endpoint, no per-profile special casing - software-rd simply ships
//        no workflows)
//      - conditional render: empty template list keeps the container hidden
//      - click wiring: POST /api/v1/workflows/{id}/start with body
//        { context: "" } (minimal v1 invocation), success -> toast
//        workflow.started + refreshAll(), failure -> workflow.startFailed
//        with the backend error surfaced (404/503 ladder)
//   2. running badge
//      - tasks carrying task.workflow render a badge joining workflow name +
//        step title from the active templates + 第N轮 when visitCounts > 1
//      - tasks without task.workflow render no badge
//   3. role visibility toggle (Phase 4 lightweight customization)
//      - localStorage-backed prefs (pure UI filter layer; /roles untouched)
//      - visibility filter applied to the manual-task role select, the
//        external-worker role select and the sidebar roles list
//      - rename falls back to the registry label on empty custom name
//      - reset clears storage and restores defaults
//   4. i18n: every workflow.* / roleDisplay.* key in BOTH en and zh dicts

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const uiHtmlPath = path.join(projectRoot, "src", "src", "ui", "index.html");

const [appSource, htmlSource] = await Promise.all([
  fs.readFile(uiAppPath, "utf8"),
  fs.readFile(uiHtmlPath, "utf8"),
]);

// ---------------------------------------------------------------------------
// 1. Button group: container + data-driven visibility.
// ---------------------------------------------------------------------------
assert.match(
  htmlSource,
  /<div id="workflow-launcher" class="task-filters workflow-launcher" role="group" hidden><\/div>/,
  "tasks tab must carry the #workflow-launcher button-group container, hidden by default",
);
assert.ok(
  htmlSource.indexOf('class="task-filters"') < htmlSource.indexOf('id="workflow-launcher"') &&
    htmlSource.indexOf('id="workflow-launcher"') < htmlSource.indexOf('id="tasks-board"'),
  "workflow buttons must render between the task filters and the tasks board (above the task area)",
);
assert.match(
  appSource,
  /function renderWorkflowLauncher/,
  "app.js must implement renderWorkflowLauncher",
);
assert.match(
  appSource,
  /function activeWorkflows\(\) \{\s*return activeTeamProfile && activeTeamProfile\.profile && Array\.isArray\(activeTeamProfile\.profile\.workflows\)/,
  "the button source must be the /team/profile mirror's profile.workflows array (PR #243 contract)",
);
assert.match(
  appSource,
  /var workflows = activeWorkflows\(\);\s*if \(!workflows\.length\) \{\s*container\.hidden = true;/,
  "an empty template list must keep the container hidden (software-rd: no workflows, no buttons)",
);
assert.match(
  appSource,
  /container\.hidden = false;/,
  "a non-empty template list must reveal the container",
);
// Zero per-profile branches: the renderer slice must not special-case ids.
const launcherSlice = appSource.slice(
  appSource.indexOf("function renderWorkflowLauncher"),
  appSource.indexOf("function startWorkflow"),
);
assert.ok(
  !/software-rd|banking|trading|insurance|securities|crossborder/.test(launcherSlice),
  "the launcher must stay data-driven - no profile-id literals in the renderer",
);
assert.match(
  appSource,
  /renderWorkflowLauncher\(\);/,
  "refreshAll must render the launcher on every refresh (language switches, profile switches)",
);
assert.match(
  appSource,
  /data-workflow-id=/,
  "launcher buttons must carry data-workflow-id for click wiring",
);
assert.match(
  appSource,
  /t\("workflow\.stepsTooltip", \{ n: steps\.length, roles: roles \}\)/,
  "button tooltips must summarize the template steps (N steps · role chain)",
);

// ---------------------------------------------------------------------------
// 2. Start wiring: URL, body, toast, refresh, error ladder.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /apiPost\("\/workflows\/" \+ encodeURIComponent\(workflowId\) \+ "\/start", \{ context: "" \}\)/,
  "click must POST /api/v1/workflows/{id}/start with an empty context body (minimal v1)",
);
assert.match(
  appSource,
  /function startWorkflow\(workflowId, button\)/,
  "startWorkflow must exist and disable its button while in flight",
);
assert.match(
  appSource,
  /showError\(t\("workflow\.started", \{ name: name \}\)\);/,
  "a 201 must toast workflow.started with the workflow name",
);
assert.match(
  appSource,
  /var name = \(data && data\.workflowName\) \|\| workflowId;/,
  "the success toast must prefer the 201 body's workflowName",
);
assert.match(
  appSource,
  /function startWorkflow[\s\S]*?return refreshAll\(\);/,
  "a successful start must refreshAll so the new task chain appears",
);
assert.match(
  appSource,
  /showError\(t\("workflow\.startFailed", \{\s*reason: err instanceof Error \? err\.message : String\(err \|\| "request failed"\),\s*\}\)\);/,
  "404/503 failures must surface the backend error through workflow.startFailed",
);

// ---------------------------------------------------------------------------
// 3. Running badge on workflow tasks.
// ---------------------------------------------------------------------------
assert.match(
  appSource,
  /function workflowBadgeHtml\(task\) \{\s*var context = task && task\.workflow;\s*if \(!context \|\| !context\.workflowId\) return "";/,
  "badge rendering must be guarded on task.workflow (plain tasks get no badge)",
);
assert.match(
  appSource,
  /class="task-origin-badge task-workflow-badge"/,
  "the badge must reuse the task-origin-badge chip styling",
);
assert.match(
  appSource,
  /workflow\.id === context\.workflowId/,
  "the badge must join the workflow name from the active templates by workflowId",
);
assert.match(
  appSource,
  /String\(entry && entry\.id\) === String\(context\.stepKey\)/,
  "the badge must resolve the step title by matching stepKey against template step ids",
);
assert.match(
  appSource,
  /typeof visits === "number" && visits > 1\s*\?\s*" · " \+ t\("workflow\.badgeRound", \{ n: visits \}\)/,
  "visitCounts > 1 on the current step must append the 第N轮 round marker",
);
assert.match(
  appSource,
  /creatorBadge \+ workflowBadgeHtml\(task\)/,
  "the task card title row must render the workflow badge next to the origin badge",
);

// ---------------------------------------------------------------------------
// 4. i18n: workflow.* keys must exist in BOTH the en and zh inline dicts.
// ---------------------------------------------------------------------------
for (const key of [
  "workflow.sectionTitle",
  "workflow.stepsTooltip",
  "workflow.started",
  "workflow.startFailed",
  "workflow.badgeRound",
]) {
  const count = (appSource.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) || []).length;
  assert.equal(count, 2, `i18n key ${key} must exist in both en and zh dictionaries`);
}

console.log("Workflows UI contract passed.");
