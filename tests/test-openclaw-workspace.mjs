#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const workspaceSourcePath = path.join(projectRoot, "src", "src", "openclaw-workspace.ts");
const workerProvisioningPath = path.join(projectRoot, "src", "src", "controller", "worker-provisioning.ts");
const controllerHttpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const taskExecutorPath = path.join(projectRoot, "src", "src", "task-executor.ts");
const networkingPath = path.join(projectRoot, "src", "src", "networking.ts");
const webUiPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const desktopRendererPath = path.join(projectRoot, "desktop", "renderer", "app.js");
const desktopIndexPath = path.join(projectRoot, "desktop", "renderer", "index.html");
const desktopStylePath = path.join(projectRoot, "desktop", "renderer", "style.css");
const desktopMainPath = path.join(projectRoot, "desktop", "main.mjs");
const desktopPreloadPath = path.join(projectRoot, "desktop", "preload.mjs");
const pluginEntryPath = path.join(projectRoot, "src", "index.ts");
const openClawWorkspacePath = path.join(projectRoot, "src", "src", "openclaw-workspace.ts");
const workerToolsPath = path.join(projectRoot, "src", "src", "worker", "tools.ts");
const statePath = path.join(projectRoot, "src", "src", "state.ts");
const configPath = path.join(projectRoot, "src", "src", "config.ts");
const promptPolicyPath = path.join(projectRoot, "src", "src", "prompt-policy.ts");

const [
  workspaceSource,
  workerProvisioningSource,
  controllerHttpServerSource,
  taskExecutorSource,
  networkingSource,
  webUiSource,
  desktopRendererSource,
  desktopIndexSource,
  desktopStyleSource,
  desktopMainSource,
  desktopPreloadSource,
  pluginEntrySource,
  openClawWorkspaceSource,
  workerToolsSource,
  stateSource,
  configSource,
  promptPolicySource,
] = await Promise.all([
  fs.readFile(workspaceSourcePath, "utf8"),
  fs.readFile(workerProvisioningPath, "utf8"),
  fs.readFile(controllerHttpServerPath, "utf8"),
  fs.readFile(taskExecutorPath, "utf8"),
  fs.readFile(networkingPath, "utf8"),
  fs.readFile(webUiPath, "utf8"),
  fs.readFile(desktopRendererPath, "utf8"),
  fs.readFile(desktopIndexPath, "utf8"),
  fs.readFile(desktopStylePath, "utf8"),
  fs.readFile(desktopMainPath, "utf8"),
  fs.readFile(desktopPreloadPath, "utf8"),
  fs.readFile(pluginEntryPath, "utf8"),
  fs.readFile(openClawWorkspacePath, "utf8"),
  fs.readFile(workerToolsPath, "utf8"),
  fs.readFile(statePath, "utf8"),
  fs.readFile(configPath, "utf8"),
  fs.readFile(promptPolicyPath, "utf8"),
]);

assert.match(
  workspaceSource,
  /function resolveExplicitTeamClawWorkspaceDir\([\s\S]*env\.TEAMCLAW_WORKSPACE_DIR\?\.trim\(\)/,
  "openclaw-workspace should expose a TEAMCLAW_WORKSPACE_DIR override helper",
);

assert.match(
  workspaceSource,
  /const explicitWorkspaceDir = resolveExplicitTeamClawWorkspaceDir\(env,\s*homedir\);\s*if \(explicitWorkspaceDir\) \{\s*return explicitWorkspaceDir;\s*\}/,
  "TeamClaw workspace resolution should honor TEAMCLAW_WORKSPACE_DIR before isolation-mode fallbacks",
);

assert.match(
  workspaceSource,
  /export function getTeamClawModelReadiness\([\s\S]*resolveConfiguredTeamClawModelValue[\s\S]*auth-profiles\.json/,
  "openclaw-workspace should expose TeamClaw model/auth readiness inspection",
);

assert.match(
  workspaceSource,
  /await ensureTeamClawAgentConfigBootstrap\(logger\);/,
  "startup bootstrap should self-heal the dedicated TeamClaw agent config before auth bootstrap runs",
);

assert.match(
  workspaceSource,
  /async function ensureTeamClawAgentConfigBootstrap\(logger: PluginLogger\)[\s\S]*agents\.list = nextList;[\s\S]*TeamClaw: bootstrapped dedicated agent config into/,
  "openclaw-workspace should rewrite openclaw.json with a dedicated teamclaw agent entry during startup self-heal",
);

assert.match(
  workerProvisioningSource,
  /agentDefaults\.workspace = spec\.workspaceDir;/,
  "provisioned worker config should still write the shared workspace path into agents.defaults.workspace",
);

assert.match(
  workerProvisioningSource,
  /TEAMCLAW_WORKSPACE_DIR: spec\.workspaceDir/,
  "provisioned workers should forward the shared workspace path into TEAMCLAW_WORKSPACE_DIR",
);

assert.match(
  workerProvisioningSource,
  /env:\s*\{[\s\S]*TEAMCLAW_LAUNCH_TOKEN: spec\.launchToken,\s*\.\.\.\(spec\.workspaceDir \? \{ TEAMCLAW_WORKSPACE_DIR: spec\.workspaceDir \} : \{\}\),[\s\S]*\},\s*stdio:/,
  "process-provisioned workers should export TEAMCLAW_WORKSPACE_DIR into the spawned worker environment",
);

assert.match(
  taskExecutorSource,
  /const workspaceDir = resolveTeamClawWorkspaceDir\(\);/,
  "task executor should resolve the TeamClaw shared workspace before launching subagents",
);

assert.match(
  taskExecutorSource,
  /const enrichedOptions: Parameters<typeof runtime\.subagent\.run>\[0\] & \{ workspaceDir\?: string \} = \{\s*\.\.\.options,\s*workspaceDir,/,
  "task executor should inject workspaceDir into subagent run options",
);

assert.match(
  taskExecutorSource,
  /runtime\.subagent\.run\(buildSubagentRunOptions\(\{/,
  "task executor should pass the shared workspace override into subagent runs",
);

assert.match(
  controllerHttpServerSource,
  /const modelReadiness = getTeamClawModelReadiness\(\);[\s\S]*modelReadiness,/,
  "controller APIs should expose TeamClaw model readiness in status and health responses",
);

assert.match(
  controllerHttpServerSource,
  /const externalWorkerInstall = buildExternalWorkerInstallInfo\(req,\s*config\);[\s\S]*externalWorkerInstall,/,
  "controller status API should expose copyable external worker install metadata",
);

assert.match(
  networkingSource,
  /function probeDefaultRouteInterface\(\): string[\s\S]*route", args: \["-n", "get", "default"\][\s\S]*ip", args: \["route", "show", "default"\]/,
  "networking helper should probe the default-route interface instead of choosing an arbitrary private IP",
);

assert.match(
  networkingSource,
  /export function resolvePreferredLanAddress\(\): string \| null[\s\S]*const defaultRouteInterface = probeDefaultRouteInterface\(\);[\s\S]*interfaces\[defaultRouteInterface\]/,
  "preferred LAN address resolution should prioritize the IPv4 address on the default-route interface",
);

assert.match(
  webUiSource,
  /function renderRuntimeAlert\([\s\S]*modelReadiness[\s\S]*(?:TeamClaw is installed but cannot work yet\.|runtime\.title)/,
  "controller web UI should render a prominent runtime alert when TeamClaw has no usable model/auth",
);

assert.match(
  webUiSource,
  /function renderExternalWorkerInstallCard\([\s\S]*Register a new external worker[\s\S]*Copy command/,
  "controller web UI should render a copyable external worker install command card",
);

assert.match(
  webUiSource,
  /function renderExternalWorkerInstallToggle\([\s\S]*externalWorkerInstallVisible[\s\S]*Add worker/,
  "controller web UI should expose the external worker install card behind a header toggle instead of always showing it",
);

assert.match(
  desktopRendererSource,
  /function renderRuntimeAlert\([\s\S]*modelReadiness[\s\S]*(?:TeamClaw is installed but cannot work yet\.|runtime\.title)/,
  "desktop renderer should render a prominent runtime alert when TeamClaw has no usable model/auth",
);

assert.match(
  desktopRendererSource,
  /function renderExternalWorkerInstallCard\([\s\S]*Register a new external worker[\s\S]*Copy command/,
  "desktop renderer should render a copyable external worker install command card",
);

assert.match(
  desktopRendererSource,
  /function renderExternalWorkerInstallToggle\([\s\S]*externalWorkerInstallVisible[\s\S]*Add worker/,
  "desktop renderer should expose the external worker install card behind a header toggle instead of always showing it",
);

assert.match(
  desktopRendererSource,
  /function renderUnavailableScreen\([\s\S]*#bootstrap-install-command[\s\S]*bootstrap\.connectRemote/,
  "desktop renderer should render a full-screen bootstrap experience when the local controller is unavailable",
);

assert.match(
  desktopRendererSource,
  /bootstrap-openclaw-quickstart-card[\s\S]*bootstrap-openclaw-components-card[\s\S]*classList\.toggle\("hidden", hasOpenClaw\)/,
  "desktop renderer should hide OpenClaw install and quickstart cards once OpenClaw is already installed",
);

assert.match(
  desktopRendererSource,
  /async function connectSavedController\([\s\S]*state\.localSetupInfo = await desktop\.getLocalSetupInfo\(\)[\s\S]*state\.unavailableScreenVisible = true/,
  "desktop renderer should refresh OpenClaw setup detection before showing the unavailable screen",
);

assert.match(
  desktopRendererSource,
  /function activateView\(view\)[\s\S]*function renderPlanning\(\)[\s\S]*function renderTasks\([\s\S]*async function renderTaskDetail\(taskId\)[\s\S]*function renderWorkspaceTree\(\)[\s\S]*async function loadWorkspaceFile\(relativePath\)/,
  "desktop renderer should keep core mission, planning, task, and workspace render functions defined",
);

assert.match(
  desktopRendererSource,
  /renderPlanningFact\(t\("planning\.complexity"\)[\s\S]*renderPlanningAssessments\(assessments\)[\s\S]*renderPlanningCreatedTasks\(createdTasks\)[\s\S]*renderPlanningDeferredTasks\(deferredTasks\)[\s\S]*renderPlanningQuestionList\(clarificationQuestions\)/,
  "desktop planning detail should keep the richer desktop summary, assessments, and task sections instead of collapsing to a minimal fallback",
);

assert.match(
  desktopRendererSource,
  /planning-run-card[\s\S]*groupTasksByProject\(tasks\)[\s\S]*task-list-item/,
  "desktop planning and task lists should keep the desktop card classes and grouped task structure instead of flattening into generic list items",
);

assert.match(
  desktopRendererSource,
  /function planningGroupKeyForRun\(run\)[\s\S]*data-planning-group-toggle[\s\S]*state\.planningGroupCollapsed\[groupKey\] = !state\.planningGroupCollapsed\[groupKey\];/,
  "desktop planning groups should compute group keys and wire clickable collapse toggles instead of rendering static headers",
);

assert.match(
  desktopRendererSource,
  /class="tree-row\$\{selected\} \$\{selected \? "active" : ""\}"[\s\S]*<div class="preview-shell">[\s\S]*<div class="file-shell">/,
  "desktop workspace renderer should keep tree selection styling and wrap preview/source content in the desktop shells",
);

assert.match(
  desktopStyleSource,
  /\.tree-row\s*\{[\s\S]*width:\s*100%;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;[\s\S]*appearance:\s*none;/,
  "desktop workspace tree rows should reset native button chrome so the file tree does not render as outlined pills",
);

assert.match(
  desktopStyleSource,
  /\.btn\.btn-primary:disabled\s*\{[\s\S]*opacity:\s*1;[\s\S]*background:\s*#e8f0ff;[\s\S]*color:\s*#6b7280;/,
  "desktop primary buttons should keep readable disabled contrast instead of relying on low-opacity blue treatment",
);

assert.match(
  desktopStyleSource,
  /\.planning-group-toggle\s*\{[\s\S]*width:\s*100%;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;[\s\S]*appearance:\s*none;[\s\S]*\.planning-group-items\.is-collapsed\s*\{[\s\S]*display:\s*none;/,
  "desktop planning groups should use a styled full-width toggle and actually hide collapsed sections",
);

assert.match(
  desktopStyleSource,
  /#bootstrap-install-btn\s*\{[\s\S]*background:\s*#2563eb;[\s\S]*color:\s*#fff;[\s\S]*#bootstrap-install-btn:hover\s*\{[\s\S]*background:\s*#1d4ed8;[\s\S]*#bootstrap-install-btn:disabled\s*\{[\s\S]*color:\s*#475569;/,
  "desktop install CTA should keep explicit normal, hover, and disabled contrast in the bootstrap overlay",
);

assert.match(
  desktopStyleSource,
  /\.list-copy\s*\{[\s\S]*min-width:\s*0;[\s\S]*\.list-meta\s*\{[\s\S]*-webkit-line-clamp:\s*2;/,
  "desktop list cards should keep the list-copy/list-meta structure that the planning and task renderers rely on for card layout",
);

assert.match(
  desktopRendererSource,
  /async function reconnectAfterLocalInstall\([\s\S]*await connectController\(reconnectUrl, \{ skipConversation: true \}\)/,
  "desktop renderer should reconnect to the local controller after a successful local TeamClaw install",
);

assert.match(
  desktopMainSource,
  /function buildLocalInstallCommand\(mode\)[\s\S]*return `npx -y @teamclaws\/teamclaw install --yes --install-mode \$\{selectedMode\}`;/,
  "desktop main process should always surface the published npx installer command for local setup",
);

  assert.doesNotMatch(
    desktopRendererSource,
    /need external workers|需要外部 workers|只启动 controller|same-process workers|同进程 workers/,
    "desktop install copy should not claim the local quickstart mode needs external or same-process workers",
  );

  assert.doesNotMatch(
    desktopIndexSource,
    /need external workers|external workers to join later|只启动 controller|same-process workers/,
    "desktop bootstrap skeleton should not flash stale controller-only or same-process copy before renderer hydration",
  );

assert.match(
  desktopMainSource,
  /ipcMain\.handle\("controller:get-setup-info"[\s\S]*ipcMain\.handle\("controller:install-local"[\s\S]*ipcMain\.handle\("openclaw:install-local"/,
  "desktop main process should expose OpenClaw detection plus one-click OpenClaw and TeamClaw install handlers",
);

assert.match(
  desktopPreloadSource,
  /getLocalSetupInfo: \(\) => ipcRenderer\.invoke\("controller:get-setup-info"\),[\s\S]*installLocalTeamClaw: \(options\) => ipcRenderer\.invoke\("controller:install-local", options\),[\s\S]*installOpenClaw: \(options\) => ipcRenderer\.invoke\("openclaw:install-local", options\)/,
  "desktop preload should expose both TeamClaw and OpenClaw setup APIs to the renderer",
);

assert.doesNotMatch(
  desktopMainSource,
  /controller:start-local|controller:status|local-controller:event|openclaw gateway run/,
  "desktop main process should not keep any local gateway-run bootstrap path",
);

assert.doesNotMatch(
  desktopPreloadSource,
  /startLocalController|getLocalControllerStatus|onLocalControllerEvent/,
  "desktop preload should not expose deprecated local gateway-run bootstrap APIs",
);

assert.match(
  openClawWorkspaceSource,
  /nextPluginConfig\.mode === "controller"[\s\S]*nextPluginConfig\.workerProvisioningType === "none"[\s\S]*nextPluginConfig\.workerProvisioningDisabled !== true[\s\S]*nextPluginConfig\.workerProvisioningType = "process";/,
  "bootstrap should migrate legacy local controller configs from ambiguous none provisioning to same-host process provisioning unless explicitly disabled",
);

assert.match(
  openClawWorkspaceSource,
  /const nextEntryExec: Record<string, unknown> = \{[\s\S]*TEAMCLAW_RECOMMENDED_EXEC_SECURITY[\s\S]*TEAMCLAW_RECOMMENDED_EXEC_ASK[\s\S]*tools:\s*\{[\s\S]*exec: nextEntryExec,/,
  "bootstrap should self-heal the dedicated TeamClaw agent exec policy so independent workers inherit non-interactive TeamClaw exec defaults",
);

assert.match(
  workerToolsSource,
  /import \{ loadWorkerIdentity \} from "\.\.\/state\.js";[\s\S]*async function resolveIdentity\(\): Promise<WorkerIdentity \| null> \{[\s\S]*return getIdentity\(\) \?\? await loadWorkerIdentity\(\);/,
  "worker tools should fall back to persisted worker identity so subagent sessions can still report progress and request clarifications after registration",
);

assert.match(
  workerToolsSource,
  /function normalizeProgressText\(params: Record<string, unknown>\)/,
  "worker tools should normalize progress text from multiple common fields before rejecting updates",
);

assert.match(
  workerToolsSource,
  /message: Type\.Optional\(Type\.String\(\{ description: "Alias for progress when the runtime sends a generic message field" \}\)\)/,
  "worker progress tool should accept a generic message alias for progress updates",
);

assert.match(
  workerToolsSource,
  /const progress = normalizeProgressText\(params\);[\s\S]*if \(!progress\) \{/,
  "worker progress tool should use normalized progress text before rejecting an update",
);

assert.match(
  workerToolsSource,
  /name: "teamclaw_request_parallel_help"[\s\S]*requestedWorkerCount[\s\S]*suggestedWorkstreams[\s\S]*fetch\(`\$\{identity\.controllerUrl\}\/api\/v1\/tasks\/\$\{taskId\}\/parallel-help`/,
  "worker tools should expose a controller-backed parallel-help request tool for scale-out",
);

assert.match(
  stateSource,
  /const writeQueues = new Map<string, Promise<void>>\(\);/,
  "state persistence should serialize writes per file to avoid concurrent state corruption",
);

assert.match(
  stateSource,
  /async function writeFileAtomically\(filePath: string, contents: string\): Promise<void> \{[\s\S]*const tmpPath = `\$\{filePath\}\.tmp-\$\{process\.pid\}-\$\{Date\.now\(\)\}`;[\s\S]*await fs\.rename\(tmpPath, filePath\);/,
  "state persistence should write via a temp file and atomic rename",
);

assert.match(
  stateSource,
  /await enqueueAtomicWrite\(filePath, `\$\{JSON\.stringify\(state, null, 2\)\}\\n`\);/,
  "team state saves should use the serialized atomic write helper",
);

assert.match(
  controllerHttpServerSource,
  /const supersedingRun = sessionRuns\.find\(\(run\) =>[\s\S]*run\.manifest\?\.createdTasks\.length[\s\S]*run\.manifest\?\.requirementFullyComplete[\s\S]*\),/,
  "controller clarification superseding should require real downstream progress instead of any completed follow-up run",
);

assert.doesNotMatch(
  controllerHttpServerSource,
  /const supersedingRun = sessionRuns\.find\(\(run\) =>[\s\S]*run\.status === "completed"/,
  "controller clarification superseding should not auto-answer just because a later controller run completed",
);

assert.match(
  controllerHttpServerSource,
  /function allowsNoChangeCompletion\(/,
  "controller completion gate should define a helper for evidence-backed no-change completions",
);

assert.match(
  controllerHttpServerSource,
  /function buildEffectiveTaskResultContract\([\s\S]*submittedContract[\s\S]*filterStaleDeliverables\([\s\S]*backfillWorkerTaskResultContract\(task, result, error\)/,
  "controller result handling should build an effective task result contract before deciding whether the task is blocked or complete",
);

assert.match(
  controllerHttpServerSource,
  /const effectiveContract = buildEffectiveTaskResultContract\(currentTask, result, error, submittedContract\);[\s\S]*if \(!error && effectiveContract\.outcome === "blocked"\)/,
  "controller should route blocked effective result contracts into clarification flow before marking the task completed",
);

assert.match(
  controllerHttpServerSource,
  /For any large-scale requirement, prefer parallel fan-out over serial mega-phases[\s\S]*create multiple developer tasks when the work can proceed concurrently/,
  "controller follow-up prompt should encourage parallel developer fan-out for large-scale requirements",
);

assert.match(
  controllerHttpServerSource,
  /function buildControllerParallelHelpMessage\([\s\S]*## Parallel Help Request[\s\S]*Suggested parallel workstreams:/,
  "controller should build a dedicated follow-up prompt when a worker requests more parallel help",
);

assert.match(
  controllerHttpServerSource,
  /POST \/api\/v1\/tasks\/:id\/parallel-help[\s\S]*recordTaskExecutionEvent\([\s\S]*parallel_help_requested[\s\S]*runControllerIntake\([\s\S]*buildControllerParallelHelpMessage\(/,
  "controller should accept worker parallel-help requests, log an execution event, and trigger a follow-up orchestration run",
);

assert.match(
  controllerHttpServerSource,
  /\.go", ".mod", ".sum"/,
  "completion gate should treat Go source and module files as meaningful project changes",
);

assert.match(
  controllerHttpServerSource,
  /function projectHasMeaningfulDeliverableEvidence\([\s\S]*deliverable\.kind !== "file" && deliverable\.kind !== "directory"[\s\S]*fs\.statSync\(fullPath\)/,
  "completion gate should accept existing file or directory deliverables under the project root as meaningful change evidence",
);

assert.match(
  controllerHttpServerSource,
  /!projectHasMeaningfulFileChanges\(gatedTask, effectiveContract\)/,
  "completion gate should evaluate meaningful project changes against the effective result contract",
);

assert.match(
  controllerHttpServerSource,
  /already fixed[\s\S]*无需改动/,
  "controller no-change completion helper should recognize both English and Chinese no-change verification signals",
);

assert.match(
  controllerHttpServerSource,
  /deliverable\.kind === "command"[\s\S]*deliverable\.kind === "note"/,
  "controller no-change completion helper should treat command or note deliverables as verification evidence",
);

assert.match(
  promptPolicySource,
  /Do not create new tasks, parallel workstreams, or extra backlog items on your own\.[\s\S]*ask the controller to expand parallel help instead of silently carrying the whole backlog alone/,
  "worker prompt policy should forbid self-created task trees while explicitly allowing controller-mediated parallel-help requests",
);

assert.match(
  promptPolicySource,
  /Do NOT create new tasks, duplicate an existing task, or start a parallel task tree\.[\s\S]*use the controller-facing parallel-help tool instead of silently continuing as one giant serial task/,
  "worker session rules should direct large same-role decomposition requests through the parallel-help tool",
);

assert.match(
  configSource,
  /workerProvisioningMaxPerRole:[\s\S]*default:\s*10,/,
  "config should raise the default same-role worker cap to 10",
);

assert.match(
  controllerHttpServerSource,
  /taskRequiresMeaningfulProjectChangeGate\(gatedTask\)[\s\S]*!projectHasMeaningfulFileChanges\(gatedTask, effectiveContract\)[\s\S]*!allowsNoChangeCompletion\(gatedTask, submittedContract, result\)/,
  "controller completion gate should only fail no-change developer tasks when they do not qualify as evidence-backed verification completions",
);

assert.match(
  pluginEntrySource,
  /resolveProjectSyncPaths\(assignment\.projectDir\)/,
  "worker hooks should resolve project sync paths for project-scoped tasks",
);

assert.match(
  pluginEntrySource,
  /phase: \"project_sync_restored\"/,
  "worker prepare hook should restore shared project files into the runtime workspace",
);

assert.match(
  pluginEntrySource,
  /phase: \"project_sync_published\"/,
  "worker publish hook should publish runtime project files back to the shared workspace",
);

assert.match(
  taskExecutorSource,
  /if \(rawResult && isApprovalRequiredResponse\(rawResult\)\) \{[\s\S]*buildApprovalBlockedContract\(rawResult\)/,
  "task executor should convert approval-required worker replies into blocked result contracts instead of treating them as successful completion",
);

assert.match(
  controllerHttpServerSource,
  /async function requestTaskClarification\([\s\S]*task\.status = "blocked";[\s\S]*clarification_requested/,
  "controller should expose a reusable clarification blocker helper for worker/runtime stalls",
);

assert.match(
  controllerHttpServerSource,
  /const effectiveContract = buildEffectiveTaskResultContract\(currentTask, result, error, submittedContract\);[\s\S]*effectiveContract\.outcome === "blocked"[\s\S]*await requestTaskClarification\(/,
  "controller should block tasks and request clarification when the effective worker result contract is blocked",
);

console.log("PASS test-openclaw-workspace");
