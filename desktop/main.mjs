import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// True sandbox switch for testing: on macOS Electron's userData follows the
// SYSTEM home (NSHomeDirectory), not $HOME - env-HOME sandboxes silently
// read the real user's config (that's how test instances ended up connected
// to the production controller). TC_USER_DATA redirects userData before
// anything reads it.
if (process.env.TC_USER_DATA) {
  app.setPath("userData", process.env.TC_USER_DATA);
}
const DEFAULT_SETTINGS = {
  // NO silent localhost default: an empty URL means "no instance chosen yet".
  // Boot must go through settings.instance; a hardcoded 9527 dials whatever
  // else runs on this machine (e.g. a host production controller).
  controllerUrl: "",
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
  // sandbox flag is derived, never persisted: a TC_USER_DATA launch must
  // behave like a fresh machine (wizard defaults to PRIVATE, no probing of
  // the host's real openclaw/controller) even after settings get saved.
  const derived = { ...DEFAULT_SETTINGS, sandbox: Boolean(process.env.TC_USER_DATA) };
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    return { ...derived, ...JSON.parse(raw), sandbox: derived.sandbox };
  } catch {
    return { ...derived };
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
  const res = await runShellCommand(`"${openclawBin}" plugins list 2>/dev/null || true`, { cwd: runtimeDir, env: sandboxEnv });
  // Precise: match the plugins-list TABLE row (│ TeamClaw │), not any
  // teamclaw substring - the stock-extensions path line also contains it.
  if (/│\s*TeamClaw\s*│/.test(res.stdout || "")) {
    onEvent({ phase: "teamclaw", line: "TeamClaw plugin already installed." });
    return;
  }
  // Fully-offline registration when a bundled tree exists: install the
  // plugin from the EMBEDDED runtime tree (same tar shape) - no npm, no
  // network. Only falls back to npm when the bundle is absent.
  const bundledOpenclaw = bundledBinary("openclaw");
  const bundledPlugin = bundledOpenclaw
    ? path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules", "@teamclaws", "teamclaw")
    : null;
  if (bundledPlugin && fsSync.existsSync(bundledPlugin)) {
    onEvent({ phase: "teamclaw", line: "Registering the bundled TeamClaw plugin (offline)..." });
    await runShellStream(`"${openclawBin}" plugins install "file:${bundledPlugin}" --force --accept-capabilities`, runtimeDir, (line) =>
      onEvent({ phase: "teamclaw", line }), sandboxEnv);
    // #147: openclaw's dependency probe enforces the plugin rootDir BOUNDARY -
    // hoisted deps (npm layout in the runtime tree) resolve OUTSIDE it and
    // the plugin lands error-state "required dependencies are missing".
    // Seal the runtime tree's node_modules INTO the installed plugin dir
    // (pure file copy, zero network). Symlinks copied verbatim; the .bin
    // entries in the plugin subtree were already materialized at bundle time.
    const extRoot = path.join(sandboxEnv.OPENCLAW_STATE_DIR, "extensions", "teamclaw");
    const extDeps = path.join(extRoot, "node_modules");
    if (fsSync.existsSync(extRoot)) {
      // Precise seal: the plugin's own declared dependencies only (5 pkgs,
      // incl. the openclaw peer) - copied one-by-one from the bundled tree so
      // a single bad entry can never abort the whole copy (#147: whole-tree
      // cp died silently after ~10 entries; the boundary probe needs deps
      // INSIDE the plugin rootDir, hoisted layout does not satisfy it).
      // Seal ALL real package dirs from the bundled tree (not just direct
      // deps): the plugin loads its transitive dependencies at runtime
      // (fast-deep-equal etc.) and openclaw refuses the load on ANY missing
      // one. Per-package try/catch: a single dangling entry must not abort
      // the rest (whole-tree cp died that way).
      const runtimeNM = path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules");
      let sealed = 0, skipped = 0;
      const sealDir = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
          const src = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name.startsWith("@")) { await sealDir(src); continue; }
          if (!entry.isDirectory()) continue;
          const hasManifest = fsSync.existsSync(path.join(src, "package.json"));
          if (!hasManifest) continue;
          const dst = path.join(extDeps, path.relative(runtimeNM, src));
          if (fsSync.existsSync(dst)) { continue; }
          await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true, force: true }).then(() => { sealed++; }, () => { skipped++; });
        }
      };
      onEvent({ phase: "teamclaw", line: "Sealing offline deps (full closure) into the plugin dir..." });
      await sealDir(runtimeNM);
      onEvent({ phase: "teamclaw", line: `Deps sealed: ${sealed} packages (${skipped} skipped).` });
    }
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
  // Test hook (dev/CI driving, env-gated): when TC_TEST_HOOK is set, poll a
  // command file and execute each line as JS inside the renderer; the JSON
  // result is appended to <file>.result. Coordinates-free UI automation -
  // vision-coordinate clicking proved unreliable for Electron DOM.
  if (process.env.TC_TEST_HOOK) {
    const hookFile = process.env.TC_TEST_HOOK;
    const resultFile = `${hookFile}.result`;
    setInterval(async () => {
      let line = "";
      try { line = (await fs.readFile(hookFile, "utf8")).trim(); } catch { return; }
      if (!line) return;
      try { await fs.writeFile(hookFile, "", { mode: 0o600 }); } catch { /* race */ }
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      let out = { error: "no window" };
      try {
        out = { value: await win.webContents.executeJavaScript(`(${line})()`) };
      } catch (e) { out = { error: e instanceof Error ? e.message : String(e) }; }
      try { await fs.appendFile(resultFile, JSON.stringify(out) + "\n"); } catch { /* best effort */ }
    }, 500);
  }
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
ipcMain.handle("settings:save", async (_event, settings) => {
  // `instance` is owned exclusively by instance:set. Renderer preferences are
  // saved from a snapshot taken at boot, which would otherwise clobber the
  // instance record written later (a real bug: mode/ports silently lost).
  const current = await loadSettings().catch(() => ({}));
  const next = { ...settings };
  // HARD ownership rule: renderer snapshots carry a boot-time instance value
  // (often explicit null) that would clobber a record written afterwards.
  // instance belongs to instance:set alone.
  delete next.instance;
  next.instance = current.instance ?? null;
  return saveSettings(next);
});
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
  // Same resolution order as the installer (bundled > sandbox runtime >
  // global read-only). A bundled install wrote the sandbox state with the
  // bundled (newer) openclaw - running the OLDER global binary against it
  // is refused by the gateway ("older than the config last written by").
  const bundled = bundledBinary("openclaw");
  if (bundled) return bundled;
  const sandboxBin = path.join(app.getPath("userData"), "runtime", "node_modules", ".bin", "openclaw");
  if (fsSync.existsSync(sandboxBin)) return sandboxBin;
  if (await hasOpenClawInstalled()) return "openclaw";
  throw new Error("No OpenClaw runtime available - run the one-click install first.");
}

async function seedStandaloneConfig(preferredVendor, controllerPort) {
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
    config: {
      ...(cfg.plugins.entries.teamclaw?.config || {}),
      mode: "controller",
      teamName: "private",
      // Pin the controller port so restarts land on the remembered one; the
      // plugin auto-shifts (9527 -> 9627 ...) when it is occupied, and the
      // actual bound port is recorded back into settings afterwards.
      ...(controllerPort ? { port: controllerPort } : {}),
    },
  };
  await fs.writeFile(dst, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return dst;
}

async function standaloneStart(preferredVendor, remembered) {
  if (STANDALONE.child) return { ok: true, alreadyRunning: true, port: STANDALONE.port };
  // Port memory: reuse the ports recorded in settings.instance so restarts
  // land on the SAME gateway/controller ports (probed + persisted below).
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
  // Conflict-checked port fallback (user rule): BOTH the openclaw gateway
  // port and the teamclaw controller port are probed BEFORE launch; an
  // occupied preferred port falls back to the next free one (preferred+1..
  // preferred+50, else any free port). The chosen pair is persisted into
  // settings.instance FIRST - then the processes start on exactly those
  // ports - so a restart lands on the same ports without re-shifting.
  const isFreeLocal = async (port) => {
    if (!port) return false;
    const net = await import("node:net");
    return await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
  };
  const pickPortWithFallback = async (preferred, fallbackBase) => {
    const base = Number.isFinite(preferred) && preferred > 0 ? preferred : fallbackBase;
    if (await isFreeLocal(base)) return base;
    for (let p = fallbackBase; p < fallbackBase + 50; p++) {
      if (await isFreeLocal(p)) return p;
    }
    return await findFreePort();
  };
  const persistInstancePorts = async (instance) => {
    try {
      const s = await loadSettings();
      s.instance = { ...(s.instance || {}), ...instance };
      await saveSettings(s);
    } catch { /* settings write failure must not kill the launch */ }
  };
  const wantCtrl = Number(remembered?.controllerPort) || null;
  const ctrlPort = await pickPortWithFallback(wantCtrl, 9527);
  const gwPort = await pickPortWithFallback(Number(remembered?.gatewayPort) || null, ctrlPort + 100);
  // Land the chosen pair BEFORE spawning anything (config + settings).
  await persistInstancePorts({ mode: "private", gatewayPort: gwPort, controllerPort: ctrlPort });
  if (needsSeed) await seedStandaloneConfig(preferredVendor, ctrlPort);
  else {
    // Pin the conflict-checked controller port into the sandbox config so
    // the plugin does not race its own auto-shift against a taken 9527.
    try {
      const c = JSON.parse(await fs.readFile(sandboxCfgPath, "utf8"));
      const cur = c?.plugins?.entries?.teamclaw?.config?.port;
      if (cur !== ctrlPort) await seedStandaloneConfig(preferredVendor, ctrlPort);
    } catch { await seedStandaloneConfig(preferredVendor, ctrlPort); }
  }
  STANDALONE.port = gwPort;
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
  // If the controller still auto-shifted despite the pinned port (race with
  // another process grabbing it between probe and bind), persist the ACTUAL
  // bound port so the next start remembers reality.
  const actualCtrl = controllerUrl ? Number(new URL(controllerUrl).port) : null;
  if (actualCtrl && actualCtrl !== ctrlPort) {
    await persistInstancePorts({ controllerPort: actualCtrl, controllerUrl });
  }
  const mPort = controllerUrl ? Number(new URL(controllerUrl).port) : null;
  return {
    ok: true,
    port: STANDALONE.port,
    pid: child.pid ?? null,
    controllerUrl: controllerUrl || `http://127.0.0.1:${STANDALONE.port}`,
    controllerPort: Number.isFinite(mPort) ? mPort : null,
  };
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

ipcMain.handle("standalone:start", async (_e, options) =>
  standaloneStart(options?.preferredVendor, options?.instance || null)
);
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
// Environment detection for the wizard (READ-ONLY). Decides the DEFAULT
// option: both present -> connect existing; openclaw only -> install into
// it (or private); neither -> full global install (private optional).
ipcMain.handle("env:detect", async () => {
  const globalState = path.join(process.env.HOME || "", ".openclaw");
  const cfgPath = path.join(globalState, "openclaw.json");
  let cfg = null;
  try { cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")); } catch { /* none */ }
  const openclaw = Boolean(cfg) || (await hasOpenClawInstalled());
  // teamclaw registered in the GLOBAL state? plugins.entries or extensions dir.
  const teamclawInGlobal = Boolean(
    cfg?.plugins?.entries?.teamclaw ||
    fsSync.existsSync(path.join(globalState, "plugins", "teamclaw"))
  );
  // Global controller URL is only inferred from the GLOBAL state, never
  // probed on a fixed port: a sandboxed desktop must not mistake a
  // foreign/production controller for its own. Liveness is checked later,
  // at connect time, by the caller.
  const globalControllerUrl = teamclawInGlobal
    ? `http://127.0.0.1:${controllerPortFromConfig(cfg)}`
    : null;
  return { openclaw, teamclawInGlobal, globalControllerUrl, llmConfigured: Boolean(cfg && Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey)) };
});


// Per-instance controller port: never assume the process-global 9527 - each
// OpenClaw instance (global or private) may run its controller on its own
// pinned/auto-shifted port. Read it from THAT state dir's config, then from
// the gateway log announce line (the source of truth after auto-shift).
function controllerPortFromConfig(cfg) {
  const p = Number(cfg?.plugins?.entries?.teamclaw?.config?.port);
  return Number.isFinite(p) && p > 0 ? p : 9527;
}
async function resolveInstanceControllerUrl(stateDir, cfgPort, logPaths) {
  const candidates = logPaths || [path.join(stateDir, "gateway.log"), path.join(stateDir, "logs", "gateway.log")];
  for (let i = 0; i < 45; i++) {
    for (const lp of candidates) {
      try {
        const log = await fs.readFile(lp, "utf8");
        // Announce line shape: "Controller: Web UI available at http://127.0.0.1:<port>/ui"
        // The /ui suffix is part of the real message - never anchor on end-of-string.
        const re = /Controller: Web UI available at http:\/\/127\.0\.0\.1:(\d+)/g;
        let last = null;
        for (let mm = re.exec(log); mm; mm = re.exec(log)) last = mm[1];
        if (last) {
          {
            const url = `http://127.0.0.1:${last}`;
            try {
              const r = await fetch(`${url}/api/v1/tunnel/status`, { signal: AbortSignal.timeout(1500) });
              if (r.ok) return url;
            } catch { /* announced but not answering yet */ }
          }
        }
      } catch { /* log not there yet */ }
    }
    // NO blind probe of the configured port: on a machine that already runs
    // another controller, that port belongs to a DIFFERENT instance and
    // accepting it silently attaches this app to a foreign gateway. The
    // announce line is the only trustworthy source; cfgPort is just a hint
    // for the caller's own diagnostics.
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

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
async function globalGatewayStart(preferredPort, extraEnv) {
  const port = Number(preferredPort) || (await findFreePort());
  const logFd = fsSync.openSync(path.join(app.getPath("userData"), "global-gateway.log"), "a");
  const env = { ...(extraEnv || process.env) };
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_PROFILE;
  const child = spawn(`openclaw gateway --port ${port}`, {
    cwd: env.HOME || process.env.HOME || process.cwd(),
    env,
    shell: true,
    stdio: ["ignore", logFd, logFd],
  });
  GLOBAL_GATEWAY.child = child;
  GLOBAL_GATEWAY.port = port;
  return { ok: true, port, pid: child.pid ?? null };
}
const GLOBAL_GATEWAY = { child: null, port: null };
// Install TeamClaw INTO the existing global OpenClaw (user-chosen path; the
// only flow allowed to write the global state - explicit consent by choice).
// Backs up the global cfg to the desktop dir first, then registers the plugin
// with the system openclaw CLI (global state, no sandbox env) and restarts the
// LaunchAgent gateway so the controller comes up.
ipcMain.handle("instance:install-into-global", async (event) => {
  const onEvent = (e) => { try { event.sender.send("bootstrap:install-event", e); } catch {} };
  const globalCfg = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  try {
    const bak = path.join(app.getPath("userData"), `global-cfg-backup-${Date.now()}.json`);
    await fs.copyFile(globalCfg, bak).catch(() => {});
    onEvent({ phase: "teamclaw", line: "Backed up global config to " + bak });
  } catch { /* no cfg yet */ }
  // Target the GLOBAL state explicitly: the app process may already carry a
  // private instance's OPENCLAW_STATE_DIR, and inheriting it would install
  // into the wrong instance.
  const gHome = process.env.HOME || process.cwd();
  const gEnv = { ...process.env, HOME: gHome, OPENCLAW_HOME: gHome };
  delete gEnv.OPENCLAW_STATE_DIR;
  delete gEnv.OPENCLAW_PROFILE;
  onEvent({ phase: "teamclaw", line: "Installing TeamClaw into the global OpenClaw (explicit choice)..." });
  await runShellStream("openclaw plugins install @teamclaws/teamclaw --force --accept-capabilities", gHome, (line) =>
    onEvent({ phase: "teamclaw", line }), gEnv);
  // The plugin defaults to WORKER mode; the desktop app needs this instance to
  // BE the controller. Without this the global gateway loads teamclaw as a
  // worker ("Identity: no controller found") and no dashboard API ever exists.
  const gCfgPath = path.join(gHome, ".openclaw", "openclaw.json");
  try {
    const c = JSON.parse(await fs.readFile(gCfgPath, "utf8"));
    c.plugins = c.plugins || {};
    c.plugins.entries = c.plugins.entries || {};
    const prev = c.plugins.entries.teamclaw || {};
    c.plugins.entries.teamclaw = {
      ...prev,
      enabled: true,
      config: { ...(prev.config || {}), mode: "controller", teamName: prev.config?.teamName || "global" },
    };
    await fs.writeFile(gCfgPath, JSON.stringify(c, null, 2), { mode: 0o600 });
    onEvent({ phase: "teamclaw", line: "Global instance set to controller mode." });
  } catch (e) {
    onEvent({ phase: "teamclaw", line: "Could not set controller mode: " + (e && e.message) });
  }
  onEvent({ phase: "teamclaw", line: "Restarting the global gateway..." });
  let restarted = true;
  try {
    await runShellStream("openclaw gateway restart", gHome, (line) =>
      onEvent({ phase: "teamclaw", line }), gEnv);
  } catch {
    // No service manager (fresh machine, sandbox, Linux w/o systemd unit):
    // restart is not available, so start the gateway ourselves instead of
    // failing the whole install.
    restarted = false;
  }
  if (!restarted) {
    let gPort = 18789;
    try {
      const c = JSON.parse(await fs.readFile(path.join(gHome, ".openclaw", "openclaw.json"), "utf8"));
      gPort = Number(c?.gateway?.port) || 18789;
    } catch { /* default */ }
    onEvent({ phase: "teamclaw", line: `No gateway service found - starting one on port ${gPort}...` });
    await globalGatewayStart(gPort, { ...gEnv, HOME: gHome });
  }
  // Resolve THIS instance's controller (pinned or auto-shifted port) from its
  // own config + gateway log - never the process-global 9527 default, which
  // may be another instance entirely.
  const gStateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "", ".openclaw");
  let gCfg = null;
  try { gCfg = JSON.parse(await fs.readFile(path.join(gStateDir, "openclaw.json"), "utf8")); } catch { /* none */ }
  const controllerUrl = await resolveInstanceControllerUrl(gStateDir, controllerPortFromConfig(gCfg), [
    path.join(app.getPath("userData"), "global-gateway.log"),
    path.join(gStateDir, "gateway.log"),
    path.join(gStateDir, "logs", "gateway.log"),
  ]);
  if (!controllerUrl) throw new Error(`Global controller did not come up in ${gStateDir} after install.`);
  onEvent({ phase: "done", line: "Global TeamClaw ready at " + controllerUrl });
  return { ok: true, controllerUrl };
});

ipcMain.handle("instance:start-global", () => globalGatewayStart());

ipcMain.handle("runtime:is-ready", async () => {
  const stateDir = path.join(app.getPath("userData"), "openclaw-state");
  let llm = false, plugin = false;
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8"));
    llm = Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey);
    // Plugin presence = registered in openclaw.json (the "Saved for the next
    // Gateway start" record). The old extensions/teamclaw/dist probe missed
    // npm-source installs (they land in npm/projects and only register in
    // the config), so readiness read false and boot fell back to the wizard.
    plugin = Boolean(cfg?.plugins?.entries?.teamclaw);
  } catch { /* no cfg */ }
  try {
    // Binary candidates kept as a secondary signal (bundled/sandbox/global).
    const candidates = [
      bundledBinary("openclaw"),
      path.join(app.getPath("userData"), "runtime", "node_modules", ".bin", "openclaw"),
      (await hasOpenClawInstalled()) ? "openclaw" : null,
    ];
    const cand = candidates.find(Boolean) || null;
    if (!plugin) plugin = Boolean(cand) && fsSync.existsSync(path.join(stateDir, "extensions", "teamclaw", "dist", "index.js"));
    void cand;
  } catch { /* no runtime */ }
  // Readiness = plugin installed + runtime binary present. LLM keys must NOT
  // gate readiness: "configure later" is a supported wizard path, and a
  // user who finished the install should boot straight into their private
  // instance (llm is still reported separately for the wizard to surface).
  return { ready: plugin, llm, plugin };
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
