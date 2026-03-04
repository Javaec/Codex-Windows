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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const args_1 = require("./lib/args");
const git_capability_cache_1 = require("./lib/adapters/git-capability-cache");
const workspace_registry_1 = require("./lib/adapters/workspace-registry");
const branding_1 = require("./lib/branding");
const cli_1 = require("./lib/cli");
const env_1 = require("./lib/env");
const exec_1 = require("./lib/exec");
const extract_1 = require("./lib/extract");
const manifest_1 = require("./lib/manifest");
const launch_1 = require("./lib/launch");
const patch_pipeline_1 = require("./lib/patch-pipeline");
const native_1 = require("./lib/native");
const portable_1 = require("./lib/portable");
const sfx_1 = require("./lib/sfx");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
function resolvePreferredCodexCliPath(explicit, distDir) {
    if (explicit)
        return explicit;
    const candidates = [
        path.join(distDir, "Codex-win32-x64", "resources", "codex.exe"),
        path.join(distDir, "Codex-win32-arm64", "resources", "codex.exe"),
        path.join(REPO_ROOT, "dist", "Codex-win32-x64", "resources", "codex.exe"),
        path.join(REPO_ROOT, "dist", "Codex-win32-arm64", "resources", "codex.exe"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return undefined;
}
function resolveAndProbeCodexCli(codexCliPath, requireFound, tracePath, probeFailurePrefix, missingWarnMessage) {
    const resolution = (0, cli_1.resolveCodexCliPathContract)(codexCliPath, requireFound);
    (0, cli_1.writeCliResolutionTrace)(resolution, tracePath);
    if (!resolution.found) {
        if (missingWarnMessage)
            (0, exec_1.writeWarn)(missingWarnMessage);
        return resolution;
    }
    (0, exec_1.writeSuccess)(`Using Codex CLI: ${resolution.path} (source=${resolution.source})`);
    const probe = (0, cli_1.probeCodexCliExecutable)(resolution.path);
    if (!probe.ok)
        throw new Error(`${probeFailurePrefix}: ${probe.details}`);
    return resolution;
}
function reportWorkspaceSanitizer(result) {
    if (result.updatedFiles > 0 || result.removedEntries > 0) {
        (0, exec_1.writeSuccess)(`Workspace sanitizer: updatedFiles=${result.updatedFiles}, removedEntries=${result.removedEntries}`);
    }
}
async function runPipeline(options) {
    (0, env_1.ensureWindowsEnvironment)();
    (0, exec_1.mustResolveCommand)("node.exe");
    for (const key of [
        "npm_config_runtime",
        "npm_config_target",
        "npm_config_disturl",
        "npm_config_arch",
        "npm_config_build_from_source",
    ]) {
        delete process.env[key];
    }
    const resolvedDmgPath = (0, extract_1.resolveDmgPath)(options.dmgPath, REPO_ROOT);
    const workDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work"));
    const distDir = path.resolve(options.distDir || path.join(REPO_ROOT, "dist"));
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    const ripgrep = await (0, env_1.ensureRipgrepInPath)(workDir, options.persistRipgrepPath);
    if (ripgrep.path)
        (0, exec_1.writeSuccess)(`Using rg: ${ripgrep.path} (source=${ripgrep.source})`);
    else
        (0, exec_1.writeWarn)("rg (ripgrep) is still unavailable.");
    let effectiveProfile = (0, args_1.normalizeProfileName)(options.profileName);
    if (options.devProfile && effectiveProfile === "default")
        effectiveProfile = "dev";
    const isDefaultProfile = effectiveProfile === "default";
    process.env.CODEX_WINDOWS_PROFILE = effectiveProfile;
    const manifestFileName = isDefaultProfile ? "state.manifest.json" : `state.manifest.${effectiveProfile}.json`;
    const manifestPath = path.join(workDir, manifestFileName);
    const manifest = (0, manifest_1.readStateManifest)(manifestPath);
    const previousDmgSha = manifest.dmg?.sha256 || null;
    const dmgDescriptor = (0, manifest_1.getFileDescriptorWithCache)(resolvedDmgPath, manifest.dmg);
    const allowFallbackReuse = Boolean(previousDmgSha && previousDmgSha === dmgDescriptor.sha256);
    manifest.dmg = dmgDescriptor;
    (0, manifest_1.writeStateManifest)(manifestPath, manifest);
    const extractSignature = (0, manifest_1.getStepSignature)({ dmgSha256: dmgDescriptor.sha256 });
    const extractResult = (0, extract_1.invokeExtractionStage)(resolvedDmgPath, workDir, options.reuse, allowFallbackReuse, manifest, manifestPath, extractSignature);
    const appDir = extractResult.appDir;
    const nativeDir = path.join(workDir, "native-builds");
    const userDataDir = path.join(workDir, isDefaultProfile ? "userdata" : `userdata-${effectiveProfile}`);
    const cacheDir = path.join(workDir, isDefaultProfile ? "cache" : `cache-${effectiveProfile}`);
    const diagDir = path.join(workDir, "diagnostics", effectiveProfile);
    const gitCapabilityCachePath = (0, git_capability_cache_1.ensureGitCapabilityCachePath)(workDir, effectiveProfile);
    (0, exec_1.writeHeader)("Reading app metadata");
    const pkgPath = path.join(appDir, "package.json");
    if (!fs.existsSync(pkgPath))
        throw new Error("package.json not found.");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const electronVersion = pkg.devDependencies?.electron || "";
    const betterVersion = pkg.dependencies?.["better-sqlite3"] || "";
    const ptyVersion = pkg.dependencies?.["node-pty"] || "";
    if (!electronVersion)
        throw new Error("Electron version not found.");
    const buildNumber = pkg.codexBuildNumber || "510";
    const buildFlavor = pkg.codexBuildFlavor || "prod";
    const appVersion = pkg.version || buildNumber;
    const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";
    const patchReport = (0, patch_pipeline_1.runCodexPatchPipeline)({
        appDir,
        diagnosticsDir: diagDir,
        buildNumber,
        buildFlavor,
        appVersion,
        snapshotLabel: path.basename(resolvedDmgPath),
        forcedProfileId: options.patchProfile,
    });
    (0, exec_1.writeSuccess)(`Patch pipeline report: ${patchReport.reportPath}`);
    const nativeSignature = (0, manifest_1.getStepSignature)({
        dmgSha256: dmgDescriptor.sha256,
        electron: electronVersion,
        betterSqlite3: betterVersion,
        nodePty: ptyVersion,
        arch,
    });
    (0, exec_1.writeHeader)("Preparing native modules");
    const nativeResult = (0, native_1.invokeNativeStage)(appDir, nativeDir, electronVersion, betterVersion, ptyVersion, arch, manifest, manifestPath, nativeSignature);
    const electronExe = nativeResult.electronExe;
    (0, exec_1.writeHeader)("Environment contract checks");
    (0, env_1.assertEnvironmentContract)(options.strictContract);
    const preferredCodexCliPath = resolvePreferredCodexCliPath(options.codexCliPath, distDir);
    const cliTracePath = path.join(diagDir, "cli-resolution.log");
    if (options.buildPortable) {
        (0, exec_1.writeHeader)("Resolving Codex CLI");
        const cliResolution = resolveAndProbeCodexCli(preferredCodexCliPath, false, cliTracePath, "Codex CLI preflight failed for portable packaging", "codex.exe not found; portable build will rely on runtime PATH detection.");
        (0, exec_1.writeHeader)("Packaging portable app");
        const portable = await (0, portable_1.invokePortableBuild)(distDir, nativeDir, appDir, buildNumber, buildFlavor, cliResolution.path, effectiveProfile, workDir, appVersion);
        (0, exec_1.writeSuccess)(`Portable build ready: ${portable.outputDir}`);
        (0, exec_1.writeSuccess)(`Launcher: ${portable.launcherPath}`);
        (0, exec_1.writeSuccess)(`CLI trace: ${cliTracePath}`);
        let singleExePath = "";
        if (options.buildSingleExe) {
            (0, exec_1.writeHeader)("Packaging single EXE (SFX)");
            const single = await (0, sfx_1.invokeSingleExeBuild)(portable.outputDir, distDir, workDir, appVersion);
            singleExePath = single.outputExe;
            (0, exec_1.writeSuccess)(`Single-file EXE ready: ${singleExePath}`);
        }
        if (!options.noLaunch) {
            const portableUserDataDir = path.join(portable.outputDir, effectiveProfile === "default" ? "userdata" : `userdata-${effectiveProfile}`);
            reportWorkspaceSanitizer((0, workspace_registry_1.sanitizeWorkspaceRegistry)(portableUserDataDir, diagDir));
            let status = 0;
            if (singleExePath) {
                (0, exec_1.writeHeader)("Launching single EXE");
                status = (0, exec_1.runCommand)(singleExePath, [], {
                    cwd: distDir,
                    allowNonZero: true,
                    capture: false,
                }).status;
            }
            else {
                (0, exec_1.writeHeader)("Launching portable build");
                status = (0, portable_1.startPortableDirectLaunch)(portable.outputDir, effectiveProfile);
            }
            if (status !== 0)
                return status;
        }
        return 0;
    }
    if (!options.noLaunch) {
        (0, exec_1.writeHeader)("Resolving Codex CLI");
        const cliResolution = resolveAndProbeCodexCli(preferredCodexCliPath, true, cliTracePath, "Codex CLI preflight failed");
        (0, launch_1.ensureGitOnPath)();
        const directLaunchExe = await (0, branding_1.prepareDirectLaunchExecutable)(electronExe, appVersion, workDir);
        reportWorkspaceSanitizer((0, workspace_registry_1.sanitizeWorkspaceRegistry)(userDataDir, diagDir));
        (0, exec_1.writeHeader)("Electron child-process environment check");
        (0, env_1.invokeElectronChildEnvironmentContract)(directLaunchExe, appDir, options.strictContract);
        (0, exec_1.writeHeader)("Launching Codex");
        (0, launch_1.startCodexDirectLaunch)(directLaunchExe, appDir, userDataDir, cacheDir, cliResolution.path, buildNumber, buildFlavor, gitCapabilityCachePath);
    }
    else {
        const cliResolution = (0, cli_1.resolveCodexCliPathContract)(preferredCodexCliPath, false);
        (0, cli_1.writeCliResolutionTrace)(cliResolution, cliTracePath);
    }
    return 0;
}
async function main() {
    const parsed = (0, args_1.parseArgs)(process.argv.slice(2));
    if (parsed.showHelp) {
        (0, args_1.printUsage)();
        return 0;
    }
    return runPipeline(parsed.options);
}
main()
    .then((code) => process.exit(code))
    .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
