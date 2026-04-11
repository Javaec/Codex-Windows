"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPortableRuntimeContract = verifyPortableRuntimeContract;
const fs = require("node:fs");
const path = require("node:path");
const asar_1 = require("../asar");
const exec_1 = require("../exec");
const WEBVIEW_CWD_PATCH_MARKER = "/* CODEX-WINDOWS-CWD-NORMALIZER-V2 */";
const MAIN_WINDOWS_PATH_GUIDANCE_PATCH_MARKER = "/* CODEX-WINDOWS-PATH-GUIDANCE-V1 */";
function assertExists(targetPath, label) {
    if (!(0, exec_1.fileExists)(targetPath)) {
        throw new Error(`Portable runtime contract failed: missing ${label}: ${targetPath}`);
    }
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
    assertExists(path.join(options.outputDir, "Codex.exe"), "portable executable");
    assertExists(path.join(resourcesDir, "codex.exe"), "bundled codex.exe");
    assertExists(path.join(resourcesDir, "rg.exe"), "bundled rg.exe");
    assertExists(path.join(resourcesDir, "path", "rg.exe"), "bundled path/rg.exe");
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
