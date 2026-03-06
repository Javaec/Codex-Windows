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
  if (typeof helpers.onBeforeAppServerRequest !== "function") {
    throw new Error("app-server-tweaks: missing helpers.onBeforeCodexRequest");
  }

  if (globalThis.__CODEX_MOD_APP_SERVER_TWEAKS_V2__) return;
  globalThis.__CODEX_MOD_APP_SERVER_TWEAKS_V2__ = true;

  helpers.onBeforeCodexRequest(electron, ({ method, params }) => {
    if (!method.startsWith("thread/")) return false;
    if (method === "thread/list") return false;
    if (method.endsWith("/list")) return false;
    if (method.startsWith("thread/realtime/")) return false;
    if (!params || typeof params !== "object") return false;
    if (params.persistExtendedHistory === true) return false;
    params.persistExtendedHistory = true;
    return true;
  }, { maxDepth: 6, maxKeys: 60 });
};
