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
exports.runVerify = runVerify;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const cli_resolution_1 = require("./cli-resolution");
const env_1 = require("../env");
const exec_1 = require("../exec");
const manifest_1 = require("../manifest");
const patch_pack_1 = require("../platform-patches/patch-pack");
const native_1 = require("../runtime-donor/native");
const extract_1 = require("../source-bundle/extract");
const context_1 = require("./context");
function addVerifyItem(items, name, status, details) {
    items.push({ name, status, details });
}
function writeVerifySummary(items) {
    const counts = { OK: 0, WARN: 0, FAIL: 0 };
    for (const item of items) {
        counts[item.status] += 1;
        const line = `[verify] ${item.status.padEnd(4, " ")} ${item.name} :: ${item.details}`;
        if (item.status === "OK")
            (0, exec_1.writeSuccess)(line);
        else if (item.status === "WARN")
            (0, exec_1.writeWarn)(line);
        else
            (0, exec_1.writeError)(line);
    }
    (0, exec_1.writeHeader)("Verify summary");
    (0, exec_1.writeSuccess)(`OK=${counts.OK} WARN=${counts.WARN} FAIL=${counts.FAIL}`);
}
function takeLastLine(text) {
    const lines = String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : "";
}
function summarizePatchPackPreflight(output) {
    try {
        const parsed = JSON.parse(output);
        const profileId = parsed.selected?.profileId || "unknown";
        const matchedBuildId = parsed.selected?.matchedBuildId || "unknown";
        const modCount = Number(parsed.selected?.modCount ?? 0);
        const stepCount = Number(parsed.selected?.stepCount ?? 0);
        const runtimeModCount = Number(parsed.runtimeModpack?.modCount ?? 0);
        return `build=${matchedBuildId} profile=${profileId} selectedMods=${modCount} patchSteps=${stepCount} runtimeMods=${runtimeModCount}`;
    }
    catch {
        return takeLastLine(output) || "patch-pack is valid";
    }
}
function resolveDmgBuildMetadata(dmgPath, workDir) {
    const manifestPath = path.join(workDir, "verify.state.manifest.json");
    const manifest = (0, manifest_1.readStateManifest)(manifestPath);
    const descriptor = (0, manifest_1.getFileDescriptorWithCache)(dmgPath, manifest.dmg);
    manifest.dmg = descriptor;
    (0, manifest_1.writeStateManifest)(manifestPath, manifest);
    const extractResult = (0, extract_1.invokeExtractionStage)(dmgPath, workDir, true, false, manifest, manifestPath, (0, manifest_1.getStepSignature)({ dmgSha256: descriptor.sha256 }));
    const pkgPath = path.join(extractResult.appDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
        throw new Error(`package.json not found after DMG extraction: ${pkgPath}`);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return {
        appVersion: typeof pkg.version === "string" ? pkg.version : "",
        buildNumber: typeof pkg.codexBuildNumber === "string" ? pkg.codexBuildNumber : "",
        buildFlavor: typeof pkg.codexBuildFlavor === "string" ? pkg.codexBuildFlavor : "",
        electronVersion: typeof pkg.devDependencies?.electron === "string" ? pkg.devDependencies.electron : "",
        appDir: extractResult.appDir,
    };
}
async function runVerify(options) {
    (0, context_1.sanitizeRunnerEnvironment)();
    (0, env_1.ensureWindowsEnvironment)();
    (0, exec_1.mustResolveCommand)("node.exe");
    const workDir = path.resolve(options.workDir || path.join(context_1.REPO_ROOT, "work"));
    const distDir = path.resolve(options.distDir || path.join(context_1.REPO_ROOT, "dist"));
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    const items = [];
    (0, exec_1.writeHeader)("Verify environment");
    const ripgrep = await (0, env_1.ensureRipgrepInPath)(workDir);
    addVerifyItem(items, "ripgrep", "OK", `${ripgrep.path} (source=${ripgrep.source})`);
    const environmentResult = (0, env_1.invokeEnvironmentContractChecks)();
    for (const check of environmentResult.checks) {
        addVerifyItem(items, `env:${check.name}`, check.passed ? "OK" : "FAIL", check.details);
    }
    let resolvedDmgPath = "";
    let dmgBuildMetadata = null;
    try {
        resolvedDmgPath = (0, extract_1.resolveDmgPath)(options.dmgPath, context_1.REPO_ROOT);
        addVerifyItem(items, "dmg", "OK", resolvedDmgPath);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addVerifyItem(items, "dmg", "FAIL", message);
    }
    const snapshotLabel = resolvedDmgPath ? path.basename(resolvedDmgPath) : "";
    if (resolvedDmgPath) {
        try {
            dmgBuildMetadata = resolveDmgBuildMetadata(resolvedDmgPath, workDir);
            addVerifyItem(items, "dmg-metadata", "OK", `appVersion=${dmgBuildMetadata.appVersion || "unknown"} buildNumber=${dmgBuildMetadata.buildNumber || "unknown"} buildFlavor=${dmgBuildMetadata.buildFlavor || "unknown"}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addVerifyItem(items, "dmg-metadata", "FAIL", message);
        }
    }
    try {
        const resolvedProfile = (0, patch_pack_1.resolvePatchProfile)({
            snapshotLabel,
            buildNumber: dmgBuildMetadata?.buildNumber || "",
            appVersion: dmgBuildMetadata?.appVersion || "",
            forcedProfileId: options.patchProfile || "",
        });
        addVerifyItem(items, "build-identity", resolvedProfile.matchedBuildId ? "OK" : "WARN", resolvedProfile.matchedBuildId
            ? `${resolvedProfile.matchedBuildId} (${resolvedProfile.matchedBuildSource || "known-build"})`
            : "internal version not found in known-builds");
        addVerifyItem(items, "patch-profile", "OK", `${resolvedProfile.profile.profileId} (${resolvedProfile.source})`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addVerifyItem(items, "build-identity", "FAIL", message);
        addVerifyItem(items, "patch-profile", "FAIL", message);
    }
    const preflightArgs = [path.join(context_1.REPO_ROOT, "shared", "patch-pack", "preflight.mjs")];
    if (snapshotLabel)
        preflightArgs.push("--snapshot-label", snapshotLabel);
    if (dmgBuildMetadata?.appVersion)
        preflightArgs.push("--app-version", dmgBuildMetadata.appVersion);
    if (dmgBuildMetadata?.buildNumber)
        preflightArgs.push("--build-number", dmgBuildMetadata.buildNumber);
    const preflight = (0, exec_1.runCommand)(process.execPath, preflightArgs, {
        cwd: context_1.REPO_ROOT,
        capture: true,
        allowNonZero: true,
    });
    addVerifyItem(items, "patch-pack-preflight", preflight.status === 0 ? "OK" : "FAIL", preflight.status === 0
        ? summarizePatchPackPreflight(preflight.stdout)
        : takeLastLine(preflight.stderr || preflight.stdout) || `exit=${preflight.status}`);
    const preferredCodexCliPath = (0, context_1.resolvePreferredCodexCliPath)(options.codexCliPath);
    try {
        const cliTracePath = path.join(workDir, "verify-cli-resolution.log");
        const cliResolution = await (0, cli_resolution_1.resolveAndProbeCodexCli)(preferredCodexCliPath, false, cliTracePath, "Codex CLI verify probe failed", undefined, { workDir, codexCliChannel: options.codexCliChannel });
        if (!cliResolution.found || !cliResolution.path) {
            addVerifyItem(items, "codex-cli", "FAIL", takeLastLine(cliResolution.trace.join("\n")) || "codex.exe not found");
        }
        else {
            addVerifyItem(items, "codex-cli", "OK", `${cliResolution.path} (source=${cliResolution.source})`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addVerifyItem(items, "codex-cli", "FAIL", message);
    }
    const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";
    const nativeSupport = (0, native_1.inspectNativeSupport)(workDir, arch);
    addVerifyItem(items, "native-support", nativeSupport.usableDonorAppDirs.length > 0 || nativeSupport.usableSeedAppDirs.length > 0 ? "OK" : "FAIL", `usableDonor=${nativeSupport.usableDonorAppDirs.length}/${nativeSupport.donorAppDirs.length} usableSeed=${nativeSupport.usableSeedAppDirs.length}/${nativeSupport.seedAppDirs.length}`);
    addVerifyItem(items, "bundled-native-seeds", nativeSupport.usableSeedAppDirs.length > 0 ? "OK" : "FAIL", nativeSupport.usableSeedAppDirs.length > 0
        ? nativeSupport.usableSeedAppDirs.join(", ")
        : `no usable bundled seeds under Setup-Codex/native-seeds/${arch}/app`);
    if (dmgBuildMetadata?.electronVersion) {
        const runtimePreflight = (0, native_1.inspectRuntimePreflight)(workDir, dmgBuildMetadata.electronVersion, arch);
        addVerifyItem(items, "runtime-preflight", runtimePreflight.fallbackRequired ? "WARN" : "OK", `selected=${runtimePreflight.selectedSourceKind} source=${runtimePreflight.sourceLabel} cacheAvailable=${runtimePreflight.packagedRuntimeCacheAvailable} cacheValid=${runtimePreflight.packagedRuntimeCacheValid} fallbackRequired=${runtimePreflight.fallbackRequired}`);
    }
    else {
        addVerifyItem(items, "runtime-preflight", "WARN", "electron version missing in extracted package.json");
    }
    writeVerifySummary(items);
    return items.some((item) => item.status === "FAIL") ? 1 : 0;
}
