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
  const SIDEBAR_SELECTOR =
    "aside,nav,[role='navigation'],[class*='sidebar'],[class*='Sidebar'],[data-testid*='sidebar']";
  const LIST_SELECTOR = "[role='list'],ul,ol";
  const LIST_ITEM_SELECTOR = ":scope > [role='listitem'], :scope > li";
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

  function getDirectListItems(list) {
    return Array.from(list.querySelectorAll(LIST_ITEM_SELECTOR)).filter((node) => node instanceof HTMLElement);
  }

  function getRowText(node) {
    return api.normalizeText(node.textContent || node.getAttribute("aria-label") || "").toLowerCase();
  }

  function isNativeToggleRow(node) {
    const text = getRowText(node);
    return text === SHOW_MORE_TEXT || text === SHOW_LESS_TEXT;
  }

  function getSidebarForNode(node) {
    const sidebar = node.closest(SIDEBAR_SELECTOR);
    return sidebar instanceof HTMLElement && api.isVisible(sidebar) ? sidebar : null;
  }

  function isManagedList(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (!getSidebarForNode(node) || !api.isVisible(node)) return false;
    const rows = getDirectListItems(node);
    if (rows.length < 2) return false;
    return rows.some(isNativeToggleRow);
  }

  function getListKey(list) {
    const ariaLabel = api.normalizeText(list.getAttribute("aria-label")).toLowerCase();
    if (ariaLabel) return ariaLabel;

    const sidebar = getSidebarForNode(list);
    const heading = sidebar
      ? sidebar.querySelector("h1,h2,h3,[role='heading']")
      : list.closest("section,div")?.querySelector("h1,h2,h3,[role='heading']");
    const headingText =
      heading instanceof HTMLElement
        ? api.normalizeText(heading.textContent || heading.getAttribute("aria-label") || "").toLowerCase()
        : "";
    if (headingText) return headingText;

    const listIndex = Array.from(document.querySelectorAll(LIST_SELECTOR)).indexOf(list);
    return `sidebar-list-${listIndex}`;
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

  function applyCapToList(list) {
    const label = getListKey(list);
    const state = getState(label);
    const rows = getDirectListItems(list);
    const nativeToggleRows = rows.filter(isNativeToggleRow);
    const threadRows = rows.filter((row) => !isNativeToggleRow(row));
    const nativeShowMoreRow = nativeToggleRows.find((row) => getRowText(row) === SHOW_MORE_TEXT);

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
    const lists = document.querySelectorAll(LIST_SELECTOR);
    for (const list of lists) {
      if (!isManagedList(list)) continue;
      const label = getListKey(list);
      activeLabels.add(label);
      applyCapToList(list);
    }
    cleanupUnusedState(activeLabels);
  }

  const scheduleScan = api.createDebouncedRunner(APPLY_THROTTLE_MS, scan);
  api.onRendererReady(scan);
  api.onRouteChange(scheduleScan);
  api.observeDom(scheduleScan);
})();
