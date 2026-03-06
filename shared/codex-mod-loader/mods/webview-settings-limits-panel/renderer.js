(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V17__) return;
  globalRecord.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V17__ = true;

  const PANEL_ID = "codex-windows-settings-limit-panel-v2";
  const STYLE_ID = "codex-windows-settings-limit-panel-style-v2";
  const LIMITS_CACHE_KEY = "codex-windows-limits-panel-cache-v5";
  const POLL_INTERVAL_MS = 60000;
  const REQUEST_BURST_DELAYS_MS = [50, 1000, 5000, 15000];
  const REQUEST_TIMEOUT_MS = 15000;
  const USAGE_ENDPOINT = "/wham/usage";
  const FIVE_HOUR_WINDOW_MINUTES = 300;
  const WEEKLY_WINDOW_MINUTES = 10080;
  const ONE_DAY_WINDOW_MINUTES = 1440;
  const SIDEBAR_SELECTOR =
    "aside,nav,[role='navigation'],[class*='sidebar'],[class*='Sidebar'],[data-testid*='sidebar']";
  const PANEL_HTML = '<div class="codex-windows-limit-summary" data-codex-limit-summary>5h -- | wk --</div>';
  const SPARK_LIMIT_NAME = /spark|gpt-5\.3-codex-spark/i;

  const panelState = {
    fiveHour: undefined,
    weekly: undefined,
    updatedAtIso: "",
  };

  let usageRequestSequence = 0;
  let pendingUsageRequestId = "";
  let pendingUsageTimeoutId = 0;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".codex-windows-limit-panel{display:flex;align-items:center;margin:6px 0 8px;padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);font-size:12px;line-height:1.25;max-width:320px}" +
      ".codex-windows-limit-panel--floating{position:fixed;left:12px;bottom:12px;z-index:9999;backdrop-filter:blur(4px)}" +
      ".codex-windows-limit-summary{font-weight:700;letter-spacing:.15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
    document.head && document.head.appendChild(style);
  }

  function ensurePanelNode() {
    let panel = document.getElementById(PANEL_ID);
    if (panel instanceof HTMLElement) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "codex-windows-limit-panel";
    panel.innerHTML = PANEL_HTML;
    return panel;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function toFiniteNumber(value) {
    const nextValue = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(nextValue) ? nextValue : undefined;
  }

  function clampPercent(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.min(100, value));
  }

  function normalizeRemainingPercent(usedPercent) {
    const usedValue = clampPercent(usedPercent);
    if (typeof usedValue !== "number") return undefined;
    return clampPercent(100 - usedValue);
  }

  function normalizeResetAt(value) {
    const nextValue = toFiniteNumber(value);
    if (typeof nextValue === "number" && nextValue > 0) {
      return new Date(nextValue * 1000).toISOString();
    }
    return "";
  }

  function normalizeLimitName(value) {
    if (typeof value !== "string") return null;
    const nextValue = value.trim();
    return nextValue.length > 0 ? nextValue : null;
  }

  function normalizeBucket(bucket) {
    if (!isPlainObject(bucket)) return undefined;
    const usedPercent = toFiniteNumber(bucket.used_percent);
    const remainingPercent = normalizeRemainingPercent(usedPercent);
    const windowMinutes = toFiniteNumber(bucket.window_minutes);
    const windowSeconds = toFiniteNumber(bucket.limit_window_seconds);
    const normalizedWindowMinutes = typeof windowMinutes === "number"
      ? windowMinutes
      : (typeof windowSeconds === "number" ? windowSeconds / 60 : undefined);
    if (typeof remainingPercent !== "number") return undefined;
    if (typeof normalizedWindowMinutes !== "number") return undefined;
    return {
      remainingPercent,
      usedPercent,
      remainingPercent,
      resetAt: normalizeResetAt(bucket.reset_at),
      windowMinutes: normalizedWindowMinutes,
    };
  }

  function buildSnapshot(rateLimit, snapshotLimitName) {
    if (!isPlainObject(rateLimit)) return undefined;
    const primary = normalizeBucket(rateLimit.primary_window);
    const secondary = normalizeBucket(rateLimit.secondary_window);
    if (!primary && !secondary) return undefined;
    return {
      limitName: snapshotLimitName,
      primary,
      secondary,
    };
  }

  function buildEntry(limitName, rateLimit, snapshotLimitName) {
    const snapshot = buildSnapshot(rateLimit, snapshotLimitName);
    if (!snapshot) return undefined;
    return {
      limitName,
      snapshot,
    };
  }

  function collectEntries(payload) {
    if (!isPlainObject(payload)) return [];
    const entries = [];
    const rootEntry = buildEntry(null, payload.rate_limit, normalizeLimitName(payload.rate_limit_name));
    if (rootEntry) entries.push(rootEntry);

    const additionalLimits = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
    for (const limit of additionalLimits) {
      if (!isPlainObject(limit)) continue;
      const limitName = normalizeLimitName(limit.limit_name);
      if (!limitName) continue;
      const entry = buildEntry(limitName, limit.rate_limit, limitName);
      if (entry) entries.push(entry);
    }

    return entries;
  }

  function chooseClosestBucket(candidates, targetWindowMinutes) {
    let bestBucket = undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const bucket of candidates) {
      if (!bucket) continue;
      const distance = Math.abs(bucket.windowMinutes - targetWindowMinutes);
      if (distance < bestDistance) {
        bestBucket = bucket;
        bestDistance = distance;
        continue;
      }
      if (distance === bestDistance && bestBucket && bucket.windowMinutes > bestBucket.windowMinutes) {
        bestBucket = bucket;
      }
    }

    return bestBucket;
  }

  function chooseSidebarEntries(entries) {
    const generalEntries = entries.filter((entry) => entry.limitName == null);
    if (generalEntries.length > 0) return generalEntries;
    const nonSparkEntries = entries.filter((entry) => !SPARK_LIMIT_NAME.test(entry.limitName || ""));
    return nonSparkEntries.length > 0 ? nonSparkEntries : entries;
  }

  function chooseSidebarSnapshot(entries) {
    const sourceEntries = chooseSidebarEntries(entries);
    if (sourceEntries.length === 0) return undefined;

    const fiveHourCandidates = [];
    const weeklyCandidates = [];

    for (const entry of sourceEntries) {
      for (const bucket of [entry.snapshot.primary, entry.snapshot.secondary]) {
        if (!bucket) continue;
        if (bucket.windowMinutes < ONE_DAY_WINDOW_MINUTES) {
          fiveHourCandidates.push(bucket);
        } else {
          weeklyCandidates.push(bucket);
        }
      }
    }

    return {
      fiveHour: chooseClosestBucket(fiveHourCandidates, FIVE_HOUR_WINDOW_MINUTES),
      weekly: chooseClosestBucket(weeklyCandidates, WEEKLY_WINDOW_MINUTES),
    };
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!(panel instanceof HTMLElement)) return;
    const summaryNode = panel.querySelector("[data-codex-limit-summary]");
    if (!(summaryNode instanceof HTMLElement)) return;

    const fiveHour = panelState.fiveHour ? String(Math.round(panelState.fiveHour.remainingPercent)) + "%" : "--";
    const weekly = panelState.weekly ? String(Math.round(panelState.weekly.remainingPercent)) + "%" : "--";
    summaryNode.textContent = "5h " + fiveHour + " | wk " + weekly;
  }

  function saveSnapshot() {
    try {
      localStorage.setItem(
        LIMITS_CACHE_KEY,
        JSON.stringify({
          fiveHour: panelState.fiveHour,
          weekly: panelState.weekly,
          updatedAtIso: panelState.updatedAtIso,
        }),
      );
    } catch {
      // Ignore storage failures.
    }
  }

  function loadSnapshot() {
    try {
      const rawValue = localStorage.getItem(LIMITS_CACHE_KEY);
      if (!rawValue) return;
      const parsedValue = JSON.parse(rawValue);
      if (!isPlainObject(parsedValue)) return;
      if (isPlainObject(parsedValue.fiveHour)) panelState.fiveHour = parsedValue.fiveHour;
      if (isPlainObject(parsedValue.weekly)) panelState.weekly = parsedValue.weekly;
      if (typeof parsedValue.updatedAtIso === "string") panelState.updatedAtIso = parsedValue.updatedAtIso;
    } catch {
      // Ignore invalid cache.
    }
  }

  function commitSnapshot(snapshot) {
    if (!snapshot) return;
    if (!snapshot.fiveHour && !snapshot.weekly) return;

    panelState.fiveHour = snapshot.fiveHour || panelState.fiveHour;
    panelState.weekly = snapshot.weekly || panelState.weekly;
    panelState.updatedAtIso = new Date().toISOString();
    saveSnapshot();
    renderPanel();
  }

  function normalizeMessagePayload(value) {
    if (typeof value === "string") {
      const trimmedValue = value.trim();
      if (!trimmedValue) return undefined;
      if (!trimmedValue.startsWith("{") && !trimmedValue.startsWith("[")) return undefined;
      try {
        return JSON.parse(trimmedValue);
      } catch {
        return undefined;
      }
    }
    return value && typeof value === "object" ? value : undefined;
  }

  function clearPendingUsageRequest() {
    pendingUsageRequestId = "";
    if (pendingUsageTimeoutId) {
      window.clearTimeout(pendingUsageTimeoutId);
      pendingUsageTimeoutId = 0;
    }
  }

  function resolveHostId() {
    try {
      const currentUrl = new URL(window.location.href);
      return normalizeText(currentUrl.searchParams.get("hostId")) || "local";
    } catch {
      return "local";
    }
  }

  function parseUsagePayload(message) {
    try {
      const rawBody = typeof message.bodyJsonString === "string"
        ? message.bodyJsonString
        : (typeof message.body === "string" ? message.body : "");
      if (!rawBody.trim()) return undefined;
      const parsedBody = JSON.parse(rawBody);
      const entries = collectEntries(parsedBody);
      return chooseSidebarSnapshot(entries);
    } catch {
      return undefined;
    }
  }

  function handleFetchResponse(event) {
    const payload = normalizeMessagePayload(event && typeof event === "object" ? event.data : undefined);
    if (!isPlainObject(payload)) return;
    if (payload.type !== "fetch-response") return;
    if (typeof payload.requestId !== "string" || payload.requestId !== pendingUsageRequestId) return;

    clearPendingUsageRequest();
    if (payload.responseType !== "success") return;
    const statusCode = toFiniteNumber(payload.status);
    if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) return;

    const snapshot = parseUsagePayload(payload);
    if (snapshot) commitSnapshot(snapshot);
  }

  function requestUsageSnapshot() {
    if (pendingUsageRequestId) return;
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") return;

    const requestId = "codex-windows-usage-" + String(Date.now()) + "-" + String(++usageRequestSequence);
    pendingUsageRequestId = requestId;
    pendingUsageTimeoutId = window.setTimeout(() => {
      if (pendingUsageRequestId === requestId) clearPendingUsageRequest();
    }, REQUEST_TIMEOUT_MS);

    try {
      bridge.sendMessageFromView({
        type: "fetch",
        hostId: resolveHostId(),
        requestId,
        method: "GET",
        url: USAGE_ENDPOINT,
      });
    } catch {
      clearPendingUsageRequest();
    }
  }

  function isSettingsCandidate(node) {
    const text = normalizeText(node.textContent).toLowerCase();
    if (text === "settings") return true;
    const aria = normalizeText(node.getAttribute("aria-label")).toLowerCase();
    if (aria === "settings") return true;
    const href = normalizeText(node.getAttribute("href")).toLowerCase();
    return href.includes("settings");
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function scoreSettingsCandidate(node) {
    let score = 0;
    const text = normalizeText(node.textContent).toLowerCase();
    const aria = normalizeText(node.getAttribute("aria-label")).toLowerCase();
    const href = normalizeText(node.getAttribute("href")).toLowerCase();

    if (text === "settings") score += 5;
    else if (text.includes("settings")) score += 2;
    if (aria === "settings") score += 5;
    else if (aria.includes("settings")) score += 2;
    if (href.includes("settings")) score += 3;
    if (node.closest("aside,nav,[role='navigation']")) score += 3;
    if (node.closest("[class*='sidebar'],[class*='Sidebar'],[data-testid*='sidebar']")) score += 2;
    if (node.closest("main,[role='main']")) score -= 2;
    return score;
  }

  function scoreSidebarCandidate(node) {
    if (!(node instanceof HTMLElement) || !isVisible(node)) return -999;
    const rect = node.getBoundingClientRect();
    let score = 0;

    if (rect.left < window.innerWidth * 0.4) score += 4;
    if (rect.height > 200) score += 2;
    if (node.querySelector("button,[role='button'],a")) score += 2;
    if (node.querySelector("[role='list'],ul,ol")) score += 2;
    if (node.closest("main,[role='main']")) score -= 4;
    if (findBestSettingsAnchor(node)) score += 5;

    return score;
  }

  function findBestSidebar() {
    const candidates = document.querySelectorAll(SIDEBAR_SELECTOR);
    let bestNode = undefined;
    let bestScore = -999;

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      const score = scoreSidebarCandidate(node);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    return bestNode;
  }

  function findBestSettingsAnchor(root) {
    const searchRoot = root instanceof HTMLElement ? root : document;
    const candidates = searchRoot.querySelectorAll("button,[role='button'],a");
    let bestNode = undefined;
    let bestScore = -999;

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      if (!isSettingsCandidate(node)) continue;
      const score = scoreSettingsCandidate(node);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    return bestNode;
  }

  function resolveHost(anchor) {
    if (!(anchor instanceof HTMLElement)) return undefined;
    const host = anchor.closest("button,[role='button'],a,li,div") || anchor;
    return host instanceof HTMLElement ? host : undefined;
  }

  function injectPanel() {
    ensureStyle();
    const panel = ensurePanelNode();
    const sidebar = findBestSidebar();

    if (sidebar instanceof HTMLElement) {
      panel.classList.remove("codex-windows-limit-panel--floating");
      const anchor = findBestSettingsAnchor(sidebar);
      const host = resolveHost(anchor);
      if (host instanceof HTMLElement && host.parentElement instanceof HTMLElement) {
        if (panel.parentElement !== host.parentElement || panel.nextSibling !== host) {
          host.parentElement.insertBefore(panel, host);
        }
        return;
      }

      const insertionPoint = sidebar.firstChild || null;
      if (panel.parentElement !== sidebar || panel.nextSibling !== insertionPoint) {
        sidebar.insertBefore(panel, insertionPoint);
      }
      return;
    }

    if (document.body) {
      panel.classList.add("codex-windows-limit-panel--floating");
      if (panel.parentElement !== document.body) document.body.appendChild(panel);
    }
  }

  function installInjectObserver() {
    const observer = new MutationObserver(() => {
      try {
        injectPanel();
      } catch {
        // Ignore observer errors.
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function installPeriodicRefresh() {
    window.setInterval(() => {
      injectPanel();
      renderPanel();
      requestUsageSnapshot();
    }, POLL_INTERVAL_MS);
  }

  function scheduleInjectBurst() {
    for (const delayMs of REQUEST_BURST_DELAYS_MS) {
      window.setTimeout(() => {
        injectPanel();
        renderPanel();
        requestUsageSnapshot();
      }, delayMs);
    }
  }

  function installSettingsRefreshHint() {
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const clickable = target.closest("button,[role='button'],a,div,span");
        if (!(clickable instanceof HTMLElement)) return;
        if (!isSettingsCandidate(clickable)) return;
        scheduleInjectBurst();
      },
      true,
    );
  }

  loadSnapshot();
  injectPanel();
  renderPanel();
  window.addEventListener("message", handleFetchResponse, true);
  installInjectObserver();
  installPeriodicRefresh();
  installSettingsRefreshHint();
  scheduleInjectBurst();
})();
