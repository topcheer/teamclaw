import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("teamclawDesktop", {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getLocalSetupInfo: () => ipcRenderer.invoke("controller:get-setup-info"),
  bootstrapInstall: (options) => ipcRenderer.invoke("bootstrap:install", options),
  runtimeIsReady: () => ipcRenderer.invoke("runtime:is-ready"),
  standaloneStart: (options) => ipcRenderer.invoke("standalone:start", options),
  standaloneStop: () => ipcRenderer.invoke("standalone:stop"),
  standaloneStatus: () => ipcRenderer.invoke("standalone:status"),
  onBootstrapEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("bootstrap:install-event", handler);
    return () => ipcRenderer.removeListener("bootstrap:install-event", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  showNotification: (payload) => ipcRenderer.invoke("notification:show", payload),
  applyTheme: (theme) => ipcRenderer.invoke("window:apply-theme", theme),
});
