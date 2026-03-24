#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const httpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const promptInjectorPath = path.join(projectRoot, "src", "src", "controller", "prompt-injector.ts");
const controllerToolsPath = path.join(projectRoot, "src", "src", "controller", "controller-tools.ts");
const controllerCapacityPath = path.join(projectRoot, "src", "src", "controller", "controller-capacity.ts");

async function runControllerIntakePromptSmoke() {
  const [httpServerSource, promptInjectorSource, controllerToolsSource, controllerCapacitySource] = await Promise.all([
    fs.readFile(httpServerPath, "utf8"),
    fs.readFile(promptInjectorPath, "utf8"),
    fs.readFile(controllerToolsPath, "utf8"),
    fs.readFile(controllerCapacityPath, "utf8"),
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
  assert.match(
    promptInjectorSource,
    /## Controller Workflow/,
    "controller prompt injector should explicitly describe the role-selection and orchestration workflow",
  );
  assert.match(
    promptInjectorSource,
    /You are never a substitute worker\./,
    "controller prompt injector should explicitly forbid the controller from doing specialist worker work itself",
  );
  assert.match(
    promptInjectorSource,
    /you may analyze the requirement and identify the needed roles, but do not create TeamClaw tasks yet/i,
    "controller prompt injector should block controller-created tasks when there are no workers and no on-demand provisioning",
  );
  assert.doesNotMatch(
    promptInjectorSource,
    /if\s*\(!state\)\s*return\s+null\s*;/,
    "controller prompt injector should not drop all instructions when team state is temporarily unavailable",
  );
  assert.match(
    controllerToolsSource,
    /shouldBlockControllerWithoutWorkers\(config,\s*state\)/,
    "controller task-creation tool should guard against controller-created tasks when there are no workers and no on-demand provisioning",
  );
  assert.match(
    httpServerSource,
    /createdBy === "controller" && shouldBlockControllerWithoutWorkers\(deps\.config,\s*getTeamState\(\)\)/,
    "controller task endpoint should enforce the same no-worker guard for controller-created tasks",
  );
  assert.match(
    controllerCapacitySource,
    /workerProvisioningType !== "none"/,
    "controller capacity guard should still allow the on-demand provisioning path",
  );

  console.log("Controller intake prompt smoke passed.");
}

await runControllerIntakePromptSmoke();
