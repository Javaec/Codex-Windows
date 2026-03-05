(function () {
  if (typeof window === "undefined") {
    return;
  }

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_THREADS_PER_PROJECT_CAP_V2__) {
    return;
  }
  globalRecord.__CODEX_WINDOWS_THREADS_PER_PROJECT_CAP_V2__ = true;

  const TARGET_METHOD = "thread/list";
  const TARGET_LIMIT = 10;
  const REPLACEMENT_LIMIT = 6;

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

  function shouldRewriteThreadListRequest(message) {
    const method = readMethod(message);
    if (method !== TARGET_METHOD) return false;
    const params = readParams(message);
    if (!params) return false;
    const limit = readNumberField(params, "limit");
    return limit === TARGET_LIMIT;
  }

  function rewriteLimit(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;

    const directParams = readObjectField(message, "params");
    if (directParams && readNumberField(directParams, "limit") === TARGET_LIMIT) {
      return { ...message, params: { ...directParams, limit: REPLACEMENT_LIMIT } };
    }

    const directRequest = readObjectField(message, "request");
    if (directRequest) {
      const requestParams = readObjectField(directRequest, "params");
      if (requestParams && readNumberField(requestParams, "limit") === TARGET_LIMIT) {
        return { ...message, request: { ...directRequest, params: { ...requestParams, limit: REPLACEMENT_LIMIT } } };
      }
    }

    return message;
  }

  const bridge = globalRecord.electronBridge;
  if (bridge && typeof bridge === "object" && typeof bridge.sendMessageFromView === "function") {
    const originalSendMessageFromView = bridge.sendMessageFromView.bind(bridge);
    bridge.sendMessageFromView = async (message) => {
      const patchedMessage = shouldRewriteThreadListRequest(message) ? rewriteLimit(message) : message;
      return originalSendMessageFromView(patchedMessage);
    };
  }
})();
