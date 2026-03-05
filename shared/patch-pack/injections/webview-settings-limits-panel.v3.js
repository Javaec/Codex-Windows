(function () {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V12__) {
    return;
  }
  globalRecord.__CODEX_WINDOWS_SETTINGS_LIMIT_PANEL_V12__ = true;

  const PANEL_ID = "codex-windows-settings-limit-panel-v1";
  const STYLE_ID = "codex-windows-settings-limit-panel-style-v1";
  const LIMITS_CACHE_KEY = "codex-windows-limits-panel-cache-v1";
  const PANEL_REFRESH_INTERVAL_MS = 45000;

  const PANEL_HTML =
    '<div class="codex-windows-limit-summary" data-codex-limit-summary>5h -- | wk --</div>' +
    '<div class="codex-windows-limit-updated" data-codex-limit-updated>waiting for data</div>';

  const KEY_HINTS = new Set([
    "rate_limit",
    "primary_window",
    "secondary_window",
    "used_percent",
    "window_minutes",
    "limit_window_seconds",
    "resets_at",
    "credits",
    "quota",
    "usage",
    "remaining",
    "limit",
  ]);

  const panelState = {
    fiveHour: undefined,
    weekly: undefined,
    updatedAtIso: "",
    source: "",
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".codex-windows-limit-panel{display:flex;flex-direction:column;gap:4px;margin:6px 0 8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);font-size:12px;line-height:1.25}.codex-windows-limit-panel--floating{position:fixed;left:12px;bottom:12px;z-index:9999;max-width:280px;backdrop-filter:blur(4px)}.codex-windows-limit-summary{font-weight:700;letter-spacing:.15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.codex-windows-limit-updated{opacity:.72;font-size:11px}";
    if (document.head) {
      document.head.appendChild(style);
    }
  }

  function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  }

  function pickNumber(target, keys) {
    for (const key of keys) {
      if (!hasOwn(target, key)) continue;
      const value = target[key];
      const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
    return undefined;
  }

  function pickString(target, keys) {
    for (const key of keys) {
      if (!hasOwn(target, key)) continue;
      const value = target[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return "";
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clampPercent(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
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
    if (typeof seconds === "number") {
      return seconds;
    }

    const minutes = pickNumber(record, ["window_minutes", "windowMinutes", "window_mins", "windowMinutesCount"]);
    if (typeof minutes === "number") {
      return minutes * 60;
    }
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

  function readResetAt(record) {
    const text = pickString(record, ["resetAt", "reset_at", "resetTime", "reset_time", "windowResetAt", "resets_at"]);
    if (text.length > 0) {
      return text;
    }
    const unixSeconds = pickNumber(record, ["resets_at", "reset_at_unix", "reset_at_ts"]);
    if (typeof unixSeconds === "number") {
      const millis = unixSeconds > 1000000000000 ? unixSeconds : unixSeconds * 1000;
      const date = new Date(millis);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
    return "";
  }

  function readUsageEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    const record = value;
    const used = pickNumber(record, ["used", "consumed", "usage", "count", "requestsUsed", "usedCount"]);
    const limit = pickNumber(record, ["limit", "max", "quota", "requestsLimit", "limitCount"]);
    const remaining = pickNumber(record, ["remaining", "left", "available", "remainingCount"]);
    const usedPercent = clampPercent(pickNumber(record, ["used_percent", "usedPercent", "usage_percent", "percent_used"]));
    const resetAt = readResetAt(record);

    const normalizedRemaining =
      typeof remaining === "number"
        ? remaining
        : typeof usedPercent === "number"
          ? clampPercent(100 - usedPercent)
          : undefined;

    if (
      used === undefined &&
      limit === undefined &&
      normalizedRemaining === undefined &&
      usedPercent === undefined &&
      resetAt.length < 1
    ) {
      return undefined;
    }

    return {
      used,
      limit,
      remaining: normalizedRemaining,
      usedPercent,
      resetAt,
    };
  }

  function scoreEntry(entry) {
    if (!entry) return 0;
    let score = 0;
    if (entry.used !== undefined) score += 3;
    if (entry.limit !== undefined) score += 3;
    if (entry.usedPercent !== undefined) score += 4;
    if (entry.remaining !== undefined) score += 2;
    if (entry.resetAt && entry.resetAt.length > 0) score += 1;
    return score;
  }

  function deriveUsedPercent(entry) {
    if (!entry || typeof entry !== "object") {
      return 0;
    }
    if (typeof entry.usedPercent === "number" && Number.isFinite(entry.usedPercent)) {
      return clampPercent(entry.usedPercent) || 0;
    }
    if (typeof entry.used === "number" && typeof entry.limit === "number" && Number.isFinite(entry.limit) && entry.limit > 0) {
      const ratio = (entry.used / entry.limit) * 100;
      return clampPercent(ratio) || 0;
    }
    if (typeof entry.remaining === "number" && Number.isFinite(entry.remaining)) {
      return clampPercent(100 - entry.remaining) || 0;
    }
    return 0;
  }

  function chooseBetterEntry(current, next) {
    if (!next) return current;
    if (!current) return next;
    const currentScore = scoreEntry(current);
    const nextScore = scoreEntry(next);
    if (nextScore > currentScore) return next;
    if (nextScore < currentScore) return current;

    const currentUsedPercent = deriveUsedPercent(current);
    const nextUsedPercent = deriveUsedPercent(next);
    if (nextUsedPercent > currentUsedPercent) return next;
    if (nextUsedPercent < currentUsedPercent) return current;

    const currentResetAt = typeof current.resetAt === "string" ? current.resetAt : "";
    const nextResetAt = typeof next.resetAt === "string" ? next.resetAt : "";
    if (nextResetAt && currentResetAt) {
      if (nextResetAt > currentResetAt) return next;
      if (nextResetAt < currentResetAt) return current;
    }
    if (nextResetAt && !currentResetAt) return next;
    if (!nextResetAt && currentResetAt) return current;

    return next;
  }

  function isSettingsSnapshotSource(source) {
    return source === "settings-dom" || source === "settings-text";
  }

  function parseWindowEntry(windowValue, labelFallback) {
    const entry = readUsageEntry(windowValue);
    if (!entry || !windowValue || typeof windowValue !== "object" || Array.isArray(windowValue)) {
      return undefined;
    }
    const durationSeconds = normalizeDurationSeconds(windowValue);
    const kind = windowKindFromSeconds(durationSeconds) || windowKindFromLabel(labelFallback || "");
    if (!kind) {
      return undefined;
    }
    return { kind, entry };
  }

  function parseSnapshotFromPayload(payload) {
    const result = { fiveHour: undefined, weekly: undefined };
    const stack = [{ value: payload, label: "" }];
    const seen = new Set();
    let visited = 0;

    while (stack.length > 0) {
      if (visited > 1200) break;
      visited += 1;

      const item = stack.pop();
      if (!item) continue;
      const current = item.value;
      if (!current || typeof current !== "object") continue;
      if (seen.has(current)) continue;
      seen.add(current);

      if (Array.isArray(current)) {
        const count = Math.min(current.length, 50);
        for (let index = 0; index < count; index += 1) {
          stack.push({ value: current[index], label: item.label });
        }
        continue;
      }

      const record = current;

      const directLabel = pickString(record, ["window", "windowLabel", "period", "name", "id", "type", "limit_name", "rate_limit_name"]);
      const durationSeconds = normalizeDurationSeconds(record);
      const entry = readUsageEntry(record);
      const kind = windowKindFromSeconds(durationSeconds) || windowKindFromLabel(item.label) || windowKindFromLabel(directLabel);

      if (entry && kind === "fiveHour") {
        result.fiveHour = chooseBetterEntry(result.fiveHour, entry);
      }
      if (entry && kind === "weekly") {
        result.weekly = chooseBetterEntry(result.weekly, entry);
      }

      const rateLimit = hasOwn(record, "rate_limit") ? record.rate_limit : undefined;
      if (rateLimit && typeof rateLimit === "object") {
        const primaryWindow = parseWindowEntry(rateLimit.primary_window, "primary_window");
        const secondaryWindow = parseWindowEntry(rateLimit.secondary_window, "secondary_window");
        if (primaryWindow?.kind === "fiveHour") result.fiveHour = chooseBetterEntry(result.fiveHour, primaryWindow.entry);
        if (primaryWindow?.kind === "weekly") result.weekly = chooseBetterEntry(result.weekly, primaryWindow.entry);
        if (secondaryWindow?.kind === "fiveHour") result.fiveHour = chooseBetterEntry(result.fiveHour, secondaryWindow.entry);
        if (secondaryWindow?.kind === "weekly") result.weekly = chooseBetterEntry(result.weekly, secondaryWindow.entry);
      }

      const primary = parseWindowEntry(record.primary_window || record.primary, "primary");
      const secondary = parseWindowEntry(record.secondary_window || record.secondary, "secondary");
      if (primary?.kind === "fiveHour") result.fiveHour = chooseBetterEntry(result.fiveHour, primary.entry);
      if (primary?.kind === "weekly") result.weekly = chooseBetterEntry(result.weekly, primary.entry);
      if (secondary?.kind === "fiveHour") result.fiveHour = chooseBetterEntry(result.fiveHour, secondary.entry);
      if (secondary?.kind === "weekly") result.weekly = chooseBetterEntry(result.weekly, secondary.entry);

      const keys = Object.keys(record);
      const keyCount = Math.min(keys.length, 40);
      for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
        const key = keys[keyIndex];
        stack.push({ value: record[key], label: key });
      }
    }

    return result;
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

    const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (percentMatch) {
      const rawPercent = Number.parseFloat(percentMatch[1]);
      const normalizedPercent = clampPercent(rawPercent);
      if (typeof normalizedPercent === "number") {
        const lower = line.toLowerCase();
        const usedPercent = lower.includes("remaining") || lower.includes("left")
          ? clampPercent(100 - normalizedPercent)
          : normalizedPercent;
        if (typeof usedPercent === "number") {
          return {
            used: undefined,
            limit: undefined,
            remaining: clampPercent(100 - usedPercent),
            usedPercent,
            resetAt: "",
          };
        }
      }
    }

    return undefined;
  }

  function firstNeedleIndex(textLower, needles) {
    for (let index = 0; index < needles.length; index += 1) {
      const needle = needles[index];
      const position = textLower.indexOf(needle);
      if (position >= 0) {
        return position;
      }
    }
    return -1;
  }

  function parseEntryNearLabel(pageText, pageTextLower, needles) {
    let best;

    function pickCandidate(candidate) {
      if (!candidate) {
        return;
      }
      if (!best) {
        best = candidate;
        return;
      }
      const bestUsedPercent = deriveUsedPercent(best);
      const candidateUsedPercent = deriveUsedPercent(candidate);
      if (candidateUsedPercent > bestUsedPercent) {
        best = candidate;
        return;
      }
      best = chooseBetterEntry(best, candidate);
    }

    for (let needleIndex = 0; needleIndex < needles.length; needleIndex += 1) {
      const needle = needles[needleIndex];
      let searchFrom = 0;
      while (searchFrom < pageTextLower.length) {
        const labelIndex = pageTextLower.indexOf(needle, searchFrom);
        if (labelIndex < 0) {
          break;
        }

        const snippetStart = Math.max(0, labelIndex - 80);
        const snippetEnd = Math.min(pageText.length, labelIndex + 340);
        const snippet = pageText.slice(snippetStart, snippetEnd);

        const parsed = parseEntryFromText(snippet);
        if (parsed) {
          pickCandidate(parsed);
        } else {
          const percentMatch = snippet.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(left|remaining|used)?/i);
          if (percentMatch) {
            const rawPercent = Number.parseFloat(percentMatch[1]);
            const normalizedPercent = clampPercent(rawPercent);
            if (typeof normalizedPercent === "number") {
              const mode = String(percentMatch[2] || "").toLowerCase();
              const usedPercent = mode === "left" || mode === "remaining" ? clampPercent(100 - normalizedPercent) : normalizedPercent;
              if (typeof usedPercent === "number") {
                pickCandidate({
                  used: undefined,
                  limit: undefined,
                  remaining: clampPercent(100 - usedPercent),
                  usedPercent,
                  resetAt: "",
                });
              }
            }
          }
        }

        searchFrom = labelIndex + needle.length;
      }
    }

    return best;
  }

  function parseSnapshotFromSettingsText() {
    const result = { fiveHour: undefined, weekly: undefined };
    const root = document.body;
    if (!(root instanceof HTMLElement)) {
      return result;
    }
    const pageText = normalizeText(root.innerText || root.textContent || "");
    if (!pageText) {
      return result;
    }
    const pageTextLower = pageText.toLowerCase();

    const fiveHourEntry = parseEntryNearLabel(pageText, pageTextLower, [
      "5 hour usage limit",
      "5-hour usage limit",
      "5 hour limit",
      "5-hour limit",
      "5h usage",
      "5h limit",
    ]);
    if (fiveHourEntry) {
      result.fiveHour = fiveHourEntry;
    }

    const weeklyEntry = parseEntryNearLabel(pageText, pageTextLower, [
      "weekly usage limit",
      "weekly limit",
      "7 day usage limit",
      "7-day usage limit",
      "7 day limit",
      "7-day limit",
    ]);
    if (weeklyEntry) {
      result.weekly = weeklyEntry;
    }

    return result;
  }

  function parseSnapshotFromSettingsDom() {
    const result = { fiveHour: undefined, weekly: undefined };
    const nodes = document.querySelectorAll("div,li,span,p,button,tr,td,strong");
    const count = Math.min(nodes.length, 900);
    let foundFiveFromDom = false;
    let foundWeeklyFromDom = false;

    for (let index = 0; index < count; index += 1) {
      const node = nodes[index];
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest(`#${PANEL_ID}`)) continue;
      const text = normalizeText(node.textContent);
      if (!text) continue;
      const lower = text.toLowerCase();
      if (!/usage\s*limit|weekly\s*limit|5\s*-?\s*hour|7\s*-?\s*day/.test(lower)) continue;

      const kind = windowKindFromLabel(text);
      if (!kind) continue;

      const container = node.closest("li,section,article,div,tr") || node;
      const rowText = normalizeText(container.textContent);
      let entry = parseEntryFromText(rowText) || parseEntryFromText(text);
      if (!entry) {
        const rowLower = rowText.toLowerCase();
        const labelNeedles = kind === "fiveHour"
          ? ["5 hour", "5-hour", "5h"]
          : ["weekly", "7 day", "7-day", "week"];
        const rowLabelIndex = firstNeedleIndex(rowLower, labelNeedles);
        if (rowLabelIndex >= 0) {
          const rowSnippetStart = Math.max(0, rowLabelIndex - 60);
          const rowSnippetEnd = Math.min(rowText.length, rowLabelIndex + 280);
          entry = parseEntryFromText(rowText.slice(rowSnippetStart, rowSnippetEnd));
        }
      }
      if (!entry) continue;

      if (kind === "fiveHour") {
        result.fiveHour = chooseBetterEntry(result.fiveHour, entry);
        foundFiveFromDom = true;
      }
      if (kind === "weekly") {
        result.weekly = chooseBetterEntry(result.weekly, entry);
        foundWeeklyFromDom = true;
      }
    }

    const textSnapshot = parseSnapshotFromSettingsText();
    if (!foundFiveFromDom && textSnapshot.fiveHour) {
      result.fiveHour = chooseBetterEntry(result.fiveHour, textSnapshot.fiveHour);
    }
    if (!foundWeeklyFromDom && textSnapshot.weekly) {
      result.weekly = chooseBetterEntry(result.weekly, textSnapshot.weekly);
    }

    return result;
  }

  function tryUsedPercent(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    if (typeof entry.usedPercent === "number" && Number.isFinite(entry.usedPercent)) {
      return clampPercent(entry.usedPercent);
    }
    if (typeof entry.used === "number" && typeof entry.limit === "number" && Number.isFinite(entry.limit) && entry.limit > 0) {
      return clampPercent((entry.used / entry.limit) * 100);
    }
    if (typeof entry.remaining === "number" && Number.isFinite(entry.remaining)) {
      return clampPercent(100 - entry.remaining);
    }
    return undefined;
  }

  function formatCompact(entry, fallback) {
    const usedPercent = tryUsedPercent(entry);
    if (typeof usedPercent === "number") {
      return String(Math.round(usedPercent)) + "%";
    }
    if (entry && typeof entry === "object" && typeof entry.used === "number" && typeof entry.limit === "number") {
      return String(entry.used) + "/" + String(entry.limit);
    }
    return fallback;
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

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!(panel instanceof HTMLElement)) return;

    const summaryNode = panel.querySelector("[data-codex-limit-summary]");
    const updatedNode = panel.querySelector("[data-codex-limit-updated]");

    if (summaryNode) {
      const five = formatCompact(panelState.fiveHour, "--");
      const weekly = formatCompact(panelState.weekly, "--");
      summaryNode.textContent = `5h ${five} | wk ${weekly}`;
    }

    if (updatedNode) {
      if (panelState.updatedAtIso) {
        const suffix = panelState.source ? ` (${panelState.source})` : "";
        updatedNode.textContent = "updated " + String(panelState.updatedAtIso) + suffix;
      } else {
        updatedNode.textContent = "waiting for data";
      }
    }
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
      // keep runtime only
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

  function commitSnapshot(snapshot, source) {
    if (!isSettingsSnapshotSource(source) && isSettingsSnapshotSource(panelState.source)) {
      return;
    }

    if (isSettingsSnapshotSource(source) && shouldIgnoreMirroredSnapshot(snapshot)) {
      return;
    }

    let changed = false;

    if (snapshot.fiveHour) {
      if (isSettingsSnapshotSource(source)) {
        if (panelState.fiveHour !== snapshot.fiveHour) {
          panelState.fiveHour = snapshot.fiveHour;
          changed = true;
        }
      } else {
        const merged = chooseBetterEntry(panelState.fiveHour, snapshot.fiveHour);
        if (merged !== panelState.fiveHour) {
          panelState.fiveHour = merged;
          changed = true;
        }
      }
    }

    if (snapshot.weekly) {
      if (isSettingsSnapshotSource(source)) {
        if (panelState.weekly !== snapshot.weekly) {
          panelState.weekly = snapshot.weekly;
          changed = true;
        }
      } else {
        const merged = chooseBetterEntry(panelState.weekly, snapshot.weekly);
        if (merged !== panelState.weekly) {
          panelState.weekly = merged;
          changed = true;
        }
      }
    }

    if (!changed) return;

    panelState.updatedAtIso = new Date().toISOString();
    panelState.source = source;
    saveSnapshot();
    renderPanel();
  }

  function updateFromPayload(payload, source) {
    if (!payload || typeof payload !== "object") return;
    commitSnapshot(parseSnapshotFromPayload(payload), source);
  }

  function updateFromSettingsDom(source) {
    commitSnapshot(parseSnapshotFromSettingsDom(), source || "settings-dom");
  }

  function payloadHasLimitHints(payload) {
    const stack = [payload];
    const seen = new Set();
    let visited = 0;

    while (stack.length > 0) {
      if (visited > 900) return false;
      visited += 1;

      const current = stack.pop();
      if (!current || typeof current !== "object") continue;
      if (seen.has(current)) continue;
      seen.add(current);

      if (Array.isArray(current)) {
        const count = Math.min(current.length, 15);
        for (let index = 0; index < count; index += 1) {
          stack.push(current[index]);
        }
        continue;
      }

      const keys = Object.keys(current);
      const keyCount = Math.min(keys.length, 20);
      for (let index = 0; index < keyCount; index += 1) {
        const key = keys[index];
        if (KEY_HINTS.has(key)) {
          return true;
        }
      }

      const typeValue = pickString(current, ["type", "method", "event"]);
      if (/account|config|usage|quota|limit|rate/i.test(typeValue)) {
        return true;
      }

      for (let index = 0; index < keyCount; index += 1) {
        stack.push(current[keys[index]]);
      }
    }

    return false;
  }

  function isSettingsLabel(value) {
    return String(value || "").trim().toLowerCase() === "settings";
  }

  function findSettingsAnchor() {
    const candidates = document.querySelectorAll("button,[role='button'],a,div,span");
    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      if (!isSettingsLabel(node.textContent)) continue;
      return node;
    }
    return undefined;
  }

  function resolveHost(node) {
    const host = node.closest("button,[role='button'],a,li,div") || node;
    return host instanceof HTMLElement ? host : undefined;
  }

  function findSidebarContainer() {
    const selectors = [
      "aside",
      "[role='navigation']",
      "[class*='sidebar']",
      "[class*='Sidebar']",
      "[data-testid*='sidebar']",
      "nav",
    ];
    for (let index = 0; index < selectors.length; index += 1) {
      const selector = selectors[index];
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    return undefined;
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

  function injectPanel() {
    ensureStyle();
    const panel = ensurePanelNode();
    const anchor = findSettingsAnchor();
    const host = anchor ? resolveHost(anchor) : undefined;
    if (host && host.parentElement) {
      const parent = host.parentElement;
      panel.classList.remove("codex-windows-limit-panel--floating");
      if (panel.parentElement !== parent || panel.nextSibling !== host) {
        parent.insertBefore(panel, host);
      }
      renderPanel();
      return true;
    }

    const sidebar = findSidebarContainer();
    if (sidebar) {
      panel.classList.remove("codex-windows-limit-panel--floating");
      if (panel.parentElement !== sidebar) {
        sidebar.insertBefore(panel, sidebar.firstChild || null);
      }
      renderPanel();
      return true;
    }

    if (document.body) {
      panel.classList.add("codex-windows-limit-panel--floating");
      if (panel.parentElement !== document.body) {
        document.body.appendChild(panel);
      }
      renderPanel();
      return true;
    }

    renderPanel();
    return true;
  }

  function scheduleSettingsCaptureBurst(force) {
    const delays = [100, 600, 1500];
    for (const delayMs of delays) {
      window.setTimeout(() => {
        try {
          injectPanel();
          const routeText = (String(window.location.pathname || "") + " " + String(window.location.hash || "")).toLowerCase();
          if (force || routeText.includes("settings")) {
            updateFromSettingsDom("settings-dom");
          }
        } catch {
          // keep UI responsive
        }
      }, delayMs);
    }
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
          updateFromPayload(payload, "bridge-message");
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
        const routeText = (String(window.location.pathname || "") + " " + String(window.location.hash || "")).toLowerCase();
        if (routeText.includes("settings")) {
          updateFromSettingsDom("settings-dom");
        } else {
          renderPanel();
        }
      } catch {
        // ignore periodic refresh errors
      }
    }, PANEL_REFRESH_INTERVAL_MS);
  }

  loadSnapshot();
  injectPanel();
  renderPanel();

  installMessageInterceptor();
  scheduleSettingsCaptureBurst();
  installPeriodicRefresh();

  document.addEventListener(
    "click",
    (event) => {
      try {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const button = target.closest("button,[role='button'],a,div,span");
        if (!(button instanceof HTMLElement)) return;
        if (!isSettingsLabel(button.textContent)) return;
        scheduleSettingsCaptureBurst(true);
      } catch {
        // ignore click parse errors
      }
    },
    true,
  );
})();
