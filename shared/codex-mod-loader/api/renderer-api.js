/* CODEX-MOD-API:renderer@v1 */
(function installCodexModApiV1() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__CODEX_MOD_API_V1__) return;

  const SIDEBAR_SELECTOR =
    "aside,nav,[role='navigation'],[class*='sidebar'],[class*='Sidebar'],[data-testid*='sidebar']";

  let bridgeFetchSequence = 0;
  const pendingBridgeFetches = new Map();
  const rendererReadyListeners = new Set();
  const routeChangeListeners = new Set();
  let rendererReadyFired = false;
  let currentRouteUrl = String(window.location.href || "");

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function createDebouncedRunner(delayMs, callback) {
    let timerId = 0;
    return function schedule() {
      if (timerId) return;
      timerId = window.setTimeout(() => {
        timerId = 0;
        callback();
      }, delayMs);
    };
  }

  function observeDom(callback) {
    const observer = new MutationObserver(callback);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return observer;
  }

  function scheduleBurst(delaysMs, callback) {
    for (const delayMs of delaysMs) {
      window.setTimeout(callback, delayMs);
    }
  }

  function ensureStyle(styleId, cssText) {
    const existing = document.getElementById(styleId);
    if (existing instanceof HTMLStyleElement) return existing;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = cssText;
    if (!document.head) throw new Error("codex-mod-api: document.head is not available");
    document.head.appendChild(style);
    return style;
  }

  function ensureSingletonNode(nodeId, createNode) {
    const existing = document.getElementById(nodeId);
    if (existing instanceof HTMLElement) return existing;
    const created = createNode();
    if (!(created instanceof HTMLElement)) {
      throw new Error(`codex-mod-api: singleton factory for ${nodeId} must return HTMLElement`);
    }
    created.id = nodeId;
    return created;
  }

  function resolveHostId() {
    try {
      const currentUrl = new URL(String(window.location.href || ""));
      return currentUrl.searchParams.get("hostId") || "local";
    } catch {
      return "local";
    }
  }

  function normalizeMessagePayload(value) {
    if (typeof value === "string") {
      const trimmedValue = value.trim();
      if (!trimmedValue) return null;
      if (!trimmedValue.startsWith("{") && !trimmedValue.startsWith("[")) return null;
      return JSON.parse(trimmedValue);
    }
    return value && typeof value === "object" ? value : null;
  }

  function parseJsonText(rawValue) {
    const text = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!text) return null;
    return JSON.parse(text);
  }

  function handleBridgeFetchResponse(event) {
    const payload = normalizeMessagePayload(event && typeof event === "object" ? event.data : null);
    if (!payload || payload.type !== "fetch-response") return;
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;

    const pending = pendingBridgeFetches.get(requestId);
    if (!pending) return;
    pendingBridgeFetches.delete(requestId);
    if (pending.timeoutId) window.clearTimeout(pending.timeoutId);

    if (payload.responseType !== "success") {
      pending.reject(new Error(`codex-mod-api: bridge fetch failed for ${requestId}`));
      return;
    }

    const status = typeof payload.status === "number" ? payload.status : Number.parseInt(String(payload.status || ""), 10);
    if (!Number.isFinite(status)) {
      pending.reject(new Error(`codex-mod-api: missing response status for ${requestId}`));
      return;
    }
    if (status < 200 || status >= 300) {
      pending.reject(new Error(`codex-mod-api: bridge fetch returned HTTP ${status} for ${requestId}`));
      return;
    }

    const bodyText =
      typeof payload.bodyJsonString === "string"
        ? payload.bodyJsonString
        : (typeof payload.body === "string" ? payload.body : "");

    let bodyJson = null;
    if (bodyText.trim()) {
      try {
        bodyJson = parseJsonText(bodyText);
      } catch (error) {
        pending.reject(error);
        return;
      }
    }

    pending.resolve({ status, bodyText, bodyJson });
  }

  window.addEventListener("message", handleBridgeFetchResponse, true);

  function bridgeFetchJson(urlPath, options) {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      throw new Error("codex-mod-api: electronBridge.sendMessageFromView is unavailable");
    }

    const nextOptions = options && typeof options === "object" ? options : {};
    const requestId = `codex-mod-api-fetch-${Date.now()}-${++bridgeFetchSequence}`;
    const timeoutMs =
      typeof nextOptions.timeoutMs === "number" && Number.isFinite(nextOptions.timeoutMs)
        ? nextOptions.timeoutMs
        : 15000;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingBridgeFetches.delete(requestId);
        reject(new Error(`codex-mod-api: bridge fetch timed out for ${requestId}`));
      }, timeoutMs);

      pendingBridgeFetches.set(requestId, { resolve, reject, timeoutId });

      try {
        bridge.sendMessageFromView({
          type: "fetch",
          hostId: resolveHostId(),
          requestId,
          method: typeof nextOptions.method === "string" ? nextOptions.method : "GET",
          url: urlPath,
        });
      } catch (error) {
        pendingBridgeFetches.delete(requestId);
        window.clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  function findSidebarRoot() {
    const candidates = Array.from(document.querySelectorAll(SIDEBAR_SELECTOR)).filter((node) => isVisible(node));
    let bestNode = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      const rect = candidate.getBoundingClientRect();
      const score = rect.height * rect.width;
      if (score <= bestScore) continue;
      bestNode = candidate;
      bestScore = score;
    }
    return bestNode;
  }

  function findSidebarAnchor(match) {
    const sidebar = findSidebarRoot();
    if (!sidebar) return null;
    const candidates = sidebar.querySelectorAll("button,[role='button'],a,div,span");
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      if (!isVisible(candidate)) continue;
      if (match(candidate)) return candidate;
    }
    return null;
  }

  function mountSidebarPanel(options) {
    const nextOptions = options && typeof options === "object" ? options : {};
    const panelId = typeof nextOptions.panelId === "string" ? nextOptions.panelId.trim() : "";
    if (!panelId) throw new Error("codex-mod-api: mountSidebarPanel requires panelId");
    if (typeof nextOptions.createNode !== "function") {
      throw new Error(`codex-mod-api: mountSidebarPanel(${panelId}) requires createNode()`);
    }

    const panel = ensureSingletonNode(panelId, nextOptions.createNode);
    const floatingClassName =
      typeof nextOptions.floatingClassName === "string" ? nextOptions.floatingClassName.trim() : "";
    const anchorMatcher = typeof nextOptions.anchorMatcher === "function" ? nextOptions.anchorMatcher : null;
    const sidebar = findSidebarRoot();

    if (!(sidebar instanceof HTMLElement)) {
      if (!panel.isConnected) document.body.appendChild(panel);
      if (floatingClassName) panel.classList.add(floatingClassName);
      return { panel, mode: "floating" };
    }

    if (floatingClassName) panel.classList.remove(floatingClassName);
    const anchor = anchorMatcher ? findSidebarAnchor(anchorMatcher) : null;
    if (anchor && anchor.parentNode) {
      if (anchor.previousSibling !== panel) {
        anchor.parentNode.insertBefore(panel, anchor);
      }
      return { panel, mode: "anchor" };
    }

    if (sidebar.firstChild !== panel) {
      sidebar.insertBefore(panel, sidebar.firstChild);
    }
    return { panel, mode: "sidebar" };
  }

  function fireRendererReady() {
    if (rendererReadyFired) return;
    rendererReadyFired = true;
    const payload = { url: currentRouteUrl };
    for (const listener of rendererReadyListeners) listener(payload);
  }

  function onRendererReady(listener) {
    if (typeof listener !== "function") {
      throw new Error("codex-mod-api: onRendererReady requires a function");
    }
    rendererReadyListeners.add(listener);
    if (rendererReadyFired) {
      queueMicrotask(() => {
        if (rendererReadyListeners.has(listener)) listener({ url: currentRouteUrl });
      });
    }
    return () => rendererReadyListeners.delete(listener);
  }

  function emitRouteChange() {
    const nextUrl = String(window.location.href || "");
    if (nextUrl === currentRouteUrl) return;
    currentRouteUrl = nextUrl;
    const payload = { url: currentRouteUrl };
    for (const listener of routeChangeListeners) listener(payload);
  }

  const scheduleRouteChange = createDebouncedRunner(20, emitRouteChange);

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    if (typeof original !== "function") return;
    history[methodName] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      scheduleRouteChange();
      return result;
    };
  }

  function onRouteChange(listener) {
    if (typeof listener !== "function") {
      throw new Error("codex-mod-api: onRouteChange requires a function");
    }
    routeChangeListeners.add(listener);
    queueMicrotask(() => {
      if (routeChangeListeners.has(listener)) listener({ url: currentRouteUrl });
    });
    return () => routeChangeListeners.delete(listener);
  }

  window.__CODEX_MOD_API_V1__ = {
    version: 1,
    normalizeText,
    isVisible,
    createDebouncedRunner,
    observeDom,
    scheduleBurst,
    ensureStyle,
    ensureSingletonNode,
    resolveHostId,
    bridgeFetchJson,
    findSidebarRoot,
    findSidebarAnchor,
    mountSidebarPanel,
    onRendererReady,
    onRouteChange,
  };

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", scheduleRouteChange, true);
  window.addEventListener("hashchange", scheduleRouteChange, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fireRendererReady, { once: true });
  } else {
    queueMicrotask(fireRendererReady);
  }
})();
