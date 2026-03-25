#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const workerToolsPath = path.join(projectRoot, "src", "src", "worker", "tools.ts");
const workerPromptPath = path.join(projectRoot, "src", "src", "worker", "prompt-injector.ts");
const skillInstallerPath = path.join(projectRoot, "src", "src", "worker", "skill-installer.ts");
const workerServicePath = path.join(projectRoot, "src", "src", "worker", "worker-service.ts");
const taskExecutorPath = path.join(projectRoot, "src", "src", "task-executor.ts");
const controllerHttpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const controllerToolsPath = path.join(projectRoot, "src", "src", "controller", "controller-tools.ts");
const gitCollaborationPath = path.join(projectRoot, "src", "src", "git-collaboration.ts");
const interactionContractsPath = path.join(projectRoot, "src", "src", "interaction-contracts.ts");
const typesPath = path.join(projectRoot, "src", "src", "types.ts");
const pluginEntryPath = path.join(projectRoot, "src", "index.ts");

async function runWorkerContractSmoke() {
  const [
    workerToolsSource,
    workerPromptSource,
    skillInstallerSource,
    workerServiceSource,
    taskExecutorSource,
    controllerHttpServerSource,
    controllerToolsSource,
    gitCollaborationSource,
    interactionContractsSource,
    typesSource,
    pluginEntrySource,
  ] = await Promise.all([
    fs.readFile(workerToolsPath, "utf8"),
    fs.readFile(workerPromptPath, "utf8"),
    fs.readFile(skillInstallerPath, "utf8"),
    fs.readFile(workerServicePath, "utf8"),
    fs.readFile(taskExecutorPath, "utf8"),
    fs.readFile(controllerHttpServerPath, "utf8"),
    fs.readFile(controllerToolsPath, "utf8"),
    fs.readFile(gitCollaborationPath, "utf8"),
    fs.readFile(interactionContractsPath, "utf8"),
    fs.readFile(typesPath, "utf8"),
    fs.readFile(pluginEntryPath, "utf8"),
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
    /import\s*\{[\s\S]*normalizeWorkerProgressContract[\s\S]*\}\s*from "\.\.\/interaction-contracts\.js";/,
    "worker tools should import normalizeWorkerProgressContract before using it in progress reporting",
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
    workerPromptSource,
    /Do not use sessions_yield or end your turn while background work, coding agents, or process sessions are still running/i,
    "worker system prompt should forbid background-yield completions that would close a TeamClaw task too early",
  );
  assert.match(
    skillInstallerSource,
    /ON_DEMAND_DISCOVERY_SKILLS = new Set\(\["find-skills"\]\)/,
    "worker skill installer should treat find-skills as an on-demand discovery skill instead of auto-installing it during preflight",
  );
  assert.match(
    workerServiceSource,
    /controllerUrl = identity\.controllerUrl;[\s\S]*workerId = identity\.workerId;[\s\S]*onIdentityEstablished\(identity\);[\s\S]*await startServer\(\);/,
    "worker service should publish the freshly registered identity to outer hooks before restarting its HTTP server so immediate post-register assignments do not miss the worker context",
  );
  assert.match(
    pluginEntrySource,
    /const controllerUrl = currentControllerUrl \|\| config\.controllerUrl\.trim\(\);/,
    "worker task preparation should fall back to the configured controllerUrl so repo sync does not get skipped during the post-register assignment race window",
  );
  assert.match(
    pluginEntrySource,
    /const workerId = currentWorkerId \|\| "unknown-worker";/,
    "worker repo publish should still proceed with a fallback worker identifier instead of skipping publish when the outer workerId update lags the first assignment",
  );
  assert.match(
    gitCollaborationSource,
    /TEAMCLAW_RUNTIME_EXCLUDES = \[[\s\S]*"\.clawhub\/"[\s\S]*"skills\/"[\s\S]*\]/,
    "git collaboration should ignore TeamClaw runtime skill directories like .clawhub/ and skills/ so repo sync does not fail on fresh worker workspaces",
  );
  assert.match(
    gitCollaborationSource,
    /configureGitWorkspaceExcludes\(workspaceDir\)[\s\S]*const localRepo = await readGitRepoState\(config,\s*false\)[\s\S]*if \(localRepo\.dirty\)/,
    "worker repo sync should configure workspace excludes before checking whether the worktree is dirty",
  );
  assert.match(
    taskExecutorSource,
    /teamclaw_submit_result_contract/,
    "worker task executor instructions should require a structured result contract before the final reply",
  );
  assert.match(
    taskExecutorSource,
    /model_rate_limit_waiting/,
    "worker task executor should emit a dedicated execution event when upstream model rate limiting forces TeamClaw to wait",
  );
  assert.match(
    taskExecutorSource,
    /RATE_LIMIT_STALL_PROBE_MS = 5 \* 60 \* 1000/,
    "worker task executor should probe again after five minutes of rate-limit silence",
  );
  assert.match(
    taskExecutorSource,
    /TEAMCLAW_STILL_WAITING/,
    "worker task executor should use an internal still-waiting sentinel so repeated rate-limit probe replies do not spam the UI",
  );
  assert.match(
    taskExecutorSource,
    /isInternalRetryPrompt|Continue where you left off\. the previous model attempt failed or timed out\./,
    "worker task executor should suppress OpenClaw's internal retry prompt so continuous 429 retries do not reset the waiting state and spam duplicate waiting events",
  );
  assert.match(
    taskExecutorSource,
    /collectChildSessionKeys|childSessionKey/,
    "worker task executor should watch spawned child sessions so child-run rate limits can surface in the parent task timeline",
  );
  assert.match(
    taskExecutorSource,
    /background_work_waiting|background_work_probe|background_work_still_waiting/,
    "worker task executor should keep background-yielded work in a waiting state instead of treating it as immediately completed",
  );
  assert.match(
    taskExecutorSource,
    /return turn\.backgroundPending \|\| isStillWaitingResponse\(turn\.text\);/,
    "worker task executor should keep TEAMCLAW_STILL_WAITING turns in the pending state instead of treating them as completed results",
  );
  assert.match(
    taskExecutorSource,
    /sessions_yield|running in background/,
    "worker task executor should explicitly guard against sessions_yield and background-session pseudo-completions",
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
    /executionSessionKey\?: string;/,
    "task assignment payloads should allow controller-provided execution session keys for fresh task attempts",
  );
  assert.match(
    typesSource,
    /executionIdempotencyKey\?: string;/,
    "task assignment payloads should allow controller-provided execution idempotency keys for fresh task attempts",
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
