import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists, runCommand } from "./exec";

const AUTOSCROLL_SCRIPT_FILE = "codex-windows-autoscroll.js";

export function patchPreload(appDir: string): void {
  const preload = path.join(appDir, ".vite", "build", "preload.js");
  if (!fileExists(preload)) return;
  let raw = fs.readFileSync(preload, "utf8");
  const processExpose =
    'const P={env:process.env,platform:process.platform,versions:process.versions,arch:process.arch,cwd:()=>process.env.PWD,argv:process.argv,pid:process.pid};n.contextBridge.exposeInMainWorld("process",P);';
  if (!raw.includes(processExpose)) {
    const pattern =
      /n\.contextBridge\.exposeInMainWorld\("codexWindowType",[A-Za-z0-9_$]+\);n\.contextBridge\.exposeInMainWorld\("electronBridge",[A-Za-z0-9_$]+\);/;
    const match = raw.match(pattern);
    if (!match) throw new Error("preload patch point not found.");
    raw = raw.replace(match[0], `${processExpose}${match[0]}`);
    fs.writeFileSync(preload, raw, "utf8");
  }
}

function buildWebviewAutoscrollScript(): string {
  return String.raw`(() => {
  if (window.__CODEX_WINDOWS_CHAT_AUTOSCROLL__) return;
  window.__CODEX_WINDOWS_CHAT_AUTOSCROLL__ = true;

  const BOTTOM_EPSILON = 80;
  const SWITCH_SCROLL_DELAYS = [60, 220, 560];
  const SIDEBAR_CLICK_MAX_X_RATIO = 0.35;
  const SWITCH_MUTATION_NODE_THRESHOLD = 25;
  const SWITCH_TRIGGER_COOLDOWN_MS = 120;
  const SWITCH_ATTR_VALUE_TRUE = new Set(["true", "1", "active", "selected", "current", "open", "on"]);
  const stickyState = new WeakMap();
  let activeScroller = null;
  let knownRoute = location.pathname + location.search + location.hash;
  let lastSwitchTriggerAt = 0;

  function isElement(node) {
    return node instanceof HTMLElement;
  }

  function isScrollable(el) {
    const style = window.getComputedStyle(el);
    if (!style) return false;
    const overflowY = style.overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") return false;
    return el.scrollHeight - el.clientHeight > 32;
  }

  function getCenterX(rect) {
    return rect.left + rect.width * 0.5;
  }

  function isLikelySidebarElement(node) {
    if (!isElement(node)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return getCenterX(rect) <= window.innerWidth * SIDEBAR_CLICK_MAX_X_RATIO;
  }

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON;
  }

  function markSticky(el) {
    stickyState.set(el, isNearBottom(el));
  }

  function shouldStick(el) {
    if (!stickyState.has(el)) {
      stickyState.set(el, true);
      return true;
    }
    return Boolean(stickyState.get(el));
  }

  function scrollToBottom(el) {
    el.scrollTop = el.scrollHeight;
  }

  function findScrollableAncestor(node) {
    let current = node;
    while (isElement(current) && current !== document.body) {
      if (isScrollable(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function findPrimaryScrollable() {
    const all = document.querySelectorAll("*");
    let best = null;
    let bestScore = -1;
    for (const node of all) {
      if (!isElement(node)) continue;
      if (!isScrollable(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height < 120 || rect.width < 200) continue;
      if (rect.width < window.innerWidth * 0.35) continue;
      const overflow = node.scrollHeight - node.clientHeight;
      const centerX = getCenterX(rect);
      const leftPenalty = centerX < window.innerWidth * 0.3 ? 800 : 0;
      const score = overflow + rect.height * 2 + rect.width - leftPenalty;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  function updateActiveScroller() {
    const next = findPrimaryScrollable();
    if (next === activeScroller) return false;
    activeScroller = next;
    if (activeScroller) stickyState.set(activeScroller, true);
    return true;
  }

  function scrollNow(force) {
    if (!updateActiveScroller()) {
      if (!activeScroller) return;
    }
    if (!activeScroller) return;
    if (!force && !shouldStick(activeScroller)) return;
    window.requestAnimationFrame(() => {
      if (!activeScroller) return;
      scrollToBottom(activeScroller);
    });
  }

  function scheduleForcedSwitchScroll(reason) {
    const now = Date.now();
    if (now - lastSwitchTriggerAt < SWITCH_TRIGGER_COOLDOWN_MS) return;
    lastSwitchTriggerAt = now;
    for (const delay of SWITCH_SCROLL_DELAYS) {
      window.setTimeout(() => {
        scrollNow(true);
      }, delay);
    }
  }

  function handleRoutePotentialChange() {
    const current = location.pathname + location.search + location.hash;
    if (current === knownRoute) return;
    knownRoute = current;
    scheduleForcedSwitchScroll("route-change");
  }

  function patchHistoryEvents() {
    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;
    history.pushState = function patchedPushState() {
      const result = rawPushState.apply(this, arguments);
      handleRoutePotentialChange();
      return result;
    };
    history.replaceState = function patchedReplaceState() {
      const result = rawReplaceState.apply(this, arguments);
      handleRoutePotentialChange();
      return result;
    };
  }

  function autoscrollTargets(rawTargets) {
    const unique = new Set();
    for (const target of rawTargets) {
      if (!isElement(target)) continue;
      unique.add(target);
    }
    if (unique.size === 0) {
      const fallback = findPrimaryScrollable();
      if (fallback) unique.add(fallback);
    }
    for (const target of unique) {
      if (!shouldStick(target)) continue;
      window.requestAnimationFrame(() => {
        scrollToBottom(target);
      });
    }
  }

  function handlePotentialSidebarClick(event) {
    const target = event.target;
    if (!isElement(target)) return;
    const clickable = target.closest("button,a,[role='button'],[role='option'],li,div");
    if (!clickable) return;
    if (!isLikelySidebarElement(clickable)) return;
    scheduleForcedSwitchScroll("sidebar-click");
  }

  function mutationMarksSidebarSwitch(mutation) {
    if (mutation.type !== "attributes") return false;
    const target = mutation.target;
    if (!isElement(target)) return false;
    if (!isLikelySidebarElement(target)) return false;
    const attribute = mutation.attributeName || "";
    if (!attribute) return false;
    const value = String(target.getAttribute(attribute) || "").trim().toLowerCase();

    if (attribute === "class") {
      return /\b(active|selected|current)\b/.test(value);
    }
    return SWITCH_ATTR_VALUE_TRUE.has(value);
  }

  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (!isScrollable(target)) return;
      markSticky(target);
    },
    true,
  );

  const observer = new MutationObserver((mutations) => {
    const targets = [];
    let changedNodes = 0;
    let sidebarSwitchHint = false;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        changedNodes += mutation.addedNodes.length + mutation.removedNodes.length;
        if (!mutation.addedNodes || mutation.addedNodes.length === 0) continue;
        for (const added of mutation.addedNodes) {
          const base = isElement(added) ? added : mutation.target;
          const scroller = findScrollableAncestor(base);
          if (scroller) targets.push(scroller);
        }
      }
      if (mutationMarksSidebarSwitch(mutation)) {
        sidebarSwitchHint = true;
      }
    }
    if (sidebarSwitchHint) scheduleForcedSwitchScroll("sidebar-selection-change");
    const scrollerChanged = updateActiveScroller();
    if (scrollerChanged) scheduleForcedSwitchScroll("active-scroller-changed");
    if (changedNodes >= SWITCH_MUTATION_NODE_THRESHOLD) {
      scheduleForcedSwitchScroll("heavy-dom-swap");
    }
    autoscrollTargets(targets);
  });

  function bootstrap() {
    patchHistoryEvents();
    updateActiveScroller();
    scrollNow(true);
    window.addEventListener("popstate", handleRoutePotentialChange, true);
    window.addEventListener("hashchange", handleRoutePotentialChange, true);
    document.addEventListener("click", handlePotentialSidebarClick, true);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "aria-current", "data-state", "data-active", "data-selected", "class"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();`;
}

export function patchWebviewAutoScroll(appDir: string): void {
  const webviewDir = path.join(appDir, "webview");
  const indexPath = path.join(webviewDir, "index.html");
  if (!fileExists(indexPath)) return;

  const assetsDir = ensureDir(path.join(webviewDir, "assets"));
  const scriptPath = path.join(assetsDir, AUTOSCROLL_SCRIPT_FILE);
  fs.writeFileSync(scriptPath, buildWebviewAutoscrollScript(), "utf8");

  const tag = `<script defer src="./assets/${AUTOSCROLL_SCRIPT_FILE}"></script>`;
  let html = fs.readFileSync(indexPath, "utf8");
  if (html.includes(tag)) return;

  if (html.includes("</head>")) {
    html = html.replace("</head>", `    ${tag}\n</head>`);
  } else {
    html = `${html}\n${tag}\n`;
  }
  fs.writeFileSync(indexPath, html, "utf8");
}

function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildWindowsRuntimeShim(buildNumber: string, buildFlavor: string): string {
  const safeBuildNumber = escapeJsString(buildNumber);
  const safeBuildFlavor = escapeJsString(buildFlavor);

  const shim = String.raw`/* CODEX-WINDOWS-ENV-SHIM-V5 */
(function () {
  if (globalThis.__CODEX_WINDOWS_RUNTIME_PATCH_V5__) return;
  globalThis.__CODEX_WINDOWS_RUNTIME_PATCH_V5__ = true;
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const url = require("node:url");
    const cp = require("node:child_process");
    const winRoot = process.env.SystemRoot || "C:\\Windows";
    const resourcesRoot = process.resourcesPath || path.join(__dirname, "..", "..", "..");

    function safeString(value) {
      return typeof value === "string" ? value : "";
    }

    function normalizePathString(value) {
      return safeString(value).trim().replace(/^"+|"+$/g, "");
    }

    function normalizePathEnv(baseEnv) {
      const env = Object.assign({}, process.env, baseEnv || {});
      const parts = [];
      const seen = new Set();

      const include = (candidate, prepend) => {
        const value = normalizePathString(candidate);
        if (!value) return;
        if (!fs.existsSync(value)) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (prepend) parts.unshift(value);
        else parts.push(value);
      };

      const includeList = (value, prepend) => {
        if (!value || typeof value !== "string") return;
        for (const entry of value.split(";")) include(entry, prepend);
      };

      include(path.join(resourcesRoot, "path"), true);
      include(path.join(resourcesRoot, "app", "path"), true);
      include(path.join(resourcesRoot, "app", "resources", "path"), true);

      includeList(env.PATH, false);
      includeList(env.Path, false);
      includeList(process.env.PATH, false);
      includeList(process.env.Path, false);

      const preferred = [
        path.join(winRoot, "System32"),
        path.join(winRoot, "System32", "Wbem"),
        path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
        path.join(winRoot, "System32", "OpenSSH"),
        winRoot,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "PowerShell", "7") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "cmd") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin") : "",
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : ""
      ];
      for (const candidate of preferred) include(candidate, true);

      env.PATH = parts.join(";");
      env.Path = env.PATH;
      if (!env.PATHEXT) env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
      if (!env.COMSPEC) {
        const cmd = path.join(winRoot, "System32", "cmd.exe");
        if (fs.existsSync(cmd)) env.COMSPEC = cmd;
      }
      return env;
    }

    function safeBasename(file) {
      try {
        return path.basename(String(file || "")).toLowerCase();
      } catch {
        return "";
      }
    }

    function resolveUserDataDir() {
      for (const arg of process.argv || []) {
        if (typeof arg !== "string") continue;
        const lower = arg.toLowerCase();
        if (!lower.startsWith("--user-data-dir=")) continue;
        const raw = arg.slice("--user-data-dir=".length).trim();
        const cleaned = raw.replace(/^"+|"+$/g, "");
        if (!cleaned) continue;
        return path.resolve(cleaned);
      }
      return "";
    }

    function isPathLike(value) {
      if (typeof value !== "string") return false;
      const trimmed = value.trim();
      if (!trimmed) return false;
      if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
      if (/^\\\\[^\\]/.test(trimmed)) return true;
      if (/^file:\/\//i.test(trimmed)) return true;
      return false;
    }

    function isPathKey(key) {
      return /(workspace|worktree|cwd|repo|root|folder|directory|project|recent|path)s?/i.test(String(key || ""));
    }

    function normalizePathCandidate(raw) {
      if (typeof raw !== "string") return "";
      let value = raw.trim().replace(/^"+|"+$/g, "");
      if (/^file:\/\//i.test(value)) {
        try {
          const asUrl = new URL(value);
          value = decodeURIComponent(asUrl.pathname || value);
          if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
        } catch {
          return "";
        }
      }
      value = value.replace(/%([^%]+)%/g, (all, envName) => {
        const envValue = process.env[envName];
        return envValue ? envValue : all;
      });
      if (value.includes("%")) return "";
      return path.normalize(value);
    }

    function sanitizeNode(value, keyHint, stats) {
      if (typeof value === "string") {
        if (!isPathKey(keyHint) || !isPathLike(value)) return value;
        const normalized = normalizePathCandidate(value);
        if (!normalized || !fs.existsSync(normalized)) {
          stats.removedEntries += 1;
          return undefined;
        }
        return normalized;
      }

      if (Array.isArray(value)) {
        const pathLikeCount = value.filter((item) => typeof item === "string" && isPathLike(item)).length;
        const treatAsPathArray = isPathKey(keyHint) || pathLikeCount >= Math.max(1, Math.floor(value.length / 2));
        const out = [];
        const seen = new Set();
        for (const item of value) {
          if (treatAsPathArray && typeof item === "string" && isPathLike(item)) {
            const normalized = normalizePathCandidate(item);
            if (!normalized || !fs.existsSync(normalized)) {
              stats.removedEntries += 1;
              continue;
            }
            const dedupeKey = normalized.toLowerCase();
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            out.push(normalized);
            continue;
          }
          const next = sanitizeNode(item, keyHint, stats);
          if (typeof next === "undefined") continue;
          out.push(next);
        }
        return out;
      }

      if (value && typeof value === "object") {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
          const next = sanitizeNode(child, key, stats);
          if (typeof next === "undefined") continue;
          out[key] = next;
        }
        return out;
      }

      return value;
    }

    function sanitizeWorkspaceRegistry(userDataDir) {
      const report = {
        scannedFiles: 0,
        updatedFiles: 0,
        removedEntries: 0,
        reportPath: ""
      };
      if (!userDataDir || !fs.existsSync(userDataDir)) return report;

      const reportPath = path.join(userDataDir, "workspace-sanitizer-report.json");
      report.reportPath = reportPath;

      const skipDirs = new Set([
        "cache",
        "code cache",
        "gpucache",
        "dawngraphitecache",
        "indexeddb",
        "blob_storage",
        "session storage",
        "local storage",
        "shared dictionary",
        "crashpad",
        "sentry"
      ]);

      const candidates = [];
      const seen = new Set();
      const queue = [{ dir: userDataDir, depth: 0 }];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;

        let entries = [];
        try {
          entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          const fullPath = path.join(current.dir, entry.name);
          const lowerName = entry.name.toLowerCase();

          if (entry.isDirectory()) {
            if (current.depth >= 3) continue;
            if (skipDirs.has(lowerName)) continue;
            queue.push({ dir: fullPath, depth: current.depth + 1 });
            continue;
          }

          if (!entry.isFile()) continue;
          const isExplicit = lowerName === "preferences" || lowerName === "local state";
          const isCandidate = /(workspace|worktree|recent|registry|preference|local state|config|project|repo).*\.(json|jsn)$/i.test(lowerName);
          if (!isExplicit && !isCandidate) continue;
          const key = path.resolve(fullPath).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push(fullPath);
        }
      }

      for (const filePath of candidates) {
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (!stat || stat.size > 4 * 1024 * 1024) continue;

        report.scannedFiles += 1;
        let raw = "";
        try {
          raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
        } catch {
          continue;
        }
        if (!raw.trim()) continue;

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }

        const stats = { removedEntries: 0 };
        const next = sanitizeNode(parsed, "root", stats);
        report.removedEntries += stats.removedEntries;
        const nextRaw = JSON.stringify(next, null, 2) + "\n";
        if (nextRaw !== raw) {
          report.updatedFiles += 1;
          try {
            fs.writeFileSync(filePath, nextRaw, "utf8");
          } catch {
            // ignore
          }
        }
      }

      try {
        fs.writeFileSync(reportPath, JSON.stringify(Object.assign({ atUtc: new Date().toISOString() }, report), null, 2) + "\n", "utf8");
      } catch {
        // ignore
      }
      return report;
    }

    function createGitCapabilityCache(userDataDir) {
      const cachePath = process.env.CODEX_GIT_CAPABILITY_CACHE
        ? path.resolve(process.env.CODEX_GIT_CAPABILITY_CACHE)
        : path.join(userDataDir || resourcesRoot, "git-capability-cache.json");

      function nowMs() {
        return Date.now();
      }

      function newEntry(ttlHours) {
        const now = nowMs();
        return {
          firstSeenUtc: new Date(now).toISOString(),
          lastSeenUtc: new Date(now).toISOString(),
          expiresUtc: new Date(now + ttlHours * 60 * 60 * 1000).toISOString(),
          failCount: 1
        };
      }

      function load() {
        const empty = { schemaVersion: 1, updatedAtUtc: new Date().toISOString(), missingRefs: {}, invalidCwds: {} };
        try {
          if (!fs.existsSync(cachePath)) return empty;
          const raw = fs.readFileSync(cachePath, "utf8").replace(/^\uFEFF/, "");
          const parsed = JSON.parse(raw || "{}");
          if (!parsed || typeof parsed !== "object") return empty;
          return {
            schemaVersion: 1,
            updatedAtUtc: String(parsed.updatedAtUtc || empty.updatedAtUtc),
            missingRefs: parsed.missingRefs && typeof parsed.missingRefs === "object" ? parsed.missingRefs : {},
            invalidCwds: parsed.invalidCwds && typeof parsed.invalidCwds === "object" ? parsed.invalidCwds : {}
          };
        } catch {
          return empty;
        }
      }

      function prune(data) {
        const now = nowMs();
        const pruneMap = (map, limit) => {
          const entries = Object.entries(map || {}).filter((entry) => {
            const value = entry[1] || {};
            const expires = new Date(String(value.expiresUtc || "")).getTime();
            return Number.isFinite(expires) && expires > now;
          });
          entries.sort((a, b) => {
            const aTime = new Date(String((a[1] || {}).lastSeenUtc || "")).getTime();
            const bTime = new Date(String((b[1] || {}).lastSeenUtc || "")).getTime();
            return bTime - aTime;
          });
          return Object.fromEntries(entries.slice(0, limit));
        };
        data.missingRefs = pruneMap(data.missingRefs, 2000);
        data.invalidCwds = pruneMap(data.invalidCwds, 1000);
      }

      let data = load();
      prune(data);
      let dirty = false;

      function flush() {
        if (!dirty) return;
        try {
          data.updatedAtUtc = new Date().toISOString();
          const dir = path.dirname(cachePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify(data, null, 2) + "\n", "utf8");
          dirty = false;
        } catch {
          // ignore
        }
      }

      function getMissingKey(cwd, ref) {
        return (path.resolve(String(cwd || "")).toLowerCase() + "|" + String(ref || "").trim().toLowerCase());
      }

      function getCwdKey(cwd) {
        return path.resolve(String(cwd || "")).toLowerCase();
      }

      function isMissingRef(cwd, ref) {
        const key = getMissingKey(cwd, ref);
        return Boolean(data.missingRefs[key]);
      }

      function isInvalidCwd(cwd) {
        const key = getCwdKey(cwd);
        return Boolean(data.invalidCwds[key]);
      }

      function rememberMissingRef(cwd, ref) {
        const key = getMissingKey(cwd, ref);
        if (!key) return;
        const existing = data.missingRefs[key];
        const next = newEntry(6);
        if (existing) {
          next.firstSeenUtc = String(existing.firstSeenUtc || next.firstSeenUtc);
          next.failCount = Number(existing.failCount || 0) + 1;
        }
        data.missingRefs[key] = next;
        dirty = true;
      }

      function rememberInvalidCwd(cwd) {
        const key = getCwdKey(cwd);
        if (!key) return;
        const existing = data.invalidCwds[key];
        const next = newEntry(12);
        if (existing) {
          next.firstSeenUtc = String(existing.firstSeenUtc || next.firstSeenUtc);
          next.failCount = Number(existing.failCount || 0) + 1;
        }
        data.invalidCwds[key] = next;
        dirty = true;
      }

      return {
        path: cachePath,
        flush,
        isMissingRef,
        isInvalidCwd,
        rememberMissingRef,
        rememberInvalidCwd
      };
    }

    function installConsoleGuards(gitCache) {
      if (globalThis.__CODEX_WINDOWS_CONSOLE_GUARD__) return;
      globalThis.__CODEX_WINDOWS_CONSOLE_GUARD__ = true;

      const oncePatterns = [
        /^\[IpcRouter\] I am the router$/,
        /^\[git-repo-watcher\] Starting git repo watcher$/,
        /^\[electron-message-handler\] \[desktop-notifications\] service starting$/,
        /^\[build-flavor\] Resolved build flavor from env value=/
      ];
      const seen = new Map();
      const pathPattern = /path does not exist:\s*([^"\n\r]+)/i;

      function patchMethod(methodName) {
        const original = console[methodName];
        if (typeof original !== "function") return;
        console[methodName] = function guardedConsoleMethod() {
          const message = Array.from(arguments).map((item) => String(item)).join(" ");
          const match = message.match(pathPattern);
          if (match && match[1]) {
            try {
              const missingPath = normalizePathCandidate(match[1]);
              if (missingPath) gitCache.rememberInvalidCwd(missingPath);
            } catch {
              // ignore
            }
          }

          for (const pattern of oncePatterns) {
            if (!pattern.test(message)) continue;
            const key = pattern.toString() + "|" + methodName;
            const count = Number(seen.get(key) || 0) + 1;
            seen.set(key, count);
            if (count > 1) return;
            break;
          }

          return original.apply(this, arguments);
        };
      }

      patchMethod("log");
      patchMethod("info");
      patchMethod("warn");
      patchMethod("error");
    }

    function createIpcSupervisor(gitCache) {
      const tracked = new Set();
      let shutdownStarted = false;

      function shouldTrack(file) {
        const base = safeBasename(file);
        return base === "codex.exe" || base === "codex";
      }

      function track(child, file) {
        if (!child || typeof child.on !== "function") return;
        if (!shouldTrack(file)) return;
        tracked.add(child);
        const cleanup = () => tracked.delete(child);
        child.once("exit", cleanup);
        child.once("close", cleanup);
      }

      function shutdown(reason) {
        if (shutdownStarted) return;
        shutdownStarted = true;

        for (const child of Array.from(tracked)) {
          try {
            if (child.stdin && typeof child.stdin.end === "function") child.stdin.end();
          } catch {
            // ignore
          }
          try {
            if (child.stdout && typeof child.stdout.destroy === "function") child.stdout.destroy();
          } catch {
            // ignore
          }
          try {
            if (child.stderr && typeof child.stderr.destroy === "function") child.stderr.destroy();
          } catch {
            // ignore
          }
          try {
            if (child.exitCode == null) child.kill("SIGTERM");
          } catch {
            // ignore
          }
          try {
            const timer = setTimeout(() => {
              try {
                if (child.exitCode == null) child.kill("SIGKILL");
              } catch {
                // ignore
              }
            }, 1200);
            if (timer && typeof timer.unref === "function") timer.unref();
          } catch {
            // ignore
          }
        }

        gitCache.flush();
      }

      return { track, shutdown };
    }

    function resolveGitRevParseInvocation(file, args, options) {
      const base = safeBasename(file);
      if (base !== "git.exe" && base !== "git") return undefined;
      if (!Array.isArray(args)) return undefined;
      const lowered = args.map((item) => String(item).toLowerCase());
      if (!lowered.includes("rev-parse")) return undefined;
      if (!lowered.includes("--verify")) return undefined;
      if (!lowered.includes("--quiet")) return undefined;
      const ref = String(args[args.length - 1] || "");
      if (!ref || ref.startsWith("-")) return undefined;
      const cwd = options && typeof options.cwd === "string" && options.cwd
        ? path.resolve(options.cwd)
        : process.cwd();
      return { cwd, ref };
    }

    const normalizedProcessEnv = normalizePathEnv(process.env);
    for (const [key, value] of Object.entries(normalizedProcessEnv)) {
      if (typeof value === "string") process.env[key] = value;
    }

    const userDataDir = resolveUserDataDir();
    const workspaceSanitizerReport = sanitizeWorkspaceRegistry(userDataDir);
    if (workspaceSanitizerReport && workspaceSanitizerReport.reportPath) {
      process.env.CODEX_WORKSPACE_SANITIZER_REPORT = workspaceSanitizerReport.reportPath;
      if (workspaceSanitizerReport.updatedFiles > 0 || workspaceSanitizerReport.removedEntries > 0) {
        console.info("[workspace-sanitizer] scannedFiles=" + workspaceSanitizerReport.scannedFiles + " updatedFiles=" + workspaceSanitizerReport.updatedFiles + " removedEntries=" + workspaceSanitizerReport.removedEntries);
      }
    }

    const gitCache = createGitCapabilityCache(userDataDir);
    process.env.CODEX_GIT_CAPABILITY_CACHE = gitCache.path;
    installConsoleGuards(gitCache);
    const ipcSupervisor = createIpcSupervisor(gitCache);

    if (!globalThis.__CODEX_WINDOWS_CHILD_ENV_PATCHED__) {
      globalThis.__CODEX_WINDOWS_CHILD_ENV_PATCHED__ = true;

      const patchOptionsEnv = (options) => {
        if (!options || typeof options !== "object") options = {};
        options.env = normalizePathEnv(options.env || process.env);
        return options;
      };

      const spawnFastFail = (options, sync, originalSpawn, originalSpawnSync) => {
        const cmd = process.env.COMSPEC || path.join(winRoot, "System32", "cmd.exe");
        const args = ["/d", "/c", "exit", "1"];
        if (sync) return originalSpawnSync.call(cp, cmd, args, options);
        return originalSpawn.call(cp, cmd, args, options);
      };

      const origSpawn = cp.spawn;
      cp.spawn = function patchedSpawn(file, args, options) {
        if (!Array.isArray(args)) {
          options = args;
          args = [];
        }
        options = patchOptionsEnv(options);
        const gitInvocation = resolveGitRevParseInvocation(file, args, options);
        if (gitInvocation) {
          if (!fs.existsSync(gitInvocation.cwd)) {
            gitCache.rememberInvalidCwd(gitInvocation.cwd);
            return spawnFastFail(options, false, origSpawn, cp.spawnSync);
          }
          if (gitCache.isInvalidCwd(gitInvocation.cwd) || gitCache.isMissingRef(gitInvocation.cwd, gitInvocation.ref)) {
            return spawnFastFail(options, false, origSpawn, cp.spawnSync);
          }
        }

        const child = origSpawn.call(this, file, args, options);
        ipcSupervisor.track(child, file);
        if (gitInvocation && child && typeof child.on === "function") {
          child.once("close", (code) => {
            if (code === 1) gitCache.rememberMissingRef(gitInvocation.cwd, gitInvocation.ref);
          });
          child.once("error", () => {
            gitCache.rememberInvalidCwd(gitInvocation.cwd);
          });
        }
        return child;
      };

      const origSpawnSync = cp.spawnSync;
      cp.spawnSync = function patchedSpawnSync(file, args, options) {
        if (!Array.isArray(args)) {
          options = args;
          args = [];
        }
        options = patchOptionsEnv(options);
        const gitInvocation = resolveGitRevParseInvocation(file, args, options);
        if (gitInvocation) {
          if (!fs.existsSync(gitInvocation.cwd)) {
            gitCache.rememberInvalidCwd(gitInvocation.cwd);
            return spawnFastFail(options, true, cp.spawn, origSpawnSync);
          }
          if (gitCache.isInvalidCwd(gitInvocation.cwd) || gitCache.isMissingRef(gitInvocation.cwd, gitInvocation.ref)) {
            return spawnFastFail(options, true, cp.spawn, origSpawnSync);
          }
        }

        const result = origSpawnSync.call(this, file, args, options);
        if (gitInvocation && result && Number(result.status) === 1) {
          gitCache.rememberMissingRef(gitInvocation.cwd, gitInvocation.ref);
        }
        return result;
      };
    }

    process.on("beforeExit", () => ipcSupervisor.shutdown("beforeExit"));
    process.on("exit", () => ipcSupervisor.shutdown("exit"));
    process.on("SIGINT", () => ipcSupervisor.shutdown("SIGINT"));
    process.on("SIGTERM", () => ipcSupervisor.shutdown("SIGTERM"));

    try {
      const electron = require("electron");
      if (electron && electron.app && typeof electron.app.once === "function") {
        electron.app.once("before-quit", () => ipcSupervisor.shutdown("before-quit"));
      }
    } catch {
      // ignore
    }

    if (!process.env.ELECTRON_RENDERER_URL) {
      const unpacked = path.join(__dirname, "..", "..", "webview", "index.html");
      const packaged = path.join(resourcesRoot, "app", "webview", "index.html");
      const chosen = fs.existsSync(unpacked) ? unpacked : (fs.existsSync(packaged) ? packaged : "");
      if (chosen) process.env.ELECTRON_RENDERER_URL = url.pathToFileURL(chosen).toString();
    }

    if (!process.env.CODEX_CLI_PATH) {
      const bundledCli = path.join(resourcesRoot, "codex.exe");
      const bundledAppCli = path.join(resourcesRoot, "app", "codex.exe");
      if (fs.existsSync(bundledCli)) process.env.CODEX_CLI_PATH = bundledCli;
      else if (fs.existsSync(bundledAppCli)) process.env.CODEX_CLI_PATH = bundledAppCli;
    }

    if (!process.env.ELECTRON_FORCE_IS_PACKAGED) process.env.ELECTRON_FORCE_IS_PACKAGED = "1";
    if (!process.env.CODEX_BUILD_NUMBER) process.env.CODEX_BUILD_NUMBER = "__BUILD_NUMBER__";
    if (!process.env.CODEX_BUILD_FLAVOR) process.env.CODEX_BUILD_FLAVOR = "__BUILD_FLAVOR__";
    if (!process.env.BUILD_FLAVOR) process.env.BUILD_FLAVOR = "__BUILD_FLAVOR__";
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
    if (!process.env.PWD) process.env.PWD = process.cwd();
  } catch {
    // no-op
  }
})();
`;

  return shim
    .replace(/__BUILD_NUMBER__/g, safeBuildNumber)
    .replace(/__BUILD_FLAVOR__/g, safeBuildFlavor);
}

export function patchMainForWindowsEnvironment(appDir: string, buildNumber: string, buildFlavor: string): void {
  const mainJs = path.join(appDir, ".vite", "build", "main.js");
  if (!fileExists(mainJs)) return;
  let raw = fs.readFileSync(mainJs, "utf8");

  const runtimeStart =
    raw.match(/(["'])use strict\1;require\(["']electron["']\);[\s\S]*/) ??
    raw.match(/require\(["']electron["']\);[\s\S]*/);
  if (runtimeStart) raw = runtimeStart[0];

  raw = raw.replace(/\/\* CODEX-WINDOWS-ENV-SHIM-V\d+ \*\/[\s\S]*?\}\)\(\);\s*/g, "");
  raw = raw.replace(
    /\n\s*const parts = \[\];[\s\S]*?if \(!process\.env\.NODE_ENV\) process\.env\.NODE_ENV = "production";\s*\}\s*catch \{\s*\/\/ no-op\s*\}\s*\}\)\(\);\s*/g,
    "\n",
  );

  const shim = buildWindowsRuntimeShim(buildNumber, buildFlavor);
  fs.writeFileSync(mainJs, `${shim}\n${raw}`, "utf8");
}

export function ensureGitOnPath(): void {
  const candidates: string[] = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"));
    candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "git.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe"));
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "git.exe"));
  }
  const gitExe = candidates.find((candidate) => fileExists(candidate));
  if (!gitExe) return;
  const gitDir = path.dirname(gitExe);
  const current = (process.env.PATH || "").split(";").map((entry) => entry.trim().toLowerCase());
  if (!current.includes(gitDir.toLowerCase())) {
    process.env.PATH = `${gitDir};${process.env.PATH || ""}`;
    process.env.Path = process.env.PATH;
  }
}

export function startCodexDirectLaunch(
  electronExe: string,
  appDir: string,
  userDataDir: string,
  cacheDir: string,
  codexCliPath: string,
  buildNumber: string,
  buildFlavor: string,
  gitCapabilityCachePath?: string,
): void {
  if (!fileExists(electronExe)) throw new Error(`electron.exe not found: ${electronExe}`);
  const rendererPath = path.join(appDir, "webview", "index.html");
  const rendererUrl = `file:///${rendererPath.replace(/\\/g, "/")}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_RENDERER_URL = rendererUrl;
  env.ELECTRON_FORCE_IS_PACKAGED = "1";
  env.CODEX_BUILD_NUMBER = buildNumber;
  env.CODEX_BUILD_FLAVOR = buildFlavor;
  env.BUILD_FLAVOR = buildFlavor;
  env.NODE_ENV = "production";
  env.CODEX_CLI_PATH = codexCliPath;
  env.PWD = appDir;
  if (gitCapabilityCachePath) env.CODEX_GIT_CAPABILITY_CACHE = gitCapabilityCachePath;

  ensureDir(userDataDir);
  ensureDir(cacheDir);

  const result = runCommand(
    electronExe,
    [appDir, "--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`],
    { cwd: appDir, env, capture: false, allowNonZero: true },
  );
  if (result.status !== 0) {
    throw new Error(`Codex process exited with code ${result.status}.`);
  }
}
