import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("teamclawDesktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getLocalSetupInfo: () => ipcRenderer.invoke("controller:get-setup-info"),
  installLocalTeamClaw: (options) => ipcRenderer.invoke("controller:install-local", options),
  installOpenClaw: (options) => ipcRenderer.invoke("openclaw:install-local", options),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  showNotification: (payload) => ipcRenderer.invoke("notification:show", payload),
});
