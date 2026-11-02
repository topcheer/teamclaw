#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const uiStylePath = path.join(projectRoot, "src", "src", "ui", "style.css");
const uiHtmlPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const desktopAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");

async function runUiContractSmoke() {
  const [uiAppSource, uiStyleSource, uiHtml, desktopApp] = await Promise.all([
    fs.readFile(uiAppPath, "utf8"),
    fs.readFile(uiStylePath, "utf8"),
    fs.readFile(uiHtmlPath, "utf8"),
    fs.readFile(desktopAppPath, "utf8"),
  ]);

  assert.match(
    uiAppSource,
    /function renderControllerManifestCard/,
    "UI app should render structured controller manifests",
  );
  assert.match(
    uiAppSource,
    /function renderResultContractCard/,
    "UI app should render structured worker result contracts",
  );
  assert.match(
    uiAppSource,
    /function renderProgressContractCard/,
    "UI app should render structured worker progress contracts",
  );
  assert.match(
    uiAppSource,
    /function renderTeamMessageContractCard/,
    "UI app should render structured team message contracts",
  );
  assert.match(
    uiAppSource,
    /function buildTimelineClarificationBody/,
    "UI timeline should render clarification details alongside execution and messages",
  );
  assert.doesNotMatch(
    uiAppSource,
    /renderPlanningTab[\s\S]*Only show runs that have a kickoff plan[\s\S]*kickoffPlan/,
    "Web planning should not hide non-kickoff controller runs",
  );
  assert.match(
    uiAppSource,
    /let rolesRes = \{ roles: \[\] \};[\s\S]*rolesRes = await apiGet\("\/roles"\);[\s\S]*console\.error\("Failed to load roles:/,
    "Web refresh should tolerate roles endpoint failures and still render main team state",
  );
  assert.match(
    uiStyleSource,
    /\.contract-card/,
    "UI styles should define contract cards",
  );
  assert.match(
    uiStyleSource,
    /\.contract-chip/,
    "UI styles should define contract chips",
  );
  assert.match(
    uiStyleSource,
    /\.task-contract-summary/,
    "UI styles should highlight structured contract summaries on task cards",
  );

  // Tab hash deep links (#/tab/<name>) must survive refresh.
  assert.match(
    uiAppSource,
    /#\/tab\//,
    "activating a tab must sync the #/tab/<name> hash",
  );
  assert.match(
    uiAppSource,
    /addEventListener\("hashchange"/,
    "hash navigation must re-activate the tab (back/forward support)",
  );
  assert.ok(
    uiAppSource.includes("#\\/tab\\/") && uiAppSource.includes("hashMatch"),
    "initial UI state must prefer the #/tab/<name> hash over query params",
  );
  assert.match(
    uiAppSource,
    /item\.dataset\.tab === initialUiState\.tab/,
    "initial tab activation must be guarded against stale/unknown tab names",
  );

  assert.doesNotMatch(
    uiAppSource,
    /\$\$\([^)]*\)\.some\(/,
    "$$ returns a NodeList which has no .some - wrap with Array.from (breaks boot-from-hash at eval time)",
  );
  assert.ok(
    uiAppSource.includes('Array.from($$(".tab")).some'),
    "tab existence checks must use Array.from(...).some",
  );

  // Tasks page: composite ordering, terminal chunking, keyword filter.
  assert.match(uiAppSource, /function taskComparator/, "tasks must render through the composite comparator");
  assert.match(uiAppSource, /TERMINAL_STATUSES\[left\.status\] \? 1 : 0/, "comparator must float active tasks above terminal ones");
  assert.match(uiAppSource, /PRIORITY_WEIGHT\[left\.priority/, "comparator must weigh priority within a status group");
  assert.match(uiAppSource, /terminalTasksVisible/, "terminal tasks must render in bounded chunks");
  assert.match(uiAppSource, /tasks-show-more/, "a show-more control must reveal additional terminal tasks");
  assert.match(uiAppSource, /taskMatchesKeyword/, "keyword filtering must be applied to the task list");
  assert.match(uiHtml, /task-keyword/, "the tasks toolbar must expose a keyword input");
  assert.match(desktopApp, /TERMINAL_STATUSES\[a\.status\]/, "desktop sortTasks must use the same composite ordering");

  console.log("UI contract smoke passed.");
}

await runUiContractSmoke();
