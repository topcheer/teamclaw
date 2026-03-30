import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETTINGS = {
  controllerUrl: "http://127.0.0.1:9527",
  localControllerUrl: "http://127.0.0.1:9527",
  localControllerCommand: "openclaw gateway run",
  localControllerCwd: "",
};

let mainWindow = null;
let localController = null;

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

function sendLocalControllerEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("local-controller:event", event);
}

function serializeLocalController() {
  if (!localController) {
    return {
      running: false,
      pid: null,
      command: "",
      cwd: "",
      startedAt: null,
      logLines: [],
    };
  }
  return {
    running: !localController.exited,
    pid: localController.child.pid ?? null,
    command: localController.command,
    cwd: localController.cwd,
    startedAt: localController.startedAt,
    logLines: localController.logLines.slice(-120),
  };
}

function appendLocalControllerLog(stream, chunk) {
  if (!localController) {
    return;
  }
  const text = String(chunk || "");
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    localController.logLines.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stream,
      line,
      createdAt: Date.now(),
    });
  }
  localController.logLines = localController.logLines.slice(-200);
  sendLocalControllerEvent({ type: "log", payload: serializeLocalController() });
}

async function stopLocalControllerProcess() {
  if (!localController || localController.exited) {
    localController = null;
    return serializeLocalController();
  }

  const child = localController.child;
  const pid = child.pid;
  localController.exited = true;
  try {
    if (process.platform === "win32" && pid) {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      await new Promise((resolve) => killer.on("exit", resolve));
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // best effort
  }
  localController = null;
  sendLocalControllerEvent({ type: "stopped", payload: serializeLocalController() });
  return serializeLocalController();
}

async function startLocalControllerProcess(options) {
  const command = String(options?.command || DEFAULT_SETTINGS.localControllerCommand).trim();
  const cwd = String(options?.cwd || "").trim() || process.cwd();
  if (!command) {
    throw new Error("Local controller command is required");
  }

  await stopLocalControllerProcess();

  const child = spawn(command, {
    cwd,
    env: process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  localController = {
    child,
    command,
    cwd,
    startedAt: Date.now(),
    exited: false,
    logLines: [],
  };

  child.stdout?.on("data", (chunk) => appendLocalControllerLog("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendLocalControllerLog("stderr", chunk));
  child.on("exit", (code, signal) => {
    if (!localController || localController.child !== child) {
      return;
    }
    localController.exited = true;
    appendLocalControllerLog("system", `Process exited (${signal || code || 0})`);
    sendLocalControllerEvent({
      type: "exit",
      payload: {
        ...serializeLocalController(),
        exitCode: code,
        signal,
      },
    });
  });

  sendLocalControllerEvent({ type: "started", payload: serializeLocalController() });
  return serializeLocalController();
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#0b1020",
    title: "TeamClaw Desktop",
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
  await createMainWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    await stopLocalControllerProcess();
    app.quit();
  }
});

ipcMain.handle("settings:get", async () => loadSettings());
ipcMain.handle("settings:save", async (_event, settings) => saveSettings(settings));
ipcMain.handle("controller:start-local", async (_event, options) => startLocalControllerProcess(options));
ipcMain.handle("controller:stop-local", async () => stopLocalControllerProcess());
ipcMain.handle("controller:status", async () => serializeLocalController());
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
