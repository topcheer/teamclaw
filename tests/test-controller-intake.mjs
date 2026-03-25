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
const orchestrationManifestPath = path.join(projectRoot, "src", "src", "controller", "orchestration-manifest.ts");
const workerProvisioningPath = path.join(projectRoot, "src", "src", "controller", "worker-provisioning.ts");

async function runControllerIntakePromptSmoke() {
  const [httpServerSource, promptInjectorSource, controllerToolsSource, controllerCapacitySource, orchestrationManifestSource, workerProvisioningSource] = await Promise.all([
    fs.readFile(httpServerPath, "utf8"),
    fs.readFile(promptInjectorPath, "utf8"),
    fs.readFile(controllerToolsPath, "utf8"),
    fs.readFile(controllerCapacityPath, "utf8"),
    fs.readFile(orchestrationManifestPath, "utf8"),
    fs.readFile(workerProvisioningPath, "utf8"),
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
    /## Structured Orchestration Contract/,
    "controller prompt injector should require a structured orchestration contract for intake runs",
  );
  assert.match(
    promptInjectorSource,
    /teamclaw_submit_manifest/,
    "controller prompt injector should explicitly require the manifest submission tool",
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
    controllerToolsSource,
    /name:\s*"teamclaw_submit_manifest"/,
    "controller tools should expose a structured manifest submission tool",
  );
  assert.match(
    controllerToolsSource,
    /\/api\/v1\/controller\/manifest/,
    "controller manifest tool should post to the dedicated controller manifest endpoint",
  );
  assert.match(
    controllerToolsSource,
    /controllerSessionKey:\s*normalizedSessionKey\s*\|\|\s*undefined/,
    "controller task creation should forward the active controller session key so new tasks stay linked to the workflow immediately",
  );
  assert.match(
    controllerToolsSource,
    /const overlapBlocker = detectActiveTaskOverlap\(title,\s*description,\s*state\)/,
    "controller task creation should reject new remediation work that overlaps with active TeamClaw tasks before posting another conflicting task",
  );
  assert.match(
    controllerToolsSource,
    /function detectActiveTaskOverlap\(title: string,\s*description: string,\s*state: TeamState \| null\)/,
    "controller tools should expose a dedicated overlap detector so repo-wide remediation tasks do not collide with active service work",
  );
  assert.match(
    controllerToolsSource,
    /REPO_WIDE_CODE_CHANGE_RE|ACTIVE_TASK_STATUSES|extractServiceNames/,
    "controller overlap detection should distinguish repo-wide code edits from low-conflict tasks like pure document updates",
  );
  assert.match(
    controllerToolsSource,
    /overlaps with active TeamClaw work on|repo-wide code changes/,
    "controller overlap detection should surface a clear reason when another active task already owns the same service scope",
  );
  assert.match(
    controllerToolsSource,
    /function detectLaterPhasePhrase\(text: string\)/,
    "controller task creation should detect later-phase wording with a dedicated helper instead of treating every completion phrase as a blocker",
  );
  assert.match(
    controllerToolsSource,
    /const dependencyClause = chineseMatch\[1\] \?\? "";/,
    "controller readiness guard should inspect only the clause before 完成后\/就绪后 so internal completion handlers do not look like upstream prerequisites",
  );
  assert.match(
    controllerToolsSource,
    /待\.\*完成\|等待\.\*完成\/u/,
    "controller readiness guard should still block descriptions that explicitly say a task must wait for other work to finish",
  );
  assert.match(
    controllerToolsSource,
    /依赖于\|前置条件\|前置依赖\|前提条件\|前序任务\|上游任务\/u/,
    "controller readiness guard should only match explicit predecessor phrases, not domain terms like 依赖安全 in a security audit scope",
  );
  assert.doesNotMatch(
    controllerToolsSource,
    /依赖\|前置\|前提\/u/,
    "controller readiness guard should not reject any description that merely contains the substring 依赖, because security audit scopes often mention 依赖安全 or dependency scanning",
  );
  assert.doesNotMatch(
    controllerToolsSource,
    /完成后\|就绪后\|待\.\*完成\|等待\.\*完成\/u/,
    "controller readiness guard should no longer reject every 完成后 phrase, because internal completion actions like 发布事件 are execution-ready work",
  );
  assert.match(
    httpServerSource,
    /createdBy === "controller" && shouldBlockControllerWithoutWorkers\(deps\.config,\s*getTeamState\(\)\)/,
    "controller task endpoint should enforce the same no-worker guard for controller-created tasks",
  );
  assert.match(
    httpServerSource,
    /const controllerSessionKey = createdBy === "controller"[\s\S]*normalizeControllerIntakeSessionKey\(body\.controllerSessionKey\)/,
    "controller task endpoint should persist the normalized controller session key for controller-owned tasks",
  );
  assert.match(
    httpServerSource,
    /POST \/api\/v1\/controller\/manifest/,
    "controller HTTP server should expose a controller manifest endpoint",
  );
  assert.match(
    httpServerSource,
    /buildControllerManifestReply/,
    "controller HTTP server should synthesize final replies from the structured manifest",
  );
  assert.match(
    httpServerSource,
    /CONTROLLER_INTAKE_AGENT_SESSION_RE/,
    "controller HTTP server should normalize OpenClaw runtime session keys back to the TeamClaw controller session key format",
  );
  assert.match(
    httpServerSource,
    /const controllerIntakeQueue = new Map<string, Promise<void>>\(\);/,
    "controller HTTP server should keep a per-session intake queue so overlapping follow-up runs do not execute concurrently on the same controller session",
  );
  assert.match(
    httpServerSource,
    /return withSerializedControllerIntake\(normalizedSessionKey,\s*\(\)\s*=>\s*runControllerIntakeUnlocked\(/,
    "controller intake should serialize same-session follow-up runs before starting a new subagent execution",
  );
  assert.match(
    httpServerSource,
    /phase:\s*"model_rate_limit_waiting"/,
    "controller intake should emit a structured waiting event when upstream model rate limits stall orchestration",
  );
  assert.match(
    httpServerSource,
    /phase:\s*"model_rate_limit_probe"/,
    "controller intake should emit a probe event before re-checking a controller workflow that has been rate-limited for several minutes",
  );
  assert.match(
    httpServerSource,
    /phase:\s*"model_rate_limit_still_waiting"/,
    "controller intake should suppress duplicate 429 chatter by emitting a still-waiting event instead of repeating the first waiting message forever",
  );
  assert.match(
    httpServerSource,
    /buildControllerRateLimitProbeMessage\(/,
    "controller intake should ask the same workflow session whether a rate-limited orchestration step has already completed",
  );
  assert.match(
    httpServerSource,
    /CONTROLLER_RUN_WAIT_SLICE_MS/,
    "controller intake should poll long-running runs in slices so rate-limit errors can be observed without failing the whole workflow immediately",
  );
  assert.match(
    httpServerSource,
    /const deadline = Date\.now\(\) \+ deps\.config\.taskTimeoutMs/,
    "controller intake should still honor the configured TeamClaw task timeout even when it polls the run in shorter slices",
  );
  assert.match(
    httpServerSource,
    /findLatestControllerRunIdForSession\(sessionKey,\s*deps\.getTeamState\(\),\s*\{\s*preferActive:\s*true/,
    "controller manifest recording should prefer the currently active run for the session",
  );
  assert.match(
    httpServerSource,
    /manifest_backfilled/,
    "controller HTTP server should backfill a minimal manifest when the model misses the required manifest tool call",
  );
  assert.match(
    httpServerSource,
    /function reconcileControllerManifestTaskBindings\(/,
    "controller intake should reconcile manifest execution-ready tasks back onto real TeamClaw tasks so reused tasks stay linked to the workflow",
  );
  assert.match(
    httpServerSource,
    /const reconciledTasks = reconcileControllerManifestTaskBindings\(sessionKey,\s*createdTaskIds,\s*recordedManifest,\s*deps\)/,
    "controller intake should bind manifest-declared tasks to the current session before finalizing the run",
  );
  assert.match(
    httpServerSource,
    /function resolveControllerWorkflowSessionKey\(/,
    "controller result handling should be able to recover the workflow session from controller run metadata when a task is missing its direct session link",
  );
  assert.match(
    httpServerSource,
    /if \(!error && updatedTask\.createdBy === "controller"\) \{/,
    "controller result handling should attempt workflow continuation for controller tasks even when the direct session link must be recovered lazily",
  );
  assert.match(
    promptInjectorSource,
    /including a deliberately reused existing TeamClaw task/i,
    "controller prompt should allow createdTasks to include a deliberately reused execution-ready task so the workflow can bind it without duplication",
  );
  assert.match(
    orchestrationManifestSource,
    /export function normalizeControllerManifest/,
    "controller manifest helper should normalize and validate manifest payloads",
  );
  assert.match(
    controllerCapacitySource,
    /workerProvisioningType !== "none"/,
    "controller capacity guard should still allow the on-demand provisioning path",
  );
  assert.match(
    workerProvisioningSource,
    /allowing role .*pending task demand exists outside configured workerProvisioningRoles/,
    "worker provisioning should log when a task requires launching a role outside the configured preferred role list",
  );
  assert.match(
    workerProvisioningSource,
    /for \(const task of Object\.values\(state\.tasks\)\)[\s\S]*roleIds\.add\(taskRole\)/,
    "worker provisioning should union pending task demand roles into the provisionable role set",
  );
  assert.match(
    workerProvisioningSource,
    /delete config\.channels;/,
    "provisioned worker configs should strip controller channel definitions so worker runtimes do not fail validation on missing channel plugins",
  );
  assert.match(
    workerProvisioningSource,
    /controllerConfig\.workerProvisioningType === "docker" \|\| controllerConfig\.workerProvisioningType === "kubernetes"[\s\S]*delete plugins\.load;/,
    "containerized provisioned workers should drop controller-side plugins.load paths so bundled TeamClaw plugins are resolved inside the image instead of via host-only extension paths",
  );
  assert.match(
    workerProvisioningSource,
    /await prepareProcessRuntimeExtensions\(stateDir\);/,
    "process-provisioned workers should inherit controller plugin visibility before booting a fresh runtime home",
  );
  assert.match(
    workerProvisioningSource,
    /path\.join\(path\.dirname\(resolveDefaultOpenClawConfigPath\(\)\), "extensions"\)/,
    "process-provisioned workers should mirror the controller extensions directory into the child runtime",
  );
  assert.match(
    workerProvisioningSource,
    /appendNoProxyEntries\(env,\s*controllerUrl\)/,
    "provisioned workers should explicitly append controller loopback hosts to NO_PROXY so subagent-time proxy bootstrap does not break controller callbacks",
  );
  assert.match(
    workerProvisioningSource,
    /requiresDedicatedHostPortsForProvisioner\(\s*this\.backend\.type,\s*this\.deps\.config,\s*\)/,
    "worker provisioning should decide port allocation from provider semantics instead of assuming every container has isolated networking",
  );
  assert.match(
    workerProvisioningSource,
    /provider === "docker" && isDockerHostNetwork\(config\.workerProvisioningDockerNetwork\)/,
    "docker workers on host networking should reserve dedicated worker and gateway ports instead of reusing container defaults that collide on the host",
  );
  assert.match(
    workerProvisioningSource,
    /const DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR = "\/app\/extensions\/teamclaw";/,
    "docker provisioning should define a stable bundled TeamClaw plugin path inside managed worker containers",
  );
  assert.match(
    workerProvisioningSource,
    /`\$\{resolveCurrentTeamClawPluginRootDir\(\)\}:\$\{DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR\}:ro`/,
    "docker provisioning should bind the current TeamClaw plugin into the container bundled-plugin path so managed workers run the same plugin code as the controller host",
  );
  assert.match(
    workerProvisioningSource,
    /extractDockerBindTarget\(bind\) === DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR/,
    "docker provisioning should avoid duplicating the TeamClaw plugin bind when the operator already overrides the bundled plugin path explicitly",
  );
  assert.match(
    workerProvisioningSource,
    /localhost", "127\.0\.0\.1", "::1", "\[::1\]"/,
    "worker provisioning should seed NO_PROXY with exact localhost entries instead of relying on CIDR-only proxy bypass rules",
  );
  assert.match(
    workerProvisioningSource,
    /process\.env\.DOCKER_API_VERSION/,
    "docker provisioning should allow operators to override the Docker API version instead of hardcoding an outdated daemon path",
  );
  assert.match(
    workerProvisioningSource,
    /const finalPath = DOCKER_API_VERSION \? `\/\$\{DOCKER_API_VERSION\}\$\{requestPath\}` : requestPath;/,
    "docker provisioning should fall back to unversioned Docker API paths so the daemon can negotiate a supported version by default",
  );
  assert.doesNotMatch(
    workerProvisioningSource,
    /const DOCKER_API_VERSION = "v1\.41";/,
    "docker provisioning should not pin the Docker API to v1.41 because newer daemons may reject that legacy client version",
  );
  assert.match(
    httpServerSource,
    /if \(previousWorker\.status !== "offline"\) \{\s*previousWorker\.status = "idle";\s*\}/,
    "controller handoff should not revive offline workers back to idle when re-routing a task",
  );
  assert.match(
    httpServerSource,
    /task .* failed; retiring managed worker before retry|onWorkerRemoved\(\s*updatedTask\.assignedWorkerId,\s*`task \$\{taskId\} failed; retiring managed worker before retry`/,
    "controller should retire a managed worker after task failure so retries do not reuse a dirty ephemeral workspace",
  );
  assert.match(
    httpServerSource,
    /if \(assignedWorker\.status !== "offline"\) \{\s*assignedWorker\.status = "idle";\s*\}/,
    "controller lifecycle transitions should avoid resurrecting offline workers during result or clarification cleanup",
  );
  assert.match(
    httpServerSource,
    /const avoidPreviousManagedWorker = Boolean\(/,
    "controller handoff should detect when the previous assignee was a managed worker so retries can avoid immediately reusing it",
  );
  assert.match(
    httpServerSource,
    /scheduleProvisioningReconcile\(deps,\s*`handoff:\$\{taskId\}`\)/,
    "controller handoff should trigger provisioning reconcile when a fresh worker is needed for the retried task",
  );
  assert.match(
    httpServerSource,
    /executionSessionKey: `teamclaw-task-\$\{taskId\}-\$\{attemptId\}`|executionSessionKey: `teamclaw-task-\$\{task\.id\}-\$\{attemptId\}`/,
    "controller dispatch should generate a fresh execution session key for each task assignment attempt",
  );
  assert.match(
    httpServerSource,
    /executionIdempotencyKey: `teamclaw-\$\{taskId\}-\$\{workerId\}-\$\{attemptId\}`/,
    "controller dispatch should generate a fresh execution idempotency key for each task assignment attempt",
  );
  assert.match(
    httpServerSource,
    /function resetTaskForFreshAttempt\(task: TaskInfo\)/,
    "controller HTTP server should reset terminal task state before a fresh assignment attempt",
  );
  assert.match(
    httpServerSource,
    /resetTaskForFreshAttempt\(task\);/,
    "controller retry paths should clear stale execution state before reassigning or resuming a task",
  );

  console.log("Controller intake prompt smoke passed.");
}

await runControllerIntakePromptSmoke();
