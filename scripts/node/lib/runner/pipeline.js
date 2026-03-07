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
exports.runPipelineDetailed = runPipelineDetailed;
exports.runPipeline = runPipeline;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const git_capability_cache_1 = require("../adapters/git-capability-cache");
const workspace_registry_1 = require("../adapters/workspace-registry");
const branding_1 = require("../branding");
const env_1 = require("../env");
const exec_1 = require("../exec");
const manifest_1 = require("../manifest");
const patch_pipeline_1 = require("../platform-patches/patch-pipeline");
const direct_launch_1 = require("../runtime-pack/direct-launch");
const portable_1 = require("../runtime-pack/portable");
const sfx_1 = require("../runtime-pack/sfx");
const native_1 = require("../runtime-donor/native");
const extract_1 = require("../source-bundle/extract");
const cli_resolution_1 = require("./cli-resolution");
const artifact_cleanup_1 = require("./artifact-cleanup");
const context_1 = require("./context");
const metadata_1 = require("./metadata");
function reportWorkspaceSanitizer(result) {
    if (result.updatedFiles > 0 || result.removedEntries > 0) {
        (0, exec_1.writeSuccess)(`Workspace sanitizer: updatedFiles=${result.updatedFiles}, removedEntries=${result.removedEntries}`);
    }
}
async function runPipelineDetailed(options) {
    (0, context_1.sanitizeRunnerEnvironment)();
    (0, context_1.sanitizeNpmBuildEnvironment)();
    (0, env_1.ensureWindowsEnvironment)();
    (0, exec_1.mustResolveCommand)("node.exe");
    const resolvedDmgPath = (0, extract_1.resolveDmgPath)(options.dmgPath, context_1.REPO_ROOT);
    const workDir = path.resolve(options.workDir || path.join(context_1.REPO_ROOT, "work"));
    const distDir = path.resolve(options.distDir || path.join(context_1.REPO_ROOT, "dist"));
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    (0, artifact_cleanup_1.cleanupRunnerArtifacts)(context_1.REPO_ROOT, workDir, distDir);
    const ripgrep = await (0, env_1.ensureRipgrepInPath)(workDir);
    (0, exec_1.writeSuccess)(`Using rg: ${ripgrep.path} (source=${ripgrep.source})`);
    const effectiveProfile = options.devProfile && options.profileName === "default" ? "dev" : options.profileName;
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
    const preferredCodexCliPath = (0, context_1.resolvePreferredCodexCliPath)(options.codexCliPath);
    const cliTracePath = path.join(diagDir, "cli-resolution.log");
    if (options.buildPortable) {
        (0, exec_1.writeHeader)("Resolving Codex CLI");
        const cliResolution = (0, cli_resolution_1.resolveAndProbeCodexCli)(preferredCodexCliPath, true, cliTracePath, "Codex CLI preflight failed for portable packaging");
        (0, exec_1.writeHeader)("Packaging portable app");
        const portable = await (0, portable_1.invokePortableBuild)(distDir, nativeDir, appDir, buildNumber, buildFlavor, cliResolution.path, effectiveProfile, workDir, appVersion);
        const buildMetadataPath = (0, metadata_1.writeBuildMetadata)(portable.outputDir, {
            dmgPath: resolvedDmgPath,
            appVersion,
            buildNumber,
            buildFlavor,
            profileName: effectiveProfile,
            patchProfileId: patchReport.profileId,
            patchReportPath: patchReport.reportPath,
            cliPath: cliResolution.path,
            cliSource: cliResolution.source,
        });
        (0, exec_1.writeSuccess)(`Portable build ready: ${portable.outputDir}`);
        (0, exec_1.writeSuccess)(`Launcher: ${portable.launcherPath}`);
        (0, exec_1.writeSuccess)(`CLI trace: ${cliTracePath}`);
        (0, exec_1.writeSuccess)(`Build metadata: ${buildMetadataPath}`);
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
            if (status !== 0) {
                return {
                    exitCode: status,
                    portableOutputDir: portable.outputDir,
                    launcherPath: portable.launcherPath,
                    buildMetadataPath,
                    cliTracePath,
                };
            }
        }
        return {
            exitCode: 0,
            portableOutputDir: portable.outputDir,
            launcherPath: portable.launcherPath,
            buildMetadataPath,
            cliTracePath,
        };
    }
    if (!options.noLaunch) {
        (0, exec_1.writeHeader)("Resolving Codex CLI");
        const cliResolution = (0, cli_resolution_1.resolveAndProbeCodexCli)(preferredCodexCliPath, true, cliTracePath, "Codex CLI preflight failed");
        (0, direct_launch_1.ensureGitOnPath)();
        const directLaunchExe = await (0, branding_1.prepareDirectLaunchExecutable)(electronExe, appVersion, workDir);
        reportWorkspaceSanitizer((0, workspace_registry_1.sanitizeWorkspaceRegistry)(userDataDir, diagDir));
        (0, exec_1.writeHeader)("Electron child-process environment check");
        (0, env_1.invokeElectronChildEnvironmentContract)(directLaunchExe, appDir, options.strictContract);
        (0, exec_1.writeHeader)("Launching Codex");
        (0, direct_launch_1.startCodexDirectLaunch)(directLaunchExe, appDir, userDataDir, cacheDir, cliResolution.path, buildNumber, buildFlavor, gitCapabilityCachePath);
    }
    else {
        const cliResolution = (0, cli_resolution_1.resolveAndProbeCodexCli)(preferredCodexCliPath, false, cliTracePath, "Codex CLI trace failed");
        if (cliResolution.found) {
            (0, exec_1.writeSuccess)(`CLI trace recorded: ${cliTracePath}`);
        }
    }
    return {
        exitCode: 0,
        portableOutputDir: "",
        launcherPath: "",
        buildMetadataPath: "",
        cliTracePath,
    };
}
async function runPipeline(options) {
    const result = await runPipelineDetailed(options);
    return result.exitCode;
}
