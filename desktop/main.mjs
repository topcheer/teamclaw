import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETTINGS = {
  controllerUrl: "http://127.0.0.1:9527",
  theme: "system",
  // instance = the app's single source of truth for what to run/connect:
  //   mode: "private"  - bundled/sandbox runtime, own state dir, own port
  //                       lifecycle "app" (die with app) | "persistent"
  //         "global"   - the machine-level OpenClaw (system PATH binary,
  //                       default state dir). Reuses any pre-existing state
  //                       and NEVER overwrites its LLM config.
  //         "external" - just connect to a controller URL, manage nothing.
  //   controllerUrl - resolved/known URL for this instance
  //   llmConfigured - whether the wizard already wrote LLM config for it
  instance: null,
};

let mainWindow = null;

const LOCAL_SETUP_MODES = [
  {
    id: "controller-manual",
    title: "Local quickstart",
    description: "Runs the controller here with same-host process provisioning and empty preferred provisioning roles. TeamClaw can still scale up to the configured per-role cap.",
    warning: "Leanest same-host setup. TeamClaw still provisions local worker processes on demand, but keeps `workerProvisioningRoles: []` so startup readiness falls back to a warm developer worker.",
    recommended: true,
  },
  {
    id: "controller-process",
    title: "Local multi-process",
    description: "Runs the controller here and provisions local worker processes on demand.",
    warning: "Uses more CPU and memory, but gives local workers stronger process isolation.",
    recommended: false,
  },
];

function getDesktopIconPath() {
  return path.join(__dirname, "renderer", "assets", "teamclaw-app-icon.png");
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(nextSettings) {
  const settings = { ...DEFAULT_SETTINGS, ...(nextSettings || {}) };
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

function buildLocalInstallCommand(mode) {
  const selectedMode = LOCAL_SETUP_MODES.some((entry) => entry.id === mode) ? mode : "controller-manual";
  return `npx -y @teamclaws/teamclaw install --yes --install-mode ${selectedMode}`;
}

async function hasOpenClawInstalled() {
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("openclaw", ["--help"], { stdio: "ignore", windowsHide: true });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(true);
          return;
        }
        reject(new Error(`openclaw --help exited with ${code ?? 1}`));
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function getLocalSetupInfo() {
  const hasOpenClaw = await hasOpenClawInstalled();
  return {
    hasOpenClaw,
    openClawInstallCommand: "sandboxed: desktop-managed runtime (never global)",
    openClawQuickstartCommand: "openclaw onboard --flow quickstart --install-daemon",
    modes: LOCAL_SETUP_MODES.map((entry) => ({
      ...entry,
      installCommand: buildLocalInstallCommand(entry.id),
    })),
  };
}

async function runShellCommand(command, options = {}) {
  const cwd = String(options.cwd || "").trim() || process.cwd();
  const child = spawn(command, {
    cwd,
    env: options.env || process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk || "");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk || "");
  });

  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = {
        ok: code === 0,
        code: code ?? null,
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command,
        cwd,
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const failure = new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`);
      Object.assign(failure, result);
      reject(failure);
    });
  });
}

/* ---------------- Bootstrap installer (streamed) ---------------- */

// Install sources for the OpenClaw + TeamClaw runtimes.
//   bundled  - ships inside this app (extraResources/bin; offline install)
//   official - npm registry (@latest)
//   artifact - prebuilt tar from the FIXED-URL GitHub release (runtime-latest)
const BUNDLED_BIN_DIR = () => path.join(process.resourcesPath || "", "bin");

function bundledBinary(name) {
  // extraResources embeds build/bundle -> Resources/bin. NOTE: the .bin
  // entries are SYMLINKS and electron-builder's copy breaks them (lstat
  // hits, existsSync false), so resolve the REAL files instead:
  //   openclaw  -> node_modules/openclaw/openclaw.mjs
  //   (any pkg) -> node_modules/<name>/... resolved per-package below
  if (name === "openclaw") {
    const real = path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules", "openclaw", "openclaw.mjs");
    return fsSync.existsSync(real) ? real : null;
  }
  const direct = path.join(BUNDLED_BIN_DIR(), name);
  if (fsSync.existsSync(direct)) return direct;
  const tree = path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules", ".bin", name);
  return fsSync.existsSync(tree) ? tree : null;
}

function resolveInstallSource(source) {
  switch (source) {
    case "bundled":
    case "official":
    case "artifact":
      return source;
    default:
      // Auto: prefer a bundled binary when present, else npm.
      return bundledBinary("openclaw") ? "bundled" : "official";
  }
}

async function ensureOpenClawRuntime({ source, artifactUrl }, onEvent) {
  // Returns the openclaw command (bundled path or global CLI name).
  // Bundled tree WINS over reusing the global install: the embedded runtime
  // keeps openclaw+teamclaw peers resolvable inside one tree, which is what
  // makes fully-offline plugin registration work (a local-path plugins
  // install otherwise resolves its openclaw peer over npm).
  const bundled = bundledBinary("openclaw");
  if (bundled) {
    onEvent({ phase: "openclaw", line: "Using bundled OpenClaw runtime: " + bundled });
    return bundled;
  }
  const existing = await hasOpenClawInstalled();
  if (existing) {
    onEvent({ phase: "openclaw", line: "OpenClaw already installed - reusing." });
    return "openclaw";
  }
  const src = resolveInstallSource(source);
  if (src === "bundled") {
    const bin = bundledBinary("openclaw");
    if (!bin) throw new Error("Bundled OpenClaw binary missing from the app package.");
    onEvent({ phase: "openclaw", line: "Using bundled OpenClaw binary: " + bin });
    return bin;
  }
  if (src === "artifact") {
    // Fixed-URL rolling release (user design): tag never moves, CI replaces
    // assets. Default URL, user-overridable; sha256 verified when available.
    const plat = `${process.platform}-${process.arch}`;
    const url = artifactUrl || `https://github.com/topcheer/teamclaw/releases/download/runtime-latest/teamclaw-runtime-${plat}.tar.gz`;
    const workDir = path.join(app.getPath("userData"), "downloads");
    await fs.mkdir(workDir, { recursive: true });
    const fileName = url.split("/").pop() || "artifact.tar.gz";
    const dest = path.join(workDir, fileName);
    onEvent({ phase: "openclaw", line: `Downloading runtime artifact ${fileName}...` });
    await runShellStream(`curl -fSL --retry 3 -o "${dest}" "${url}"`, workDir, (line) =>
      onEvent({ phase: "openclaw", line }),
    );
    onEvent({ phase: "openclaw", line: "Verifying sha256..." });
    const sum = await runShellCommand(`shasum -a 256 "${dest}"`, { cwd: workDir });
    const digest = (sum.stdout || "").split(" ")[0];
    try {
      const expect = (await (await fetch(url + ".sha256")).text()).split(" ")[0];
      if (expect && digest !== expect) throw new Error(`sha256 mismatch: ${digest} != ${expect}`);
      onEvent({ phase: "openclaw", line: "sha256 OK: " + digest.slice(0, 12) });
    } catch (e) {
      if (String(e.message || "").startsWith("sha256 mismatch")) throw e;
      onEvent({ phase: "openclaw", line: "checksum file unavailable - continuing without verification" });
    }
    const extractDir = path.join(workDir, "runtime-extracted");
    await fs.mkdir(extractDir, { recursive: true });
    await runShellStream(`tar xzf "${dest}" -C "${extractDir}"`, workDir, (line) => onEvent({ phase: "openclaw", line }));
    const bin = path.join(extractDir, "runtime", "node_modules", ".bin", "openclaw");
    if (!fsSync.existsSync(bin)) throw new Error("Runtime tree malformed (no openclaw bin).");
    onEvent({ phase: "openclaw", line: "Artifact runtime ready: " + bin });
    return bin;
  }
  // official: npm install into the DESKTOP-OWNED prefix - the user's global
  // installation is never touched (hard requirement from the user).
  const runtimeDir = path.join(app.getPath("userData"), "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  onEvent({ phase: "openclaw", line: `Installing OpenClaw into desktop runtime (${runtimeDir})...` });
  await runShellStream(`npm install --prefix "${runtimeDir}" openclaw@latest`, runtimeDir, (line) =>
    onEvent({ phase: "openclaw", line }),
  );
  const bin = path.join(runtimeDir, "node_modules", ".bin", "openclaw");
  if (!fsSync.existsSync(bin)) throw new Error("OpenClaw install finished but binary not found at " + bin);
  return bin;
}

async function ensureTeamClawPlugin(openclawBin, onEvent) {
  // FULLY SANDBOXED (user vetoed global writes): registration and runtime
  // both use the desktop state dir; ~/.openclaw is never written. The user's
  // global config is only ever READ (LLM seeding happens elsewhere).
  const sandboxEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(app.getPath("userData"), "openclaw-state") };
  const runtimeDir = path.join(app.getPath("userData"), "runtime");
  // The "reusing existing OpenClaw" path skips the runtime install, so the
  // runtime dir may not exist yet - spawn cwd must exist or every command
  // below fails with ENOENT.
  await fs.mkdir(runtimeDir, { recursive: true });
  const pluginDir = path.join(runtimeDir, "node_modules", "@teamclaws", "teamclaw");
  const res = await runShellCommand(`"${openclawBin}" plugins list --json 2>/dev/null || true`, { cwd: runtimeDir, env: sandboxEnv });
  // Precise: match on the plugin ROW (id === "teamclaw"), not any teamclaw
  // substring - the stock-extensions path line also contains it. A row in
  // error-state is NOT "installed": the copying file: install (#147) left
  // deps missing, so fall through and re-register from the bundled tree.
  let existingRow = null;
  try {
    existingRow = (JSON.parse(res.stdout || "").plugins || []).find((p) => p && p.id === "teamclaw") || null;
  } catch { existingRow = null; }
  if (existingRow && existingRow.status !== "error") {
    onEvent({ phase: "teamclaw", line: "TeamClaw plugin already installed." });
    return;
  }
  // Fully-offline registration when a bundled tree exists: LINK the
  // plugin from the EMBEDDED runtime tree (same tar shape) - no npm, no
  // network, no copy. A copy install ("file:<dir>" / plain path) breaks on
  // this tree shape: the runtime tar hoists most plugin deps to the tree
  // root (runtime/node_modules/<dep>), while only version-conflicted deps
  // stay nested under @teamclaws/teamclaw/node_modules. The copy carries
  // just the nested set, so the dependency scan finds @sinclair/typebox,
  // bonjour-service and json5 missing and the plugin lands error-state
  // after enable (#147). A linked install keeps loading from the bundled
  // tree, where Node resolves every hoisted dep one directory up.
  const bundledOpenclaw = bundledBinary("openclaw");
  const bundledPlugin = bundledOpenclaw
    ? path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules", "@teamclaws", "teamclaw")
    : null;
  // Older installs registered via a COPYING file: install and now sit in
  // error-state with a broken extensions/teamclaw copy. Fresh installs
  // (either path) refuse to replace an existing copy ("plugin already
  // exists ... delete it first"), so clear it first: uninstall removes the
  // record + directory. Runs for BOTH the bundled and npm paths.
  if (existingRow) {
    onEvent({ phase: "teamclaw", line: "Replacing the broken (error-state) plugin registration..." });
    await runShellCommand(`"${openclawBin}" plugins uninstall teamclaw --force`, { cwd: runtimeDir, env: sandboxEnv });
  }
  if (bundledPlugin && fsSync.existsSync(bundledPlugin)) {
    onEvent({ phase: "teamclaw", line: "Registering the bundled TeamClaw plugin (offline)..." });
    await runShellStream(`"${openclawBin}" plugins install --link "${bundledPlugin}" --force --accept-capabilities`, runtimeDir, (line) =>
      onEvent({ phase: "teamclaw", line }), sandboxEnv);
    // Uninstall (repair path) drops the enable state; install --link does
    // not always restore it. Enable explicitly - idempotent either way.
    await runShellCommand(`"${openclawBin}" plugins enable teamclaw`, { cwd: runtimeDir, env: sandboxEnv });
    return;
  }
  await runShellStream(`npm install --prefix "${runtimeDir}" @teamclaws/teamclaw@latest`, runtimeDir, (line) =>
    onEvent({ phase: "teamclaw", line }),
  );
  onEvent({ phase: "teamclaw", line: "Registering the TeamClaw plugin..." });
  // npm spec install ships compiled dist (local-path installs trip the
  // "compiled runtime output" packaging check); force skips the local-path
  // trust prompt. Registration lands in the SANDBOX state dir only.
  await runShellStream(`"${openclawBin}" plugins install @teamclaws/teamclaw --force --accept-capabilities`, runtimeDir, (line) => {
    onEvent({ phase: "teamclaw", line });
  }, sandboxEnv);
}

// Minimal LLM config: write the DESKTOP-SANDBOX openclaw.json directly
// (userData/openclaw-state). The user's own ~/.openclaw is never touched -
// hard requirement. Provider + endpoint + apiKey only, all else defaults.
async function writeLlmConfig(_openclawBin, { provider, endpoint, apiKey }, onEvent) {
  if (!provider || !apiKey) {
    onEvent({ phase: "llm", line: "No LLM credentials provided - keeping defaults." });
    return;
  }
  const stateDir = path.join(app.getPath("userData"), "openclaw-state");
  await fs.mkdir(stateDir, { recursive: true });
  const cfgPath = path.join(stateDir, "openclaw.json");
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")); } catch { cfg = {}; }
  // Real OpenClaw schema: models.providers.<id> (NOT a top-level "vendors"
  // key - that fails config validation and blocks every CLI command).
  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};
  cfg.models.providers[provider] = {
    ...(cfg.models.providers[provider] || {}),
    apiKey,
    ...(endpoint ? { baseUrl: endpoint } : {}),
  };
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  onEvent({ phase: "llm", line: `LLM config written for ${provider} (sandbox only).` });
}

// Streamed variant: emits every stdout/stderr line through onLine and
// resolves with the same result shape as runShellCommand.
async function runShellStream(command, cwd, onLine, envOverride) {
  const child = spawn(command, {
    cwd,
    env: envOverride || process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Watchdog: grandchildren can inherit and hold the stdio pipes, so the
  // child's 'exit' may fire but 'close' never does and callers hang. If the
  // stream goes silent for 20s AFTER the child exits, force-settle.
  let exited = false;
  let lastActivity = Date.now();
  child.on("exit", () => { exited = true; lastActivity = Date.now(); });
  const watchdog = setInterval(() => {
    if (exited && Date.now() - lastActivity > 20000) {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }, 5000);
  const bump = () => { lastActivity = Date.now(); };
  let stdout = "";
  let stderr = "";
  const makePump = (isErr) => {
    let pending = "";
    return (stream) => {
      stream?.on("data", (chunk) => {
        pending += String(chunk || "");
        const captured = isErr ? (stderr += pending) : null;
        void captured;
        let idx;
        while ((idx = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, idx).trim();
          if (line) { onLine(line); bump(); }
          pending = pending.slice(idx + 1);
        }
      });
    };
  };
  makePump(false)(child.stdout);
  makePump(true)(child.stderr);
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearInterval(watchdog);
      const result = { ok: code === 0, code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) return resolve(result);
      const failure = new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`);
      Object.assign(failure, result);
      reject(failure);
    });
  });
}

async function installLocalTeamClaw(options) {
  const mode = String(options?.mode || "controller-manual").trim();
  const command = buildLocalInstallCommand(mode);
  return await runShellCommand(command, { cwd: String(options?.cwd || "").trim() || process.cwd() });
}

async function installOpenClawLocally(options) {
  let command = String(options?.command || "").trim();
  if (!command) {
    throw new Error("OpenClaw install command is required (sandboxed installs use bootstrap:install)");
  }
  if (/(^|\s)npm\s+install\s+-g\b/.test(command)) {
    throw new Error("Global installs are disabled: use the sandboxed bootstrap installer.");
  }
  return await runShellCommand(command, { cwd: String(options?.cwd || "").trim() || process.cwd() });
}

// Window chrome colors per theme (kept in sync with renderer/style.css).
const THEME_CHROME = {
  day: { background: "#faf9f7", symbol: "#26231d" },
  night: { background: "#131109", symbol: "#f0ece3" },
};

function effectiveTheme(theme) {
  if (theme === "day" || theme === "night") return theme;
  return nativeTheme.shouldUseDarkColors ? "night" : "day";
}

async function createMainWindow() {
  const settings = await loadSettings();
  const chrome = THEME_CHROME[effectiveTheme(settings.theme)];
  // Titleless chrome: the OS title bar is replaced by an in-page drag
  // region (renderer/.titlebar) so the app title merges with the shell.
  // macOS keeps native traffic lights (hiddenInset); Windows/Linux draw
  // native min/max/close over the page via titleBarOverlay, tinted to the
  // page background for a seamless look.
  const isDarwin = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: chrome.background,
    title: "TeamClaw Desktop",
    icon: getDesktopIconPath(),
    titleBarStyle: isDarwin ? "hiddenInset" : "hidden",
    ...(isDarwin ? {} : {
      titleBarOverlay: {
        color: chrome.background,
        symbolColor: chrome.symbol,
        height: 40,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // No app.dock.setIcon here: the Dock icon comes from the bundle icns
  // (build/icon.icns = site claw mark). The old runtime override pointed at
  // a legacy PNG and masked the bundle icon on every launch.
  await createMainWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("window:apply-theme", async (_event, theme) => {
  const chrome = THEME_CHROME[theme === "night" ? "night" : "day"];
  if (mainWindow) {
    mainWindow.setBackgroundColor(chrome.background);
    if (process.platform !== "darwin") {
      try {
        mainWindow.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
      } catch {
        /* setTitleBarOverlay unsupported on this platform/build */
      }
    }
  }
  return { ok: true };
});
ipcMain.handle("settings:get", async () => loadSettings());
ipcMain.handle("settings:save", async (_event, settings) => saveSettings(settings));
/* ---------------- Standalone instance (fully isolated) ----------------
 * A desktop-owned OpenClaw+TeamClaw instance:
 *   - state dir: userData/standalone-state (OPENCLAW_STATE_DIR) - never the
 *     user's ~/.openclaw
 *   - runtime: the sandboxed npm-prefix binaries from bootstrap (or the
 *     user-installed openclaw binary, executed read-only)
 *   - its own port (auto-picked free port)
 *   - LLM config defaults to a READ-ONLY COPY of the user's config; the
 *     desktop may override the vendor - written only into the sandbox copy
 *   - started/stopped with the desktop app; killed on quit, pid-guarded
 */
const STANDALONE = { child: null, port: null, pid: null, controllerUrl: null };

function standaloneStateDir() {
  // The private instance RUNS on the bootstrap sandbox state - one sandbox
  // holds both the registered plugin and the running gateway. A separate
  // standalone-state dir used to split them (plugin registered in one,
  // gateway in the other - controller never came up).
  return path.join(app.getPath("userData"), "openclaw-state");
}
function standalonePidFile() {
  return path.join(standaloneStateDir(), "gateway.pid");
}

async function findFreePort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function standaloneBinary() {
  // Prefer the desktop sandbox runtime; fall back to the user-installed
  // openclaw (executed read-only - we never modify its installation).
  const sandboxBin = path.join(app.getPath("userData"), "runtime", "node_modules", ".bin", "openclaw");
  if (fsSync.existsSync(sandboxBin)) return sandboxBin;
  if (await hasOpenClawInstalled()) return "openclaw";
  throw new Error("No OpenClaw runtime available - run the one-click install first.");
}

async function seedStandaloneConfig(preferredVendor) {
  // Minimal-config seeding: a full copy of the user's config made the
  // gateway normalize production-specific fields at startup, tripping its
  // own config-guard ("config changed during startup") in a loop. Instead
  // write ONLY {gateway.mode:local} + the LLM providers already configured
  // in the bootstrap sandbox (read-only source; user config never read or
  // written here).
  const stateDir = standaloneStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  const dst = path.join(stateDir, "openclaw.json");
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(dst, "utf8")); } catch { cfg = {}; }
  cfg.gateway = { ...(cfg.gateway || {}), mode: "local" };
  cfg.models = cfg.models || { providers: {} };
  cfg.models.providers = cfg.models.providers || {};
  const bootstrapCfg = path.join(app.getPath("userData"), "openclaw-state", "openclaw.json");
  try {
    const b = JSON.parse(await fs.readFile(bootstrapCfg, "utf8"));
    for (const [id, p] of Object.entries(b?.models?.providers || {})) {
      cfg.models.providers[id] = { ...(cfg.models.providers[id] || {}), ...p };
    }
  } catch { /* bootstrap not run yet - empty providers */ }
  if (preferredVendor && cfg.models.providers[preferredVendor]) cfg.preferredVendor = preferredVendor;
  // Declare the plugin in controller mode - without this the gateway starts
  // the teamclaw plugin as a WORKER (it just polls for a controller and the
  // desktop dashboard never gets its API).
  cfg.plugins = cfg.plugins || { entries: {} };
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries.teamclaw = {
    ...(cfg.plugins.entries.teamclaw || {}),
    enabled: true,
    config: { ...(cfg.plugins.entries.teamclaw?.config || {}), mode: "controller", teamName: "private" },
  };
  await fs.writeFile(dst, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return dst;
}

async function standaloneStart(preferredVendor) {
  if (STANDALONE.child) return { ok: true, alreadyRunning: true, port: STANDALONE.port };
  const bin = await standaloneBinary();
  // Idempotent seed: a rewrite (even identical) trips the gateway config-guard
  // ("config changed during startup") and kills the spawn. Only seed when the
  // sandbox config is missing or lacks any models.providers entry.
  const sandboxCfgPath = path.join(standaloneStateDir(), "openclaw.json");
  let needsSeed = true;
  try {
    const c = JSON.parse(await fs.readFile(sandboxCfgPath, "utf8"));
    const noLlm = !c?.models?.providers || Object.keys(c.models.providers).length === 0;
    const noGateway = !c?.gateway?.mode;
    const noController = c?.plugins?.entries?.teamclaw?.config?.mode !== "controller";
    needsSeed = noLlm || noGateway || noController;
  } catch { /* missing -> seed */ }
  if (needsSeed) await seedStandaloneConfig(preferredVendor);
  STANDALONE.port = await findFreePort();
  const logPath = path.join(standaloneStateDir(), "gateway.log");
  const logFd = fsSync.openSync(logPath, "a");
  const child = spawn(`"${bin}" gateway --port ${STANDALONE.port}`, {
    cwd: standaloneStateDir(),
    env: { ...process.env, OPENCLAW_STATE_DIR: standaloneStateDir() },
    shell: true,
    stdio: ["ignore", logFd, logFd],
    detached: false,
  });
  STANDALONE.child = child;
  STANDALONE.pid = child.pid ?? null;
  await fs.writeFile(standalonePidFile(), String(child.pid ?? ""), { mode: 0o600 });
  child.on("exit", () => {
    STANDALONE.child = null;
    STANDALONE.pid = null;
    try { fsSync.rmSync(standalonePidFile(), { force: true }); } catch { /* gone */ }
  });
  // The teamclaw controller picks its own HTTP port (9527, auto-shifted when
  // occupied - e.g. 9537 next to a production controller). Wait for its
  // announce line in the gateway log and surface THAT as the controllerUrl.
  let controllerUrl = null;
  for (let i = 0; i < 40 && !controllerUrl; i++) {
    try {
      const log = await fs.readFile(logPath, "utf8");
      const m = log.match(/Controller: Web UI available at http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) controllerUrl = `http://127.0.0.1:${m[1]}`;
    } catch { /* log not written yet */ }
    if (!controllerUrl) await new Promise((r) => setTimeout(r, 1000));
  }
  STANDALONE.controllerUrl = controllerUrl;
  return { ok: true, port: STANDALONE.port, pid: child.pid ?? null, controllerUrl: controllerUrl || `http://127.0.0.1:${STANDALONE.port}` };
}

async function standaloneStop() {
  if (!STANDALONE.child) {
    // Stale pid from a previous run (crashed desktop): reap if alive.
    try {
      const pid = Number((await fs.readFile(standalonePidFile(), "utf8")).trim());
      if (pid) process.kill(pid, 0); // throws if dead
      process.kill(pid, "SIGTERM");
    } catch { /* not running */ }
    try { fsSync.rmSync(standalonePidFile(), { force: true }); } catch { /* gone */ }
    return { ok: true, alreadyRunning: false };
  }
  const child = STANDALONE.child;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 4000);
  });
  return { ok: true };
}

function standaloneStatus() {
  return {
    running: Boolean(STANDALONE.child),
    port: STANDALONE.port,
    pid: STANDALONE.pid,
    controllerUrl: STANDALONE.controllerUrl || null,
    stateDir: standaloneStateDir(),
  };
}

ipcMain.handle("standalone:start", async (_e, options) => standaloneStart(options?.preferredVendor));
ipcMain.handle("standalone:stop", () => standaloneStop());
ipcMain.handle("standalone:status", () => standaloneStatus());

// App lifecycle: the private instance dies with the app UNLESS the user
// chose "persistent" (keep it running in the background so the next app
// start reconnects instantly). Global gateways are always left running.
app.on("before-quit", async () => {
  const settings = await loadSettings().catch(() => null);
  const lifecycle = settings?.instance?.lifecycle || "app";
  if (lifecycle === "app") {
    try { STANDALONE.child?.kill("SIGTERM"); } catch { /* gone */ }
  }
});

// Readiness gate: fully-offline two probes against the DESKOP SANDBOX state.
// ready = LLM configured (any models.providers[*].apiKey) AND teamclaw registered.
// ---- Instance manager: one IPC family driven ONLY by settings.instance ----
ipcMain.handle("instance:get", async () => (await loadSettings()).instance);
ipcMain.handle("instance:set", async (_e, instance) => {
  const settings = await loadSettings();
  settings.instance = instance || null;
  await saveSettings(settings);
  return settings.instance;
});
// Global-mode detection for the wizard: does the machine-level OpenClaw have
// a pre-existing state (LLM already configured)? Read-only.
ipcMain.handle("global:probe", async () => {
  const statePath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  try {
    const cfg = JSON.parse(await fs.readFile(statePath, "utf8"));
    const llm = Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey);
    return { present: true, llmConfigured: llm, binary: await hasOpenClawInstalled() };
  } catch {
    return { present: false, llmConfigured: false, binary: await hasOpenClawInstalled() };
  }
});
// Global-mode gateway: spawn the system openclaw gateway (default state dir,
// NO sandbox env). Fresh installs get LLM written by the wizard first;
// pre-existing state is reused untouched.
async function globalGatewayStart() {
  const port = await findFreePort();
  const logFd = fsSync.openSync(path.join(app.getPath("userData"), "global-gateway.log"), "a");
  const child = spawn(`openclaw gateway --port ${port}`, {
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
    shell: true,
    stdio: ["ignore", logFd, logFd],
  });
  GLOBAL_GATEWAY.child = child;
  GLOBAL_GATEWAY.port = port;
  return { ok: true, port, pid: child.pid ?? null };
}
const GLOBAL_GATEWAY = { child: null, port: null };
ipcMain.handle("instance:start-global", () => globalGatewayStart());

ipcMain.handle("runtime:is-ready", async () => {
  const stateDir = path.join(app.getPath("userData"), "openclaw-state");
  let llm = false, plugin = false;
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8"));
    llm = Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey);
  } catch { /* no cfg */ }
  try {
    const bin = path.join(app.getPath("userData"), "runtime", "node_modules", ".bin", "openclaw");
    const cand = fsSync.existsSync(bin) ? bin : (await hasOpenClawInstalled() ? "openclaw" : null);
    if (cand) {
      const res = await runShellCommand(`"${cand}" plugins list --json 2>/dev/null || true`, { cwd: path.join(app.getPath("userData"), "runtime"), env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
      // Registered is not enough: an error-state row means the plugin fails
      // to load (#147) - only a non-error row counts as ready.
      const row = (JSON.parse(res.stdout || "").plugins || []).find((p) => p && p.id === "teamclaw");
      plugin = Boolean(row && row.status !== "error");
    }
  } catch { /* no runtime */ }
  return { ready: llm && plugin, llm, plugin };
});

ipcMain.handle("bootstrap:install", async (event, options) => {
  // Orchestrate the sandboxed bootstrap with streamed progress events.
  // NEVER touches the user's global installs or ~/.openclaw (hard rule).
  const onEvent = (e) => {
    try { event.sender.send("bootstrap:install-event", e); } catch { /* window gone */ }
  };
  const { llm, source, artifactUrl } = options || {};
  try {
    onEvent({ phase: "start", line: "Starting sandboxed bootstrap..." });
    onEvent({ phase: "diag", line: "rp=" + (process.resourcesPath||"none") });
    {
      const base = path.join(process.resourcesPath || "", "bin");
      const t1 = path.join(base, "runtime", "node_modules", ".bin", "openclaw");
      onEvent({ phase: "diag", line: "bin-dir=" + fsSync.existsSync(base) + " tree=" + fsSync.existsSync(t1) + " lstat=" + (() => { try { return fsSync.lstatSync(t1).isSymbolicLink(); } catch { return "ERR:"; } })() });
    }
    const openclawBin = await ensureOpenClawRuntime({ source, artifactUrl }, onEvent);
    await ensureTeamClawPlugin(openclawBin, onEvent);
    await writeLlmConfig(openclawBin, llm || {}, onEvent);
    onEvent({ phase: "done", line: "Bootstrap complete.", openclawBin });
    return { ok: true, openclawBin };
  } catch (err) {
    onEvent({ phase: "error", line: err instanceof Error ? err.message : String(err) });
    throw err;
  }
});

ipcMain.handle("controller:get-setup-info", async () => getLocalSetupInfo());
ipcMain.handle("shell:openExternal", async (_event, url) => {
  await shell.openExternal(String(url || ""));
});
ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  const result = await shell.openPath(String(targetPath || ""));
  if (result) {
    throw new Error(result);
  }
  return { ok: true };
});
ipcMain.handle("notification:show", async (_event, payload) => {
  const title = String(payload?.title || "TeamClaw");
  const body = String(payload?.body || "");
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});
