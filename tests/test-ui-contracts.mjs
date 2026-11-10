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

  // Desktop titleless window: in-page drag bar replaces the OS title bar.
  const [desktopHtml, desktopMain, desktopStyle] = await Promise.all([
    fs.readFile(path.join(projectRoot, "desktop", "renderer", "index.html"), "utf8"),
    fs.readFile(path.join(projectRoot, "desktop", "main.mjs"), "utf8"),
    fs.readFile(path.join(projectRoot, "desktop", "renderer", "style.css"), "utf8"),
  ]);
  assert.match(desktopHtml, /class="titlebar"/, "desktop shell must include the in-page titlebar");
  assert.match(desktopMain, /titleBarStyle: isDarwin \? "hiddenInset" : "hidden"/, "window must hide the native title bar (hiddenInset on macOS)");
  assert.match(desktopMain, /titleBarOverlay/, "Windows/Linux must keep native controls via titleBarOverlay");
  assert.match(desktopStyle, /-webkit-app-region: drag/, "the titlebar must be the window drag region");
  assert.match(desktopApp, /dataset\.platform/, "renderer must bind the platform for titlebar insets");

  // Day/night theming: paired token blocks, no-flash bootstrap, live toggle,
  // window chrome follows the theme.
  const desktopPreload = await fs.readFile(path.join(projectRoot, "desktop", "preload.cjs"), "utf8");
  assert.match(desktopStyle, /html\[data-theme="dark"\]/, "a dark theme token block must exist");
  assert.match(desktopStyle, /--info-bg|--danger-bg/, "status colors must be semantic tokens");
  assert.match(desktopHtml, /teamclaw-theme/, "index.html must bootstrap the theme before paint");
  assert.match(desktopHtml, /id="theme-toggle"/, "the theme toggle must be reachable in the rail");
  assert.match(desktopApp, /prefers-color-scheme/, "system theme must be followed by default");
  assert.match(desktopMain, /THEME_CHROME/, "window chrome colors must follow the theme");
  assert.match(desktopMain, /window:apply-theme/, "theme changes must update window chrome live");
  assert.match(desktopPreload, /applyTheme/, "preload must expose the theme bridge");

  // Desktop internet tunnel card (Controller view).
  assert.match(desktopHtml, /ctl-tunnel-state/, "controller view hosts the tunnel card");
  assert.match(desktopHtml, /ctl-tunnel-share/, "share action present");
  assert.match(desktopHtml, /ctl-tunnel-stop/, "stop action present");
  assert.match(desktopApp, /refreshTunnelPanel/, "tunnel card polls status");
  assert.match(desktopApp, /\/tunnel\/status/, "polls the controller tunnel status endpoint");
  assert.match(desktopApp, /\/tunnel\/start/, "share hits the controller start endpoint");
  assert.match(desktopApp, /\/tunnel\/install-cloudflared/, "install action present");
  assert.match(desktopApp, /ctl\.tunnel\.gateToken/, "gate token is surfaced to the user");
  assert.match(desktopApp, /errEl\.textContent = ""/, "a successful poll clears the previous error (transient startup failures self-heal)");

  console.log("UI contract smoke passed.");
}

await runUiContractSmoke();
