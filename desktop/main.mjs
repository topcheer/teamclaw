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
//   gitlab   - prebuilt tar/zip from a GitLab artifact URL
const BUNDLED_BIN_DIR = () => path.join(process.resourcesPath || "", "bin");

function bundledBinary(name) {
  const candidate = path.join(BUNDLED_BIN_DIR(), name);
  return fsSync.existsSync(candidate) ? candidate : null;
}

function resolveInstallSource(source) {
  switch (source) {
    case "bundled":
    case "official":
    case "gitlab":
      return source;
    default:
      // Auto: prefer a bundled binary when present, else npm.
      return bundledBinary("openclaw") ? "bundled" : "official";
  }
}

async function ensureOpenClawRuntime({ source, gitlabUrl }, onEvent) {
  // Returns the openclaw command (bundled path or global CLI name).
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
  if (src === "gitlab") {
    if (!gitlabUrl) throw new Error("GitLab artifact URL is required for the gitlab source.");
    const workDir = path.join(app.getPath("userData"), "downloads");
    await fs.mkdir(workDir, { recursive: true });
    const fileName = gitlabUrl.split("/").pop() || "artifact.tgz";
    const dest = path.join(workDir, fileName);
    onEvent({ phase: "openclaw", line: `Downloading GitLab artifact ${fileName}...` });
    await runShellStream(`curl -fSL --retry 3 -o "${dest}" "${gitlabUrl}"`, workDir, (line) =>
      onEvent({ phase: "openclaw", line }),
    );
    const extractDir = path.join(workDir, fileName.replace(/\.(tar\.gz|tgz|zip)$/, ""));
    await fs.mkdir(extractDir, { recursive: true });
    onEvent({ phase: "openclaw", line: `Extracting to ${extractDir}...` });
    if (/\.(tar\.gz|tgz)$/.test(fileName)) {
      await runShellStream(`tar xzf "${dest}" -C "${extractDir}"`, workDir, (line) => onEvent({ phase: "openclaw", line }));
    } else if (/\.zip$/.test(fileName)) {
      await runShellStream(`unzip -oq "${dest}" -d "${extractDir}"`, workDir, (line) => onEvent({ phase: "openclaw", line }));
    }
    // Locate the openclaw binary inside the extracted tree.
    const found = await runShellCommand(`find "${extractDir}" -name openclaw -type f -perm +111 | head -1`, { cwd: workDir });
    const bin = (found.stdout || "").trim();
    if (!bin) throw new Error("No openclaw binary found inside the GitLab artifact.");
    await fs.chmod(bin, 0o755).catch(() => {});
    onEvent({ phase: "openclaw", line: "GitLab artifact ready: " + bin });
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
  if ((res.stdout || "").includes("teamclaw")) {
    onEvent({ phase: "teamclaw", line: "TeamClaw plugin already installed." });
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
  cfg.vendors = cfg.vendors || {};
  cfg.vendors[provider] = { ...(cfg.vendors[provider] || {}), apiKey, ...(endpoint ? { baseUrl: endpoint } : {}) };
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
          if (line) onLine(line);
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
const STANDALONE = { child: null, port: null, pid: null };

function standaloneStateDir() {
  return path.join(app.getPath("userData"), "standalone-state");
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
  // Copy the user's LLM config (READ-ONLY source) into the sandbox state;
  // optionally pin a preferred vendor. Never writes the user's file.
  const stateDir = standaloneStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  const dst = path.join(stateDir, "openclaw.json");
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(dst, "utf8")); } catch { cfg = {}; }
  const userCfgPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  try {
    const userCfg = JSON.parse(await fs.readFile(userCfgPath, "utf8"));
    cfg.vendors = { ...(userCfg.vendors || {}), ...(cfg.vendors || {}) };
  } catch { /* no user config - empty start */ }
  if (preferredVendor && cfg.vendors && cfg.vendors[preferredVendor]) {
    cfg.preferredVendor = preferredVendor;
  }
  await fs.writeFile(dst, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return dst;
}

async function standaloneStart(preferredVendor) {
  if (STANDALONE.child) return { ok: true, alreadyRunning: true, port: STANDALONE.port };
  const bin = await standaloneBinary();
  await seedStandaloneConfig(preferredVendor);
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
  return { ok: true, port: STANDALONE.port, pid: child.pid ?? null, controllerUrl: `http://127.0.0.1:${STANDALONE.port}` };
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
    controllerUrl: STANDALONE.port ? `http://127.0.0.1:${STANDALONE.port}` : null,
    stateDir: standaloneStateDir(),
  };
}

ipcMain.handle("standalone:start", async (_e, options) => standaloneStart(options?.preferredVendor));
ipcMain.handle("standalone:stop", () => standaloneStop());
ipcMain.handle("standalone:status", () => standaloneStatus());

// App lifecycle: the desktop-owned instance dies with the app (no orphans).
app.on("before-quit", () => { try { STANDALONE.child?.kill("SIGTERM"); } catch { /* gone */ } });

ipcMain.handle("bootstrap:install", async (event, options) => {
  // Orchestrate the sandboxed bootstrap with streamed progress events.
  // NEVER touches the user's global installs or ~/.openclaw (hard rule).
  const onEvent = (e) => {
    try { event.sender.send("bootstrap:install-event", e); } catch { /* window gone */ }
  };
  const { llm, source, gitlabUrl } = options || {};
  try {
    onEvent({ phase: "start", line: "Starting sandboxed bootstrap..." });
    const openclawBin = await ensureOpenClawRuntime({ source, gitlabUrl }, onEvent);
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
ipcMain.handle("controller:install-local", async (_event, options) => installLocalTeamClaw(options));
ipcMain.handle("openclaw:install-local", async (_event, options) => installOpenClawLocally(options));
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
