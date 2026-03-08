/* CODEX-MOD:session-request-guard@v1 */
"use strict";

const AUTH_REFRESH_DEBOUNCE_MS = 2500;
const SAFE_THREAD_LIST_LIMIT = 30;

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

function rewriteThreadListLimit(node) {
  if (!isPlainObject(node)) return false;
  if (node.method !== "thread/list") return false;
  if (!isPlainObject(node.params)) return false;

  const currentLimit = Number(node.params.limit);
  if (Number.isFinite(currentLimit) && currentLimit > 0 && currentLimit <= SAFE_THREAD_LIST_LIMIT) {
    return false;
  }
  node.params.limit = SAFE_THREAD_LIST_LIMIT;
  return true;
}

module.exports = function activate(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const electron = ctx.electron;
  const helpers = ctx.helpers;
  if (!electron || typeof electron !== "object") {
    throw new Error("session-request-guard: missing electron handle");
  }
  if (!helpers || typeof helpers !== "object") {
    throw new Error("session-request-guard: missing API helpers");
  }
  if (typeof helpers.isPlainObject !== "function") {
    throw new Error("session-request-guard: missing helpers.isPlainObject");
  }
  if (typeof helpers.onBeforeAppServerRequest !== "function") {
    throw new Error("session-request-guard: missing helpers.onBeforeAppServerRequest");
  }
  if (typeof helpers.onBeforeCodexRequest !== "function") {
    throw new Error("session-request-guard: missing helpers.onBeforeCodexRequest");
  }

  if (globalThis.__CODEX_MOD_SESSION_REQUEST_GUARD_V1__) return;
  globalThis.__CODEX_MOD_SESSION_REQUEST_GUARD_V1__ = true;

  let lastAuthRefreshAt = 0;

  helpers.onBeforeAppServerRequest(
    electron,
    (node) => {
      if (!isPlainObject(node)) return false;
      if (node.method !== "getAuthStatus") return false;
      if (!isPlainObject(node.params)) return false;
      if (node.params.refreshToken !== true) return false;

      const now = Date.now();
      const lastAuthFileChangeAt = Number(globalThis.__CODEX_AUTH_RUNTIME_LAST_FILE_CHANGE_AT__ || 0);
      if (lastAuthFileChangeAt > lastAuthRefreshAt) {
        lastAuthRefreshAt = now;
        return false;
      }
      if (now - lastAuthRefreshAt < AUTH_REFRESH_DEBOUNCE_MS) {
        node.params.refreshToken = false;
        return true;
      }
      lastAuthRefreshAt = now;
      return false;
    },
    { maxDepth: 5, maxKeys: 40 },
  );

  helpers.onBeforeCodexRequest(
    electron,
    ({ envelope, method, params }) => {
      if (rewritePersistExtendedHistory(envelope)) return true;
      if (method === "thread/list" && isPlainObject(params)) {
        return rewriteThreadListLimit(envelope);
      }
      return false;
    },
    { maxDepth: 6, maxKeys: 60 },
  );
};
