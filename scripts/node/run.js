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
const cli_1 = require("./lib/cli");
const env_1 = require("./lib/env");
const exec_1 = require("./lib/exec");
const extract_1 = require("./lib/extract");
const manifest_1 = require("./lib/manifest");
const launch_1 = require("./lib/launch");
const native_1 = require("./lib/native");
const portable_1 = require("./lib/portable");
const sfx_1 = require("./lib/sfx");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
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
    const repoRoot = REPO_ROOT;
    const resolvedDmgPath = (0, extract_1.resolveDmgPath)(options.dmgPath, repoRoot);
    const workDir = path.resolve(options.workDir || path.join(repoRoot, "work"));
    const distDir = path.resolve(options.distDir || path.join(repoRoot, "dist"));
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
    (0, exec_1.writeHeader)("Patching preload");
    (0, launch_1.patchPreload)(appDir);
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
    const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";
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
    (0, launch_1.patchMainForWindowsEnvironment)(appDir, buildNumber, buildFlavor);
    (0, exec_1.writeHeader)("Environment contract checks");
    (0, env_1.assertEnvironmentContract)(options.strictContract);
    const diagDir = path.join(workDir, "diagnostics", effectiveProfile);
    const cliTracePath = path.join(diagDir, "cli-resolution.log");
    if (options.buildPortable) {
        (0, exec_1.writeHeader)("Resolving Codex CLI");
        const cliResolution = (0, cli_1.resolveCodexCliPathContract)(options.codexCliPath, false);
        (0, cli_1.writeCliResolutionTrace)(cliResolution, cliTracePath);
        if (cliResolution.found) {
            (0, exec_1.writeSuccess)(`Using Codex CLI: ${cliResolution.path} (source=${cliResolution.source})`);
        }
        else {
            (0, exec_1.writeWarn)("codex.exe not found; portable build will rely on runtime PATH detection.");
        }
        (0, exec_1.writeHeader)("Packaging portable app");
        const portable = (0, portable_1.invokePortableBuild)(distDir, nativeDir, appDir, buildNumber, buildFlavor, cliResolution.path, effectiveProfile);
        (0, exec_1.writeSuccess)(`Portable build ready: ${portable.outputDir}`);
        (0, exec_1.writeSuccess)(`Launcher: ${portable.launcherPath}`);
        (0, exec_1.writeSuccess)(`CLI trace: ${cliTracePath}`);
        let singleExePath = null;
        if (options.buildSingleExe) {
            (0, exec_1.writeHeader)("Packaging single EXE (SFX)");
            const single = (0, sfx_1.invokeSingleExeBuild)(portable.outputDir, distDir, workDir);
            singleExePath = single.outputExe;
            (0, exec_1.writeSuccess)(`Single-file EXE ready: ${singleExePath}`);
        }
        if (!options.noLaunch) {
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
                const cmdPath = (0, env_1.resolveCmdPath)();
                if (!cmdPath)
                    throw new Error("cmd.exe not found for portable launch.");
                status = (0, exec_1.runCommand)(cmdPath, ["/d", "/s", "/c", `"${portable.launcherPath}"`], {
                    cwd: portable.outputDir,
                    allowNonZero: true,
                    capture: false,
                }).status;
            }
            if (status !== 0)
                return status;
        }
        return 0;
    }
    if (!options.noLaunch) {
        (0, exec_1.writeHeader)("Resolving Codex CLI");
        const cliResolution = (0, cli_1.resolveCodexCliPathContract)(options.codexCliPath, true);
        (0, cli_1.writeCliResolutionTrace)(cliResolution, cliTracePath);
        (0, exec_1.writeSuccess)(`Using Codex CLI: ${cliResolution.path} (source=${cliResolution.source})`);
        (0, launch_1.ensureGitOnPath)();
        (0, exec_1.writeHeader)("Electron child-process environment check");
        (0, env_1.invokeElectronChildEnvironmentContract)(electronExe, appDir, options.strictContract);
        (0, exec_1.writeHeader)("Launching Codex");
        (0, launch_1.startCodexDirectLaunch)(electronExe, appDir, userDataDir, cacheDir, cliResolution.path, buildNumber, buildFlavor);
    }
    else {
        const cliResolution = (0, cli_1.resolveCodexCliPathContract)(options.codexCliPath, false);
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
