/* CODEX-MOD:app-server-tweaks@v3 */
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

function rewritePersistExtendedHistory(node) {
  if (!isPlainObject(node)) return false;
  const method = typeof node.method === "string" ? node.method : "";
  if (!method.startsWith("thread/")) return false;
  if (method === "thread/list") return false;
  if (method.endsWith("/list")) return false;
  if (method.startsWith("thread/realtime/")) return false;
  if (!isPlainObject(node.params)) return false;
  if (node.params.persistExtendedHistory === true) return false;
  node.params.persistExtendedHistory = true;
  return true;
}

function rewriteNode(node, depth) {
  if (depth > 6) return false;
  if (!node) return false;

  if (Array.isArray(node)) {
    let changed = false;
    for (const item of node) {
      if (rewriteNode(item, depth + 1)) changed = true;
    }
    return changed;
  }

  if (!isPlainObject(node)) return false;

  let changed = false;
  if (rewritePersistExtendedHistory(node)) changed = true;

  const keys = Object.keys(node);
  if (keys.length > 60) return changed;
  for (const key of keys) {
    if (rewriteNode(node[key], depth + 1)) changed = true;
  }
  return changed;
}

function wrapListener(listener) {
  if (typeof listener !== "function") return listener;
  return function wrappedListener(event, ...args) {
    for (const arg of args) rewriteNode(arg, 0);
    return listener.call(this, event, ...args);
  };
}

module.exports = function activate(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const electron = ctx.electron;
  const helpers = ctx.helpers;
  if (!electron || typeof electron !== "object") {
    throw new Error("app-server-tweaks: missing electron handle");
  }
  if (!helpers || typeof helpers !== "object") {
    throw new Error("app-server-tweaks: missing API helpers");
  }
  if (typeof helpers.isPlainObject !== "function") {
    throw new Error("app-server-tweaks: missing helpers.isPlainObject");
  }
  if (typeof helpers.wrapIpcListeners !== "function") {
    throw new Error("app-server-tweaks: missing helpers.wrapIpcListeners");
  }

  const ipcMain = electron.ipcMain;
  if (!ipcMain || typeof ipcMain !== "object") {
    throw new Error("app-server-tweaks: missing electron.ipcMain");
  }

  if (globalThis.__CODEX_MOD_APP_SERVER_TWEAKS_V2__) return;
  globalThis.__CODEX_MOD_APP_SERVER_TWEAKS_V2__ = true;

  helpers.wrapIpcListeners(ipcMain, wrapListener);
};
