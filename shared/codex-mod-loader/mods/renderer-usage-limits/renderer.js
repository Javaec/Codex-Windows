(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const api = window.__CODEX_MOD_API_V1__;
  if (!api || api.version !== 1) {
    throw new Error("renderer-usage-limits: Codex Mod API v1 is required");
  }

  if (window.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V18__) return;
  window.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V18__ = true;

  const PANEL_ID = "codex-windows-limit-panel-v3";
  const STYLE_ID = "codex-windows-limit-panel-style-v3";
  const LIMITS_CACHE_KEY = "codex-windows-limits-panel-cache-v6";
  const POLL_INTERVAL_MS = 20000;
  const REQUEST_BURST_DELAYS_MS = [50, 1000, 5000, 15000];
  const REQUEST_TIMEOUT_MS = 15000;
  const FIVE_HOUR_WINDOW_MINUTES = 300;
  const WEEKLY_WINDOW_MINUTES = 10080;
  const ONE_DAY_WINDOW_MINUTES = 1440;
  const SPARK_LIMIT_NAME = /spark|gpt-5\.3-codex-spark/i;

  const panelState = {
    fiveHour: null,
    weekly: null,
    updatedAtIso: "",
  };

  let usageRequestPromise = null;
  let authReloadPromise = null;

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function toFiniteNumber(value) {
    const nextValue = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(nextValue) ? nextValue : 0;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function normalizeRemainingPercent(usedPercent) {
    return clampPercent(100 - clampPercent(usedPercent));
  }

  function normalizeResetAt(value) {
    const nextValue = toFiniteNumber(value);
    if (nextValue <= 0) return "";
    return new Date(nextValue * 1000).toISOString();
  }

  function normalizeLimitName(value) {
    const nextValue = typeof value === "string" ? value.trim() : "";
    return nextValue.length > 0 ? nextValue : "";
  }

  function normalizeBucket(bucket) {
    if (!isPlainObject(bucket)) return null;
    const usedPercent = toFiniteNumber(bucket.used_percent);
    const windowMinutes = toFiniteNumber(bucket.window_minutes);
    const windowSeconds = toFiniteNumber(bucket.limit_window_seconds);
    const normalizedWindowMinutes = windowMinutes > 0 ? windowMinutes : (windowSeconds > 0 ? windowSeconds / 60 : 0);
    if (normalizedWindowMinutes <= 0) return null;
    return {
      usedPercent: clampPercent(usedPercent),
      remainingPercent: normalizeRemainingPercent(usedPercent),
      resetAt: normalizeResetAt(bucket.reset_at),
      windowMinutes: normalizedWindowMinutes,
    };
  }

  function buildSnapshot(rateLimit, limitName) {
    if (!isPlainObject(rateLimit)) return null;
    const primary = normalizeBucket(rateLimit.primary_window);
    const secondary = normalizeBucket(rateLimit.secondary_window);
    if (!primary && !secondary) return null;
    return { limitName, primary, secondary };
  }

  function collectEntries(payload) {
    if (!isPlainObject(payload)) return [];
    const entries = [];
    const rootSnapshot = buildSnapshot(payload.rate_limit, normalizeLimitName(payload.rate_limit_name));
    if (rootSnapshot) entries.push({ limitName: "", snapshot: rootSnapshot });

    const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
    for (const limit of additional) {
      if (!isPlainObject(limit)) continue;
      const limitName = normalizeLimitName(limit.limit_name);
      if (!limitName) continue;
      const snapshot = buildSnapshot(limit.rate_limit, limitName);
      if (!snapshot) continue;
      entries.push({ limitName, snapshot });
    }

    return entries;
  }

  function chooseClosestBucket(candidates, targetWindowMinutes) {
    let bestBucket = null;
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
    const generalEntries = entries.filter((entry) => entry.limitName === "");
    if (generalEntries.length > 0) return generalEntries;
    const nonSparkEntries = entries.filter((entry) => !SPARK_LIMIT_NAME.test(entry.limitName || ""));
    return nonSparkEntries.length > 0 ? nonSparkEntries : entries;
  }

  function chooseSidebarSnapshot(entries) {
    const sourceEntries = chooseSidebarEntries(entries);
    if (sourceEntries.length === 0) return null;

    const fiveHourCandidates = [];
    const weeklyCandidates = [];
    for (const entry of sourceEntries) {
      for (const bucket of [entry.snapshot.primary, entry.snapshot.secondary]) {
        if (!bucket) continue;
        if (bucket.windowMinutes < ONE_DAY_WINDOW_MINUTES) fiveHourCandidates.push(bucket);
        else weeklyCandidates.push(bucket);
      }
    }

    return {
      fiveHour: chooseClosestBucket(fiveHourCandidates, FIVE_HOUR_WINDOW_MINUTES),
      weekly: chooseClosestBucket(weeklyCandidates, WEEKLY_WINDOW_MINUTES),
    };
  }

  function ensureStyle() {
    api.ensureStyle(
      STYLE_ID,
      ".codex-windows-limit-panel{display:flex;align-items:center;margin:6px 0 8px;padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);font-size:12px;line-height:1.25;max-width:320px}" +
        ".codex-windows-limit-panel__row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%}" +
        ".codex-windows-limit-panel--floating{position:fixed;left:12px;bottom:12px;z-index:9999;backdrop-filter:blur(4px)}" +
        ".codex-windows-limit-summary{font-weight:700;letter-spacing:.15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        ".codex-windows-limit-auth{flex:0 0 auto;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:inherit;border-radius:999px;padding:2px 8px;font:inherit;cursor:pointer;opacity:.88}" +
        ".codex-windows-limit-auth:hover{background:rgba(255,255,255,.08)}" +
        ".codex-windows-limit-auth:disabled{cursor:progress;opacity:.6}",
    );
  }

  function ensurePanelNode() {
    const panel = api.ensureSingletonNode(PANEL_ID, () => {
      const element = document.createElement("div");
      element.className = "codex-windows-limit-panel";
      element.innerHTML =
        '<div class="codex-windows-limit-panel__row">' +
        '<div class="codex-windows-limit-summary" data-codex-limit-summary>5h -- | wk --</div>' +
        '<button type="button" class="codex-windows-limit-auth" data-codex-limit-auth>Reload Auth</button>' +
        "</div>";
      return element;
    });
    const reloadButton = panel.querySelector("[data-codex-limit-auth]");
    if (reloadButton instanceof HTMLButtonElement && !reloadButton.dataset.codexLimitAuthBound) {
      reloadButton.dataset.codexLimitAuthBound = "1";
      reloadButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        requestAuthReload();
      });
    }
    return panel;
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!(panel instanceof HTMLElement)) return;
    const summaryNode = panel.querySelector("[data-codex-limit-summary]");
    const reloadButton = panel.querySelector("[data-codex-limit-auth]");
    if (!(summaryNode instanceof HTMLElement)) return;

    const fiveHour = panelState.fiveHour ? `${Math.round(panelState.fiveHour.remainingPercent)}%` : "--";
    const weekly = panelState.weekly ? `${Math.round(panelState.weekly.remainingPercent)}%` : "--";
    summaryNode.textContent = `5h ${fiveHour} | wk ${weekly}`;
    if (reloadButton instanceof HTMLButtonElement) {
      reloadButton.disabled = Boolean(authReloadPromise);
      reloadButton.textContent = authReloadPromise ? "Reloading..." : "Reload Auth";
    }
  }

  function saveSnapshot() {
    localStorage.setItem(
      LIMITS_CACHE_KEY,
      JSON.stringify({
        fiveHour: panelState.fiveHour,
        weekly: panelState.weekly,
        updatedAtIso: panelState.updatedAtIso,
      }),
    );
  }

  function loadSnapshot() {
    const rawValue = localStorage.getItem(LIMITS_CACHE_KEY);
    if (!rawValue) return;
    const parsed = JSON.parse(rawValue);
    if (!isPlainObject(parsed)) return;
    if (isPlainObject(parsed.fiveHour)) panelState.fiveHour = parsed.fiveHour;
    if (isPlainObject(parsed.weekly)) panelState.weekly = parsed.weekly;
    if (typeof parsed.updatedAtIso === "string") panelState.updatedAtIso = parsed.updatedAtIso;
  }

  function commitSnapshot(snapshot) {
    if (!snapshot) return;
    if (snapshot.fiveHour) panelState.fiveHour = snapshot.fiveHour;
    if (snapshot.weekly) panelState.weekly = snapshot.weekly;
    if (!panelState.fiveHour && !panelState.weekly) return;
    panelState.updatedAtIso = new Date().toISOString();
    saveSnapshot();
    renderPanel();
  }

  function isSettingsCandidate(node) {
    const text = api.normalizeText(node.textContent).toLowerCase();
    if (text === "settings") return true;
    const aria = api.normalizeText(node.getAttribute("aria-label")).toLowerCase();
    if (aria === "settings") return true;
    const href = api.normalizeText(node.getAttribute("href")).toLowerCase();
    return href.includes("settings");
  }

  function injectPanel() {
    ensureStyle();
    api.injectSidebarPanel({
      panelId: PANEL_ID,
      createNode: ensurePanelNode,
      anchorMatcher: isSettingsCandidate,
      floatingClassName: "codex-windows-limit-panel--floating",
    });
    renderPanel();
  }

  function requestUsageSnapshot() {
    if (usageRequestPromise) return usageRequestPromise;
    usageRequestPromise = api
      .bridgeFetchJson("/wham/usage", { method: "GET", timeoutMs: REQUEST_TIMEOUT_MS })
      .then((response) => {
        const snapshot = chooseSidebarSnapshot(collectEntries(response.bodyJson));
        if (snapshot) commitSnapshot(snapshot);
      })
      .finally(() => {
        usageRequestPromise = null;
      });
    return usageRequestPromise;
  }

  function refreshUsageSnapshot() {
    requestUsageSnapshot().catch((error) => {
      console.error("[codex-mod-loader] limits refresh failed", error);
    });
  }

  function requestAuthReload() {
    if (authReloadPromise) return authReloadPromise;
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      throw new Error("renderer-usage-limits: electronBridge.sendMessageFromView is unavailable");
    }
    authReloadPromise = bridge
      .sendMessageFromView({
        type: "codex-app-server-restart",
        hostId: api.resolveHostId(),
      })
      .then(() => {
        api.scheduleBurst([200, 1000, 3000], () => {
          refreshUsageSnapshot();
        });
      })
      .catch((error) => {
        console.error("[codex-mod-loader] reload auth failed", error);
      })
      .finally(() => {
        authReloadPromise = null;
        renderPanel();
      });
    renderPanel();
    return authReloadPromise;
  }

  const scheduleInject = api.createDebouncedRunner(120, injectPanel);
  function handleDomMutations(records) {
    const sidebar = api.getSidebarRoot();
    if (sidebar instanceof HTMLElement && !api.mutationTouchesNode(records, sidebar)) return;
    scheduleInject();
  }

  loadSnapshot();
  api.onRendererReady(() => {
    injectPanel();
    renderPanel();
  });
  api.onRouteChange(() => {
    api.scheduleBurst(REQUEST_BURST_DELAYS_MS, () => {
      injectPanel();
      renderPanel();
      refreshUsageSnapshot();
    });
  });
  api.observeSettingsPanel(() => {
    injectPanel();
    renderPanel();
  });
  api.observeDom(handleDomMutations);
  api.scheduleRefresh(POLL_INTERVAL_MS, () => {
    injectPanel();
    renderPanel();
    refreshUsageSnapshot();
  }, { leading: false });
  window.addEventListener("focus", () => {
    injectPanel();
    renderPanel();
    refreshUsageSnapshot();
  });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const clickable = target.closest("button,[role='button'],a,div,span");
      if (!(clickable instanceof HTMLElement)) return;
      if (!isSettingsCandidate(clickable)) return;
      api.scheduleBurst(REQUEST_BURST_DELAYS_MS, () => {
        injectPanel();
        renderPanel();
        refreshUsageSnapshot();
      });
    },
    true,
  );
  api.scheduleBurst(REQUEST_BURST_DELAYS_MS, () => {
    injectPanel();
    renderPanel();
    refreshUsageSnapshot();
  });
})();
