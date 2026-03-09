"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexForgeHost", {
  shell: "electron",
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openPath(targetPath) {
    return ipcRenderer.invoke("codex-forge:open-path", targetPath);
  },
  pickDirectory() {
    return ipcRenderer.invoke("codex-forge:pick-directory");
  },
});
