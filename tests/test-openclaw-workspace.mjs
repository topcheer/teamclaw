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
const workerServicePath = path.join(projectRoot, "src", "src", "worker", "worker-service.ts");
const statePath = path.join(projectRoot, "src", "src", "state.ts");
const configPath = path.join(projectRoot, "src", "src", "config.ts");
const promptPolicyPath = path.join(projectRoot, "src", "src", "prompt-policy.ts");
const controllerPromptInjectorPath = path.join(projectRoot, "src", "src", "controller", "prompt-injector.ts");
const controllerToolsPath = path.join(projectRoot, "src", "src", "controller", "controller-tools.ts");
const websocketPath = path.join(projectRoot, "src", "src", "controller", "websocket.ts");
const gitCollaborationPath = path.join(projectRoot, "src", "src", "git-collaboration.ts");

const [
  workspaceSource,
  workerProvisioningSource,
  controllerHttpServerSource,
  // PR-D of issue #204: the declarative route table + the handlers that
  // were inline in http-server.ts (workspace/model-config routes, manifest
  // recording, run delete, team status) moved into controller/route-table.ts.
  controllerRouteTableSource,
  controllerPlanningSource,
  controllerRunsSource,
  projectRegistrySource,
  taskCleanupSource,
  taskResultsSource,
  taskRoutesSource,
  clarificationRoutesSource,
  controllerIntakeSource,
  taskAssignmentSource,
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
  workerServiceSource,
  stateSource,
  configSource,
  promptPolicySource,
  controllerPromptInjectorSource,
  controllerToolsSource,
  websocketSource,
  gitCollaborationSource,
] = await Promise.all([
  fs.readFile(workspaceSourcePath, "utf8"),
  fs.readFile(workerProvisioningPath, "utf8"),
  fs.readFile(controllerHttpServerPath, "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "route-table.ts"), "utf8"),
  // PR-C of issue #204: the software-requirement heuristics moved from
  // http-server.ts into controller/controller-planning.ts.
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "controller-planning.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "controller-runs.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "project-registry.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "task-cleanup.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "task-results.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "task-routes.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "clarification-routes.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "controller-intake.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "src", "controller", "task-assignment.ts"), "utf8"),
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
  fs.readFile(workerServicePath, "utf8"),
  fs.readFile(statePath, "utf8"),
  fs.readFile(configPath, "utf8"),
  fs.readFile(promptPolicyPath, "utf8"),
  fs.readFile(controllerPromptInjectorPath, "utf8"),
  fs.readFile(controllerToolsPath, "utf8"),
  fs.readFile(websocketPath, "utf8"),
  fs.readFile(gitCollaborationPath, "utf8"),
]);

const desktopAppSource = desktopRendererSource;

assert.match(
  workspaceSource,
  /export function deriveStableProjectKey\(text: string\): string \{[\s\S]*replace\(\/\[\^a-z0-9\]\+\/g, "-"\)/,
  "openclaw-workspace should expose a stable project key normalizer for registry-backed reuse",
);

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
  configSource,
  /taskTimeoutMs:[\s\S]*default: 600000/,
  "default task stall threshold should be 10 minutes so LLM inactivity probes trigger promptly",
);

assert.match(
  workerProvisioningSource,
  /teamclawConfig\.taskTimeoutMs = controllerConfig\.taskTimeoutMs/,
  "provisioned workers should inherit the controller task stall threshold for consistent probe timing",
);

assert.match(
  workerServiceSource,
  /let consecutiveHeartbeatFailures = 0;[\s\S]*if \(!res\.ok\) \{[\s\S]*consecutiveHeartbeatFailures \+= 1;[\s\S]*identityManager\.clear\(\)[\s\S]*await startServer\(\)[\s\S]*\} else \{[\s\S]*consecutiveHeartbeatFailures = 0;[\s\S]*\}[\s\S]*catch \(err\) \{[\s\S]*consecutiveHeartbeatFailures \+= 1;[\s\S]*identityManager\.clear\(\)[\s\S]*await startServer\(\)/,
  "worker heartbeat logic should force identity reset and re-registration after repeated controller heartbeat failures",
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
  /const enrichedOptions: Parameters<typeof runtime\.subagent\.run>\[0\] & \{\s*workspaceDir\?: string;\s*cwd\?: string;\s*\} = \{\s*\.\.\.options,\s*workspaceDir,\s*cwd: options\.cwd \?\? workspaceDir,/,
  "task executor should inject workspaceDir into subagent run options",
);

assert.match(
  taskExecutorSource,
  /runtime\.subagent\.run\(buildSubagentRunOptions\(\{/,
  "task executor should pass the shared workspace override into subagent runs",
);

// PR-D of issue #204: the status/health handlers moved from http-server.ts
// into controller/route-table.ts - pin the new home (bodies unchanged).
assert.match(
  controllerRouteTableSource,
  /const modelReadiness = getTeamClawModelReadiness\(\);[\s\S]*modelReadiness,/,
  "controller APIs should expose TeamClaw model readiness in status and health responses",
);

assert.match(
  controllerRouteTableSource,
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
  /function renderUnavailableScreen\([\s\S]*#bootstrap-overlay[\s\S]*unavailableScreenVisible/,
  "desktop renderer should render a full-screen bootstrap experience when the local controller is unavailable",
);

assert.match(
  desktopRendererSource,
  /data-bootstrap-install\][\s\S]*hasOpenClaw[\s\S]*isInstallingLocal = hasOpenClaw[\s\S]*isInstallingOpenClaw = !hasOpenClaw/,
  "desktop renderer should branch the install flow instead of reinstalling once OpenClaw is already installed",
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

// PR-D of issue #204: the project-path shell moved from the http-server.ts
// if chain into controller/route-table.ts - pin the route entry AND the same
// handler content (safe directory resolution + 404 miss + absolutePath echo).
assert.match(
  controllerRouteTableSource,
  /\{ method: "GET", path: "\/api\/v1\/workspace\/project-path", handler: workspaceProjectPathRoute \}/,
  "controller should expose a safe local project-path endpoint for desktop shell integrations",
);
assert.match(
  controllerRouteTableSource,
  /function workspaceProjectPathRoute\(ctx: RouteContext\): Promise<void> \{[\s\S]*resolveSafeProjectDirectory\(projectDir\)[\s\S]*absolutePath[\s\S]*sendJson\(res, 200, \{[\s\S]*absolutePath,/,
  "the project-path handler must keep the safe-directory resolution and absolutePath response shape",
);

assert.match(
  controllerPlanningSource,
  /function looksLikeSoftwareRequirement\(request: string\): boolean \{[\s\S]*stderr[\s\S]*stdout[\s\S]*日志[\s\S]*输出[\s\S]*配置[\s\S]*文件/,
  "controller should treat common code-change requests like logging, output, config, and file behavior as software requirements",
);

assert.match(
  controllerPlanningSource,
  /if \(requiredRoles\.length === 1 && requiredRoles\[0\] === "architect" && implementationLikeRequest\) \{[\s\S]*return "developer";/,
  "fallback role selection should prefer developer when a backfilled architect-only manifest actually describes implementation work",
);

assert.match(
  controllerPlanningSource,
  /const likelyTechnicalRequest = looksLikeSoftwareRequirement\(request\)[\s\S]*manifest\.requiredRoles\.length > 0[\s\S]*日志\|输出\|文件\|配置\|命令\|修复\|实现\|修改[\s\S]*if \(!likelyTechnicalRequest\) \{/,
  "fallback task creation should still trigger for simple technical requests even when the original manifest was backfilled",
);

assert.match(
  controllerPlanningSource,
  /function looksLikeManualExecutionClarification\(question: string\): boolean \{[\s\S]*git pull[\s\S]*go build[\s\S]*still crash/,
  "controller should recognize manual run/rebuild/repro clarification prompts as execution candidates",
);

assert.match(
  controllerPlanningSource,
  /async function maybeConvertControllerClarificationToExecutionTask\([\s\S]*manifest\.clarificationsNeeded = false;[\s\S]*phase: "clarification_converted_to_task"/,
  "controller should convert manual-action clarifications into execution-ready tasks instead of blocking on human input",
);

assert.match(
  controllerIntakeSource,
  /const convertedClarificationTaskIds = await maybeConvertControllerClarificationToExecutionTask\([\s\S]*syncControllerRunClarifications\(controllerRun\.id, sessionKey, recordedManifest, deps\);/,
  "controller intake should convert manual-action clarifications before syncing pending clarification state",
);

assert.match(
  promptPolicySource,
  /Never ask the human to manually run an obvious machine step such as rebuild\/retest\/repro\/verification[\s\S]*git pull[\s\S]*go build[\s\S]*TeamClaw can create an execution task and do that work itself\./,
  "controller discipline should forbid escalating obvious execution steps into human clarifications",
);

assert.match(
  taskAssignmentSource,
  /answeredClarifications: Object\.values\(state\.clarifications\)[\s\S]*clarification\.status === "answered" && clarification\.answer[\s\S]*clarification\.taskId === task\.id[\s\S]*answer: clarification\.answer \|\| ""/,
  "task context snapshot should include recent answered clarifications for resumed work",
);

assert.match(
  taskExecutorSource,
  /Recently answered clarifications \(treat these as authoritative and do not ask the same question again unless the answer is still objectively missing or invalid\):[\s\S]*A: \$\{clarification\.answer\}/,
  "task executor prompt should show answered clarification history so workers do not re-ask the same question",
);

assert.match(
  desktopMainSource,
  /ipcMain\.handle\("shell:openPath", async \(_event, targetPath\) => \{[\s\S]*shell\.openPath\(String\(targetPath \|\| ""\)\)/,
  "desktop main process should expose a shell.openPath bridge for opening local project folders",
);

assert.match(
  desktopPreloadSource,
  /openPath: \(targetPath\) => ipcRenderer\.invoke\("shell:openPath", targetPath\)/,
  "desktop preload should expose openPath to the renderer",
);

assert.match(
  desktopRendererSource,
  /function canOpenProjectInFinder\(\) \{[\s\S]*isLoopbackControllerUrl\(state\.controllerUrl\)[\s\S]*async function openProjectInFinder\(projectDir, sourceLabel\) \{[\s\S]*\/workspace\/project-path\?projectDir=\$\{encodeURIComponent\(projectDir\)\}[\s\S]*desktop\.openPath\(data\.absolutePath \|\| ""\)/,
  "desktop renderer should only offer Finder opening for local controllers and resolve the project path via the controller before opening it",
);

assert.match(
  desktopRendererSource,
  /data-open-project-finder="[\s\S]*Finder[\s\S]*target\.closest\('\[data-open-project-finder\]'\)/,
  "desktop workspace tree should render a Finder action for local project directories and wire its click handler",
);

assert.match(
  controllerIntakeSource,
  /const progressSnapshot:[\s\S]*fingerprints:[\s\S]*latestMessages:[\s\S]*const syncControllerSessionProgress = async \(\): Promise<void> => \{[\s\S]*getSessionMessages\({[\s\S]*buildSessionProgressEntries\(progressSnapshot\.latestMessages, message\)[\s\S]*recordControllerRunEvent\(controllerRun\.id, \{/,
  "controller intake should summarize LLM session messages into planning timeline progress events",
);

assert.match(
  desktopRendererSource,
  /function renderExecutionEventTitle\(event\) \{[\s\S]*event && event\.stream === "assistant"[\s\S]*event && event\.stream === "tool"[\s\S]*renderPlanningExecutionEventEntry\(event\) \{[\s\S]*renderExecutionEventTitle\(event\)/,
  "desktop planning timeline should label assistant and tool session events distinctly",
);

assert.match(
  controllerRunsSource,
  /if \(source === "task_follow_up"\) \{[\s\S]*compactSourceTitle[\s\S]*Controller follow-up after \$\{compactSourceTitle\}/,
  "controller follow-up run titles should compact the source task title instead of letting long text dominate the visible label",
);

assert.match(
  desktopRendererSource,
  /const detailTitle = selectedRun\.source === "task_follow_up"[\s\S]*selectedRun\.title \|\| manifest\.requirementSummary[\s\S]*<div class="detail-title">\$\{escapeHtml\(detailTitle\)\}<\/div>/,
  "desktop planning detail should prefer the compact follow-up run title over the full requirement summary for follow-up runs",
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
  /\.btn\.btn-primary:disabled\s*\{[\s\S]*opacity:\s*1;[\s\S]*background:\s*var\(--info-bg\);[\s\S]*color:\s*var\(--neutral-text\);/,
  "desktop primary buttons should keep readable disabled contrast instead of relying on low-opacity blue treatment",
);

assert.match(
  desktopStyleSource,
  /\.planning-group-toggle\s*\{[\s\S]*width:\s*100%;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;[\s\S]*appearance:\s*none;[\s\S]*\.planning-group-items\.is-collapsed\s*\{[\s\S]*display:\s*none;/,
  "desktop planning groups should use a styled full-width toggle and actually hide collapsed sections",
);

assert.match(
  desktopStyleSource,
  /#bootstrap-install-btn\s*\{[\s\S]*background:\s*var\(--info-text\);[\s\S]*color:\s*#fff;[\s\S]*#bootstrap-install-btn:hover\s*\{[\s\S]*background:\s*var\(--accent\);[\s\S]*#bootstrap-install-btn:disabled\s*\{[\s\S]*color:\s*var\(--neutral-text\);/,
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

assert.match(
  desktopMainSource,
  /id: "controller-manual"[\s\S]*recommended: true[\s\S]*id: "controller-process"[\s\S]*recommended: false[\s\S]*const selectedMode = LOCAL_SETUP_MODES\.some\(\(entry\) => entry\.id === mode\) \? mode : "controller-manual";/,
  "desktop main process should keep local quickstart as the default local install mode",
);

assert.match(
  desktopRendererSource,
  /localSetupMode: "controller-manual"[\s\S]*entry\.id === state\.localSetupMode\) \|\| modes\[0\][\s\S]*state\.localSetupMode = 'controller-manual';/,
  "desktop renderer should default the bootstrap selection and fallback to the first local setup mode",
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
  /ipcMain\.handle\("bootstrap:install"[\s\S]*ensureOpenClawRuntime[\s\S]*ensureTeamClawPlugin[\s\S]*ipcMain\.handle\("controller:get-setup-info"/,
  "desktop main process should expose OpenClaw detection plus one-click OpenClaw and TeamClaw install handlers",
);

assert.match(
  desktopPreloadSource,
  /getLocalSetupInfo: \(\) => ipcRenderer\.invoke\("controller:get-setup-info"\),[\s\S]*bootstrapInstall: \(options\) => ipcRenderer\.invoke\("bootstrap:install", options\),[\s\S]*bootstrap:install-event/,
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
  desktopRendererSource,
  /case "controller:run":[\s\S]*upsertControllerRunState\(data\);[\s\S]*renderMissionSummary\(\);[\s\S]*renderPlanning\(\);[\s\S]*renderChrome\(\);/,
  "desktop renderer should fully refresh mission and planning chrome when controller run websocket updates arrive",
);

assert.match(
  desktopRendererSource,
  /const getScopedField = \(selector\) => \{[\s\S]*card\.querySelector\(selector\) \|\| document\.querySelector\(selector\);[\s\S]*const textarea = getScopedField\(`\[data-clarification-answer="\$\{CSS\.escape\(id\)\}"\]`\);[\s\S]*setStatusLine\('Please provide an answer before submitting\.'\);/,
  "desktop clarification submit should read answers from the active modal card before falling back to the page list and should surface empty-answer guidance",
);

assert.match(
  desktopRendererSource,
  /function renderClarificationAnswerForm\(item, scopeKey\) \{[\s\S]*controlHtml = `<textarea data-clarification-answer="\$\{escapeHtml\(id\)\}"[\s\S]*`<div class="clarification-form" data-clarification-card="\$\{escapeHtml\(id\)\}">`/,
  "desktop clarification forms should wrap even plain-text answers in a scoped clarification card so modal submits read the active prompt inputs",
);

assert.match(
  desktopRendererSource,
  /async function apiGetOptional\(path, fallbackValue\) \{[\s\S]*response\.status === 404[\s\S]*return fallbackValue;[\s\S]*async function refreshReports\(\) \{[\s\S]*apiGetOptional\("\/reports", \{ reports: \[\] \}\)[\s\S]*Promise\.all\(\[[\s\S]*apiGetOptional\("\/reports", \{ reports: \[\] \}\)/,
  "desktop renderer should treat /reports as an optional capability instead of marking the controller unavailable on 404",
);

assert.match(
  desktopRendererSource,
  /function renderChrome\(\) \{[\s\S]*renderActivitySignals\(\);[\s\S]*renderUnavailableScreen\(\);[\s\S]*\}/,
  "desktop chrome rendering should stay lightweight and avoid rebuilding the clarification modal on every status refresh",
);

assert.match(
  desktopRendererSource,
  /function getClarificationPromptSignature\(item\)[\s\S]*state\.clarificationDrafts\[id\] = draft;[\s\S]*restoreClarificationDraft\(active\.id, content\);/,
  "desktop clarification modal should preserve active drafts across the remaining prompt rerenders that are actually needed",
);

assert.match(
  desktopRendererSource,
  /function splitMarkdownTableRow\(line\)[\s\S]*function isMarkdownTableStart\(lines, index\)[\s\S]*function renderMarkdownTable\(lines, startIndex\)[\s\S]*markdown-table-wrap/,
  "desktop renderer markdown parser should recognize and render GitHub-style pipe tables",
);

assert.match(
  desktopStyleSource,
  /\.markdown-table-wrap\s*\{[\s\S]*overflow-x:\s*auto;[\s\S]*\.markdown-body table\s*\{[\s\S]*border-collapse:\s*collapse;[\s\S]*\.markdown-body th,[\s\S]*\.markdown-body td\s*\{/,
  "desktop markdown styles should include scrollable, bordered table presentation",
);

assert.match(
  desktopStyleSource,
  /\.task-group-title\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*word-break:\s*break-word;/,
  "desktop task group titles should clamp long project names instead of expanding indefinitely",
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
  /if \(!state\.projects \|\| typeof state\.projects !== "object"\) \{[\s\S]*state\.projects = \{\};[\s\S]*state\.projects = state\.projects && typeof state\.projects === "object"/,
  "team state persistence should normalize a projects registry for stable project identity reuse",
);

assert.match(
  controllerToolsSource,
  /projectName: Type\.Optional\(Type\.String\({ description: "Stable project key to reuse or create for this task/,
  "controller create-task tool should allow passing an explicit stable project name",
);

assert.match(
  controllerPromptInjectorSource,
  /for \(const project of Object\.values\(state\.projects \?\? \{\}\)\)[\s\S]*aliases: /,
  "controller prompt injector should surface registered projects and aliases before falling back to task-derived directories",
);

assert.match(
  projectRegistrySource,
  /const GENERIC_PROJECT_FOLLOW_UP_RE =[\s\S]*function syncProjectRegistryEntry\([\s\S]*function resolveProjectIdentityForSession\(/,
  "controller http server should maintain a stable project registry and resolve project identity beyond session inheritance",
);

assert.match(
  controllerRunsSource,
  /createControllerRun\([\s\S]*resolveExistingProjectIdentityFromMessage\(message, existingState\)[\s\S]*projectId: projectId \|\| undefined,[\s\S]*syncProjectRegistryEntry\(teamState,/,
  "controller intake should register and reuse stable project identity when creating runs",
);

assert.match(
  controllerPlanningSource,
  /projectName: actualCreatedTasks\.find\(\(task\) => task\.projectId\)\?\.projectId/,
  "backfilled controller manifests should preserve the created task project identity",
);

assert.match(
  taskRoutesSource,
  /const explicitProjectName = typeof body\.projectName === "string"[\s\S]*const projectId = inheritedProject\?\.projectId \?\? \(explicitProjectName \|\| undefined\)[\s\S]*task\.projectId = project\.projectId;/,
  "controller task creation should preserve stable project identity across sessions and explicit project names",
);

assert.match(
  controllerRouteTableSource,
  /run\.manifest = manifest;[\s\S]*projectId: manifest\.projectName \?\? run\.projectId,[\s\S]*run\.projectId = project\.projectId;[\s\S]*if \(!task\.projectId\) \{\s*task\.projectId = run\.projectId;/,
  "controller manifest submission should sync canonical project identity back onto runs and created tasks",
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
  controllerIntakeSource,
  /const supersedingRun = sessionRuns\.find\(\(run\) =>[\s\S]*run\.manifest\?\.createdTasks\.length[\s\S]*run\.manifest\?\.requirementFullyComplete[\s\S]*\),/,
  "controller clarification superseding should require real downstream progress instead of any completed follow-up run",
);

assert.match(
  controllerIntakeSource,
  /const desiredQuestionKeys = new Set\([\s\S]*entries\.map\(\(entry\) => normalizeComparableText\(entry\.question\)\)[\s\S]*clarification\.status === "pending"[\s\S]*!desiredQuestionKeys\.has\(key\)[\s\S]*Automatically superseded by the latest controller clarification set\./,
  "controller clarification sync should retire stale pending questions when a newer run replaces the clarification set",
);

// PR-D of issue #204: the reconciliation moved out of http-server.ts (PR-C)
// and the dispatch moved into route-table.ts - the negative pin guards both
// homes so the pattern cannot reappear in either.
assert.doesNotMatch(
  controllerHttpServerSource + controllerRouteTableSource,
  /const supersedingRun = sessionRuns\.find\(\(run\) =>[\s\S]*run\.status === "completed"/,
  "controller clarification superseding should not auto-answer just because a later controller run completed",
);

assert.match(
  taskResultsSource,
  /function allowsNoChangeCompletion\(/,
  "controller completion gate should define a helper for evidence-backed no-change completions",
);

assert.match(
  taskResultsSource,
  /function buildEffectiveTaskResultContract\([\s\S]*submittedContract[\s\S]*filterStaleDeliverables\([\s\S]*backfillWorkerTaskResultContract\(task, result, error\)/,
  "controller result handling should build an effective task result contract before deciding whether the task is blocked or complete",
);

assert.match(
  taskRoutesSource,
  /const effectiveContract = buildEffectiveTaskResultContract\(currentTask, result, error, submittedContract(?: \?\? undefined)?\);[\s\S]*if \(!error && effectiveContract\.outcome === "blocked"\)/,
  "controller should route blocked effective result contracts into clarification flow before marking the task completed",
);

assert.match(
  controllerPlanningSource,
  /For any large-scale requirement, prefer parallel fan-out over serial mega-phases[\s\S]*create multiple developer tasks when the work can proceed concurrently/,
  "controller follow-up prompt should encourage parallel developer fan-out for large-scale requirements",
);

assert.match(
  controllerPlanningSource,
  /function buildControllerParallelHelpMessage\([\s\S]*## Parallel Help Request[\s\S]*Suggested parallel workstreams:/,
  "controller should build a dedicated follow-up prompt when a worker requests more parallel help",
);

assert.match(
  controllerPlanningSource,
  /if \(inferredRoles\.size === 0\) \{[\s\S]*inferredRoles\.add\("architect"\);[\s\S]*function isArchitectureFirstRequirement\(request: string\)[\s\S]*function chooseFallbackAssignedRole\(manifest: ControllerOrchestrationManifest, request: string\): RoleId[\s\S]*const assignedRole = chooseFallbackAssignedRole\(manifest, request\);/,
  "controller fallback intake routing should default architecture-first requirements to architect instead of blindly preferring developer",
);

assert.match(
  taskRoutesSource,
  /POST \/api\/v1\/tasks\/:id\/parallel-help[\s\S]*recordTaskExecutionEvent\([\s\S]*parallel_help_requested[\s\S]*runControllerIntake\([\s\S]*buildControllerParallelHelpMessage\(/,
  "controller should accept worker parallel-help requests, log an execution event, and trigger a follow-up orchestration run",
);

assert.match(
  taskCleanupSource,
  /async function deleteTaskCascade\([\s\S]*cancelTaskExecution\(taskId, existingTask\.assignedWorkerId, "cleanup deletion", deps\)[\s\S]*stopTaskPreviews\(taskId, "task deleted during cleanup"\)[\s\S]*delete state\.tasks\[taskId\][\s\S]*clarification\.taskId === taskId[\s\S]*message\.taskId === taskId/,
  "task cleanup should cascade through active execution, previews, clarifications, messages, and the task record itself",
);

assert.match(
  taskCleanupSource,
  /function resolveSafeProjectDirectory\([\s\S]*segment === "\.\."[\s\S]*path\.resolve\(projectsRoot, normalized\)[\s\S]*relative\.startsWith\("\.\."\)/,
  "project cleanup should reject path traversal and constrain deletions to the TeamClaw projects root",
);

assert.match(
  taskCleanupSource,
  /async function deleteProjectDirectoryIfUnused\([\s\S]*stillReferencedByTask[\s\S]*stillReferencedByRun[\s\S]*removeTrackedWorkspaceSubtree\(deps\.config, deps\.logger, safeProjectPath\)[\s\S]*fs\.promises\.rm\(safeProjectPath, \{ recursive: true, force: true \}\)[\s\S]*deletedProjectDirs\.push\(projectDir\)/,
  "project cleanup should only remove unused project directories and confirm the deletion",
);

assert.match(
  gitCollaborationSource,
  /export async function removeTrackedWorkspaceSubtree\([\s\S]*path\.relative\(workspaceDir, targetPath\)[\s\S]*relative\.startsWith\("\.\."\)[\s\S]*tryGit\(\["ls-files", "--", relative\][\s\S]*runGit\(\["rm", "-r", "--ignore-unmatch", "--", relative\]/,
  "git collaboration should remove tracked workspace files only for safe in-workspace project subtrees before filesystem cleanup",
);

assert.match(
  taskCleanupSource,
  /async function deleteProjectCascade\([\s\S]*deleteControllerRunCascade\(runId, deps\)[\s\S]*deleteTaskCascade\(taskId, deps, summary\)[\s\S]*deleteProjectDirectoryIfUnused\(projectDir, deps, summary\)[\s\S]*type: "project:deleted"/,
  "project delete should cascade through related runs and tasks before removing the project directory",
);

assert.match(
  taskRoutesSource,
  /DELETE \/api\/v1\/tasks\/:id[\s\S]*const stillExists = !!getTeamState\(\)\?\.tasks\[taskId\];[\s\S]*Task cleanup could not be confirmed/,
  "task delete API should confirm the task is really gone before returning success",
);

assert.match(
  taskCleanupSource,
  /async function deleteControllerRunCascade\([\s\S]*const linkedTaskIds = new Set<string>\(run\.createdTaskIds\)[\s\S]*task\.controllerRunId === run\.id[\s\S]*await deleteTaskCascade\(taskId, deps, summary\)[\s\S]*delete state\.controllerRuns\[runId\]/,
  "planning-run cleanup should only cascade into tasks explicitly owned by that run before removing it",
);

assert.match(
  taskCleanupSource,
  /function canAutoDeleteStaleControllerRun\([\s\S]*task\.controllerRunId === run\.id[\s\S]*clarification\.controllerRunId === run\.id[\s\S]*return !hasPendingClarification;/,
  "stale planning run cleanup should only auto-delete orphaned runs that have no active owned tasks or pending clarifications",
);

assert.match(
  controllerPlanningSource,
  /function tagControllerCreatedTasks\([\s\S]*task\.controllerRunId = controllerRunId/,
  "controller-created tasks should be bound to a specific controller run to avoid session-wide delete mistakes",
);

assert.match(
  controllerPlanningSource,
  /function reconcileControllerManifestTaskBindings\([\s\S]*matchedTask\.controllerRunId = controllerRunId/,
  "manifest-linked tasks should also be rebound to the specific controller run that owns them",
);

assert.match(
  controllerPlanningSource,
  /function looksLikeSupplementalHumanContextUpdate\([\s\S]*function getActiveTasksForSupplementalHumanContext\([\s\S]*function forwardSupplementalHumanContextToActiveTasks\([\s\S]*intent: "update"[\s\S]*message:new/,
  "controller should detect supplemental human context updates and forward them to active tasks as direct update messages",
);

assert.match(
  controllerPlanningSource,
  /async function maybeBackfillExecutionReadyTask\([\s\S]*const forwardedTaskIds = await forwardSupplementalHumanContextToActiveTasks\([\s\S]*if \(forwardedTaskIds\.length > 0\) \{\s*return \[\];/,
  "controller fallback task synthesis should stop and avoid creating a new execution task when the intake can be routed as supplemental context to active work",
);

assert.match(
  controllerRouteTableSource,
  /\{ method: "DELETE", path: \/\^\\\/api\\\/v1\\\/controller\\\/runs\\\/\[\^\/\]\+\$\/, handler: controllerRunDeleteRoute \}/,
  "planning-run delete API should stay routed (PR-D table entry)",
);
assert.match(
  controllerRouteTableSource,
  /function controllerRunDeleteRoute[\s\S]*const stillExists = !!getTeamState\(\)\?\.controllerRuns\[runId\];[\s\S]*Planning run cleanup could not be confirmed/,
  "planning-run delete API should confirm the run is really gone before returning success",
);

assert.match(
  websocketSource,
  /controller:run_deleted[\s\S]*task:deleted[\s\S]*clarification:deleted[\s\S]*message:deleted[\s\S]*project:deleted/,
  "websocket contract should include deletion events for runs, tasks, clarifications, messages, and projects",
);

assert.match(
  desktopAppSource,
  /async function deleteTaskWithConfirmation\([\s\S]*window\.confirm\(`Delete task[\s\S]*await apiDelete\(`\/tasks\/\$\{encodeURIComponent\(taskId\)\}`\)[\s\S]*apiGetOptional\(`\/tasks\/\$\{encodeURIComponent\(taskId\)\}`/,
  "desktop task cleanup should require confirmation, call the delete API, and re-read the task to confirm removal",
);

assert.match(
  desktopAppSource,
  /async function deletePlanningRunWithConfirmation\([\s\S]*window\.confirm\(`Delete planning run[\s\S]*await apiDelete\(`\/controller\/runs\/\$\{encodeURIComponent\(runId\)\}`\)[\s\S]*apiGetOptional\(`\/controller\/runs`/,
  "desktop planning-run cleanup should require confirmation, call the delete API, and re-read controller runs to confirm removal",
);

assert.match(
  desktopAppSource,
  /async function deleteProjectWithConfirmation\([\s\S]*window\.confirm\(`Delete project[\s\S]*await apiDelete\(`\/projects\/\$\{encodeURIComponent\(projectDir\)\}`\)[\s\S]*await refreshAll\(true\)/,
  "desktop project cleanup should require confirmation and call the dedicated project delete API",
);

assert.match(
  desktopAppSource,
  /const executionEvents = normalizeArray\(\(selectedRun\.execution && selectedRun\.execution\.events\) \|\| \[\]\);[\s\S]*Planning timeline[\s\S]*renderPlanningTimeline\(executionEvents\)/,
  "planning detail should render a timeline from controller run execution events",
);

assert.match(
  desktopAppSource,
  /data-delete-project=/,
  "workspace tree should expose direct delete actions for top-level project directories",
);

assert.match(
  desktopAppSource,
  /const treeDir = target\.closest\('\[data-tree-dir\]'\);[\s\S]*const node = row\.closest\('\.tree-node'\);[\s\S]*const container = node \? node\.querySelector\(':scope > \.tree-children'\) : null;/,
  "workspace tree directory toggles should resolve children from the tree node wrapper after adding row action buttons",
);

assert.match(
  desktopAppSource,
  /case "controller:run_deleted":[\s\S]*removeControllerRunState\(data\.runId\)/,
  "desktop websocket handling should evict deleted planning runs from local state",
);

assert.match(
  desktopAppSource,
  /case "task:deleted":[\s\S]*removeTaskState\(data\.taskId\)/,
  "desktop websocket handling should evict deleted tasks from local state",
);

assert.match(
  desktopAppSource,
  /case "clarification:deleted":[\s\S]*removeClarificationState\(data\.clarificationId\)/,
  "desktop websocket handling should evict deleted clarifications from local state",
);

assert.match(
  desktopAppSource,
  /case "message:deleted":[\s\S]*removeMessageState\(data\.messageId\)/,
  "desktop websocket handling should evict deleted runs, tasks, clarifications, and messages from local state",
);

assert.match(
  desktopAppSource,
  /case "project:deleted":[\s\S]*refreshAll\(true\)\.catch\(\(\) => \{\}\)/,
  "desktop websocket handling should refresh state when a project is deleted",
);

assert.match(
  desktopAppSource,
  /function pruneClarificationNotifications\([\s\S]*item\.id\.startsWith\('clarification:'\)[\s\S]*pendingIds\.has\(item\.id\)[\s\S]*case "clarification:answered":[\s\S]*pruneClarificationNotifications\(\)[\s\S]*case "clarification:deleted":[\s\S]*pruneClarificationNotifications\(\)/,
  "desktop notifications should drop answered or deleted clarification alerts so the drawer stays in sync with the clarification list",
);

assert.match(
  taskResultsSource,
  /\.go", ".mod", ".sum"/,
  "completion gate should treat Go source and module files as meaningful project changes",
);

assert.match(
  taskResultsSource,
  /function projectHasMeaningfulDeliverableEvidence\([\s\S]*deliverable\.kind !== "file" && deliverable\.kind !== "directory"[\s\S]*fs\.statSync\(fullPath\)/,
  "completion gate should accept existing file or directory deliverables under the project root as meaningful change evidence",
);

assert.match(
  taskRoutesSource,
  /!projectHasMeaningfulFileChanges\(gatedTask, effectiveContract\)/,
  "completion gate should evaluate meaningful project changes against the effective result contract",
);

assert.match(
  taskResultsSource,
  /already fixed[\s\S]*无需改动/,
  "controller no-change completion helper should recognize both English and Chinese no-change verification signals",
);

assert.match(
  taskResultsSource,
  /deliverable\.kind === "command"[\s\S]*deliverable\.kind === "note"/,
  "controller no-change completion helper should treat command or note deliverables as verification evidence",
);

assert.match(
  promptPolicySource,
  /Route repository analysis, architecture design, feasibility assessment, migration planning, and large rewrite decomposition to architect first\./,
  "controller intake rules should explicitly route architecture-first and migration-analysis work to architect before developer",
);

assert.match(
  promptPolicySource,
  /Do not infer ownership, license scope, or lack of user authorization from technical characteristics such as proprietary branding, bundled assets, binary files, minified code, or repository layout\./,
  "role operating rules should forbid ownership judgments based on repository technical characteristics",
);

assert.match(
  promptPolicySource,
  /Do not infer that the user lacks rights to inspect, modify, port, rename, or rebrand code merely because a repository contains bundled, binary, generated, minified, or vendor-branded material\./,
  "task execution rules should keep workers focused on technical work instead of guessing authorization from code shape",
);

assert.match(
  promptPolicySource,
  /Do not reject, moralize, or speculate about ownership merely because code appears bundled, binary-adjacent, generated, minified, vendor-branded, or otherwise unusual\./,
  "controller intake rules should forbid ownership speculation from unusual codebase structure",
);

assert.match(
  controllerPromptInjectorSource,
  /Do not infer that the user lacks rights to work on a codebase just because it contains binaries, bundles, minified code, generated artifacts, proprietary branding, or unusual repository structure\./,
  "controller prompt injection should remind TeamClaw to stay technical instead of making ownership judgments",
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
  promptPolicySource,
  /Default to completing implementation work in your current worker session\.[\s\S]*Only use a helper coding agent when there is a concrete capability gap[\s\S]*Never ask a helper coding agent to take over the whole TeamClaw task\./,
  "worker execution rules should strongly constrain nested coding-agent delegation",
);

assert.match(
  taskAssignmentSource,
  /function buildTaskContextSnapshot\([\s\S]*requirementSummary:[\s\S]*recentCompletedTasks:[\s\S]*kickoffSummary:/,
  "controller should build a richer same-session context snapshot for worker assignments",
);

assert.match(
  taskExecutorSource,
  /teamContext: assignment\.teamContext[\s\S]*function buildTaskMessage\([\s\S]*## TeamClaw Requirement Context/,
  "task executor should include packed TeamClaw requirement context in worker task prompts",
);

assert.match(
  controllerIntakeSource,
  /Would you like TeamClaw to continue with one of these adjacent next steps\?/,
  "controller should surface completion opportunities as a structured next-step clarification prompt",
);

assert.match(
  configSource,
  /workerProvisioningMaxPerRole:[\s\S]*default:\s*10,/,
  "config should raise the default same-role worker cap to 10",
);

assert.match(
  taskRoutesSource,
  /taskRequiresMeaningfulProjectChangeGate\(gatedTask\)[\s\S]*!projectHasMeaningfulFileChanges\(gatedTask, effectiveContract\)[\s\S]*!allowsNoChangeCompletion\(gatedTask, submittedContract(?: \?\? undefined)?, result\)/,
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
  clarificationRoutesSource,
  /async function requestTaskClarification\([\s\S]*task\.status = "blocked";[\s\S]*clarification_requested/,
  "controller should expose a reusable clarification blocker helper for worker/runtime stalls",
);

assert.match(
  taskRoutesSource,
  /const effectiveContract = buildEffectiveTaskResultContract\(currentTask, result, error, submittedContract(?: \?\? undefined)?\);[\s\S]*effectiveContract\.outcome === "blocked"[\s\S]*await requestTaskClarification\(/,
  "controller should block tasks and request clarification when the effective worker result contract is blocked",
);

// Provisioned worker configs must stay loadable by older openclaw runtimes:
// the host config can carry the newer keyed agents.entries schema (written
// by model configuration), which older workers reject with "Unrecognized
// key: entries". The provisioner folds the teamclaw entry model back into
// agents.defaults.model and strips the entries map.
{
  const provisioningSource = await fs.readFile(workerProvisioningPath, "utf8");
  assert.match(
    provisioningSource,
    /agentsRecord\.entries\[TEAMCLAW_AGENT_ID\]\?\.model[\s\S]*agentDefaults\.model = entryModel[\s\S]*delete agentsRecord\.entries/,
    "provisioned worker configs should fold agents.entries back into legacy agents.defaults for older worker runtimes",
  );
}

// OpenClaw startup detection must be retry-robust and must not degrade a
// resolvable-but-busy binary into a full runtime install (#140):
//   1. one retry of the `openclaw --help` probe with a short delay;
//   2. exit-non-zero after retry is treated as installed-with-warning
//      (surfaced as openClawProbeWarning), not not-installed;
//   3. only spawn ENOENT (binary does not resolve) stays not-installed.
{
  assert.match(
    desktopMainSource,
    /async function probeOpenClawInstall\(\) \{[\s\S]*for \(let attempt = 0; attempt < 2; attempt\+\+\)[\s\S]*OPENCLAW_PROBE_RETRY_DELAY_MS/,
    "desktop openclaw probe should retry the --help spawn once before deciding the runtime is missing",
  );

  assert.match(
    desktopMainSource,
    /kind === "error" && outcome\.error && outcome\.error\.code === "ENOENT"[\s\S]*return \{ installed: false, warning: null \}/,
    "desktop openclaw probe should only report not-installed for spawn ENOENT (binary does not resolve)",
  );

  assert.match(
    desktopMainSource,
    /warning: `openclaw --help exited with \$\{(?:lastFailure\.code \?\? 1)\}`[\s\S]*after retry/,
    "desktop openclaw probe should treat a resolvable-but-failing --help as installed-with-warning after the retry",
  );

  assert.match(
    desktopMainSource,
    /async function hasOpenClawInstalled\(\) \{\s*const probe = await probeOpenClawInstall\(\);\s*return probe\.installed;\s*\}/,
    "desktop hasOpenClawInstalled should be a thin boolean wrapper over the retrying probe",
  );

  assert.match(
    desktopMainSource,
    /hasOpenClaw: probe\.installed,[\s\S]*openClawProbeWarning: probe\.warning,/,
    "desktop local setup info should surface the probe warning to the renderer",
  );

  assert.doesNotMatch(
    desktopMainSource,
    /reject\(new Error\(`openclaw --help exited with/,
    "desktop openclaw probe should not go through a rejecting promise wrapper that collapses failures into not-installed",
  );

  assert.match(
    desktopRendererSource,
    /openClawProbeWarning[\s\S]*"OpenClaw detected \(degraded\)"/,
    "desktop bootstrap status pill should show a degraded-detected state when the probe warning is set",
  );
}

console.log("PASS test-openclaw-workspace");
