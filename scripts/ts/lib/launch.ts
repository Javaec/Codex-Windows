import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists, runCommand, writeWarn } from "./exec";

const WEBVIEW_CWD_NORMALIZER_PATCH_TAG = "/* CODEX-WINDOWS-CWD-NORMALIZER-V1 */";
const WEBVIEW_APP_SUNSET_PATCH_TAG = "/* CODEX-WINDOWS-APP-SUNSET-BYPASS-V1 */";
const WEBVIEW_SETTINGS_LIMIT_PANEL_PATCH_TAG = "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V16 */";
const WEBVIEW_THREADS_PER_PROJECT_CAP_PATCH_TAG = "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V9 */";
const WEBVIEW_DISABLE_LOGOUT_PATCH_TAG = "/* CODEX-WINDOWS-DISABLE-LOGOUT-V1 */";
const WEBVIEW_PERSIST_EXTENDED_HISTORY_PATCH_TAG = "/* CODEX-WINDOWS-WEBVIEW-PERSIST-EXTENDED-HISTORY-V1 */";
const WEBVIEW_SETTINGS_LIMIT_PANEL_LEGACY_TAGS = [
  "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V15 */",
  "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V14 */",
  "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V13 */",
  "/* CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V12 */",
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
const WEBVIEW_THREADS_PER_PROJECT_CAP_LEGACY_TAGS: string[] = [
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V8 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V7 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V6 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V5 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V4 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V1 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V2 */",
  "/* CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V3 */",
];
const WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "shared",
  "patch-pack",
  "injections",
  "webview-settings-limits-panel.v3.js",
);
const WEBVIEW_DISABLE_LOGOUT_SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "shared",
  "patch-pack",
  "injections",
  "webview-disable-logout.v1.js",
);

const MAIN_SHIM_LOADER_TAG = "/* CODEX-WINDOWS-MAIN-SHIM-LOADER-V1 */";
const MAIN_SHIM_OUTPUT_NAME = "codex-windows-main-shim.cjs";
const MAIN_SHIM_TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "shared",
  "patch-pack",
  "runtime",
  "codex-windows-main-shim.template.cjs",
);
let webviewSettingsLimitPanelScriptCache = "";
let webviewDisableLogoutScriptCache = "";
let mainShimTemplateCache = "";

function resolveWebviewSettingsLimitPanelScript(): string {
  if (webviewSettingsLimitPanelScriptCache.length > 0) {
    return webviewSettingsLimitPanelScriptCache;
  }
  if (!fileExists(WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH)) {
    throw new Error(`settings limits panel script not found: ${WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH}`);
  }
  const script = fs.readFileSync(WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH, "utf8").trim();
  if (script.length < 16) {
    throw new Error(`settings limits panel script is empty: ${WEBVIEW_SETTINGS_LIMIT_PANEL_SCRIPT_PATH}`);
  }
  webviewSettingsLimitPanelScriptCache = script;
  return webviewSettingsLimitPanelScriptCache;
}

function resolveWebviewDisableLogoutScript(): string {
  if (webviewDisableLogoutScriptCache.length > 0) {
    return webviewDisableLogoutScriptCache;
  }
  if (!fileExists(WEBVIEW_DISABLE_LOGOUT_SCRIPT_PATH)) {
    throw new Error(`disable logout script not found: ${WEBVIEW_DISABLE_LOGOUT_SCRIPT_PATH}`);
  }
  const script = fs.readFileSync(WEBVIEW_DISABLE_LOGOUT_SCRIPT_PATH, "utf8").trim();
  if (script.length < 16) {
    throw new Error(`disable logout script is empty: ${WEBVIEW_DISABLE_LOGOUT_SCRIPT_PATH}`);
  }
  webviewDisableLogoutScriptCache = script;
  return webviewDisableLogoutScriptCache;
}

function resolveMainShimTemplate(): string {
  if (mainShimTemplateCache.length > 0) return mainShimTemplateCache;
  if (!fileExists(MAIN_SHIM_TEMPLATE_PATH)) {
    throw new Error(`main shim template not found: ${MAIN_SHIM_TEMPLATE_PATH}`);
  }
  const template = fs.readFileSync(MAIN_SHIM_TEMPLATE_PATH, "utf8").replace(/^\uFEFF/, "");
  if (template.trim().length < 32) {
    throw new Error(`main shim template is empty: ${MAIN_SHIM_TEMPLATE_PATH}`);
  }
  mainShimTemplateCache = template;
  return mainShimTemplateCache;
}
type WebviewPatchResult = {
  alreadyPatched: boolean;
  patched: boolean;
  content: string;
};

export type WebviewPatchSummary = {
  patchedFiles: number;
  alreadyPatchedFiles: number;
};

export type WebviewPatchOptions = {
  allowMissingPatchPoint?: boolean;
};

function patchWebviewIndexBundles(
  appDir: string,
  bundleNotFoundError: string,
  patchNotFoundError: string,
  patchContent: (raw: string) => WebviewPatchResult,
  optionalPatch = false,
): WebviewPatchSummary {
  const assetsDir = path.join(appDir, "webview", "assets");
  if (!fileExists(assetsDir)) {
    return { patchedFiles: 0, alreadyPatchedFiles: 0 };
  }

  const bundles = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^index-.*\.js$/i.test(entry.name))
    .map((entry) => path.join(assetsDir, entry.name));

  if (bundles.length === 0) throw new Error(bundleNotFoundError);

  let patchedFileCount = 0;
  let alreadyPatchedFileCount = 0;

  for (const bundlePath of bundles) {
    const raw = fs.readFileSync(bundlePath, "utf8");
    const result = patchContent(raw);
    if (result.alreadyPatched) {
      alreadyPatchedFileCount += 1;
      continue;
    }
    if (!result.patched) continue;

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

export function patchPreload(appDir: string): boolean {
  const preload = path.join(appDir, ".vite", "build", "preload.js");
  if (!fileExists(preload)) return false;
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
    return true;
  }
  return false;
}

export function patchWebviewCwdNormalization(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const helperPairPattern =
    /function\s+([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{return\s+([A-Za-z0-9_$]+)\(\2\)\.toLowerCase\(\)\}function\s+\3\(([A-Za-z0-9_$]+)\)\{return\s+\4\.replace\([^)]*\)\}/g;

  const summary = patchWebviewIndexBundles(
    appDir,
    "webview index bundle not found for cwd normalization patch.",
    "webview cwd normalization patch point not found.",
    (raw) => {
      if (raw.includes(WEBVIEW_CWD_NORMALIZER_PATCH_TAG)) {
        return { alreadyPatched: true, patched: false, content: raw };
      }
      let changed = false;
      const next = raw.replace(helperPairPattern, (_full, lowerFn, lowerArg, normalizeFn, normalizeArg) => {
        changed = true;
        return `${WEBVIEW_CWD_NORMALIZER_PATCH_TAG}function ${lowerFn}(${lowerArg}){return ${normalizeFn}(${lowerArg}).toLowerCase()}function ${normalizeFn}(${normalizeArg}){const __codexWindowsPathRaw=${normalizeArg}.replace(/\\\\/g,"/");const __codexWindowsPath=__codexWindowsPathRaw.startsWith("//?/")?__codexWindowsPathRaw.slice(4):(__codexWindowsPathRaw.startsWith("/??/")?__codexWindowsPathRaw.slice(4):__codexWindowsPathRaw);const __codexWindowsDrivePath=__codexWindowsPath.startsWith("/")?__codexWindowsPath.slice(1):__codexWindowsPath;return /^[A-Za-z]:\\//.test(__codexWindowsDrivePath)?__codexWindowsDrivePath:__codexWindowsPath}`;
      });
      return { alreadyPatched: false, patched: changed, content: next };
    },
    allowMissingPatchPoint,
  );
  const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
  if (!matched && allowMissingPatchPoint) {
    writeWarn("webview cwd normalization patch skipped: patch point not found for current bundle signature.");
  }
  return summary;
}

export function patchWebviewAppSunsetGate(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const legacyPatchNeedles = ["const s=Xs(i);if(r){", "const s=Cs(i);if(r){", "const s=ys(i);if(r){"];
  const markerNeedles = ['id:"appSunset.title"', 'defaultMessage:"Update required"'];
  const gatePattern =
    /const\s+([A-Za-z0-9_$]+)\s*=\s*([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\);\s*if\(([A-Za-z0-9_$]+)\)\{/g;

  const summary = patchWebviewIndexBundles(
    appDir,
    "webview index bundle not found for app sunset patch.",
    "webview app sunset patch point not found.",
    (raw) => {
      if (raw.includes(WEBVIEW_APP_SUNSET_PATCH_TAG)) {
        return { alreadyPatched: true, patched: false, content: raw };
      }

      for (const needle of legacyPatchNeedles) {
        if (!raw.includes(needle)) continue;
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

      const sunsetComponentMatch = /^function\s+([A-Za-z0-9_$]+)\(/.exec(
        raw.slice(sunsetComponentStart, sunsetComponentStart + 96),
      );
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
      let selectedPatch:
        | {
            start: number;
            end: number;
            gateVar: string;
            guardVar: string;
          }
        | undefined;
      let match: RegExpExecArray | null;
      while ((match = gatePattern.exec(searchWindow)) !== null) {
        const full = match[0];
        const gateVar = match[1];
        const guardVar = match[4];
        const branchWindow = searchWindow.slice(match.index, Math.min(searchWindow.length, match.index + 640));
        if (!branchWindow.includes(`else if(${gateVar}){`)) continue;
        const componentRenderedInBranch = usageNeedles.some((needle) => branchWindow.includes(needle));
        if (!componentRenderedInBranch) continue;
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
    },
    allowMissingPatchPoint,
  );
  const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
  if (!matched && allowMissingPatchPoint) {
    writeWarn("webview app sunset patch skipped: patch point not found for current bundle signature.");
  }
  return summary;
}

export function patchWebviewSettingsLimitsPanel(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const disableLimitsPanelValue = process.env.CODEX_WINDOWS_DISABLE_LIMITS_PANEL;
  const disableLimitsPanel = String(disableLimitsPanelValue || "").trim() === "1";
  if (disableLimitsPanel) {
    writeWarn("webview settings limits panel patch disabled by CODEX_WINDOWS_DISABLE_LIMITS_PANEL=1");
    return { patchedFiles: 0, alreadyPatchedFiles: 0 };
  }
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const settingsPanelScript = resolveWebviewSettingsLimitPanelScript();
  const summary = patchWebviewIndexBundles(
    appDir,
    "webview index bundle not found for settings limits panel patch.",
    "webview settings limits panel patch point not found.",
    (raw) => {
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
    },
    allowMissingPatchPoint,
  );
  const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
  if (!matched && allowMissingPatchPoint) {
    writeWarn("webview settings limits panel patch skipped: patch point not found for current bundle signature.");
  }
  return summary;
}

export function patchWebviewDisableLogout(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const script = resolveWebviewDisableLogoutScript();

  const summary = patchWebviewIndexBundles(
    appDir,
    "webview index bundle not found for disable logout patch.",
    "webview disable logout patch point not found.",
    (raw) => {
      if (raw.includes(WEBVIEW_DISABLE_LOGOUT_PATCH_TAG)) {
        return { alreadyPatched: true, patched: false, content: raw };
      }

      const content = `${raw.trimEnd()};\n${WEBVIEW_DISABLE_LOGOUT_PATCH_TAG}\n${script}\n`;
      return { alreadyPatched: false, patched: true, content };
    },
    allowMissingPatchPoint,
  );
  return summary;
}

export function patchWebviewThreadsPerProjectCap(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const summary = patchWebviewIndexBundles(
    appDir,
    "webview index bundle not found for threads per project cap patch.",
    "webview threads per project cap patch point not found.",
    (raw) => {
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

      let patched = false;
      // Newer builds cap the recent section via `maxItems:<token>`.
      next = next.replace(/maxItems:10(?=,)/g, () => {
        patched = true;
        return "maxItems:6";
      });

      const ids = new Set<string>();
      for (const match of next.matchAll(/maxItems:([A-Za-z0-9_$]+)/g)) {
        const id = match[1];
        if (id && id.length >= 3) ids.add(id);
      }
      for (const id of ids) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        next = next.replace(new RegExp(`\\b(const|let|var)\\s+${escaped}=(\\d+)\\b`), (_match, keyword, value) => {
          if (value === "6") return `${keyword} ${id}=6`;
          patched = true;
          return `${keyword} ${id}=6`;
        });
      }

      // Legacy fallback: older builds cap by request `limit=<pageSize>*this.recentConversationsPageCount`.
      if (!patched) {
        next = next.replace(
          /(const\s+[A-Za-z0-9_$]+\s*=\s*)([A-Za-z0-9_$]+)\*this\.recentConversationsPageCount/g,
          (_match, prefix) => {
            patched = true;
            return `${prefix}6*this.recentConversationsPageCount`;
          },
        );
      }
      // Legacy fallback: load-more uses `limit:<pageSize>,cursor:this.recentConversationsNextCursor`.
      if (!patched) {
        next = next.replace(
          /sendRequest\((["'])thread\/list\1,\{limit:[A-Za-z0-9_$]+,cursor:this\.recentConversationsNextCursor/g,
          (_match, quote) => {
            patched = true;
            return `sendRequest(${quote}thread/list${quote},{limit:6,cursor:this.recentConversationsNextCursor`;
          },
        );
      }

      if (!patched) {
        return { alreadyPatched: false, patched: false, content: raw };
      }

      const content = `${next};\n${WEBVIEW_THREADS_PER_PROJECT_CAP_PATCH_TAG}\n`;
      return { alreadyPatched: false, patched: true, content };
    },
    allowMissingPatchPoint,
  );
  const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
  if (!matched && allowMissingPatchPoint) {
    writeWarn("webview threads per project cap patch skipped: patch point not found for current bundle signature.");
  }
  return summary;
}

export function patchWebviewPersistExtendedHistory(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const summary = patchWebviewIndexBundles(
    appDir,
    "webview index bundle not found for persistExtendedHistory patch.",
    "webview persistExtendedHistory patch point not found.",
    (raw) => {
      if (raw.includes(WEBVIEW_PERSIST_EXTENDED_HISTORY_PATCH_TAG)) {
        return { alreadyPatched: true, patched: false, content: raw };
      }
      let next = raw;
      let patched = false;

      // If another patch removed our tag but the bundle is already patched, re-tag without failing the pipeline.
      if (
        next.includes("persistExtendedHistory:!0") ||
        next.includes("persistExtendedHistory:true") ||
        next.includes("persistExtendedHistory:1")
      ) {
        const content = `${next};\n${WEBVIEW_PERSIST_EXTENDED_HISTORY_PATCH_TAG}\n`;
        return { alreadyPatched: false, patched: true, content };
      }

      next = next.replace(/persistExtendedHistory:!1\b/g, () => {
        patched = true;
        return "persistExtendedHistory:!0";
      });
      next = next.replace(/persistExtendedHistory:false\b/g, () => {
        patched = true;
        return "persistExtendedHistory:!0";
      });
      next = next.replace(/persistExtendedHistory:0\b/g, () => {
        patched = true;
        return "persistExtendedHistory:1";
      });

      if (!patched) {
        return { alreadyPatched: false, patched: false, content: raw };
      }

      const content = `${next};\n${WEBVIEW_PERSIST_EXTENDED_HISTORY_PATCH_TAG}\n`;
      return { alreadyPatched: false, patched: true, content };
    },
    allowMissingPatchPoint,
  );
  const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
  if (!matched && allowMissingPatchPoint) {
    writeWarn("webview persistExtendedHistory patch skipped: patch point not found for current bundle signature.");
  }
  return summary;
}

function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildMainShim(buildNumber: string, buildFlavor: string): string {
  const safeBuildNumber = escapeJsString(buildNumber);
  const safeBuildFlavor = escapeJsString(buildFlavor);
  return resolveMainShimTemplate()
    .replace(/__BUILD_NUMBER__/g, safeBuildNumber)
    .replace(/__BUILD_FLAVOR__/g, safeBuildFlavor);
}

export function patchMainForWindowsEnvironment(appDir: string, buildNumber: string, buildFlavor: string): void {
  const mainJs = path.join(appDir, ".vite", "build", "main.js");
  if (!fileExists(mainJs)) return;
  const buildDir = path.dirname(mainJs);
  const shimPath = path.join(buildDir, MAIN_SHIM_OUTPUT_NAME);
  fs.writeFileSync(shimPath, `${buildMainShim(buildNumber, buildFlavor)}\n`, "utf8");

  let raw = fs.readFileSync(mainJs, "utf8");

  raw = raw.replace(/\/\* CODEX-WINDOWS-ENV-SHIM-V\d+ \*\/[\s\S]*?\}\)\(\);\s*/g, "");
  raw = raw.replace(/\(function codeXWindowsEnvironmentShim\(\)\s*\{[\s\S]*?\}\)\(\);\s*/g, "");
  raw = raw.replace(/\/\* CODEX-WINDOWS-MAIN-SHIM-LOADER-V\d+ \*\/require\([^)]+\);\s*/g, "");

  const runtimeStart = raw.match(/(["'])use strict\1;\s*[\s\S]*/);
  if (!runtimeStart) {
    throw new Error(`Unable to locate runtime entry in ${mainJs}. Expected '"use strict";' prefix.`);
  }
  raw = runtimeStart[0];
  if (!/require\(["']electron["']\)/.test(raw)) {
    throw new Error(`Unable to locate electron bootstrap require in ${mainJs}.`);
  }

  if (!raw.includes(MAIN_SHIM_LOADER_TAG)) {
    raw = raw.replace(
      /(["'])use strict\1;/,
      `$&${MAIN_SHIM_LOADER_TAG}require(\"./${MAIN_SHIM_OUTPUT_NAME}\");`,
    );
  }

  fs.writeFileSync(mainJs, raw, "utf8");
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
