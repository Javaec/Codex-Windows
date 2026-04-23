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
exports.writeBuildMetadata = writeBuildMetadata;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { resolveRuntimeModCompatibility } = require(path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs"));
function describeRuntime(runtime) {
    return {
        source: runtime.sourceKind,
        sourceLabel: runtime.sourceLabel,
        executablePath: runtime.executablePath,
        runtimeRoot: runtime.runtimeRoot,
        electronVersion: runtime.electronVersion,
        fingerprint: runtime.fingerprint,
        validationMode: runtime.validationMode,
    };
}
function writeLiteContract(outputDir, payload) {
    const targetPath = path.join(outputDir, "lite-contract.json");
    const contract = {
        version: 1,
        runtimeFlavor: payload.runtimeFlavor,
        appVersion: payload.appVersion,
        buildNumber: payload.buildNumber,
        knownBuildId: payload.knownBuildId,
        knownBuildSource: payload.knownBuildSource,
        patchProfileId: payload.patchProfileId,
        directExeReady: true,
        bundledTools: {
            codexCli: fs.existsSync(path.join(outputDir, "resources", "codex.exe")),
            ripgrep: fs.existsSync(path.join(outputDir, "resources", "rg.exe")),
            windowsPathContract: fs.existsSync(path.join(outputDir, "resources", "app", ".vite", "build", "codex-windows-path-contract.cjs")),
        },
        runtimeModsBundled: payload.includeRuntimeMods,
        launchers: [
            "Launch-Codex.cmd",
            ...(payload.includeRuntimeMods ? ["Launch-Codex-with-mods.cmd"] : []),
        ],
        electronRuntimeSource: payload.portableShellRuntime.sourceKind,
        nativeElectronRuntimeSource: payload.nativeRuntime.sourceKind,
        shellRuntimeMatchesNative: path.resolve(payload.portableShellRuntime.executablePath) === path.resolve(payload.nativeRuntime.executablePath),
        canonicalOutputReady: payload.canonicalOutputReady,
        latestLaunchersReady: payload.latestLaunchersReady,
        cliSource: payload.cliSource || "",
        ripgrepSource: payload.ripgrepSource || "",
    };
    fs.writeFileSync(targetPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
}
function writeBuildMetadata(outputDir, metadata) {
    const resolvedRuntimeModCompatibility = resolveRuntimeModCompatibility({
        modsRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods"),
        loaderRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader"),
        snapshotLabel: metadata.dmgPath,
        appVersion: metadata.appVersion,
        buildNumber: metadata.buildNumber,
    });
    const runtimeModCompatibility = {
        bundled: metadata.includeRuntimeMods,
        buildHint: resolvedRuntimeModCompatibility.build.buildHint,
        matchedBuildId: resolvedRuntimeModCompatibility.build.matchedBuild ? resolvedRuntimeModCompatibility.build.matchedBuild.id : "",
        selectedModIds: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.selectedModIds : [],
        loadOrder: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.loadOrder : [],
        recommendedDisabledMods: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.recommendedDisabledMods : [],
        incompatibleMods: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.incompatibleMods : [],
        softIncompatibilities: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.softIncompatibilities : [],
    };
    const targetPath = path.join(outputDir, "build-metadata.json");
    const payload = {
        builtAtIso: new Date().toISOString(),
        dmgPath: metadata.dmgPath,
        dmgFileName: path.basename(metadata.dmgPath),
        appVersion: metadata.appVersion,
        buildNumber: metadata.buildNumber,
        buildFlavor: metadata.buildFlavor,
        profileName: metadata.profileName,
        runtimeFlavor: metadata.runtimeFlavor,
        knownBuildId: metadata.knownBuildId,
        knownBuildSource: metadata.knownBuildSource,
        patchProfileId: metadata.patchProfileId,
        patchReportPath: metadata.patchReportPath,
        codexCliPath: metadata.cliPath,
        codexCliSource: metadata.cliSource,
        bundledRipgrepPath: metadata.bundledRipgrepPath,
        bundledRipgrepSource: metadata.ripgrepSource,
        bundledRipgrepSourcePath: metadata.bundledRipgrepSourcePath,
        electronRuntimeRole: "portable-shell",
        electronRuntimeSource: metadata.portableShellRuntime.sourceKind,
        electronRuntimeSourceLabel: metadata.portableShellRuntime.sourceLabel,
        electronRuntimePath: metadata.portableShellRuntime.executablePath,
        electronRuntimeVersion: metadata.portableShellRuntime.electronVersion,
        electronRuntimeFingerprint: metadata.portableShellRuntime.fingerprint,
        electronRuntimeValidationMode: metadata.portableShellRuntime.validationMode,
        packagedRuntimeCached: metadata.portableShellRuntime.sourceKind === "packaged-runtime-cache",
        nativePackagedRuntimeCached: metadata.nativeRuntime.sourceKind === "packaged-runtime-cache",
        shellRuntimeMatchesNative: path.resolve(metadata.portableShellRuntime.executablePath) === path.resolve(metadata.nativeRuntime.executablePath),
        portableShellRuntime: describeRuntime(metadata.portableShellRuntime),
        nativeRuntime: describeRuntime(metadata.nativeRuntime),
        runtimeModCompatibility,
    };
    fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    writeLiteContract(outputDir, {
        appVersion: metadata.appVersion,
        buildNumber: metadata.buildNumber,
        knownBuildId: metadata.knownBuildId,
        knownBuildSource: metadata.knownBuildSource,
        patchProfileId: metadata.patchProfileId,
        cliSource: metadata.cliSource,
        ripgrepSource: metadata.ripgrepSource,
        runtimeFlavor: metadata.runtimeFlavor,
        includeRuntimeMods: metadata.includeRuntimeMods,
        portableShellRuntime: metadata.portableShellRuntime,
        nativeRuntime: metadata.nativeRuntime,
        canonicalOutputReady: metadata.canonicalOutputReady,
        latestLaunchersReady: metadata.latestLaunchersReady,
    });
    return targetPath;
}
