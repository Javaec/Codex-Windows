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
exports.verifyPortableRuntimeContract = verifyPortableRuntimeContract;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const asar_1 = require("../asar");
const exec_1 = require("../exec");
const WEBVIEW_CWD_PATCH_MARKER = "/* CODEX-WINDOWS-CWD-NORMALIZER-V2 */";
const MAIN_WINDOWS_PATH_GUIDANCE_PATCH_MARKER = "/* CODEX-WINDOWS-PATH-GUIDANCE-V1 */";
function assertExists(targetPath, label) {
    if (!(0, exec_1.fileExists)(targetPath)) {
        throw new Error(`Portable runtime contract failed: missing ${label}: ${targetPath}`);
    }
}
function getFileSha256(targetPath) {
    return (0, node_crypto_1.createHash)("sha256").update(fs.readFileSync(targetPath)).digest("hex");
}
function verifyWebviewCwdPatch(resourcesAppDir) {
    const assetsDir = path.join(resourcesAppDir, "webview", "assets");
    assertExists(assetsDir, "webview assets directory");
    const jsBundles = fs.readdirSync(assetsDir).filter((name) => /\.js$/i.test(name));
    if (jsBundles.length < 1) {
        throw new Error(`Portable runtime contract failed: no webview js bundle found in ${assetsDir}`);
    }
    const patched = jsBundles.some((fileName) => {
        const content = fs.readFileSync(path.join(assetsDir, fileName), "utf8");
        return content.includes(WEBVIEW_CWD_PATCH_MARKER);
    });
    if (!patched) {
        throw new Error("Portable runtime contract failed: webview cwd patch marker not found in packaged webview bundle.");
    }
}
function verifyMainPathGuidancePatch(resourcesAppDir) {
    const buildDir = path.join(resourcesAppDir, ".vite", "build");
    assertExists(buildDir, "packaged build directory");
    const jsBundles = fs.readdirSync(buildDir).filter((name) => /\.js$/i.test(name));
    if (jsBundles.length < 1) {
        throw new Error(`Portable runtime contract failed: no build js bundle found in ${buildDir}`);
    }
    const patched = jsBundles.some((fileName) => {
        const content = fs.readFileSync(path.join(buildDir, fileName), "utf8");
        return content.includes(MAIN_WINDOWS_PATH_GUIDANCE_PATCH_MARKER);
    });
    if (!patched) {
        throw new Error("Portable runtime contract failed: Windows path guidance patch marker not found in packaged main bundle.");
    }
}
function resolvePackagedAppDir(outputDir, resourcesDir) {
    const unpackedAppDir = path.join(resourcesDir, "app");
    if ((0, exec_1.fileExists)(unpackedAppDir)) {
        return { appDir: unpackedAppDir, cleanup: () => { } };
    }
    const packedAppPath = path.join(resourcesDir, "app.asar");
    assertExists(packedAppPath, "packaged app archive");
    assertExists(`${packedAppPath}.unpacked`, "packaged app unpacked directory");
    const inspectDir = path.join(outputDir, ".verify-app");
    (0, exec_1.removePath)(inspectDir);
    (0, asar_1.extractAsarArchive)(packedAppPath, inspectDir);
    return {
        appDir: inspectDir,
        cleanup: () => (0, exec_1.removePath)(inspectDir),
    };
}
function verifyPortableRuntimeContract(options) {
    const resourcesDir = path.join(options.outputDir, "resources");
    const bundledRipgrepPath = path.join(resourcesDir, "rg.exe");
    const bundledPathRipgrepPath = path.join(resourcesDir, "path", "rg.exe");
    assertExists(path.join(options.outputDir, "Codex.exe"), "portable executable");
    assertExists(path.join(resourcesDir, "codex.exe"), "bundled codex.exe");
    assertExists(bundledRipgrepPath, "bundled rg.exe");
    assertExists(bundledPathRipgrepPath, "bundled path/rg.exe");
    if (getFileSha256(bundledRipgrepPath) !== getFileSha256(bundledPathRipgrepPath)) {
        throw new Error("Portable runtime contract failed: bundled rg.exe and path/rg.exe differ.");
    }
    assertExists(path.join(options.outputDir, "Launch-Codex.cmd"), "default launcher");
    const { appDir, cleanup } = resolvePackagedAppDir(options.outputDir, resourcesDir);
    try {
        assertExists(path.join(appDir, ".vite", "build", "codex-windows-path-contract.cjs"), "runtime windows path contract helper");
        verifyMainPathGuidancePatch(appDir);
        if (options.includeRuntimeMods) {
            assertExists(path.join(resourcesDir, "mods"), "runtime mods directory");
            assertExists(path.join(resourcesDir, "mod-api"), "runtime mod API directory");
            assertExists(path.join(resourcesDir, "mod-loader"), "runtime mod loader directory");
            assertExists(path.join(resourcesDir, "compatibility.cjs"), "runtime compatibility helper");
            assertExists(path.join(resourcesDir, "version-identity"), "runtime version identity directory");
            assertExists(path.join(options.outputDir, "Launch-Codex-with-mods.cmd"), "with-mods launcher");
        }
        if (options.requireWebviewCwdPatch) {
            verifyWebviewCwdPatch(appDir);
        }
    }
    finally {
        cleanup();
    }
}
