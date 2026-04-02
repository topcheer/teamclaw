import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETTINGS = {
  controllerUrl: "http://127.0.0.1:9527",
};

let mainWindow = null;

const LOCAL_SETUP_MODES = [
  {
    id: "controller-manual",
    title: "Local quickstart",
    description: "Runs the controller here and launches local worker processes on demand with controller-decided defaults.",
    warning: "Leanest local setup. TeamClaw still provisions local worker processes on demand, but uses a smaller default worker pool.",
    recommended: false,
  },
  {
    id: "controller-process",
    title: "Local multi-process",
    description: "Runs the controller here and provisions local worker processes on demand.",
    warning: "Uses more CPU and memory, but gives local workers stronger process isolation.",
    recommended: true,
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
  const selectedMode = LOCAL_SETUP_MODES.some((entry) => entry.id === mode) ? mode : "controller-process";
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
    openClawInstallCommand: "npm install -g openclaw@latest",
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
    env: process.env,
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

async function installLocalTeamClaw(options) {
  const mode = String(options?.mode || "controller-process").trim();
  const command = buildLocalInstallCommand(mode);
  return await runShellCommand(command, { cwd: String(options?.cwd || "").trim() || process.cwd() });
}

async function installOpenClawLocally(options) {
  const command = String(options?.command || "npm install -g openclaw@latest").trim();
  if (!command) {
    throw new Error("OpenClaw install command is required");
  }
  return await runShellCommand(command, { cwd: String(options?.cwd || "").trim() || process.cwd() });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#0b1020",
    title: "TeamClaw Desktop",
    icon: getDesktopIconPath(),
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
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(getDesktopIconPath());
  }
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

ipcMain.handle("settings:get", async () => loadSettings());
ipcMain.handle("settings:save", async (_event, settings) => saveSettings(settings));
ipcMain.handle("controller:get-setup-info", async () => getLocalSetupInfo());
ipcMain.handle("controller:install-local", async (_event, options) => installLocalTeamClaw(options));
ipcMain.handle("openclaw:install-local", async (_event, options) => installOpenClawLocally(options));
ipcMain.handle("shell:openExternal", async (_event, url) => {
  await shell.openExternal(String(url || ""));
});
ipcMain.handle("notification:show", async (_event, payload) => {
  const title = String(payload?.title || "TeamClaw");
  const body = String(payload?.body || "");
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});
