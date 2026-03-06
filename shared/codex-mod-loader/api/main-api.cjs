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

function walkJsonTree(node, visit, depth, maxDepth, maxKeys) {
  if (depth > maxDepth || !node) return false;

  if (Array.isArray(node)) {
    let changed = false;
    for (const item of node) {
      if (walkJsonTree(item, visit, depth + 1, maxDepth, maxKeys)) changed = true;
    }
    return changed;
  }

  if (!isPlainObject(node)) return false;

  let changed = visit(node) === true;
  const keys = Object.keys(node);
  if (keys.length > maxKeys) return changed;
  for (const key of keys) {
    if (walkJsonTree(node[key], visit, depth + 1, maxDepth, maxKeys)) changed = true;
  }
  return changed;
}

function looksLikeCodexMethod(value) {
  return typeof value === "string" && value.includes("/") && value.length >= 3;
}

function looksLikeCodexRequestEnvelope(node) {
  if (!isPlainObject(node)) return false;
  if (!looksLikeCodexMethod(node.method)) return false;
  if ("params" in node && node.params !== undefined && !isPlainObject(node.params)) return false;
  return true;
}

function looksLikeCodexResponseEnvelope(node) {
  if (!isPlainObject(node)) return false;
  if (!looksLikeCodexMethod(node.method)) return false;
  if ("result" in node || "errorCode" in node || "responseType" in node || "durationMs" in node) return true;
  return false;
}

function visitCodexEnvelopes(root, predicate, visit, maxDepth, maxKeys) {
  const seen = new WeakSet();
  walkJsonTree(
    root,
    (node) => {
      if (!isPlainObject(node)) return false;
      if (seen.has(node)) return false;
      if (!predicate(node)) return false;
      seen.add(node);
      return visit({
        envelope: node,
        method: String(node.method || ""),
        params: isPlainObject(node.params) ? node.params : null,
        requestId: typeof node.requestId === "string" ? node.requestId : "",
      });
    },
    0,
    maxDepth,
    maxKeys,
  );
}

function onBeforeAppServerRequest(electron, visit, options) {
  if (!electron || typeof electron !== "object") {
    throw new Error("codex-mod-api: electron is required");
  }
  if (typeof visit !== "function") {
    throw new Error("codex-mod-api: onBeforeAppServerRequest requires a visitor");
  }

  const nextOptions = options && typeof options === "object" ? options : {};
  const maxDepth = Number.isFinite(nextOptions.maxDepth) ? Number(nextOptions.maxDepth) : 6;
  const maxKeys = Number.isFinite(nextOptions.maxKeys) ? Number(nextOptions.maxKeys) : 60;
  const ipcMain = electron.ipcMain;

  wrapIpcListeners(ipcMain, (listener) => {
    if (typeof listener !== "function") return listener;
    return function wrappedListener(event, ...args) {
      for (const arg of args) {
        walkJsonTree(arg, visit, 0, maxDepth, maxKeys);
      }
      return listener.call(this, event, ...args);
    };
  });
}

function onAfterAppServerResponse(electron, visit, options) {
  if (!electron || typeof electron !== "object") {
    throw new Error("codex-mod-api: electron is required");
  }
  if (typeof visit !== "function") {
    throw new Error("codex-mod-api: onAfterAppServerResponse requires a visitor");
  }

  const nextOptions = options && typeof options === "object" ? options : {};
  const maxDepth = Number.isFinite(nextOptions.maxDepth) ? Number(nextOptions.maxDepth) : 6;
  const maxKeys = Number.isFinite(nextOptions.maxKeys) ? Number(nextOptions.maxKeys) : 60;
  const ipcMain = electron.ipcMain;

  wrapIpcListeners(ipcMain, (listener) => {
    if (typeof listener !== "function") return listener;
    return function wrappedListener(event, ...args) {
      const result = listener.call(this, event, ...args);
      const visitResult = (value) => {
        walkJsonTree(value, visit, 0, maxDepth, maxKeys);
        return value;
      };
      if (result && typeof result.then === "function") {
        result.then(visitResult, () => {});
        return result;
      }
      visitResult(result);
      return result;
    };
  });
}

function onBeforeCodexRequest(electron, visit, options) {
  if (!electron || typeof electron !== "object") {
    throw new Error("codex-mod-api: electron is required");
  }
  if (typeof visit !== "function") {
    throw new Error("codex-mod-api: onBeforeCodexRequest requires a visitor");
  }

  const nextOptions = options && typeof options === "object" ? options : {};
  const maxDepth = Number.isFinite(nextOptions.maxDepth) ? Number(nextOptions.maxDepth) : 6;
  const maxKeys = Number.isFinite(nextOptions.maxKeys) ? Number(nextOptions.maxKeys) : 60;
  const ipcMain = electron.ipcMain;

  wrapIpcListeners(ipcMain, (listener) => {
    if (typeof listener !== "function") return listener;
    return function wrappedListener(event, ...args) {
      for (const arg of args) {
        visitCodexEnvelopes(arg, looksLikeCodexRequestEnvelope, visit, maxDepth, maxKeys);
      }
      return listener.call(this, event, ...args);
    };
  });
}

function onAfterCodexResponse(electron, visit, options) {
  if (!electron || typeof electron !== "object") {
    throw new Error("codex-mod-api: electron is required");
  }
  if (typeof visit !== "function") {
    throw new Error("codex-mod-api: onAfterCodexResponse requires a visitor");
  }

  const nextOptions = options && typeof options === "object" ? options : {};
  const maxDepth = Number.isFinite(nextOptions.maxDepth) ? Number(nextOptions.maxDepth) : 6;
  const maxKeys = Number.isFinite(nextOptions.maxKeys) ? Number(nextOptions.maxKeys) : 60;
  const ipcMain = electron.ipcMain;

  wrapIpcListeners(ipcMain, (listener) => {
    if (typeof listener !== "function") return listener;
    return function wrappedListener(event, ...args) {
      const result = listener.call(this, event, ...args);
      const visitResult = (value) => {
        visitCodexEnvelopes(value, looksLikeCodexResponseEnvelope, visit, maxDepth, maxKeys);
        return value;
      };
      if (result && typeof result.then === "function") {
        result.then(visitResult, () => {});
        return result;
      }
      visitResult(result);
      return result;
    };
  });
}

function onAppStart(electron, callback) {
  if (!electron || typeof electron !== "object" || !electron.app) {
    throw new Error("codex-mod-api: electron.app is required");
  }
  if (typeof callback !== "function") {
    throw new Error("codex-mod-api: onAppStart requires a callback");
  }
  if (electron.app.isReady()) {
    queueMicrotask(() => callback({ electron, app: electron.app }));
    return () => {};
  }
  const handler = () => callback({ electron, app: electron.app });
  electron.app.once("ready", handler);
  return () => electron.app.removeListener("ready", handler);
}

function onWindowCreated(electron, callback) {
  if (!electron || typeof electron !== "object" || !electron.app) {
    throw new Error("codex-mod-api: electron.app is required");
  }
  if (typeof callback !== "function") {
    throw new Error("codex-mod-api: onWindowCreated requires a callback");
  }
  const handler = (_event, browserWindow) => callback({ electron, browserWindow });
  electron.app.on("browser-window-created", handler);
  return () => electron.app.removeListener("browser-window-created", handler);
}

function onWebContentsReady(electron, callback) {
  if (!electron || typeof electron !== "object" || !electron.app) {
    throw new Error("codex-mod-api: electron.app is required");
  }
  if (typeof callback !== "function") {
    throw new Error("codex-mod-api: onWebContentsReady requires a callback");
  }
  const createdHandler = (_event, webContents) => {
    if (!webContents || typeof webContents.on !== "function") return;
    webContents.on("dom-ready", () => callback({ electron, webContents }));
  };
  electron.app.on("web-contents-created", createdHandler);
  return () => electron.app.removeListener("web-contents-created", createdHandler);
}

function createMainModApi(context) {
  const nextContext = context && typeof context === "object" ? context : {};
  return {
    version: 1,
    modId: typeof nextContext.modId === "string" ? nextContext.modId : "",
    buildHint: typeof nextContext.buildHint === "number" ? nextContext.buildHint : 0,
    capabilities: Array.isArray(nextContext.capabilities) ? nextContext.capabilities.slice() : [],
    electron: nextContext.electron,
    helpers: {
      isPlainObject,
      wrapIpcListeners,
      walkJsonTree,
      onAppStart,
      onWindowCreated,
      onWebContentsReady,
      onBeforeAppServerRequest,
      onAfterAppServerResponse,
      onBeforeCodexRequest,
      onAfterCodexResponse,
    },
  };
}

module.exports = {
  createMainModApi,
};
