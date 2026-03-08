/* CODEX-MOD:auth-session-runtime@v1 */
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WATCH_DEBOUNCE_MS = 400;
const WATCH_POLL_INTERVAL_MS = 2000;

function normalizePathString(value) {
  return typeof value === "string" ? value.trim().replace(/^"+|"+$/g, "") : "";
}

function normalizeBoolean(value) {
  return value === true ? 1 : 0;
}

function logAuthRuntime(event, details) {
  const payload = {
    event,
    ...details,
  };
  console.log(`[codex-auth-runtime] ${JSON.stringify(payload)}`);
}

function fileExists(candidatePath) {
  try {
    return fs.existsSync(candidatePath);
  } catch {
    return false;
  }
}

function resolveCodexHomeDir() {
  const configured = normalizePathString(process.env.CODEX_HOME || "");
  if (configured) return path.resolve(configured);
  const userProfile = normalizePathString(process.env.USERPROFILE || process.env.HOME || "");
  if (!userProfile) return "";
  return path.join(userProfile, ".codex");
}

function resolveAuthJsonPath() {
  const codexHomeDir = resolveCodexHomeDir();
  if (!codexHomeDir) return "";
  return path.join(codexHomeDir, "auth.json");
}

function stableHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function summarizeAuthJson(filePath) {
  const exists = fileExists(filePath);
  if (!exists) {
    return {
      path: filePath,
      exists: 0,
      parseOk: 0,
      fingerprint: "",
      sizeBytes: 0,
      mtimeMs: 0,
      topLevelKeys: [],
      authMethod: "",
      provider: "",
      hasAccessToken: 0,
      hasRefreshToken: 0,
      hasIdToken: 0,
      hasApiKey: 0,
    };
  }

  const stats = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const summary = {
    path: filePath,
    exists: 1,
    parseOk: 0,
    fingerprint: stableHash(raw),
    sizeBytes: Number(stats.size || 0),
    mtimeMs: Number(stats.mtimeMs || 0),
    topLevelKeys: [],
    authMethod: "",
    provider: "",
    hasAccessToken: 0,
    hasRefreshToken: 0,
    hasIdToken: 0,
    hasApiKey: 0,
  };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      summary.parseOk = 1;
      summary.topLevelKeys = Object.keys(parsed).sort().slice(0, 24);
      summary.authMethod = normalizePathString(parsed.authMethod || parsed.method || "");
      summary.provider = normalizePathString(parsed.provider || parsed.authProvider || "");
      summary.hasAccessToken = normalizeBoolean(Boolean(parsed.accessToken || parsed.access_token));
      summary.hasRefreshToken = normalizeBoolean(Boolean(parsed.refreshToken || parsed.refresh_token));
      summary.hasIdToken = normalizeBoolean(Boolean(parsed.idToken || parsed.id_token));
      summary.hasApiKey = normalizeBoolean(Boolean(parsed.apiKey || parsed.api_key));
    }
  } catch {
    summary.parseOk = 0;
  }

  return summary;
}

function createDebouncedRunner(delayMs, callback) {
  let timerId = 0;
  return function schedule(reason) {
    if (timerId) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = 0;
      callback(reason);
    }, delayMs);
  };
}

function watchAuthFile() {
  const authJsonPath = resolveAuthJsonPath();
  if (!authJsonPath) return () => {};

  let previousSummary;
  try {
    previousSummary = summarizeAuthJson(authJsonPath);
    logAuthRuntime("auth-file-snapshot", { reason: "startup", ...previousSummary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAuthRuntime("auth-file-watch-error", { reason: "startup", path: authJsonPath, message });
    previousSummary = null;
  }

  const emitSnapshot = (reason) => {
    try {
      const nextSummary = summarizeAuthJson(authJsonPath);
      const changed =
        !previousSummary ||
        nextSummary.fingerprint !== previousSummary.fingerprint ||
        nextSummary.mtimeMs !== previousSummary.mtimeMs ||
        nextSummary.sizeBytes !== previousSummary.sizeBytes;
      if (!changed && reason !== "startup") return;
      previousSummary = nextSummary;
      globalThis.__CODEX_AUTH_RUNTIME_LAST_FILE_CHANGE_AT__ = Date.now();
      logAuthRuntime("auth-file-changed", { reason, ...nextSummary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logAuthRuntime("auth-file-watch-error", { reason, path: authJsonPath, message });
    }
  };

  const scheduleSnapshot = createDebouncedRunner(WATCH_DEBOUNCE_MS, emitSnapshot);
  const directoryPath = path.dirname(authJsonPath);
  const authFileName = path.basename(authJsonPath).toLowerCase();

  let watcher = null;
  if (fileExists(directoryPath)) {
    try {
      watcher = fs.watch(directoryPath, { persistent: false }, (eventType, fileName) => {
        const changedFileName = normalizePathString(fileName || "").toLowerCase();
        if (changedFileName && changedFileName !== authFileName) return;
        scheduleSnapshot(`fs-watch:${eventType || "change"}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logAuthRuntime("auth-file-watch-error", { reason: "watch-init", path: authJsonPath, message });
    }
  }

  const pollTimer = setInterval(() => {
    scheduleSnapshot("poll");
  }, WATCH_POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  return () => {
    if (watcher && typeof watcher.close === "function") {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    clearInterval(pollTimer);
  };
}

function createJsonLineTap(onMessage) {
  let buffer = "";
  return function pushChunk(chunk) {
    if (chunk == null) return;
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line || (line[0] !== "{" && line[0] !== "[")) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore malformed non-protocol output
      }
    }
  };
}

function summarizeAuthStatusResponse(message) {
  if (!message || typeof message !== "object") return {};
  const result = message.result && typeof message.result === "object" ? message.result : null;
  const error = message.error && typeof message.error === "object" ? message.error : null;
  return {
    requestId: typeof message.id === "string" ? message.id : "",
    hasError: normalizeBoolean(Boolean(error)),
    errorCode: error && error.code != null ? String(error.code) : "",
    authMethod: result && typeof result.authMethod === "string" ? result.authMethod : "",
    hasToken: normalizeBoolean(Boolean(result && result.authToken)),
    hasAccountId: normalizeBoolean(Boolean(result && result.accountId)),
    hasUserId: normalizeBoolean(Boolean(result && result.userId)),
    hasEmail: normalizeBoolean(Boolean(result && result.email)),
    hasPlan: normalizeBoolean(Boolean(result && result.planType)),
  };
}

function instrumentCodexChild(child, executablePath) {
  if (!child || child.__CODEX_AUTH_RUNTIME_INSTRUMENTED__) return;
  child.__CODEX_AUTH_RUNTIME_INSTRUMENTED__ = true;

  const pid = typeof child.pid === "number" ? child.pid : 0;
  logAuthRuntime("codex-transport-spawn", {
    pid,
    executable: executablePath,
  });

  if (child.stdin && typeof child.stdin.write === "function") {
    const stdinTap = createJsonLineTap((message) => {
      if (!message || typeof message !== "object") return;
      if (message.method !== "getAuthStatus") return;
      const params = message.params && typeof message.params === "object" ? message.params : {};
      logAuthRuntime("get-auth-status-request", {
        pid,
        requestId: typeof message.id === "string" ? message.id : "",
        includeToken: normalizeBoolean(Boolean(params.includeToken)),
        refreshToken: normalizeBoolean(Boolean(params.refreshToken)),
      });
    });

    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = function patchedWrite(chunk, encoding, callback) {
      try {
        stdinTap(chunk);
      } catch {
        // ignore tap failures
      }
      return originalWrite(chunk, encoding, callback);
    };
  }

  if (child.stdout && typeof child.stdout.on === "function") {
    const stdoutTap = createJsonLineTap((message) => {
      if (!message || typeof message !== "object") return;
      if (message.method === "account/updated") {
        logAuthRuntime("account-updated-notification", {
          pid,
          method: "account/updated",
          hasParams: normalizeBoolean(Boolean(message.params && typeof message.params === "object")),
        });
        return;
      }
      if (message.method === "account/login/completed") {
        logAuthRuntime("account-login-completed-notification", {
          pid,
          method: "account/login/completed",
        });
        return;
      }
      if (typeof message.id === "string" && message.id.startsWith("electron-auth:")) {
        logAuthRuntime("get-auth-status-response", {
          pid,
          ...summarizeAuthStatusResponse(message),
        });
      }
    });
    child.stdout.on("data", stdoutTap);
  }

  child.on("close", (code, signal) => {
    logAuthRuntime("codex-transport-close", {
      pid,
      code: Number.isFinite(code) ? code : "",
      signal: typeof signal === "string" ? signal : "",
    });
  });
}

function patchCodexSpawn() {
  if (globalThis.__CODEX_AUTH_RUNTIME_SPAWN_PATCHED__) return;
  globalThis.__CODEX_AUTH_RUNTIME_SPAWN_PATCHED__ = true;

  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function patchedSpawn(...args) {
    const child = originalSpawn.apply(this, args);
    const file = args.length > 0 ? args[0] : "";
    const executablePath = normalizePathString(file || "");
    const baseName = path.basename(executablePath).toLowerCase();
    if (baseName === "codex.exe" || baseName === "codex") {
      instrumentCodexChild(child, executablePath);
    }
    return child;
  };
}

module.exports = function activate(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const helpers = ctx.helpers;
  if (!helpers || typeof helpers !== "object") {
    throw new Error("auth-session-runtime: missing API helpers");
  }
  if (typeof helpers.onAppStart !== "function") {
    throw new Error("auth-session-runtime: missing helpers.onAppStart");
  }
  if (globalThis.__CODEX_AUTH_RUNTIME_CONTRACT_V1__) return;
  globalThis.__CODEX_AUTH_RUNTIME_CONTRACT_V1__ = true;

  patchCodexSpawn();
  const disposeWatcher = watchAuthFile();

  helpers.onAppStart(ctx.electron, () => {
    logAuthRuntime("app-start", {
      authJsonPath: resolveAuthJsonPath(),
      codexHome: resolveCodexHomeDir(),
    });
  });

  process.once("exit", () => {
    try {
      disposeWatcher();
    } catch {
      // ignore
    }
  });
};
