(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const api = window.__CODEX_MOD_API_V1__;
  if (!api || api.version !== 1) {
    throw new Error("webview-thread-list-cap: Codex Mod API v1 is required");
  }

  if (window.__CODEX_WINDOWS_THREAD_LIST_CAP_V4__) return;
  window.__CODEX_WINDOWS_THREAD_LIST_CAP_V4__ = true;

  const THREAD_CAP = 4;
  const SHOW_MORE_TEXT = "show more";
  const SHOW_LESS_TEXT = "show less";
  const TOGGLE_ATTR = "data-codex-windows-thread-cap-toggle";
  const TOGGLE_LABEL_ATTR = "data-codex-windows-thread-cap-label";
  const THREAD_ROW_ATTR = "data-codex-windows-thread-row";
  const THREAD_CURRENT_ATTR = "data-codex-windows-thread-current";
  const THREAD_COMPLETED_ATTR = "data-codex-windows-thread-completed";
  const THREAD_STATE_EVENT = "codex-thread-activity-state";
  const APPLY_THROTTLE_MS = 120;
  const NATIVE_EXPAND_RETRY_MS = 600;
  const STATUS_SCAN_SELECTOR =
    "a,button,[role='button'],[aria-label],[title],[data-state],[data-status],[data-testid],[data-icon],svg,span,div";
  const PROGRESS_SELECTOR =
    "[role='progressbar'],[aria-busy='true'],[class*='spinner'],[class*='Spinner'],[class*='loading'],[class*='Loading'],[data-state='loading']";
  const ACTIVE_SELECTOR =
    "[aria-current],[aria-selected='true'],[data-selected='true'],[data-active='true'],[data-state='active'],[data-state='open']";
  const ACTIVE_SIGNAL_TOKENS = ["active", "current", "selected", "running", "streaming", "working", "open"];
  const COMPLETED_SIGNAL_TOKENS = ["completed", "complete", "done", "finished", "resolved", "success", "checkmark", "check-circle", "circle-check"];
  const stateByLabel = new Map();

  api.ensureStyle(
    "codex-windows-thread-list-cap-v4",
    `
      [${THREAD_ROW_ATTR}="1"] {
        border-radius: 12px;
        overflow: clip;
        transition: background-color 140ms ease, box-shadow 140ms ease;
      }
      [${THREAD_ROW_ATTR}="1"] > :first-child {
        border-radius: inherit;
        transition: background-color 140ms ease, box-shadow 140ms ease;
      }
      [${THREAD_CURRENT_ATTR}="1"],
      [${THREAD_CURRENT_ATTR}="1"] > :first-child {
        background: rgba(245, 158, 11, 0.10) !important;
        box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.24);
      }
      [${THREAD_COMPLETED_ATTR}="1"],
      [${THREAD_COMPLETED_ATTR}="1"] > :first-child {
        background: rgba(34, 197, 94, 0.08) !important;
        box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.18);
      }
    `,
  );

  function getThreadActivityState() {
    const rawState = window.__CODEX_THREAD_ACTIVITY_STATE__;
    if (!rawState || typeof rawState !== "object") return {};
    const threads = rawState.threads;
    return threads && typeof threads === "object" ? threads : {};
  }

  function extractThreadId(text) {
    if (typeof text !== "string") return "";
    const match = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    return match ? match[0].toLowerCase() : "";
  }

  function getRowThreadId(row) {
    const candidates = [
      row.getAttribute("href"),
      row.getAttribute("data-thread-id"),
      row.getAttribute("data-conversation-id"),
      row.getAttribute("aria-label"),
      row.textContent,
    ];
    for (const candidate of candidates) {
      const threadId = extractThreadId(String(candidate || ""));
      if (threadId) return threadId;
    }
    const links = row.querySelectorAll("a[href]");
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const threadId = extractThreadId(link.href);
      if (threadId) return threadId;
    }
    return "";
  }

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

  function setRowVisible(node, visible) {
    node.style.display = visible ? "" : "none";
  }

  function resetRowDecoration(row) {
    row.setAttribute(THREAD_ROW_ATTR, "1");
    row.removeAttribute(THREAD_CURRENT_ATTR);
    row.removeAttribute(THREAD_COMPLETED_ATTR);
  }

  function collectRowSignals(row) {
    const signals = [];
    const nodes = [row, ...row.querySelectorAll(STATUS_SCAN_SELECTOR)];
    for (const node of nodes.slice(0, 40)) {
      if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) continue;
      for (const attrName of ["aria-label", "title", "data-state", "data-status", "data-testid", "data-icon", "class"]) {
        const rawValue = typeof node.getAttribute === "function" ? node.getAttribute(attrName) : "";
        const value = api.normalizeText(rawValue || "").toLowerCase();
        if (value) signals.push(value);
      }
      if (node instanceof HTMLElement && node.childElementCount === 0) {
        const text = api.normalizeText(node.textContent || "").toLowerCase();
        if (text && text.length <= 24) signals.push(text);
      }
    }
    return signals;
  }

  function hasSignal(signals, tokens) {
    return signals.some((signal) => tokens.some((token) => signal.includes(token)));
  }

  function rowMatchesCurrentLocation(row) {
    const links = row.querySelectorAll("a[href]");
    const currentPath = `${window.location.pathname || ""}${window.location.search || ""}`;
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      let targetUrl = null;
      try {
        targetUrl = new URL(link.href, window.location.href);
      } catch {
        targetUrl = null;
      }
      if (!targetUrl) continue;
      const targetPath = `${targetUrl.pathname || ""}${targetUrl.search || ""}`;
      if (targetPath && targetPath === currentPath) return true;
    }
    return false;
  }

  function classifyThreadRow(row) {
    resetRowDecoration(row);
    const threadId = getRowThreadId(row);
    const threadActivityState = getThreadActivityState();
    const stateEntry = threadId ? threadActivityState[threadId] : null;
    if (stateEntry && stateEntry.status === "current") {
      row.setAttribute(THREAD_CURRENT_ATTR, "1");
      return;
    }
    if (stateEntry && stateEntry.status === "completed") {
      row.setAttribute(THREAD_COMPLETED_ATTR, "1");
      return;
    }

    const signals = collectRowSignals(row);
    const hasProgressMarker =
      row.matches(PROGRESS_SELECTOR) ||
      Boolean(row.querySelector(PROGRESS_SELECTOR)) ||
      hasSignal(signals, ["progress", "loading", "spinner", "running", "streaming"]);
    const isCurrent =
      row.matches(ACTIVE_SELECTOR) ||
      Boolean(row.querySelector(ACTIVE_SELECTOR)) ||
      rowMatchesCurrentLocation(row) ||
      hasProgressMarker ||
      hasSignal(signals, ACTIVE_SIGNAL_TOKENS);
    const isCompleted = !isCurrent && hasSignal(signals, COMPLETED_SIGNAL_TOKENS);
    if (isCurrent) {
      row.setAttribute(THREAD_CURRENT_ATTR, "1");
    } else if (isCompleted) {
      row.setAttribute(THREAD_COMPLETED_ATTR, "1");
    }
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

    for (const row of threadRows) classifyThreadRow(row);
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
  function handleDomMutations(records) {
    const sidebar = api.getSidebarRoot();
    if (sidebar instanceof HTMLElement && !api.mutationTouchesNode(records, sidebar)) return;
    scheduleScan();
  }
  api.onRendererReady(scan);
  api.onRouteChange(scheduleScan);
  api.observeDom(handleDomMutations);
  window.addEventListener(THREAD_STATE_EVENT, scheduleScan);
})();
