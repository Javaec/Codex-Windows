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
exports.patchMainForWindowsEnvironment = patchMainForWindowsEnvironment;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const WEBVIEW_CWD_NORMALIZER_PATCH_TAG = "/* CODEX-WINDOWS-CWD-NORMALIZER-V1 */";
const WEBVIEW_APP_SUNSET_PATCH_TAG = "/* CODEX-WINDOWS-APP-SUNSET-BYPASS-V1 */";
const MAIN_SHIM_LOADER_TAG = "/* CODEX-WINDOWS-MAIN-SHIM-LOADER-V1 */";
const MAIN_SHIM_OUTPUT_NAME = "codex-windows-main-shim.cjs";
const MAIN_SHIM_TEMPLATE_PATH = path.resolve(__dirname, "..", "..", "..", "..", "shared", "patch-pack", "runtime", "codex-windows-main-shim.template.cjs");
let mainShimTemplateCache = "";
const BAD_RENDERER_MOD_WRAP_SNIPPET = "const wrapped = `/* CODEX-MOD:${mod.id} */\\\\n${mod.script}\\\\n`;";
const GOOD_LOADER_BOOTSTRAP_SNIPPETS = [
    'const activateRuntimeMods = loadRuntimeModLoader();',
    'activateRuntimeMods({ electron, buildHint, resourcesRoot, minimalPlatform: IS_MINIMAL_PLATFORM });',
    'const loaderPath = path.join(modLoaderRootPath, "main-loader.cjs");',
];
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function resolveMainShimTemplate() {
    if (mainShimTemplateCache.length > 0)
        return mainShimTemplateCache;
    if (!(0, exec_1.fileExists)(MAIN_SHIM_TEMPLATE_PATH)) {
        throw new Error(`main shim template not found: ${MAIN_SHIM_TEMPLATE_PATH}`);
    }
    const template = fs.readFileSync(MAIN_SHIM_TEMPLATE_PATH, "utf8").replace(/^\uFEFF/, "");
    if (template.trim().length < 32) {
        throw new Error(`main shim template is empty: ${MAIN_SHIM_TEMPLATE_PATH}`);
    }
    if (template.includes(BAD_RENDERER_MOD_WRAP_SNIPPET)) {
        throw new Error(`main shim template contains escaped renderer newlines and will break mod injection: ${MAIN_SHIM_TEMPLATE_PATH}`);
    }
    for (const requiredSnippet of GOOD_LOADER_BOOTSTRAP_SNIPPETS) {
        if (template.includes(requiredSnippet))
            continue;
        throw new Error(`main shim template is missing the mod loader bootstrap contract: ${MAIN_SHIM_TEMPLATE_PATH}`);
    }
    mainShimTemplateCache = template;
    return mainShimTemplateCache;
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
    if (/\.contextBridge\.exposeInMainWorld\((["'`])process\1,/.test(raw))
        return false;
    const exposePatterns = [
        /([A-Za-z0-9_$]+)\.contextBridge\.exposeInMainWorld\((["'`])codexWindowType\2,[A-Za-z0-9_$]+\)/,
        /([A-Za-z0-9_$]+)\.contextBridge\.exposeInMainWorld\((["'`])electronBridge\2,[A-Za-z0-9_$]+\)/,
        /([A-Za-z0-9_$]+)\.contextBridge\.exposeInMainWorld\((["'`])[A-Za-z0-9_$:-]+\2,[A-Za-z0-9_$]+\)/,
    ];
    const anchorMatch = exposePatterns
        .map((pattern) => raw.match(pattern))
        .find((value) => Boolean(value));
    if (!anchorMatch)
        throw new Error("preload patch point not found.");
    const electronAlias = anchorMatch[1];
    const processExpose = `const __codexWindowsProcessBridge={env:process.env,platform:process.platform,versions:process.versions,arch:process.arch,cwd:()=>process.env.PWD,argv:process.argv,pid:process.pid};${electronAlias}.contextBridge.exposeInMainWorld("process",__codexWindowsProcessBridge);`;
    const anchorValue = anchorMatch[0];
    const anchorIndex = typeof anchorMatch.index === "number" ? anchorMatch.index : raw.indexOf(anchorValue);
    if (anchorIndex < 0)
        throw new Error("preload patch anchor index not found.");
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
        (0, exec_1.writeInfo)("webview cwd normalization patch not required for current bundle signature.");
    }
    return summary;
}
function patchWebviewAppSunsetGate(appDir, options = {}) {
    const allowMissingPatchPoint = options.allowMissingPatchPoint !== false;
    const legacyPatchNeedles = ["const s=Xs(i);if(r){", "const s=Cs(i);if(r){", "const s=ys(i);if(r){"];
    const markerNeedles = ["appSunset.title", "Update required"];
    const gatePattern = /(const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[^;]+;\s*if\(([A-Za-z0-9_$]+)\)\{/g;
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
        const usageIndex = raw.indexOf(`${sunsetComponentName},`, markerIndex);
        if (usageIndex < 0) {
            return { alreadyPatched: false, patched: false, content: raw };
        }
        const searchStart = Math.max(0, usageIndex - 1600);
        const searchEnd = Math.min(raw.length, usageIndex + 512);
        const searchWindow = raw.slice(searchStart, searchEnd);
        let selectedPatch;
        let match;
        while ((match = gatePattern.exec(searchWindow)) !== null) {
            const full = match[0];
            const declarationKind = match[1];
            const gateVar = match[2];
            const guardVar = match[3];
            const branchWindow = searchWindow.slice(match.index, Math.min(searchWindow.length, match.index + 640));
            if (!branchWindow.includes(`else if(${gateVar}){`))
                continue;
            const componentRenderedInBranch = new RegExp(`\\b${escapeRegExp(sunsetComponentName)}\\b,`).test(branchWindow);
            if (!componentRenderedInBranch)
                continue;
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
        const replacement = `${WEBVIEW_APP_SUNSET_PATCH_TAG}${selectedPatch.declarationKind} ${selectedPatch.gateVar}=!1;if(${selectedPatch.guardVar}){`;
        return {
            alreadyPatched: false,
            patched: true,
            content: raw.slice(0, selectedPatch.start) + replacement + raw.slice(selectedPatch.end),
        };
    }, allowMissingPatchPoint);
    const matched = summary.patchedFiles > 0 || summary.alreadyPatchedFiles > 0;
    if (!matched && allowMissingPatchPoint) {
        (0, exec_1.writeInfo)("webview app sunset patch not required for current bundle signature.");
    }
    return summary;
}
function escapeJsString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function buildMainShim(buildNumber, buildFlavor) {
    const safeBuildNumber = escapeJsString(buildNumber);
    const safeBuildFlavor = escapeJsString(buildFlavor);
    return resolveMainShimTemplate()
        .replace(/__BUILD_NUMBER__/g, safeBuildNumber)
        .replace(/__BUILD_FLAVOR__/g, safeBuildFlavor);
}
function patchMainForWindowsEnvironment(appDir, buildNumber, buildFlavor) {
    const mainJs = path.join(appDir, ".vite", "build", "main.js");
    if (!(0, exec_1.fileExists)(mainJs))
        return;
    const buildDir = path.dirname(mainJs);
    const shimPath = path.join(buildDir, MAIN_SHIM_OUTPUT_NAME);
    fs.writeFileSync(shimPath, `${buildMainShim(buildNumber, buildFlavor)}\n`, "utf8");
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
