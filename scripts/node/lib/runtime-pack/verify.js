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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const WEBVIEW_CWD_PATCH_MARKER = "/* CODEX-WINDOWS-CWD-NORMALIZER-V1 */";
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
function verifyPortableRuntimeContract(options) {
    const resourcesDir = path.join(options.outputDir, "resources");
    const appDir = path.join(resourcesDir, "app");
    assertExists(path.join(options.outputDir, "Codex.exe"), "portable executable");
    assertExists(appDir, "packaged app directory");
    assertExists(path.join(appDir, ".vite", "build", "codex-windows-path-contract.cjs"), "runtime windows path contract helper");
    assertExists(path.join(resourcesDir, "codex.exe"), "bundled codex.exe");
    assertExists(path.join(resourcesDir, "rg.exe"), "bundled rg.exe");
    assertExists(path.join(resourcesDir, "path", "rg.exe"), "bundled path/rg.exe");
    assertExists(path.join(options.outputDir, "Launch-Codex.cmd"), "default launcher");
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
