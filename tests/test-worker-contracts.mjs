#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const workerToolsPath = path.join(projectRoot, "src", "src", "worker", "tools.ts");
const workerPromptPath = path.join(projectRoot, "src", "src", "worker", "prompt-injector.ts");
const taskExecutorPath = path.join(projectRoot, "src", "src", "task-executor.ts");
const controllerHttpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const controllerToolsPath = path.join(projectRoot, "src", "src", "controller", "controller-tools.ts");
const interactionContractsPath = path.join(projectRoot, "src", "src", "interaction-contracts.ts");
const typesPath = path.join(projectRoot, "src", "src", "types.ts");

async function runWorkerContractSmoke() {
  const [
    workerToolsSource,
    workerPromptSource,
    taskExecutorSource,
    controllerHttpServerSource,
    controllerToolsSource,
    interactionContractsSource,
    typesSource,
  ] = await Promise.all([
    fs.readFile(workerToolsPath, "utf8"),
    fs.readFile(workerPromptPath, "utf8"),
    fs.readFile(taskExecutorPath, "utf8"),
    fs.readFile(controllerHttpServerPath, "utf8"),
    fs.readFile(controllerToolsPath, "utf8"),
    fs.readFile(interactionContractsPath, "utf8"),
    fs.readFile(typesPath, "utf8"),
  ]);

  assert.match(
    workerToolsSource,
    /name:\s*"teamclaw_submit_result_contract"/,
    "worker tools should expose an explicit structured result contract tool",
  );
  assert.match(
    workerToolsSource,
    /\/api\/v1\/tasks\/\$\{taskId\}\/result-contract/,
    "worker result contract tool should post to the dedicated task result contract endpoint",
  );
  assert.match(
    workerToolsSource,
    /progressContract/,
    "worker progress reporting should send a structured progress contract",
  );
  assert.match(
    workerToolsSource,
    /ensureTeamMessageContract/,
    "worker messaging tools should attach structured message contracts",
  );
  assert.match(
    workerToolsSource,
    /normalizeTaskHandoffContract/,
    "worker handoff tool should build a structured handoff contract",
  );
  assert.match(
    workerPromptSource,
    /submit structured collaboration contracts/i,
    "worker system prompt should require structured collaboration contracts",
  );
  assert.match(
    taskExecutorSource,
    /teamclaw_submit_result_contract/,
    "worker task executor instructions should require a structured result contract before the final reply",
  );
  assert.match(
    controllerToolsSource,
    /ensureTeamMessageContract/,
    "controller messaging tool should also use the shared message contract helper",
  );
  assert.match(
    controllerHttpServerSource,
    /POST \/api\/v1\/tasks\/:id\/result-contract|POST \/api\/v1\/tasks\/\[\^\/\]\+\/result-contract/,
    "controller HTTP server should expose a task result contract endpoint",
  );
  assert.match(
    controllerHttpServerSource,
    /ensureTaskResultContract/,
    "controller HTTP server should backfill a result contract when the worker misses the explicit contract tool",
  );
  assert.match(
    controllerHttpServerSource,
    /task\.resultContract = contract/,
    "controller HTTP server should persist structured task result contracts on tasks",
  );
  assert.match(
    controllerHttpServerSource,
    /task\.progressContract = progressContract/,
    "controller HTTP server should persist structured progress contracts on tasks",
  );
  assert.match(
    controllerHttpServerSource,
    /lastHandoff = handoffContract/,
    "controller HTTP server should persist structured handoff contracts on tasks",
  );
  assert.match(
    controllerHttpServerSource,
    /contract:\s*ensureTeamMessageContract/,
    "controller HTTP server should normalize message contracts for routed team messages",
  );
  assert.match(
    interactionContractsSource,
    /export function normalizeWorkerTaskResultContract/,
    "interaction contract helpers should normalize worker result contracts",
  );
  assert.match(
    interactionContractsSource,
    /export function ensureTeamMessageContract/,
    "interaction contract helpers should normalize or backfill message contracts",
  );
  assert.match(
    typesSource,
    /resultContract\?: WorkerTaskResultContract;/,
    "task type should store the structured worker result contract",
  );
  assert.match(
    typesSource,
    /progressContract\?: WorkerProgressContract;/,
    "task type should store the structured progress contract",
  );
  assert.match(
    typesSource,
    /lastHandoff\?: TaskHandoffContract;/,
    "task type should store the structured handoff contract",
  );
  assert.match(
    typesSource,
    /contract\?: TeamMessageContract;/,
    "team messages should store their structured message contract",
  );

  console.log("Worker contract smoke passed.");
}

await runWorkerContractSmoke();
