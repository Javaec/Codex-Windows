(function () {
  if (typeof window === "undefined") {
    return;
  }

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_THREADS_PER_PROJECT_CAP_V1__) {
    return;
  }
  globalRecord.__CODEX_WINDOWS_THREADS_PER_PROJECT_CAP_V1__ = true;

  const TARGET_METHOD = "thread/list";
  const TARGET_LIMIT = 10;
  const PER_PROJECT_LIMIT = 6;

  const trackedRequestIds = new Set();

  function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  }

  function readStringField(target, key) {
    if (!target || typeof target !== "object") return "";
    if (!hasOwn(target, key)) return "";
    const value = target[key];
    return typeof value === "string" ? value : "";
  }

  function readNumberField(target, key) {
    if (!target || typeof target !== "object") return undefined;
    if (!hasOwn(target, key)) return undefined;
    const value = target[key];
    const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  function readObjectField(target, key) {
    if (!target || typeof target !== "object") return undefined;
    if (!hasOwn(target, key)) return undefined;
    const value = target[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value;
  }

  function readRequestId(message) {
    const direct = readStringField(message, "id") || readStringField(message, "requestId") || readStringField(message, "request_id");
    if (direct.length > 0) return direct;
    const nestedRequest = readObjectField(message, "request");
    if (nestedRequest) {
      const nested = readStringField(nestedRequest, "id") || readStringField(nestedRequest, "requestId") || readStringField(nestedRequest, "request_id");
      if (nested.length > 0) return nested;
    }
    return "";
  }

  function readMethod(message) {
    const direct = readStringField(message, "method");
    if (direct.length > 0) return direct;
    const nestedRequest = readObjectField(message, "request");
    if (nestedRequest) {
      const nested = readStringField(nestedRequest, "method");
      if (nested.length > 0) return nested;
    }
    return "";
  }

  function readParams(message) {
    const direct = readObjectField(message, "params");
    if (direct) return direct;
    const nestedRequest = readObjectField(message, "request");
    if (nestedRequest) {
      const nested = readObjectField(nestedRequest, "params");
      if (nested) return nested;
    }
    return undefined;
  }

  function shouldTrackThreadListRequest(message) {
    const method = readMethod(message);
    if (method !== TARGET_METHOD) return false;
    const params = readParams(message);
    if (!params) return false;
    const limit = readNumberField(params, "limit");
    return limit === TARGET_LIMIT;
  }

  function readThreadProjectKey(thread) {
    if (!thread || typeof thread !== "object") return "";
    const cwd = readStringField(thread, "cwd");
    if (cwd.length > 0) return cwd;
    const rolloutPath = readStringField(thread, "rollout_path") || readStringField(thread, "rolloutPath");
    if (rolloutPath.length > 0) return rolloutPath;
    return "";
  }

  function capThreadsPerProject(list) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const counts = new Map();
    const capped = [];
    for (const thread of list) {
      const key = readThreadProjectKey(thread) || "__unknown__";
      const current = counts.get(key) || 0;
      if (current >= PER_PROJECT_LIMIT) continue;
      counts.set(key, current + 1);
      capped.push(thread);
    }
    return capped;
  }

  function applyCapToResultObject(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    if (!hasOwn(result, "data")) return false;
    const data = result.data;
    if (!Array.isArray(data)) return false;
    const capped = capThreadsPerProject(data);
    if (capped.length === data.length) return false;
    result.data = capped;
    return true;
  }

  const bridge = globalRecord.electronBridge;
  if (bridge && typeof bridge === "object" && typeof bridge.sendMessageFromView === "function") {
    const originalSendMessageFromView = bridge.sendMessageFromView.bind(bridge);
    bridge.sendMessageFromView = async (message) => {
      try {
        if (shouldTrackThreadListRequest(message)) {
          const id = readRequestId(message);
          if (id.length > 0) {
            trackedRequestIds.add(id);
          }
        }
      } catch {
        // keep IPC path stable
      }
      return originalSendMessageFromView(message);
    };
  }

  window.addEventListener(
    "message",
    (event) => {
      try {
        const payload = event && typeof event === "object" ? event.data : undefined;
        if (!payload || typeof payload !== "object") return;

        const id = readRequestId(payload);
        if (id.length === 0) return;
        if (!trackedRequestIds.has(id)) return;
        trackedRequestIds.delete(id);

        const result = readObjectField(payload, "result");
        if (result && applyCapToResultObject(result)) {
          return;
        }
        applyCapToResultObject(payload);
      } catch {
        // ignore malformed bridge payloads
      }
    },
    true,
  );
})();

