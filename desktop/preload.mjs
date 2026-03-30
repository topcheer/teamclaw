import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("teamclawDesktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  startLocalController: (options) => ipcRenderer.invoke("controller:start-local", options),
  stopLocalController: () => ipcRenderer.invoke("controller:stop-local"),
  getLocalControllerStatus: () => ipcRenderer.invoke("controller:status"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  showNotification: (payload) => ipcRenderer.invoke("notification:show", payload),
  onLocalControllerEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("local-controller:event", wrapped);
    return () => ipcRenderer.removeListener("local-controller:event", wrapped);
  },
});
