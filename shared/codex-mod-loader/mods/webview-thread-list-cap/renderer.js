(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const api = window.__CODEX_MOD_API_V1__;
  if (!api || api.version !== 1) {
    throw new Error("webview-thread-list-cap: Codex Mod API v1 is required");
  }

  if (window.__CODEX_WINDOWS_THREAD_LIST_CAP_V3__) return;
  window.__CODEX_WINDOWS_THREAD_LIST_CAP_V3__ = true;

  const THREAD_CAP = 6;
  const SHOW_MORE_TEXT = "show more";
  const SHOW_LESS_TEXT = "show less";
  const TOGGLE_ATTR = "data-codex-windows-thread-cap-toggle";
  const TOGGLE_LABEL_ATTR = "data-codex-windows-thread-cap-label";
  const APPLY_THROTTLE_MS = 120;
  const NATIVE_EXPAND_RETRY_MS = 600;
  const stateByLabel = new Map();

  function getState(label) {
    let state = stateByLabel.get(label);
    if (state) return state;
    state = {
      expanded: false,
      toggleElement: null,
      lastNativeExpandAttemptAt: 0,
    };
    stateByLabel.set(label, state);
    return state;
  }

  function getRowText(node) {
    return api.normalizeText(node.textContent || node.getAttribute("aria-label") || "").toLowerCase();
  }

  function setRowVisible(node, visible) {
    node.style.display = visible ? "" : "none";
  }

  function ensureToggleElement(state, label) {
    let toggle = state.toggleElement;
    if (!(toggle instanceof HTMLElement) || !toggle.isConnected) {
      toggle = document.createElement("div");
      toggle.setAttribute(TOGGLE_ATTR, "1");
      toggle.setAttribute(TOGGLE_LABEL_ATTR, label);
      toggle.style.padding = "4px 32px 6px";
      toggle.style.display = "flex";
      toggle.style.alignItems = "center";

      const button = document.createElement("button");
      button.type = "button";
      button.style.background = "transparent";
      button.style.border = "0";
      button.style.padding = "0";
      button.style.margin = "0";
      button.style.color = "var(--text-secondary, rgba(255,255,255,0.72))";
      button.style.cursor = "pointer";
      button.style.font = "inherit";
      button.style.lineHeight = "1.2";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.expanded = !state.expanded;
        scan();
      });

      toggle.appendChild(button);
      state.toggleElement = toggle;
    }

    const button = toggle.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`webview-thread-list-cap: missing toggle button for ${label}`);
    }
    button.textContent = state.expanded ? "Show less" : "Show more";
    button.setAttribute("aria-expanded", state.expanded ? "true" : "false");
    return toggle;
  }

  function removeToggle(state) {
    const toggle = state.toggleElement;
    if (toggle instanceof HTMLElement && toggle.isConnected) toggle.remove();
    state.toggleElement = null;
  }

  function tryExpandNativeList(showMoreRow, state) {
    const now = Date.now();
    if (now - state.lastNativeExpandAttemptAt < NATIVE_EXPAND_RETRY_MS) return false;
    const button = showMoreRow.querySelector("button,[role='button']");
    if (!(button instanceof HTMLElement)) return false;
    state.lastNativeExpandAttemptAt = now;
    button.click();
    return true;
  }

  function applyCapToGroup(group) {
    const list = group.list;
    const label = String(group.label || "");
    const state = getState(label);
    const nativeToggleRows = group.toggleRows;
    const threadRows = group.threadRows;
    const nativeShowMoreRow = group.nativeShowMoreRow;

    for (const row of nativeToggleRows) setRowVisible(row, false);
    if (nativeShowMoreRow && tryExpandNativeList(nativeShowMoreRow, state)) return;

    if (threadRows.length <= THREAD_CAP) {
      for (const row of threadRows) setRowVisible(row, true);
      removeToggle(state);
      return;
    }

    const shouldShowAllRows = state.expanded;
    threadRows.forEach((row, index) => {
      setRowVisible(row, shouldShowAllRows || index < THREAD_CAP);
    });

    const toggle = ensureToggleElement(state, label);
    if (list.nextSibling !== toggle && list.parentNode) {
      list.parentNode.insertBefore(toggle, list.nextSibling);
    }
    toggle.style.display = "";
  }

  function cleanupUnusedState(activeLabels) {
    for (const [label, state] of stateByLabel.entries()) {
      if (activeLabels.has(label)) continue;
      removeToggle(state);
      stateByLabel.delete(label);
    }
  }

  function scan() {
    const activeLabels = new Set();
    const groups = api.getProjectLists();
    for (const group of groups) {
      const label = String(group.label || "");
      activeLabels.add(label);
      applyCapToGroup(group);
    }
    cleanupUnusedState(activeLabels);
  }

  const scheduleScan = api.createDebouncedRunner(APPLY_THROTTLE_MS, scan);
  api.onRendererReady(scan);
  api.onRouteChange(scheduleScan);
  api.observeDom(scheduleScan);
})();
