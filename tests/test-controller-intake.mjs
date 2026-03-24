#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const httpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const promptInjectorPath = path.join(projectRoot, "src", "src", "controller", "prompt-injector.ts");

async function runControllerIntakePromptSmoke() {
  const [httpServerSource, promptInjectorSource] = await Promise.all([
    fs.readFile(httpServerPath, "utf8"),
    fs.readFile(promptInjectorPath, "utf8"),
  ]);

  assert.match(
    httpServerSource,
    /export function buildControllerIntakeSystemPrompt/,
    "controller HTTP server should expose a dedicated intake prompt builder",
  );
  assert.match(
    httpServerSource,
    /extraSystemPrompt:\s*buildControllerIntakeSystemPrompt\(deps\)/,
    "controller intake should pass the TeamClaw controller system prompt into subagent.run",
  );
  assert.match(
    promptInjectorSource,
    /## TeamClaw Controller Mode/,
    "controller prompt injector should still define TeamClaw controller mode instructions",
  );
  assert.doesNotMatch(
    promptInjectorSource,
    /if\s*\(!state\)\s*return\s+null\s*;/,
    "controller prompt injector should not drop all instructions when team state is temporarily unavailable",
  );

  console.log("Controller intake prompt smoke passed.");
}

await runControllerIntakePromptSmoke();
