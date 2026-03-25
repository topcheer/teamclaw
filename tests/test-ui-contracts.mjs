#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const uiStylePath = path.join(projectRoot, "src", "src", "ui", "style.css");

async function runUiContractSmoke() {
  const [uiAppSource, uiStyleSource] = await Promise.all([
    fs.readFile(uiAppPath, "utf8"),
    fs.readFile(uiStylePath, "utf8"),
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

  console.log("UI contract smoke passed.");
}

await runUiContractSmoke();
