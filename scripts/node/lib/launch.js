"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.patchPreload = patchPreload;
exports.patchWebviewCwdNormalization = patchWebviewCwdNormalization;
exports.patchWebviewAppSunsetGate = patchWebviewAppSunsetGate;
exports.patchWebviewSettingsLimitsPanel = patchWebviewSettingsLimitsPanel;
exports.patchWebviewThreadsPerProjectCap = patchWebviewThreadsPerProjectCap;
exports.patchMainForWindowsEnvironment = patchMainForWindowsEnvironment;
exports.ensureGitOnPath = ensureGitOnPath;
exports.startCodexDirectLaunch = startCodexDirectLaunch;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const WEBVIEW_CWD_NORMALIZER_PATCH_TAG = "/* CODEX-WINDOWS-CWD-NORMALIZER-V1 */";
const WEBVIEW_APP_SUNSET_PATCH_TAG = "/* CODEX-WINDOWS-APP-SUNSET-BYPASS-V1 */";
const WEBVIEW_SETTINGS_LIMIT_PANEL_PATCH_TAG = "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V12 */";
const WEBVIEW_THREADS_PER_PROJECT_CAP_PATCH_TAG = "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V2 */";
const WEBVIEW_SETTINGS_LIMIT_PANEL_LEGACY_TAGS = [
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V11 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V10 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V9 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V8 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V7 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V6 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V5 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V4 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V3 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V2 */",
    "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V1 */",
];
const WEBVIEW_THREADS_PER_PROJECT_CAP_LEGACY_TAGS = [
    "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V1 */",
];
const WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH = path.resolve(__dirname, "..", "..", "..", "shared", "patch-pack", "injections", "webview-settings-limits-panel.v3.js");
const WEBVIEW_THREADS_PER_PROJECT_CAP_SCRIPT_PATH = path.resolve(__dirname, "..", "..", "..", "shared", "patch-pack", "injections", "webview-threads-per-project-cap.v1.js");
let webviewSettingsLimitPanelScriptCache = "";
let webviewThreadsPerProjectCapScriptCache = "";
function resolveWebviewSettingsLimitPanelScript() {
    if (webviewSettingsLimitPanelScriptCache.length > 0) {
        return webviewSettingsLimitPanelScriptCache;
    }
    if (!(0, exec_1.fileExists)(WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH)) {
        throw new Error(`settings limits panel script not found: ${WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH}`);
    }
    const script = fs.readFileSync(WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH, "utf8").trim();
    if (script.length < 16) {
        throw new Error(`settings limits panel script is empty: ${WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH}`);
    }
    webviewSettingsLimitPanelScriptCache = script;
    return webviewSettingsLimitPanelScriptCache;
}
function resolveWebviewThreadsPerProjectCapScript() {
    if (webviewThreadsPerProjectCapScriptCache.length > 0) {
        return webviewThreadsPerProjectCapScriptCache;
    }
    if (!(0, exec_1.fileExists)(WEBVIEW_THREADS_PER_PROJECT_CAP_SCRIPT_PATH)) {
        throw new Error(`threads per project cap script not found: ${WEBVIEW_THREADS_PER_PROJECT_CAP_SCRIPT_PATH}`);
    }
    const script = fs.readFileSync(WEBVIEW_THREADS_PER_PROJECT_CAP_SCRIPT_PATH, "utf8").trim();
    if (script.length < 16) {
        throw new Error(`threads per project cap script is empty: ${WEBVIEW_THREADS_PER_PROJECT_CAP_SCRIPT_PATH}`);
    }
    webviewThreadsPerProjectCapScriptCache = script;
    return webviewThreadsPerProjectCapScriptCache;
}
function patchWebviewIndexBundles(appDir, bundleNotFoundError, patchNotFoundError, patchContent, optionalPatch = false) {
    const assetsDir = path.join(appDir, "webview", "assets");
    if (!(0, exec_1.fileExists)(assetsDir)) {
        return { patchedFiles: 0, alreadyPatchedFiles: 0 };
    }
    const bundles = fs
        .readdirSync(assetsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^index-.*\.js$/i.test(entry.name))
        .map((entry) => path.join(assetsDir, entry.name));
    if (bundles.length === 0)
        throw new Error(bundleNotFoundError);
    let patchedFileCount = 0;
    let alreadyPatchedFileCount = 0;
    for (const bundlePath of bundles) {
        const raw = fs.readFileSync(bundlePath, "utf8");
        const result = patchContent(raw);
        if (result.alreadyPatched) {
            alreadyPatchedFileCount += 1;
            continue;
        }
        if (!result.patched)
            continue;
        fs.writeFileSync(bundlePath, result.content, "utf8");
        patchedFileCount += 1;
    }
    if (patchedFileCount === 0 && alreadyPatchedFileCount === 0) {
        if (!optionalPatch) {
            throw new Error(patchNotFoundError);
        }
    }
    return { patchedFiles: patchedFileCount, alreadyPatchedFiles: alreadyPatchedFileCount };
}
function patchPreload(appDir) {
    const preload = path.join(appDir, ".vite", "build", "preload.js");
    if (!(0, exec_1.fileExists)(preload))
        return false;
    let raw = fs.readFileSync(preload, "utf8");
    const processExpose = 'const P={env:process.env,platform:process.platform,versions:process.versions,arch:process.arch,cwd:()=>process.env.PWD,argv:process.argv,pid:process.pid};n.contextBridge.exposeInMainWorld("process",P);';
    if (!raw.includes(processExpose)) {
        const pattern = /n\.contextBridge\.exposeInMainWorld\("codexWindowType",[A-Za-z0-9_$]+\);n\.contextBridge\.exposeInMainWorld\("electronBridge",[A-Za-z0-9_$]+\);/;
        const match = raw.match(pattern);
        if (!match)
            throw new Error("preload patch point not found.");
        raw = raw.replace(match[0], `${processExpose}${match[0]}`);
        fs.writeFileSync(preload, raw, "utf8");
        return true;
    }
    return false;
}
function patchWebviewCwdNormalization(appDir, options = {}) {
    const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
    const helperPairPattern = /function\s+([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{return\s+([A-Za-z0-9_$]+)\(\2\)\.toLowerCase\(\)\}function\s+\3\(([A-Za-z0-9_$]+)\)\{return\s+\4\.replace\([^)]*\)\}/g;
    const summary = patchWebviewIndexBundles(appDir, "webview index bundle not found for cwd normalization patch.", "webview cwd normalization patch point not found.", (raw) => {
        if (raw.includes(WEBVIEW_CWD_NORMALIZER_PATCH_TAG)) {
            return { alreadyPatched: true, patched: false, content: raw };
        }
        let changed = false;
        const next = raw.replace(helperPairPattern, (_full, lowerFn, lowerArg, normalizeFn, normalizeArg) => {
            changed = true;
            return `${WEBVIEW_CWD_NORMALIZER_PATCH_TAG}function ${lowerFn}(${lowerArg}){return ${normalizeFn}(${lowerArg}).toLowerCase()}function ${normalizeFn}(${normalizeArg}){const __codexWindowsPathRaw=${normalizeArg}.replace(/\\\\/g,"/");const __codexWindowsPath=__codexWindowsPathRaw.startsWith("//?/")?__codexWindowsPathRaw.slice(4):(__codexWindowsPathRaw.startsWith("/??/")?__codexWindowsPathRaw.slice(4):__codexWindowsPathRaw);const __codexWindowsDrivePath=__codexWindowsPath.startsWith("/")?__codexWindowsPath.slice(1):__codexWindowsPath;return /^[A-Za-z]:\\//.test(__codexWindowsDrivePath)?__codexWindowsDrivePath:__codexWindowsPath}`;
        });
        return { alreadyPatched: false, patched: changed, content: next };
    }, allowMissingPatchPoint);
    const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
    if (!matched && allowMissingPatchPoint) {
        (0, exec_1.writeWarn)("webview cwd normalization patch skipped: patch point not found for current bundle signature.");
    }
    return summary;
}
function patchWebviewAppSunsetGate(appDir, options = {}) {
    const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
    const legacyPatchNeedles = ["const s=Xs(i);if(r){", "const s=Cs(i);if(r){", "const s=ys(i);if(r){"];
    const markerNeedles = ['id:"appSunset.title"', 'defaultMessage:"Update required"'];
    const gatePattern = /const\s+([A-Za-z0-9_$]+)\s*=\s*([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\);\s*if\(([A-Za-z0-9_$]+)\)\{/g;
    const summary = patchWebviewIndexBundles(appDir, "webview index bundle not found for app sunset patch.", "webview app sunset patch point not found.", (raw) => {
        if (raw.includes(WEBVIEW_APP_SUNSET_PATCH_TAG)) {
            return { alreadyPatched: true, patched: false, content: raw };
        }
        for (const needle of legacyPatchNeedles) {
            if (!raw.includes(needle))
                continue;
            return {
                alreadyPatched: false,
                patched: true,
                content: raw.replace(needle, `${WEBVIEW_APP_SUNSET_PATCH_TAG}const s=!1;if(r){`),
            };
        }
        const markerIndex = markerNeedles
            .map((needle) => raw.indexOf(needle))
            .find((index) => index >= 0);
        if (markerIndex === undefined) {
            return { alreadyPatched: false, patched: false, content: raw };
        }
        const sunsetComponentStart = raw.lastIndexOf("function ", markerIndex);
        if (sunsetComponentStart < 0) {
            return { alreadyPatched: false, patched: false, content: raw };
        }
        const sunsetComponentMatch = /^function\s+([A-Za-z0-9_$]+)\(/.exec(raw.slice(sunsetComponentStart, sunsetComponentStart + 96));
        if (!sunsetComponentMatch) {
            return { alreadyPatched: false, patched: false, content: raw };
        }
        const sunsetComponentName = sunsetComponentMatch[1];
        const usageNeedles = [
            `h.jsx(${sunsetComponentName},`,
            `h.jsxs(${sunsetComponentName},`,
            `f.jsx(${sunsetComponentName},`,
            `f.jsxs(${sunsetComponentName},`,
        ];
        const usageIndex = usageNeedles
            .map((needle) => raw.indexOf(needle, markerIndex))
            .find((index) => index >= 0);
        if (usageIndex === undefined) {
            return { alreadyPatched: false, patched: false, content: raw };
        }
        const searchStart = Math.max(0, usageIndex - 1600);
        const searchEnd = Math.min(raw.length, usageIndex + 512);
        const searchWindow = raw.slice(searchStart, searchEnd);
        let selectedPatch;
        let match;
        while ((match = gatePattern.exec(searchWindow)) !== null) {
            const full = match[0];
            const gateVar = match[1];
            const guardVar = match[4];
            const branchWindow = searchWindow.slice(match.index, Math.min(searchWindow.length, match.index + 640));
            if (!branchWindow.includes(`else if(${gateVar}){`))
                continue;
            const componentRenderedInBranch = usageNeedles.some((needle) => branchWindow.includes(needle));
            if (!componentRenderedInBranch)
                continue;
            selectedPatch = {
                start: searchStart + match.index,
                end: searchStart + match.index + full.length,
                gateVar,
                guardVar,
            };
        }
        if (!selectedPatch) {
            return { alreadyPatched: false, patched: false, content: raw };
        }
        const replacement = `${WEBVIEW_APP_SUNSET_PATCH_TAG}const ${selectedPatch.gateVar}=!1;if(${selectedPatch.guardVar}){`;
        return {
            alreadyPatched: false,
            patched: true,
            content: raw.slice(0, selectedPatch.start) + replacement + raw.slice(selectedPatch.end),
        };
    }, allowMissingPatchPoint);
    const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
    if (!matched && allowMissingPatchPoint) {
        (0, exec_1.writeWarn)("webview app sunset patch skipped: patch point not found for current bundle signature.");
    }
    return summary;
}
function patchWebviewSettingsLimitsPanel(appDir, options = {}) {
    const disableLimitsPanelValue = process.env.CODEX_WINDOWS_DISABLE_LIMITS_PANEL;
    const disableLimitsPanel = String(disableLimitsPanelValue || "").trim() === "1";
    if (disableLimitsPanel) {
        (0, exec_1.writeWarn)("webview settings limits panel patch disabled by CODEX_WINDOWS_DISABLE_LIMITS_PANEL=1");
        return { patchedFiles: 0, alreadyPatchedFiles: 0 };
    }
    const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
    const settingsPanelScript = resolveWebviewSettingsLimitPanelScript();
    const summary = patchWebviewIndexBundles(appDir, "webview index bundle not found for settings limits panel patch.", "webview settings limits panel patch point not found.", (raw) => {
        if (raw.includes(WEBVIEW_SETTINGS_LIMIT_PANEL_PATCH_TAG)) {
            return { alreadyPatched: true, patched: false, content: raw };
        }
        let next = raw;
        const legacyIndexes = WEBVIEW_SETTINGS_LIMIT_PANEL_LEGACY_TAGS
            .map((tag) => next.indexOf(tag))
            .filter((index) => index >= 0)
            .sort((left, right) => left - right);
        if (legacyIndexes.length > 0) {
            next = next.slice(0, legacyIndexes[0]).trimEnd();
        }
        const content = `${next};\n${WEBVIEW_SETTINGS_LIMIT_PANEL_PATCH_TAG}\n${settingsPanelScript}\n`;
        return { alreadyPatched: false, patched: true, content };
    }, allowMissingPatchPoint);
    const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
    if (!matched && allowMissingPatchPoint) {
        (0, exec_1.writeWarn)("webview settings limits panel patch skipped: patch point not found for current bundle signature.");
    }
    return summary;
}
function patchWebviewThreadsPerProjectCap(appDir, options = {}) {
    const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
    const script = resolveWebviewThreadsPerProjectCapScript();
    const summary = patchWebviewIndexBundles(appDir, "webview index bundle not found for threads per project cap patch.", "webview threads per project cap patch point not found.", (raw) => {
        if (raw.includes(WEBVIEW_THREADS_PER_PROJECT_CAP_PATCH_TAG)) {
            return { alreadyPatched: true, patched: false, content: raw };
        }
        let next = raw;
        const legacyIndexes = WEBVIEW_THREADS_PER_PROJECT_CAP_LEGACY_TAGS
            .map((tag) => next.indexOf(tag))
            .filter((index) => index >= 0)
            .sort((left, right) => left - right);
        if (legacyIndexes.length > 0) {
            next = next.slice(0, legacyIndexes[0]).trimEnd();
        }
        const content = `${next};\n${WEBVIEW_THREADS_PER_PROJECT_CAP_PATCH_TAG}\n${script}\n`;
        return { alreadyPatched: false, patched: true, content };
    }, allowMissingPatchPoint);
    const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
    if (!matched && allowMissingPatchPoint) {
        (0, exec_1.writeWarn)("webview threads per project cap patch skipped: patch point not found for current bundle signature.");
    }
    return summary;
}
function escapeJsString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function buildWindowsRuntimeShim(buildNumber, buildFlavor) {
    const safeBuildNumber = escapeJsString(buildNumber);
    const safeBuildFlavor = escapeJsString(buildFlavor);
    const shim = String.raw `/* CODEX-WINDOWS-ENV-SHIM-V7 */
(function () {
  if (globalThis.__CODEX_WINDOWS_RUNTIME_PATCH_V7__) return;
  globalThis.__CODEX_WINDOWS_RUNTIME_PATCH_V7__ = true;
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

    function normalizeWindowsOpenPath(input) {
      let value = normalizePathString(input);
      if (!value) return value;
      if (/^file:\/\//i.test(value)) {
        try {
          value = url.fileURLToPath(value);
        } catch {
          // keep original
        }
      }
      value = value.replace(/^([ab])[\\/](?=[^\\/])/, "");
      const isUncPath = /^[/\\]{2}[^/\\]/.test(value) && !/^[/\\]{2}[?.][\\/]/.test(value);
      if (!isUncPath) {
        value = value.replace(/^[/\\]+(?=[A-Za-z]:[\\/])/, "");
      }
      return value;
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

    function resolveCodexHomeDir() {
      const configured = normalizePathString(process.env.CODEX_HOME || "");
      if (configured) return path.resolve(configured);
      const profileDir = normalizePathString(process.env.USERPROFILE || process.env.HOME || "");
      if (!profileDir) return "";
      return path.join(profileDir, ".codex");
    }

    function listStateDatabasePaths(codexHomeDir) {
      if (!codexHomeDir || !fs.existsSync(codexHomeDir)) return [];
      let entries = [];
      try {
        entries = fs.readdirSync(codexHomeDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const entry of entries) {
        if (!entry || !entry.isFile()) continue;
        if (!/^state(?:_\d+)?\.sqlite$/i.test(String(entry.name || ""))) continue;
        out.push(path.join(codexHomeDir, entry.name));
      }
      out.sort((a, b) => String(a).localeCompare(String(b)));
      return out;
    }

    function normalizeThreadPathPrefix(rawValue) {
      if (typeof rawValue !== "string") return "";
      let value = rawValue.trim().replace(/^"+|"+$/g, "");
      if (!value) return value;
      if (value.startsWith("\\\\?\\")) value = value.slice(4);
      else if (value.startsWith("//?/")) value = value.slice(4);
      else if (value.startsWith("/??/")) value = value.slice(4);
      if (/^[/\\][A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
      return value;
    }

    function buildThreadPathNormalizeExpression(column) {
      return (
        "CASE " +
        "WHEN typeof(" + column + ")='text' AND length(" + column + ") > 4 AND substr(hex(" + column + "), 1, 8)='5C5C3F5C' THEN substr(" + column + ", 5) " +
        "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '//?/%' THEN substr(" + column + ", 5) " +
        "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '/??/%' THEN substr(" + column + ", 5) " +
        "WHEN typeof(" + column + ")='text' AND " + column + " GLOB '/[A-Za-z]:/*' THEN substr(" + column + ", 2) " +
        "WHEN typeof(" + column + ")='text' AND substr(" + column + ", 1, 1)='\\\\' AND substr(" + column + ", 2, 2) GLOB '[A-Za-z]:' THEN substr(" + column + ", 2) " +
        "ELSE " + column + " END"
      );
    }

    function ensureThreadPathNormalizationTriggers(db, migrationTargets, availableColumns) {
      for (const column of migrationTargets) {
        if (!availableColumns.includes(column)) continue;
        const normalizeExpr = buildThreadPathNormalizeExpression(column);
        const triggerPrefix = "codex_windows_threads_" + column + "_normalize";
        const createInsertTrigger =
          "CREATE TRIGGER IF NOT EXISTS " + triggerPrefix + "_insert " +
          "AFTER INSERT ON threads " +
          "FOR EACH ROW BEGIN " +
          "UPDATE threads SET " + column + " = " + normalizeExpr + " WHERE id = NEW.id; " +
          "END;";
        const createUpdateTrigger =
          "CREATE TRIGGER IF NOT EXISTS " + triggerPrefix + "_update " +
          "AFTER UPDATE OF " + column + " ON threads " +
          "FOR EACH ROW BEGIN " +
          "UPDATE threads SET " + column + " = " + normalizeExpr + " WHERE id = NEW.id; " +
          "END;";
        db.exec(createInsertTrigger);
        db.exec(createUpdateTrigger);
      }
    }

    function migrateThreadCwdPrefixInSqlite(codexHomeDir) {
      const report = {
        codexHomeDir: codexHomeDir || "",
        scannedDatabases: 0,
        updatedDatabases: 0,
        updatedRows: 0
      };

      const databasePaths = listStateDatabasePaths(codexHomeDir);
      if (databasePaths.length === 0) return report;

      let DatabaseCtor;
      try {
        DatabaseCtor = require("better-sqlite3");
      } catch {
        console.warn("[sqlite-cwd-migration] skipped reason=missing-better-sqlite3");
        return report;
      }
      if (typeof DatabaseCtor !== "function") {
        console.warn("[sqlite-cwd-migration] skipped reason=invalid-better-sqlite3-export");
        return report;
      }

      const migrationTargets = ["cwd", "rollout_path"];
      const hasThreadsTableQuery = "SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads' LIMIT 1";

      for (const databasePath of databasePaths) {
        let db;
        try {
          db = new DatabaseCtor(databasePath, { fileMustExist: true });
          report.scannedDatabases += 1;
          const hasThreadsTable = db.prepare(hasThreadsTableQuery).get();
          if (!hasThreadsTable) continue;
          let availableColumns = [];
          try {
            availableColumns = db.prepare("PRAGMA table_info(threads)").all().map((row) => String(row && row.name ? row.name : ""));
          } catch {
            availableColumns = [];
          }
          ensureThreadPathNormalizationTriggers(db, migrationTargets, availableColumns);
          let changedRows = 0;
          for (const column of migrationTargets) {
            if (!availableColumns.includes(column)) continue;
            const rows = db
              .prepare("SELECT id, " + column + " AS pathValue FROM threads WHERE typeof(" + column + ")='text'")
              .all();
            if (!Array.isArray(rows) || rows.length === 0) continue;
            const updateStatement = db.prepare("UPDATE threads SET " + column + " = ? WHERE id = ?");
            for (const row of rows) {
              const threadId = row && typeof row.id === "string" ? row.id : "";
              const currentPath = row && typeof row.pathValue === "string" ? row.pathValue : "";
              if (!threadId || !currentPath) continue;
              const normalizedPath = normalizeThreadPathPrefix(currentPath);
              if (!normalizedPath || normalizedPath === currentPath) continue;
              const updateResult = updateStatement.run(normalizedPath, threadId);
              changedRows += Number(updateResult && updateResult.changes ? updateResult.changes : 0);
            }
          }
          if (changedRows > 0) {
            report.updatedDatabases += 1;
            report.updatedRows += changedRows;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[sqlite-cwd-migration] failed db=" + databasePath + " message=" + message);
        } finally {
          try {
            if (db && typeof db.close === "function") db.close();
          } catch {
            // ignore
          }
        }
      }

      return report;
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
      if (value.startsWith("\\\\?\\")) value = value.slice(4);
      else if (value.startsWith("//?/")) value = value.slice(4);
      else if (value.startsWith("/??/")) value = value.slice(4);
      if (/^[/\\][A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
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
    const sqliteMigrationReport = migrateThreadCwdPrefixInSqlite(resolveCodexHomeDir());
    if (sqliteMigrationReport.updatedRows > 0) {
      console.info("[sqlite-cwd-migration] codexHomeDir=" + sqliteMigrationReport.codexHomeDir + " scannedDatabases=" + sqliteMigrationReport.scannedDatabases + " updatedDatabases=" + sqliteMigrationReport.updatedDatabases + " updatedRows=" + sqliteMigrationReport.updatedRows);
    }
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
      if (electron && electron.shell && !globalThis.__CODEX_WINDOWS_SHELL_OPEN_PATH_PATCHED__) {
        globalThis.__CODEX_WINDOWS_SHELL_OPEN_PATH_PATCHED__ = true;
        const originalOpenPath = typeof electron.shell.openPath === "function" ? electron.shell.openPath.bind(electron.shell) : null;
        const originalShowItemInFolder = typeof electron.shell.showItemInFolder === "function"
          ? electron.shell.showItemInFolder.bind(electron.shell)
          : null;
        if (originalOpenPath) {
          electron.shell.openPath = (targetPath) => originalOpenPath(normalizeWindowsOpenPath(targetPath));
        }
        if (originalShowItemInFolder) {
          electron.shell.showItemInFolder = (targetPath) => originalShowItemInFolder(normalizeWindowsOpenPath(targetPath));
        }
      }
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
function patchMainForWindowsEnvironment(appDir, buildNumber, buildFlavor) {
    const mainJs = path.join(appDir, ".vite", "build", "main.js");
    const openFilePrefixPattern = '.replace(/^([ab])[\\\\/]/,"")';
    const openFilePrefixReplacement = '.replace(/^([ab])[\\\\/]/,"").replace(/^[/\\\\]+(?=[A-Za-z]:[\\\\/])/,"")';
    if (!(0, exec_1.fileExists)(mainJs))
        return;
    let raw = fs.readFileSync(mainJs, "utf8");
    raw = raw.replace(/\/\* CODEX-WINDOWS-ENV-SHIM-V\d+ \*\/[\s\S]*?\}\)\(\);\s*/g, "");
    raw = raw.replace(/\(function codeXWindowsEnvironmentShim\(\)\s*\{[\s\S]*?\}\)\(\);\s*/g, "");
    const runtimeStart = raw.match(/(["'])use strict\1;\s*[\s\S]*/);
    if (!runtimeStart) {
        throw new Error(`Unable to locate runtime entry in ${mainJs}. Expected '"use strict";' prefix.`);
    }
    raw = runtimeStart[0];
    if (!/require\(["']electron["']\)/.test(raw)) {
        throw new Error(`Unable to locate electron bootstrap require in ${mainJs}.`);
    }
    const openFilePrefixPatchCount = raw.split(openFilePrefixPattern).length - 1;
    if (openFilePrefixPatchCount < 1) {
        throw new Error(`Unable to locate open-file path normalization patch point in ${mainJs}.`);
    }
    raw = raw.split(openFilePrefixPattern).join(openFilePrefixReplacement);
    const shim = buildWindowsRuntimeShim(buildNumber, buildFlavor);
    fs.writeFileSync(mainJs, `${shim}\n${raw}`, "utf8");
}
function ensureGitOnPath() {
    const candidates = [];
    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"));
        candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "git.exe"));
    }
    if (process.env["ProgramFiles(x86)"]) {
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe"));
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "git.exe"));
    }
    const gitExe = candidates.find((candidate) => (0, exec_1.fileExists)(candidate));
    if (!gitExe)
        return;
    const gitDir = path.dirname(gitExe);
    const current = (process.env.PATH || "").split(";").map((entry) => entry.trim().toLowerCase());
    if (!current.includes(gitDir.toLowerCase())) {
        process.env.PATH = `${gitDir};${process.env.PATH || ""}`;
        process.env.Path = process.env.PATH;
    }
}
function startCodexDirectLaunch(electronExe, appDir, userDataDir, cacheDir, codexCliPath, buildNumber, buildFlavor, gitCapabilityCachePath) {
    if (!(0, exec_1.fileExists)(electronExe))
        throw new Error(`electron.exe not found: ${electronExe}`);
    const rendererPath = path.join(appDir, "webview", "index.html");
    const rendererUrl = `file:///${rendererPath.replace(/\\/g, "/")}`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.ELECTRON_RENDERER_URL = rendererUrl;
    env.ELECTRON_FORCE_IS_PACKAGED = "1";
    env.CODEX_BUILD_NUMBER = buildNumber;
    env.CODEX_BUILD_FLAVOR = buildFlavor;
    env.BUILD_FLAVOR = buildFlavor;
    env.NODE_ENV = "production";
    env.CODEX_CLI_PATH = codexCliPath;
    env.PWD = appDir;
    if (gitCapabilityCachePath)
        env.CODEX_GIT_CAPABILITY_CACHE = gitCapabilityCachePath;
    (0, exec_1.ensureDir)(userDataDir);
    (0, exec_1.ensureDir)(cacheDir);
    const result = (0, exec_1.runCommand)(electronExe, [appDir, "--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`], { cwd: appDir, env, capture: false, allowNonZero: true });
    if (result.status !== 0) {
        throw new Error(`Codex process exited with code ${result.status}.`);
    }
}
