import * as fs from "node:fs";
import * as path from "node:path";
import { copyFileSafe, fileExists, writeInfo } from "../exec";

const WEBVIEW_CWD_NORMALIZER_PATCH_TAG = "/* CODEX-WINDOWS-CWD-NORMALIZER-V1 */";
const WEBVIEW_APP_SUNSET_PATCH_TAG = "/* CODEX-WINDOWS-APP-SUNSET-BYPASS-V1 */";

const MAIN_SHIM_LOADER_TAG = "/* CODEX-WINDOWS-MAIN-SHIM-LOADER-V1 */";
const MAIN_SHIM_OUTPUT_NAME = "codex-windows-main-shim.cjs";
const WINDOWS_PATH_CONTRACT_OUTPUT_NAME = "codex-windows-path-contract.cjs";
const MAIN_SHIM_TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "shared",
  "patch-pack",
  "runtime",
  "codex-windows-main-shim.template.cjs",
);
const WINDOWS_PATH_CONTRACT_SOURCE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "shared",
  "windows-path-contract",
  "index.cjs",
);
let mainShimTemplateCache = "";
const WINDOWS_PATH_CONTRACT = require(WINDOWS_PATH_CONTRACT_SOURCE_PATH) as {
  buildInlineNormalizeWindowsPathContractExpression: (
    inputExpression: string,
    options?: {
      stripDiffPrefix?: boolean;
      stripLeadingDriveSlash?: boolean;
      slashStyle?: "forward" | "backward" | "preserve";
      lowerCase?: boolean;
    },
  ) => string;
};
const BAD_RENDERER_MOD_WRAP_SNIPPET = "const wrapped = `/* CODEX-MOD:${mod.id} */\\\\n${mod.script}\\\\n`;";
const GOOD_LOADER_BOOTSTRAP_SNIPPETS = [
  'const activateRuntimeMods = loadRuntimeModLoader();',
  'activateRuntimeMods({ electron, buildHint,',
  'minimalPlatform: IS_MINIMAL_PLATFORM',
  'const loaderPath = path.join(modLoaderRootPath, "main-loader.cjs");',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  if (template.includes(BAD_RENDERER_MOD_WRAP_SNIPPET)) {
    throw new Error(
      `main shim template contains escaped renderer newlines and will break mod injection: ${MAIN_SHIM_TEMPLATE_PATH}`,
    );
  }
  for (const requiredSnippet of GOOD_LOADER_BOOTSTRAP_SNIPPETS) {
    if (template.includes(requiredSnippet)) continue;
    throw new Error(`main shim template is missing the mod loader bootstrap contract: ${MAIN_SHIM_TEMPLATE_PATH}`);
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
  bundlePattern: RegExp = /^index-.*\.js$/i,
): WebviewPatchSummary {
  const assetsDir = path.join(appDir, "webview", "assets");
  if (!fileExists(assetsDir)) {
    return { patchedFiles: 0, alreadyPatchedFiles: 0 };
  }

  const bundles = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && bundlePattern.test(entry.name))
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
  if (/\.contextBridge\.exposeInMainWorld\((["'`])process\1,/.test(raw)) return false;

  const exposePatterns = [
    /([A-Za-z0-9_$]+)\.contextBridge\.exposeInMainWorld\((["'`])codexWindowType\2,[A-Za-z0-9_$]+\)/,
    /([A-Za-z0-9_$]+)\.contextBridge\.exposeInMainWorld\((["'`])electronBridge\2,[A-Za-z0-9_$]+\)/,
    /([A-Za-z0-9_$]+)\.contextBridge\.exposeInMainWorld\((["'`])[A-Za-z0-9_$:-]+\2,[A-Za-z0-9_$]+\)/,
  ];
  const anchorMatch = exposePatterns
    .map((pattern) => raw.match(pattern))
    .find((value): value is RegExpMatchArray => Boolean(value));
  if (!anchorMatch) throw new Error("preload patch point not found.");

  const electronAlias = anchorMatch[1];
  const processExpose =
    `const __codexWindowsProcessBridge={env:process.env,platform:process.platform,versions:process.versions,arch:process.arch,cwd:()=>process.env.PWD,argv:process.argv,pid:process.pid};${electronAlias}.contextBridge.exposeInMainWorld("process",__codexWindowsProcessBridge);`;
  const anchorValue = anchorMatch[0];
  const anchorIndex = typeof anchorMatch.index === "number" ? anchorMatch.index : raw.indexOf(anchorValue);
  if (anchorIndex < 0) throw new Error("preload patch anchor index not found.");

  let replacementStart = anchorIndex;
  while (replacementStart > 0 && /\s/.test(raw[replacementStart - 1])) {
    replacementStart -= 1;
  }
  let replacementPrefix = "";
  if (replacementStart > 0 && raw[replacementStart - 1] === ",") {
    replacementStart -= 1;
    replacementPrefix = ";";
  }

  raw =
    raw.slice(0, replacementStart) +
    replacementPrefix +
    processExpose +
    anchorValue +
    raw.slice(anchorIndex + anchorValue.length);
  fs.writeFileSync(preload, raw, "utf8");
  return true;
}

export function patchWebviewCwdNormalization(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const helperPairPattern =
    /function\s+([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{return\s+([A-Za-z0-9_$]+)\(\2\)\.toLowerCase\(\)\}function\s+\3\(([A-Za-z0-9_$]+)\)\{return\s+\4\.replace\([^)]*\)\}/g;
  const slashNormalizerPattern =
    /function\s+([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{return\s+\2\.replace\(\/\\\\\/g,([`'"])\/\3\)\}/g;
  const drivePrefixPattern =
    /function\s+([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{return\s+([A-Za-z0-9_$]+)\(\2\)&&!\2\.startsWith\(([`'"])\/\4\)\?\4\/\$\{\2\}\4:\2\}/g;
  const buildNormalizeFunction = (argName: string): string =>
    `return ${WINDOWS_PATH_CONTRACT.buildInlineNormalizeWindowsPathContractExpression(argName, {
      slashStyle: "forward",
    })}`;

  const summary = patchWebviewIndexBundles(
    appDir,
    "webview js bundle not found for cwd normalization patch.",
    "webview cwd normalization patch point not found.",
    (raw) => {
      if (raw.includes(WEBVIEW_CWD_NORMALIZER_PATCH_TAG)) {
        return { alreadyPatched: true, patched: false, content: raw };
      }
      let changed = false;
      let tagInserted = false;
      const withTag = (content: string): string => {
        if (tagInserted) return content;
        tagInserted = true;
        return `${WEBVIEW_CWD_NORMALIZER_PATCH_TAG}${content}`;
      };
      let next = raw.replace(helperPairPattern, (_full, lowerFn, lowerArg, normalizeFn, normalizeArg) => {
        changed = true;
        return withTag(`function ${lowerFn}(${lowerArg}){return ${normalizeFn}(${lowerArg}).toLowerCase()}function ${normalizeFn}(${normalizeArg}){${buildNormalizeFunction(normalizeArg)}}`);
      });
      next = next.replace(slashNormalizerPattern, (_full, normalizeFn, normalizeArg) => {
        changed = true;
        return withTag(`function ${normalizeFn}(${normalizeArg}){${buildNormalizeFunction(normalizeArg)}}`);
      });
      next = next.replace(drivePrefixPattern, (_full, normalizeFn, normalizeArg, driveFn) => {
        changed = true;
        return withTag(`function ${normalizeFn}(${normalizeArg}){const __codexWindowsPath=${WINDOWS_PATH_CONTRACT.buildInlineNormalizeWindowsPathContractExpression(normalizeArg, { slashStyle: "forward" })};return ${driveFn}(__codexWindowsPath)?__codexWindowsPath:${normalizeArg}}`);
      });
      return { alreadyPatched: false, patched: changed, content: next };
    },
    allowMissingPatchPoint,
    /\.js$/i,
  );
  const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
  if (!matched && allowMissingPatchPoint) {
    writeInfo("webview cwd normalization patch not required for current bundle signature.");
  }
  return summary;
}

export function patchWebviewAppSunsetGate(
  appDir: string,
  options: WebviewPatchOptions = {},
): WebviewPatchSummary {
  const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
  const legacyPatchNeedles = ["const s=Xs(i);if(r){", "const s=Cs(i);if(r){", "const s=ys(i);if(r){"];
  const markerNeedles = ["appSunset.title", "Update required"];
  const gatePattern =
    /(const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[^;]+;\s*if\(([A-Za-z0-9_$]+)\)\{/g;

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
      const usageIndex = raw.indexOf(`${sunsetComponentName},`, markerIndex);
      if (usageIndex < 0) {
        return { alreadyPatched: false, patched: false, content: raw };
      }

      const searchStart = Math.max(0, usageIndex - 1600);
      const searchEnd = Math.min(raw.length, usageIndex + 512);
      const searchWindow = raw.slice(searchStart, searchEnd);
      let selectedPatch:
        | {
            start: number;
            end: number;
            declarationKind: string;
            gateVar: string;
            guardVar: string;
          }
        | undefined;
      let match: RegExpExecArray | null;
      while ((match = gatePattern.exec(searchWindow)) !== null) {
        const full = match[0];
        const declarationKind = match[1];
        const gateVar = match[2];
        const guardVar = match[3];
        const branchWindow = searchWindow.slice(match.index, Math.min(searchWindow.length, match.index + 640));
        if (!branchWindow.includes(`else if(${gateVar}){`)) continue;
        const componentRenderedInBranch = new RegExp(`\\b${escapeRegExp(sunsetComponentName)}\\b,`).test(branchWindow);
        if (!componentRenderedInBranch) continue;
        selectedPatch = {
          start: searchStart + match.index,
          end: searchStart + match.index + full.length,
          declarationKind,
          gateVar,
          guardVar,
        };
      }
      if (!selectedPatch) {
        return { alreadyPatched: false, patched: false, content: raw };
      }

      const replacement =
        `${WEBVIEW_APP_SUNSET_PATCH_TAG}${selectedPatch.declarationKind} ${selectedPatch.gateVar}=!1;if(${selectedPatch.guardVar}){`;
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
    writeInfo("webview app sunset patch not required for current bundle signature.");
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
  const windowsPathContractPath = path.join(buildDir, WINDOWS_PATH_CONTRACT_OUTPUT_NAME);
  fs.writeFileSync(shimPath, `${buildMainShim(buildNumber, buildFlavor)}\n`, "utf8");
  copyFileSafe(WINDOWS_PATH_CONTRACT_SOURCE_PATH, windowsPathContractPath);

  let raw = fs.readFileSync(mainJs, "utf8");

  raw = raw.replace(/\/\* CODEX-WINDOWS-ENV-SHIM-V\d+ \*\/[\s\S]*?\}\)\(\);\s*/g, "");
  raw = raw.replace(/\(function codeXWindowsEnvironmentShim\(\)\s*\{[\s\S]*?\}\)\(\);\s*/g, "");
  raw = raw.replace(/\/\* CODEX-WINDOWS-MAIN-SHIM-LOADER-V\d+ \*\/require\([^)]+\);\s*/g, "");

  if (!/require\((["'`])electron\1\)/.test(raw)) {
    throw new Error(`Unable to locate electron bootstrap require in ${mainJs}.`);
  }

  if (!raw.includes(MAIN_SHIM_LOADER_TAG)) {
    const loaderStatement = `${MAIN_SHIM_LOADER_TAG}require("./${MAIN_SHIM_OUTPUT_NAME}");`;
    const strictPrefix = raw.match(/^(["'`])use strict\1;/);
    raw = strictPrefix
      ? raw.replace(/^(["'`])use strict\1;/, `$&${loaderStatement}`)
      : `${loaderStatement}${raw}`;
  }

  fs.writeFileSync(mainJs, raw, "utf8");
}
