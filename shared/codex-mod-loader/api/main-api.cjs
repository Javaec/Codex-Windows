/* CODEX-MOD-API:main@v1 */
"use strict";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function wrapIpcListeners(ipcMain, wrapListener) {
  if (!ipcMain || typeof ipcMain !== "object") {
    throw new Error("codex-mod-api: ipcMain is required");
  }
  if (typeof wrapListener !== "function") {
    throw new Error("codex-mod-api: wrapListener must be a function");
  }

  const originalOn = typeof ipcMain.on === "function" ? ipcMain.on.bind(ipcMain) : null;
  const originalOnce = typeof ipcMain.once === "function" ? ipcMain.once.bind(ipcMain) : null;
  const originalHandle = typeof ipcMain.handle === "function" ? ipcMain.handle.bind(ipcMain) : null;
  const originalHandleOnce = typeof ipcMain.handleOnce === "function" ? ipcMain.handleOnce.bind(ipcMain) : null;

  if (!originalOn || !originalHandle) {
    throw new Error("codex-mod-api: ipcMain.on/handle are required");
  }

  ipcMain.on = (channel, listener) => originalOn(channel, wrapListener(listener));
  if (originalOnce) {
    ipcMain.once = (channel, listener) => originalOnce(channel, wrapListener(listener));
  }
  ipcMain.handle = (channel, listener) => originalHandle(channel, wrapListener(listener));
  if (originalHandleOnce) {
    ipcMain.handleOnce = (channel, listener) => originalHandleOnce(channel, wrapListener(listener));
  }
}

function createMainModApi(context) {
  const nextContext = context && typeof context === "object" ? context : {};
  return {
    version: 1,
    modId: typeof nextContext.modId === "string" ? nextContext.modId : "",
    buildHint: typeof nextContext.buildHint === "number" ? nextContext.buildHint : 0,
    electron: nextContext.electron,
    helpers: {
      isPlainObject,
      wrapIpcListeners,
    },
  };
}

module.exports = {
  createMainModApi,
};
