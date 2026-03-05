(function () {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V13__) {
    return;
  }
  globalRecord.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V13__ = true;

  const PANEL_ID = "codex-windows-settings-limit-panel-v1";
  const STYLE_ID = "codex-windows-settings-limit-panel-style-v1";
  const LIMITS_CACHE_KEY = "codex-windows-limits-panel-cache-v1";
  const REFRESH_INTERVAL_MS = 30000;
  const SETTINGS_TRUST_WINDOW_MS = 10 * 60 * 1000;

  const PANEL_HTML = '<div class="codex-windows-limit-summary" data-codex-limit-summary>5h -- | wk --</div>';

  const panelState = {
    fiveHour: undefined,
    weekly: undefined,
    updatedAtIso: "",
    settingsTrustUntilMs: 0,
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
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
    if (!(panel instanceof HTMLElement)) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.className = "codex-windows-limit-panel";
      panel.innerHTML = PANEL_HTML;
    }
    return panel;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  }

  function pickNumber(target, keys) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
    for (const key of keys) {
      if (!hasOwn(target, key)) continue;
      const value = target[key];
      const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
      if (Number.isFinite(numeric)) return numeric;
    }
    return undefined;
  }

  function pickString(target, keys) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return "";
    for (const key of keys) {
      if (!hasOwn(target, key)) continue;
      const value = target[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
    return "";
  }

  function clampPercent(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(100, Math.max(0, value));
  }

  function normalizeDurationSeconds(record) {
    const seconds = pickNumber(record, [
      "windowSeconds",
      "window_seconds",
      "windowSec",
      "window_sec",
      "durationSeconds",
      "duration_seconds",
      "periodSeconds",
      "period_seconds",
      "limit_window_seconds",
    ]);
    if (typeof seconds === "number") return seconds;

    const minutes = pickNumber(record, ["window_minutes", "windowMinutes", "window_mins", "windowMinutesCount"]);
    if (typeof minutes === "number") return minutes * 60;

    return undefined;
  }

  function windowKindFromSeconds(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
    if (seconds >= 17000 && seconds <= 19000) return "fiveHour";
    if (seconds >= 580000 && seconds <= 620000) return "weekly";
    return "";
  }

  function windowKindFromLabel(value) {
    const label = String(value || "").toLowerCase();
    if (!label) return "";
    if (
      label.includes("5h") ||
      label.includes("5-hour") ||
      label.includes("5 hour") ||
      label.includes("fivehour") ||
      label.includes("five_hour") ||
      label.includes("short_window")
    ) return "fiveHour";
    if (
      label.includes("7d") ||
      label.includes("7-day") ||
      label.includes("7 day") ||
      label.includes("week") ||
      label.includes("weekly") ||
      label.includes("seven_day")
    ) return "weekly";
    return "";
  }

  function readUsageEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

    const used = pickNumber(value, ["used", "consumed", "usage", "count", "requestsUsed", "usedCount"]);
    const limit = pickNumber(value, ["limit", "max", "quota", "requestsLimit", "limitCount"]);
    const remaining = pickNumber(value, ["remaining", "left", "available", "remainingCount"]);
    const usedPercent = clampPercent(pickNumber(value, ["used_percent", "usedPercent", "usage_percent", "percent_used"]));

    const resetsAt = pickNumber(value, ["resets_at", "reset_at_unix", "reset_at_ts"]);
    const resetAt =
      typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0
        ? new Date((resetsAt > 1000000000000 ? resetsAt : resetsAt * 1000)).toISOString()
        : pickString(value, ["resetAt", "reset_at", "resetTime", "reset_time", "windowResetAt", "resets_at"]);

    return {
      used: typeof used === "number" ? used : undefined,
      limit: typeof limit === "number" ? limit : undefined,
      remaining: typeof remaining === "number" ? remaining : undefined,
      usedPercent: typeof usedPercent === "number" ? usedPercent : undefined,
      resetAt: typeof resetAt === "string" ? resetAt : "",
    };
  }

  function scoreEntry(entry) {
    if (!entry) return 0;
    let score = 0;
    const percent = tryUsedPercent(entry);
    if (typeof percent === "number") score += 10;
    if (entry.used !== undefined) score += 2;
    if (entry.limit !== undefined) score += 2;
    if (entry.remaining !== undefined) score += 1;
    if (entry.resetAt && entry.resetAt.length > 0) score += 1;
    if (entry.source === "settings") score += 6;
    return score;
  }

  function chooseBetterEntry(current, next) {
    if (!next) return current;
    if (!current) return next;

    const currentScore = scoreEntry(current);
    const nextScore = scoreEntry(next);

    const currentPercent = tryUsedPercent(current);
    const nextPercent = tryUsedPercent(next);
    const currentResetAt = typeof current.resetAt === "string" ? current.resetAt : "";
    const nextResetAt = typeof next.resetAt === "string" ? next.resetAt : "";

    if (
      Date.now() < panelState.settingsTrustUntilMs &&
      current.source === "settings" &&
      next.source === "payload" &&
      typeof currentPercent === "number" &&
      typeof nextPercent === "number" &&
      Math.abs(currentPercent - nextPercent) >= 15
    ) {
      return current;
    }

    if (typeof currentPercent === "number" && typeof nextPercent !== "number") {
      return current;
    }
    if (typeof currentPercent === "number" && currentPercent > 1 && nextPercent === 0) {
      if (!nextResetAt || (currentResetAt && nextResetAt <= currentResetAt)) {
        return current;
      }
    }

    if (nextScore > currentScore) return next;
    if (nextScore < currentScore) return current;

    if (nextResetAt && currentResetAt) {
      if (nextResetAt > currentResetAt) return next;
      if (nextResetAt < currentResetAt) return current;
    }
    if (nextResetAt && !currentResetAt) return next;
    if (!nextResetAt && currentResetAt) return current;

    return next;
  }

  function tryUsedPercent(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    if (typeof entry.usedPercent === "number" && Number.isFinite(entry.usedPercent)) {
      return clampPercent(entry.usedPercent);
    }
    if (typeof entry.used === "number" && typeof entry.limit === "number" && Number.isFinite(entry.limit) && entry.limit > 0) {
      return clampPercent((entry.used / entry.limit) * 100);
    }
    if (
      typeof entry.remaining === "number" &&
      typeof entry.limit === "number" &&
      Number.isFinite(entry.remaining) &&
      Number.isFinite(entry.limit) &&
      entry.limit > 0
    ) {
      return clampPercent(((entry.limit - entry.remaining) / entry.limit) * 100);
    }
    return undefined;
  }

  function formatCompact(entry, fallback) {
    const usedPercent = tryUsedPercent(entry);
    if (typeof usedPercent === "number") return String(Math.round(usedPercent)) + "%";
    if (entry && typeof entry === "object" && typeof entry.used === "number" && typeof entry.limit === "number") {
      return String(entry.used) + "/" + String(entry.limit);
    }
    return fallback;
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!(panel instanceof HTMLElement)) return;
    const summaryNode = panel.querySelector("[data-codex-limit-summary]");
    if (!summaryNode) return;

    const five = formatCompact(panelState.fiveHour, "--");
    const weekly = formatCompact(panelState.weekly, "--");
    summaryNode.textContent = "5h " + five + " | wk " + weekly;
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
      // ignore storage errors
    }
  }

  function loadSnapshot() {
    try {
      const raw = localStorage.getItem(LIMITS_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      panelState.fiveHour = readUsageEntry(parsed.fiveHour) || panelState.fiveHour;
      panelState.weekly = readUsageEntry(parsed.weekly) || panelState.weekly;
      if (typeof parsed.updatedAtIso === "string") {
        panelState.updatedAtIso = parsed.updatedAtIso;
      }
    } catch {
      // ignore invalid cache
    }
  }

  function shouldIgnoreMirroredSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    if (!snapshot.fiveHour || !snapshot.weekly) return false;
    const incomingFive = tryUsedPercent(snapshot.fiveHour);
    const incomingWeekly = tryUsedPercent(snapshot.weekly);
    if (typeof incomingFive !== "number" || typeof incomingWeekly !== "number") return false;
    if (Math.round(incomingFive) !== Math.round(incomingWeekly)) return false;

    const currentFive = tryUsedPercent(panelState.fiveHour);
    const currentWeekly = tryUsedPercent(panelState.weekly);
    if (typeof currentFive !== "number" || typeof currentWeekly !== "number") return false;
    if (Math.round(currentFive) === Math.round(currentWeekly)) return false;

    return true;
  }

  function commitSnapshot(snapshot) {
    let source = "payload";
    if (arguments.length >= 2 && typeof arguments[1] === "string" && arguments[1].length > 0) {
      source = arguments[1];
    }
    if (!snapshot || typeof snapshot !== "object") return;
    if (shouldIgnoreMirroredSnapshot(snapshot)) return;

    let changed = false;

    if (snapshot.fiveHour) {
      const incoming = { ...snapshot.fiveHour, source };
      const merged = chooseBetterEntry(panelState.fiveHour, incoming);
      if (merged !== panelState.fiveHour) {
        panelState.fiveHour = merged;
        changed = true;
      }
    }

    if (snapshot.weekly) {
      const incoming = { ...snapshot.weekly, source };
      const merged = chooseBetterEntry(panelState.weekly, incoming);
      if (merged !== panelState.weekly) {
        panelState.weekly = merged;
        changed = true;
      }
    }

    if (!changed) return;

    if (source === "settings") {
      panelState.settingsTrustUntilMs = Date.now() + SETTINGS_TRUST_WINDOW_MS;
    }
    panelState.updatedAtIso = new Date().toISOString();
    saveSnapshot();
    renderPanel();
  }

  function parseWindowEntry(windowValue, labelFallback) {
    const entry = readUsageEntry(windowValue);
    if (!entry || !windowValue || typeof windowValue !== "object" || Array.isArray(windowValue)) {
      return undefined;
    }
    const durationSeconds = normalizeDurationSeconds(windowValue);
    const kind = windowKindFromSeconds(durationSeconds) || windowKindFromLabel(labelFallback || "");
    if (!kind) return undefined;
    return { kind, entry };
  }

  function looksLikeWindow(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    return (
      hasOwn(record, "used_percent") ||
      hasOwn(record, "usedPercent") ||
      hasOwn(record, "window_minutes") ||
      hasOwn(record, "windowMinutes") ||
      hasOwn(record, "limit_window_seconds") ||
      hasOwn(record, "window_seconds")
    );
  }

  function looksLikeRateLimits(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const primary = record.primary_window || record.primaryWindow || record.primary;
    const secondary = record.secondary_window || record.secondaryWindow || record.secondary;
    return looksLikeWindow(primary) && looksLikeWindow(secondary);
  }

  function parseSnapshotFromRateLimitsRecord(record) {
    const result = { fiveHour: undefined, weekly: undefined };
    if (!record || typeof record !== "object") return result;

    const primaryCandidate = record.primary_window || record.primaryWindow || record.primary;
    const secondaryCandidate = record.secondary_window || record.secondaryWindow || record.secondary;

    const primary = parseWindowEntry(primaryCandidate, "primary");
    const secondary = parseWindowEntry(secondaryCandidate, "secondary");

    if (primary && primary.kind === "fiveHour") result.fiveHour = chooseBetterEntry(result.fiveHour, primary.entry);
    if (primary && primary.kind === "weekly") result.weekly = chooseBetterEntry(result.weekly, primary.entry);
    if (secondary && secondary.kind === "fiveHour") result.fiveHour = chooseBetterEntry(result.fiveHour, secondary.entry);
    if (secondary && secondary.kind === "weekly") result.weekly = chooseBetterEntry(result.weekly, secondary.entry);

    return result;
  }

  function scoreSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return 0;
    let score = 0;
    if (snapshot.fiveHour) score += scoreEntry(snapshot.fiveHour);
    if (snapshot.weekly) score += scoreEntry(snapshot.weekly);
    if (snapshot.fiveHour && snapshot.weekly) score += 4;
    return score;
  }

  function parseSnapshotFromPayload(payload) {
    const best = { fiveHour: undefined, weekly: undefined };
    if (!payload || typeof payload !== "object") return best;

    const stack = [payload];
    const seen = new Set();
    let visited = 0;
    let bestScore = 0;

    while (stack.length > 0) {
      if (visited > 220) break;
      visited += 1;

      const current = stack.pop();
      if (!current || typeof current !== "object") continue;
      if (seen.has(current)) continue;
      seen.add(current);

      if (looksLikeRateLimits(current)) {
        const snapshot = parseSnapshotFromRateLimitsRecord(current);
        const snapshotScore = scoreSnapshot(snapshot);
        if (snapshotScore > bestScore) {
          bestScore = snapshotScore;
          best.fiveHour = snapshot.fiveHour;
          best.weekly = snapshot.weekly;
        }
      }

      if (Array.isArray(current)) {
        for (let index = 0; index < Math.min(current.length, 10); index += 1) {
          stack.push(current[index]);
        }
        continue;
      }

      const keys = Object.keys(current);
      for (let index = 0; index < Math.min(keys.length, 24); index += 1) {
        stack.push(current[keys[index]]);
      }
    }

    return best;
  }

  function firstNeedleIndex(hayLower, needles) {
    let best = -1;
    for (const needle of needles) {
      const index = hayLower.indexOf(needle);
      if (index < 0) continue;
      best = best < 0 ? index : Math.min(best, index);
    }
    return best;
  }

  function parseEntryFromText(text) {
    const line = normalizeText(text);
    if (line.length < 3) return undefined;

    const fraction = line.match(/(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})/i);
    if (fraction) {
      const used = Number.parseInt(fraction[1], 10);
      const limit = Number.parseInt(fraction[2], 10);
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
        return { used, limit, remaining: Math.max(0, limit - used), usedPercent: clampPercent((used / limit) * 100), resetAt: "" };
      }
    }

    const percentUsed = line.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%\s*(?:used|utilized)/i);
    if (percentUsed) {
      const usedPercent = clampPercent(Number.parseFloat(percentUsed[1]));
      if (typeof usedPercent === "number") {
        return { used: undefined, limit: undefined, remaining: undefined, usedPercent, resetAt: "" };
      }
    }

    const percentLeft = line.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%\s*(?:left|remaining)/i);
    if (percentLeft) {
      const left = clampPercent(Number.parseFloat(percentLeft[1]));
      if (typeof left === "number") {
        const usedPercent = clampPercent(100 - left);
        if (typeof usedPercent === "number") {
          return { used: undefined, limit: undefined, remaining: undefined, usedPercent, resetAt: "" };
        }
      }
    }

    return undefined;
  }

  function parseEntryNearLabel(pageText, pageTextLower, labelNeedles) {
    let best = undefined;
    let searchFrom = 0;

    function pickCandidate(candidate) {
      best = chooseBetterEntry(best, candidate);
    }

    while (true) {
      let labelIndex = -1;
      let matchedNeedle = "";
      for (const needle of labelNeedles) {
        const index = pageTextLower.indexOf(needle, searchFrom);
        if (index < 0) continue;
        if (labelIndex < 0 || index < labelIndex) {
          labelIndex = index;
          matchedNeedle = needle;
        }
      }
      if (labelIndex < 0) break;

      const windowStart = Math.max(0, labelIndex - 40);
      const windowEnd = Math.min(pageText.length, labelIndex + 260);
      const snippet = pageText.slice(windowStart, windowEnd);
      const parsed = parseEntryFromText(snippet);
      if (parsed) pickCandidate(parsed);

      const after = pageText.slice(labelIndex, Math.min(pageText.length, labelIndex + 420));
      const lines = after.split(/\r?\n/).slice(0, 6);
      for (const line of lines) {
        const parsedLine = parseEntryFromText(line);
        if (parsedLine) pickCandidate(parsedLine);
      }

      searchFrom = labelIndex + matchedNeedle.length;
    }

    return best;
  }

  function parseSnapshotFromSettingsText() {
    const result = { fiveHour: undefined, weekly: undefined };
    const root = document.body;
    if (!(root instanceof HTMLElement)) return result;

    const pageText = normalizeText(root.innerText || root.textContent || "");
    if (!pageText) return result;
    const lower = pageText.toLowerCase();

    const five = parseEntryNearLabel(pageText, lower, [
      "5 hour usage limit",
      "5-hour usage limit",
      "5 hour limit",
      "5-hour limit",
      "5h usage",
      "5h limit",
    ]);
    if (five) result.fiveHour = five;

    const weekly = parseEntryNearLabel(pageText, lower, [
      "weekly usage limit",
      "weekly limit",
      "7 day usage limit",
      "7-day usage limit",
      "7 day limit",
      "7-day limit",
    ]);
    if (weekly) result.weekly = weekly;

    return result;
  }

  function captureFromSettingsIfOpen() {
    const routeText = (String(window.location.pathname || "") + " " + String(window.location.hash || "")).toLowerCase();
    if (!routeText.includes("settings")) return;
    commitSnapshot(parseSnapshotFromSettingsText(), "settings");
  }

  function isSettingsCandidate(node) {
    const text = normalizeText(node.textContent).toLowerCase();
    if (text === "settings") return true;
    const aria = normalizeText(node.getAttribute("aria-label")).toLowerCase();
    if (aria === "settings") return true;
    const href = normalizeText(node.getAttribute("href")).toLowerCase();
    if (href.includes("settings")) return true;
    return false;
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

  function findBestSettingsAnchor() {
    const candidates = document.querySelectorAll("button,[role='button'],a");
    let best = undefined;
    let bestScore = -999;
    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      if (!isSettingsCandidate(node)) continue;
      const score = scoreSettingsCandidate(node);
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  function resolveSidebarContainer(anchor) {
    if (!(anchor instanceof HTMLElement)) return undefined;
    const container = anchor.closest(
      "aside,nav,[role='navigation'],[class*='sidebar'],[class*='Sidebar'],[data-testid*='sidebar']",
    );
    return container instanceof HTMLElement ? container : undefined;
  }

  function resolveHost(node) {
    const host = node.closest("button,[role='button'],a,li,div") || node;
    return host instanceof HTMLElement ? host : undefined;
  }

  function injectPanel() {
    ensureStyle();
    const panel = ensurePanelNode();

    const anchor = findBestSettingsAnchor();
    const sidebar = resolveSidebarContainer(anchor);
    if (sidebar instanceof HTMLElement) {
      panel.classList.remove("codex-windows-limit-panel--floating");
      const host = anchor ? resolveHost(anchor) : undefined;
      if (host instanceof HTMLElement && host.parentElement instanceof HTMLElement) {
        if (panel.parentElement !== host.parentElement || panel.nextSibling !== host) {
          host.parentElement.insertBefore(panel, host);
        }
        return;
      }
      const insertionPoint = sidebar.firstChild || null;
      if (panel.parentElement !== sidebar || panel.nextSibling !== insertionPoint) sidebar.insertBefore(panel, insertionPoint);
      return;
    }

    if (document.body) {
      panel.classList.add("codex-windows-limit-panel--floating");
      if (panel.parentElement !== document.body) {
        document.body.appendChild(panel);
      }
    }
  }

  function scheduleInjectBurst() {
    const delays = [50, 250, 750, 1500, 5000];
    for (const delayMs of delays) {
      window.setTimeout(() => {
        try {
          injectPanel();
          renderPanel();
          captureFromSettingsIfOpen();
        } catch {
          // ignore burst errors
        }
      }, delayMs);
    }
  }

  function installInjectObserver() {
    const observer = new MutationObserver(() => {
      try {
        injectPanel();
      } catch {
        // ignore observer errors
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function installMessageInterceptor() {
    window.addEventListener(
      "message",
      (event) => {
        try {
          const eventRecord = event && typeof event === "object" ? event : undefined;
          let payload = eventRecord ? eventRecord.data : undefined;
          if (typeof payload === "string") {
            const rawText = payload.trim();
            if ((rawText.startsWith("{") && rawText.endsWith("}")) || (rawText.startsWith("[") && rawText.endsWith("]"))) {
              try {
                payload = JSON.parse(rawText);
              } catch {
                payload = undefined;
              }
            } else {
              payload = undefined;
            }
          }
          if (!payload || typeof payload !== "object") return;
          const snapshot = parseSnapshotFromPayload(payload);
          if (snapshot.fiveHour || snapshot.weekly) {
            commitSnapshot(snapshot, "payload");
          }
        } catch {
          // ignore malformed bridge payloads
        }
      },
      true,
    );
  }

  function installPeriodicRefresh() {
    window.setInterval(() => {
      try {
        injectPanel();
        captureFromSettingsIfOpen();
        renderPanel();
      } catch {
        // ignore periodic refresh errors
      }
    }, REFRESH_INTERVAL_MS);
  }

  loadSnapshot();
  injectPanel();
  renderPanel();
  scheduleInjectBurst();
  installInjectObserver();
  installMessageInterceptor();
  installPeriodicRefresh();

  document.addEventListener(
    "click",
    (event) => {
      try {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const clickable = target.closest("button,[role='button'],a,div,span");
        if (!(clickable instanceof HTMLElement)) return;
        if (!isSettingsCandidate(clickable)) return;
        scheduleInjectBurst();
      } catch {
        // ignore click errors
      }
    },
    true,
  );
})();
