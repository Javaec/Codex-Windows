/* CODEX-MOD:thread-status-bridge@v1 */
"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const STATE_EVENT_NAME = "codex-thread-activity-state";
const MAX_TRACKED_THREADS = 200;
const BROADCAST_DEBOUNCE_MS = 120;

function normalizePathString(value) {
  return typeof value === "string" ? value.trim().replace(/^"+|"+$/g, "") : "";
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

function createDebouncedRunner(delayMs, callback) {
  let timerId = 0;
  return function schedule() {
    if (timerId) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = 0;
      callback();
    }, delayMs);
  };
}

function normalizeTitleKey(value) {
  return normalizePathString(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function extractThreadId(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return match ? match[0].toLowerCase() : "";
}

function extractThreadIdFromObject(value) {
  if (!value || typeof value !== "object") return "";
  const directCandidates = [
    value.threadId,
    value.conversationId,
    value.id,
    value.thread && value.thread.id,
    value.turn && value.turn.threadId,
    value.params && value.params.threadId,
    value.params && value.params.conversationId,
  ];
  for (const candidate of directCandidates) {
    const threadId = extractThreadId(String(candidate || ""));
    if (threadId) return threadId;
  }
  return "";
}

function classifyThreadStatusFromMessage(message) {
  if (!message || typeof message !== "object") return null;

  const method = typeof message.method === "string" ? message.method : "";
  if (method === "turn/start" || method === "turn/started" || method === "thread/start") {
    const threadId = extractThreadIdFromObject(message.params || message);
    return threadId ? { threadId, status: "current", source: method } : null;
  }
  if (method === "turn/completed" || method === "turn/aborted") {
    const threadId = extractThreadIdFromObject(message.params || message);
    return threadId ? { threadId, status: "completed", source: method } : null;
  }

  const responseId = typeof message.id === "string" ? message.id : "";
  const result = message.result && typeof message.result === "object" ? message.result : null;
  if (!responseId || !result) return null;

  if (responseId.startsWith("thread/resume:") || responseId.startsWith("thread/read:")) {
    const thread = result.thread && typeof result.thread === "object" ? result.thread : result;
    const threadId = extractThreadIdFromObject(thread);
    if (!threadId) return null;

    let latestStatus = "";
    if (Array.isArray(thread.turns) && thread.turns.length > 0) {
      const latestTurn = thread.turns[thread.turns.length - 1];
      latestStatus = normalizePathString(latestTurn && latestTurn.status ? latestTurn.status : "").toLowerCase();
    }
    if (latestStatus === "completed" || latestStatus === "aborted") {
      return { threadId, status: "completed", source: responseId.split(":")[0] };
    }
    if (latestStatus && latestStatus !== "completed") {
      return { threadId, status: "current", source: responseId.split(":")[0] };
    }
  }

  return null;
}

function collectThreadEntries(value, out, depth) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectThreadEntries(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const threadId = extractThreadIdFromObject(value);
  const titleKey = normalizeTitleKey(value.title || value.name || value.label || "");
  const rawStatus = normalizeTitleKey(value.latestTurnStatus || value.turnStatus || value.status || "");
  if (threadId || titleKey) {
    out.push({
      threadId,
      titleKey,
      status:
        rawStatus === "completed" || rawStatus === "aborted"
          ? "completed"
          : (rawStatus ? "current" : ""),
    });
  }

  for (const childValue of Object.values(value)) {
    collectThreadEntries(childValue, out, depth + 1);
  }
}

module.exports = function activate(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const helpers = ctx.helpers;
  if (!helpers || typeof helpers !== "object") {
    throw new Error("thread-status-bridge: missing API helpers");
  }
  if (typeof helpers.onWindowCreated !== "function") {
    throw new Error("thread-status-bridge: missing helpers.onWindowCreated");
  }
  if (typeof helpers.onAppStart !== "function") {
    throw new Error("thread-status-bridge: missing helpers.onAppStart");
  }
  if (globalThis.__CODEX_THREAD_ACTIVITY_BRIDGE_V1__) return;
  globalThis.__CODEX_THREAD_ACTIVITY_BRIDGE_V1__ = true;

  const trackedWebContents = new Set();
  const threadStates = new Map();

  function createSerializableState() {
    const threads = {};
    for (const [threadId, entry] of threadStates.entries()) {
      threads[threadId] = {
        status: entry.status,
        updatedAtMs: entry.updatedAtMs,
        source: entry.source,
        titleKey: entry.titleKey || "",
      };
    }
    return {
      version: 1,
      threads,
    };
  }

  function injectState(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    const currentUrl = typeof webContents.getURL === "function" ? String(webContents.getURL() || "") : "";
    if (currentUrl.startsWith("devtools://")) return;
    const serialized = JSON.stringify(createSerializableState()).replace(/</g, "\\u003c");
    webContents.executeJavaScript(
      `window.__CODEX_THREAD_ACTIVITY_STATE__=${serialized};window.dispatchEvent(new CustomEvent(${JSON.stringify(STATE_EVENT_NAME)}));`,
      true,
    ).catch(() => {});
  }

  const broadcastState = createDebouncedRunner(BROADCAST_DEBOUNCE_MS, () => {
    for (const webContents of [...trackedWebContents]) {
      if (!webContents || webContents.isDestroyed()) {
        trackedWebContents.delete(webContents);
        continue;
      }
      injectState(webContents);
    }
  });

  function upsertThreadState(update) {
    if (!update || !update.threadId || !update.status) return;
    const existing = threadStates.get(update.threadId);
    threadStates.set(update.threadId, {
      status: update.status,
      updatedAtMs: Date.now(),
      source: update.source || "",
      titleKey: update.titleKey || (existing && existing.titleKey) || "",
    });
    if (threadStates.size > MAX_TRACKED_THREADS) {
      const ordered = [...threadStates.entries()].sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
      while (ordered.length > MAX_TRACKED_THREADS) {
        const stale = ordered.shift();
        if (!stale) break;
        threadStates.delete(stale[0]);
      }
    }
    broadcastState();
  }

  function ingestThreadEntries(message) {
    const entries = [];
    collectThreadEntries(message && typeof message === "object" ? message.result || message.params || message : null, entries, 0);
    for (const entry of entries) {
      if (!entry.threadId) continue;
      const existing = threadStates.get(entry.threadId);
      if (!existing && !entry.status && !entry.titleKey) continue;
      threadStates.set(entry.threadId, {
        status: entry.status || (existing && existing.status) || "",
        updatedAtMs: Date.now(),
        source: (existing && existing.source) || "thread-metadata",
        titleKey: entry.titleKey || (existing && existing.titleKey) || "",
      });
    }
  }

  function instrumentCodexChild(child, executablePath) {
    if (!child || child.__CODEX_THREAD_ACTIVITY_INSTRUMENTED__) return;
    child.__CODEX_THREAD_ACTIVITY_INSTRUMENTED__ = true;

    if (child.stdin && typeof child.stdin.write === "function") {
      const stdinTap = createJsonLineTap((message) => {
        ingestThreadEntries(message);
        const update = classifyThreadStatusFromMessage(message);
        if (update) upsertThreadState(update);
      });
      const originalWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = function patchedWrite(chunk, encoding, callback) {
        try {
          stdinTap(chunk);
        } catch {
          // ignore
        }
        return originalWrite(chunk, encoding, callback);
      };
    }

    if (child.stdout && typeof child.stdout.on === "function") {
      const stdoutTap = createJsonLineTap((message) => {
        ingestThreadEntries(message);
        const update = classifyThreadStatusFromMessage(message);
        if (update) upsertThreadState(update);
      });
      child.stdout.on("data", stdoutTap);
    }

    console.log(`[codex-thread-activity] attached executable=${executablePath}`);
  }

  function patchCodexSpawn() {
    if (globalThis.__CODEX_THREAD_ACTIVITY_SPAWN_PATCHED__) return;
    globalThis.__CODEX_THREAD_ACTIVITY_SPAWN_PATCHED__ = true;

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

  patchCodexSpawn();

  helpers.onWindowCreated(ctx.electron, ({ browserWindow }) => {
    if (!browserWindow || !browserWindow.webContents) return;
    const contents = browserWindow.webContents;
    trackedWebContents.add(contents);
    contents.on("did-finish-load", () => injectState(contents));
    contents.on("render-process-gone", () => {
      trackedWebContents.add(contents);
    });
    contents.on("destroyed", () => {
      trackedWebContents.delete(contents);
    });
  });

  helpers.onAppStart(ctx.electron, () => {
    console.log("[codex-thread-activity] bridge started");
  });
};
