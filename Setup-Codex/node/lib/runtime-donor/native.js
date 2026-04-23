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
exports.inspectNativeSupport = inspectNativeSupport;
exports.inspectRuntimePreflight = inspectRuntimePreflight;
exports.ensureElectronDistCacheForPackaging = ensureElectronDistCacheForPackaging;
exports.invokeNativeStage = invokeNativeStage;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const manifest_1 = require("../manifest");
const npm_1 = require("../npm");
const windows_apps_1 = require("./windows-apps");
const PACKAGED_RUNTIME_DIR_NAME = "packaged-runtime";
const PACKAGED_RUNTIME_TMP_DIR_NAME = "packaged-runtime.tmp";
const RUNTIME_DESCRIPTOR_FILE_NAME = "runtime-descriptor.json";
const RUNTIME_VALIDATION_MODE = "electron-run-as-node";
const SETUP_CODEX_ROOT = path.resolve(__dirname, "..", "..", "..");
function getFileSha256(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}
function createRuntimeDescriptor(sourceKind, executablePath, electronVersion, sourceLabel, fingerprint = getFileSha256(executablePath)) {
    const resolvedExecutablePath = path.resolve(executablePath);
    return {
        sourceKind,
        executablePath: resolvedExecutablePath,
        runtimeRoot: path.dirname(resolvedExecutablePath),
        electronVersion,
        sourceLabel,
        fingerprint,
        validationMode: RUNTIME_VALIDATION_MODE,
    };
}
function readRuntimeDescriptor(descriptorPath) {
    if (!(0, exec_1.fileExists)(descriptorPath))
        return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
        if (typeof parsed.sourceKind !== "string" ||
            typeof parsed.executablePath !== "string" ||
            typeof parsed.runtimeRoot !== "string" ||
            typeof parsed.electronVersion !== "string" ||
            typeof parsed.sourceLabel !== "string" ||
            typeof parsed.fingerprint !== "string" ||
            parsed.validationMode !== RUNTIME_VALIDATION_MODE) {
            return null;
        }
        return {
            sourceKind: parsed.sourceKind,
            executablePath: path.resolve(parsed.executablePath),
            runtimeRoot: path.resolve(parsed.runtimeRoot),
            electronVersion: parsed.electronVersion,
            sourceLabel: parsed.sourceLabel,
            fingerprint: parsed.fingerprint,
            validationMode: RUNTIME_VALIDATION_MODE,
        };
    }
    catch {
        return null;
    }
}
function writeRuntimeDescriptor(runtimeRoot, descriptor) {
    (0, exec_1.ensureDir)(runtimeRoot);
    fs.writeFileSync(path.join(runtimeRoot, RUNTIME_DESCRIPTOR_FILE_NAME), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
}
function resolveValidationRuntime(electronExe, allowNodeFallback) {
    if (electronExe && (0, exec_1.fileExists)(electronExe))
        return { exe: electronExe, mode: "electron" };
    if (allowNodeFallback) {
        const node = require("../exec").resolveCommand("node.exe") ?? require("../exec").resolveCommand("node");
        if (node)
            return { exe: node, mode: "node" };
    }
    return null;
}
function runValidationScript(electronExe, workingDir, script, label, allowNodeFallback = false, failureSeverity = "warn") {
    const logFailure = failureSeverity === "warn" ? exec_1.writeWarn : exec_1.writeInfo;
    const formatFailure = (message) => failureSeverity === "warn" ? message : message.replace(" failed ", " did not validate ");
    const runtime = resolveValidationRuntime(electronExe, allowNodeFallback);
    if (!runtime) {
        logFailure(`${label}: runtime not available for validation.`);
        return false;
    }
    if (!(0, exec_1.fileExists)(workingDir)) {
        logFailure(`${label}: working dir not found at ${workingDir}`);
        return false;
    }
    const env = { ...process.env };
    if (runtime.mode === "electron")
        env.ELECTRON_RUN_AS_NODE = "1";
    const result = (0, exec_1.runCommand)(runtime.exe, ["-e", script], {
        cwd: workingDir,
        env,
        allowNonZero: true,
        capture: true,
    });
    if (result.status !== 0) {
        logFailure(formatFailure(`${label} failed (exit code ${result.status}).`));
        return false;
    }
    return true;
}
function testElectronRequire(electronExe, workingDir, requireTarget, label, failureSeverity = "warn") {
    const script = `try{require('${requireTarget}');process.exit(0)}catch(e){console.error(e&&e.stack?e.stack:e);process.exit(1)}`;
    return runValidationScript(electronExe, workingDir, script, label, false, failureSeverity);
}
function testBetterSqlite3Usable(electronExe, workingDir, label, failureSeverity = "warn") {
    const script = String.raw `
try {
  const Database = require('./node_modules/better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('select 1 as ok').get();
  db.close();
  process.exit(0);
} catch (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
`;
    return runValidationScript(electronExe, workingDir, script, label, false, failureSeverity);
}
function copyNativeFile(sourcePath, destinationPath, label) {
    try {
        (0, exec_1.copyFileSafe)(sourcePath, destinationPath);
    }
    catch (error) {
        if ((0, exec_1.fileExists)(destinationPath)) {
            throw new Error(`${label} is locked by another process at ${destinationPath}. Close running Codex and rerun.`);
        }
        throw error;
    }
}
function readPeMachineType(filePath) {
    const fd = fs.openSync(filePath, "r");
    try {
        const dosHeader = Buffer.allocUnsafe(64);
        const dosRead = fs.readSync(fd, dosHeader, 0, dosHeader.length, 0);
        if (dosRead < 64)
            return 0;
        if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a)
            return 0;
        const peOffset = dosHeader.readUInt32LE(0x3c);
        if (!Number.isFinite(peOffset) || peOffset < 0)
            return 0;
        const peHeader = Buffer.allocUnsafe(6);
        const peRead = fs.readSync(fd, peHeader, 0, peHeader.length, peOffset);
        if (peRead < 6)
            return 0;
        if (peHeader[0] !== 0x50 ||
            peHeader[1] !== 0x45 ||
            peHeader[2] !== 0x00 ||
            peHeader[3] !== 0x00) {
            return 0;
        }
        return peHeader.readUInt16LE(4);
    }
    finally {
        fs.closeSync(fd);
    }
}
function expectedPeMachineTypes(arch) {
    if (arch === "arm64" || arch === "win32-arm64")
        return [0xaa64];
    return [0x8664];
}
function isUsableWindowsNativeAddon(filePath, arch) {
    if (!(0, exec_1.fileExists)(filePath))
        return false;
    return expectedPeMachineTypes(arch).includes(readPeMachineType(filePath));
}
function getBetterSqlite3BinaryPath(appDir) {
    return path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
}
function getNodePtyPrebuildDir(appDir, arch) {
    return path.join(appDir, "node_modules", "node-pty", "prebuilds", arch);
}
function getNodePtyReleaseDir(appDir) {
    return path.join(appDir, "node_modules", "node-pty", "build", "Release");
}
function hasUsableNodePtyPrebuildArtifacts(prebuildDir, arch) {
    if (!isUsableWindowsNativeAddon(path.join(prebuildDir, "pty.node"), arch))
        return false;
    for (const addonName of ["conpty.node", "conpty_console_list.node"]) {
        if (!isUsableWindowsNativeAddon(path.join(prebuildDir, addonName), arch))
            return false;
    }
    for (const supportPath of [
        "winpty-agent.exe",
        "winpty.dll",
        path.join("conpty", "conpty.dll"),
        path.join("conpty", "OpenConsole.exe"),
    ]) {
        if (!(0, exec_1.fileExists)(path.join(prebuildDir, supportPath)))
            return false;
    }
    return true;
}
function hasUsableNodePtyReleaseArtifacts(releaseDir, arch) {
    return isUsableWindowsNativeAddon(path.join(releaseDir, "pty.node"), arch);
}
function hasUsableNodePtyArtifacts(appDir, arch) {
    return (hasUsableNodePtyPrebuildArtifacts(getNodePtyPrebuildDir(appDir, arch), arch) ||
        hasUsableNodePtyReleaseArtifacts(getNodePtyReleaseDir(appDir), arch));
}
function hasUsableAppNativeArtifacts(appDir, arch) {
    return isUsableWindowsNativeAddon(getBetterSqlite3BinaryPath(appDir), arch) && hasUsableNodePtyArtifacts(appDir, arch);
}
function copyNativeArtifactsFromAppLayout(sourceAppDir, appDir, nativeDir, arch) {
    const bsSrc = getBetterSqlite3BinaryPath(sourceAppDir);
    if (!(0, exec_1.fileExists)(bsSrc))
        return false;
    const ptyPrebuildDir = getNodePtyPrebuildDir(sourceAppDir, arch);
    const ptyReleaseDir = getNodePtyReleaseDir(sourceAppDir);
    const ptySrcDir = hasUsableNodePtyPrebuildArtifacts(ptyPrebuildDir, arch)
        ? ptyPrebuildDir
        : (hasUsableNodePtyReleaseArtifacts(ptyReleaseDir, arch) ? ptyReleaseDir : "");
    if (!ptySrcDir)
        return false;
    copyNativeFile(bsSrc, getBetterSqlite3BinaryPath(appDir), "better-sqlite3 app artifact");
    copyNativeFile(bsSrc, getBetterSqlite3BinaryPath(nativeDir), "better-sqlite3 native cache artifact");
    (0, exec_1.copyDirectory)(ptySrcDir, getNodePtyPrebuildDir(appDir, arch));
    (0, exec_1.copyDirectory)(ptySrcDir, getNodePtyPrebuildDir(nativeDir, arch));
    for (const fileName of ["pty.node", "conpty.node", "conpty_console_list.node"]) {
        const src = path.join(ptySrcDir, fileName);
        if (!(0, exec_1.fileExists)(src))
            continue;
        copyNativeFile(src, path.join(getNodePtyReleaseDir(appDir), fileName), "node-pty app release artifact");
    }
    return true;
}
function isRepoRootCandidate(dir) {
    return ((0, exec_1.fileExists)(path.join(dir, "package.json")) &&
        (0, exec_1.fileExists)(path.join(dir, "scripts")) &&
        (0, exec_1.fileExists)(path.join(dir, "shared")));
}
function getRepositoryRoots(workDir) {
    const candidates = [];
    const addCandidate = (dir) => {
        if (isRepoRootCandidate(dir))
            candidates.push(dir);
    };
    addCandidate(process.cwd());
    addCandidate(path.resolve(__dirname, "..", "..", ".."));
    let currentDir = workDir;
    while (true) {
        addCandidate(currentDir);
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            break;
        currentDir = parentDir;
    }
    return (0, exec_1.uniqueExistingDirs)(candidates);
}
function getNativeDonorAppDirs(workDir) {
    const candidates = [];
    candidates.push(...(0, windows_apps_1.getWindowsRuntimeDonorAppDirs)());
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "resources", "app"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI Codex", "resources", "app"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "codex", "resources", "app"));
    }
    for (const repoRoot of getRepositoryRoots(workDir)) {
        const distRoot = path.join(repoRoot, "dist");
        if (!(0, exec_1.fileExists)(distRoot))
            continue;
        for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            candidates.push(path.join(distRoot, entry.name, "resources", "app"));
        }
    }
    return (0, exec_1.uniqueExistingDirs)(candidates);
}
function getNativeSeedAppDirs(workDir, arch) {
    const candidates = [path.join(SETUP_CODEX_ROOT, "native-seeds", arch, "app")];
    for (const repoRoot of getRepositoryRoots(workDir)) {
        candidates.push(path.join(repoRoot, "Setup-Codex", "native-seeds", arch, "app"));
        candidates.push(path.join(repoRoot, "scripts", "native-seeds", arch, "app"));
        candidates.push(path.join(repoRoot, "native-seeds", arch, "app"));
    }
    return (0, exec_1.uniqueExistingDirs)(candidates);
}
function inspectNativeSupport(workDir, arch) {
    const donorAppDirs = (0, exec_1.uniqueExistingDirs)(getNativeDonorAppDirs(workDir));
    const seedAppDirs = (0, exec_1.uniqueExistingDirs)(getNativeSeedAppDirs(workDir, arch));
    return {
        donorAppDirs,
        usableDonorAppDirs: donorAppDirs.filter((candidate) => hasUsableAppNativeArtifacts(candidate, arch)),
        seedAppDirs,
        usableSeedAppDirs: seedAppDirs.filter((candidate) => hasUsableAppNativeArtifacts(candidate, arch)),
    };
}
function readElectronPackageVersion(electronRoot) {
    const packageJsonPath = path.join(electronRoot, "package.json");
    if (!(0, exec_1.fileExists)(packageJsonPath))
        return "";
    try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        return typeof pkg.version === "string" ? pkg.version.trim() : "";
    }
    catch {
        return "";
    }
}
function testElectronRuntimeExecutable(executablePath) {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const result = (0, exec_1.runCommand)(executablePath, ["-e", "process.exit(0)"], {
        env,
        allowNonZero: true,
        capture: true,
    });
    return result.status === 0;
}
function tryReusePackagedRuntimeCache(nativeDir, donorPackage, electronVersion, quiet = false) {
    const packagedRuntimeDir = path.join(nativeDir, PACKAGED_RUNTIME_DIR_NAME);
    const packagedRuntimeExe = path.join(packagedRuntimeDir, "Codex.exe");
    const descriptorPath = path.join(packagedRuntimeDir, RUNTIME_DESCRIPTOR_FILE_NAME);
    if (!(0, exec_1.fileExists)(packagedRuntimeExe))
        return null;
    const descriptor = readRuntimeDescriptor(descriptorPath);
    const actualFingerprint = getFileSha256(packagedRuntimeExe);
    const descriptorMatches = Boolean(descriptor &&
        descriptor.sourceLabel === donorPackage.packageFullName &&
        descriptor.electronVersion === electronVersion &&
        descriptor.fingerprint === actualFingerprint);
    if (!descriptorMatches) {
        if (!quiet) {
            (0, exec_1.writeInfo)(`Refreshing packaged Electron runtime cache: expected ${donorPackage.packageFullName} / ${electronVersion}, found ${descriptor?.sourceLabel || "unknown"} / ${descriptor?.electronVersion || "unknown"}.`);
        }
        return null;
    }
    return createRuntimeDescriptor("packaged-runtime-cache", packagedRuntimeExe, electronVersion, donorPackage.packageFullName, actualFingerprint);
}
function materializePackagedRuntimeCopy(nativeDir, donorPackage, electronVersion) {
    const donorRuntimeDir = donorPackage.appDir;
    const donorExe = path.join(donorRuntimeDir, "Codex.exe");
    if (!(0, exec_1.fileExists)(donorExe))
        return null;
    const packagedRuntimeDir = path.join(nativeDir, PACKAGED_RUNTIME_DIR_NAME);
    const packagedRuntimeTmpDir = path.join(nativeDir, PACKAGED_RUNTIME_TMP_DIR_NAME);
    const packagedRuntimeTmpExe = path.join(packagedRuntimeTmpDir, "Codex.exe");
    const packagedRuntimeExe = path.join(packagedRuntimeDir, "Codex.exe");
    (0, exec_1.removePath)(packagedRuntimeTmpDir);
    (0, exec_1.copyDirectory)(donorRuntimeDir, packagedRuntimeTmpDir);
    if (!(0, exec_1.fileExists)(packagedRuntimeTmpExe)) {
        (0, exec_1.removePath)(packagedRuntimeTmpDir);
        return null;
    }
    (0, exec_1.removePath)(packagedRuntimeDir);
    (0, exec_1.movePathSafe)(packagedRuntimeTmpDir, packagedRuntimeDir);
    const descriptor = createRuntimeDescriptor("windows-runtime-donor-copy", packagedRuntimeExe, electronVersion, donorPackage.packageFullName);
    writeRuntimeDescriptor(packagedRuntimeDir, descriptor);
    (0, exec_1.writeSuccess)(`Using packaged Electron runtime from donor copy: ${packagedRuntimeExe} (source=${donorExe})`);
    return descriptor;
}
function preparePackagedElectronRuntime(nativeDir, electronVersion) {
    const donorPackages = (0, windows_apps_1.listWindowsCodexPackages)().filter((runtimePackage) => (0, exec_1.fileExists)(path.join(runtimePackage.appDir, "Codex.exe")));
    if (donorPackages.length === 0)
        return null;
    const reusableCache = tryReusePackagedRuntimeCache(nativeDir, donorPackages[0], electronVersion);
    if (reusableCache) {
        (0, exec_1.writeSuccess)(`Using packaged Electron runtime cache: ${reusableCache.executablePath}`);
        return reusableCache;
    }
    for (const donorPackage of donorPackages) {
        const materialized = materializePackagedRuntimeCopy(nativeDir, donorPackage, electronVersion);
        if (materialized)
            return materialized;
    }
    return null;
}
function getReusableElectronDistCache(nativeDir, electronVersion) {
    const electronRoot = path.join(nativeDir, "node_modules", "electron");
    const electronExe = path.join(electronRoot, "dist", "electron.exe");
    const installedVersion = readElectronPackageVersion(electronRoot);
    if (!(0, exec_1.fileExists)(electronExe) || installedVersion !== electronVersion)
        return null;
    if (!testElectronRuntimeExecutable(electronExe))
        return null;
    return createRuntimeDescriptor("electron-dist-cache", electronExe, electronVersion, electronRoot);
}
function findFirstElectronDistSource(appDirs) {
    for (const appDir of appDirs) {
        const candidate = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
        if ((0, exec_1.fileExists)(candidate))
            return appDir;
    }
    return "";
}
function inspectRuntimePreflight(workDir, electronVersion, arch) {
    const nativeDir = path.join(workDir, "native-builds");
    const nativeSupport = inspectNativeSupport(workDir, arch);
    const donorDirs = nativeSupport.donorAppDirs;
    const seedDirs = nativeSupport.seedAppDirs;
    const donorPackages = (0, windows_apps_1.listWindowsCodexPackages)().filter((runtimePackage) => (0, exec_1.fileExists)(path.join(runtimePackage.appDir, "Codex.exe")));
    const packagedRuntimeCacheAvailable = (0, exec_1.fileExists)(path.join(nativeDir, PACKAGED_RUNTIME_DIR_NAME, "Codex.exe"));
    const packagedRuntimeCacheValid = donorPackages.length > 0 && Boolean(tryReusePackagedRuntimeCache(nativeDir, donorPackages[0], electronVersion, true));
    if (packagedRuntimeCacheValid) {
        return {
            selectedSourceKind: "packaged-runtime-cache",
            sourceLabel: donorPackages[0].packageFullName,
            packagedRuntimeCacheAvailable,
            packagedRuntimeCacheValid,
            fallbackRequired: false,
        };
    }
    if (donorPackages.length > 0) {
        return {
            selectedSourceKind: "windows-runtime-donor-copy",
            sourceLabel: donorPackages[0].packageFullName,
            packagedRuntimeCacheAvailable,
            packagedRuntimeCacheValid: false,
            fallbackRequired: false,
        };
    }
    const reusableElectronCache = getReusableElectronDistCache(nativeDir, electronVersion);
    if (reusableElectronCache) {
        return {
            selectedSourceKind: reusableElectronCache.sourceKind,
            sourceLabel: reusableElectronCache.sourceLabel,
            packagedRuntimeCacheAvailable,
            packagedRuntimeCacheValid: false,
            fallbackRequired: false,
        };
    }
    const donorElectronSource = findFirstElectronDistSource(donorDirs);
    if (donorElectronSource) {
        return {
            selectedSourceKind: "electron-dist-cache",
            sourceLabel: donorElectronSource,
            packagedRuntimeCacheAvailable,
            packagedRuntimeCacheValid: false,
            fallbackRequired: false,
        };
    }
    const seedElectronSource = findFirstElectronDistSource(seedDirs);
    if (seedElectronSource) {
        return {
            selectedSourceKind: "seed",
            sourceLabel: seedElectronSource,
            packagedRuntimeCacheAvailable,
            packagedRuntimeCacheValid: false,
            fallbackRequired: false,
        };
    }
    return {
        selectedSourceKind: "npm-fallback",
        sourceLabel: `electron@${electronVersion}`,
        packagedRuntimeCacheAvailable,
        packagedRuntimeCacheValid: false,
        fallbackRequired: true,
    };
}
function tryRepairElectronRuntimeInPlace(electronRoot, electronExe, electronVersion) {
    const nodeExe = (0, exec_1.resolveCommand)("node.exe") ?? (0, exec_1.resolveCommand)("node");
    if (!nodeExe) {
        (0, exec_1.writeInfo)(`Repairing incomplete cached Electron runtime skipped: Node.js is not available for ${electronVersion}.`);
        return false;
    }
    const result = (0, exec_1.runCommand)(nodeExe, ["install.js"], {
        cwd: electronRoot,
        allowNonZero: true,
        capture: true,
    });
    if (result.status === 0 && (0, exec_1.fileExists)(electronExe)) {
        (0, exec_1.writeSuccess)(`Repaired cached Electron runtime in place: ${electronVersion}`);
        return true;
    }
    (0, exec_1.writeInfo)(`In-place Electron runtime repair did not validate (exit code ${result.status}).`);
    return false;
}
function ensureElectronDistCache(nativeDir, electronVersion, donorAppDirs, seedAppDirs) {
    const electronRoot = path.join(nativeDir, "node_modules", "electron");
    const electronExe = path.join(electronRoot, "dist", "electron.exe");
    const installedVersion = readElectronPackageVersion(electronRoot);
    const hasElectronExe = (0, exec_1.fileExists)(electronExe);
    if (hasElectronExe && installedVersion === electronVersion && testElectronRuntimeExecutable(electronExe)) {
        return createRuntimeDescriptor("electron-dist-cache", electronExe, electronVersion, electronRoot);
    }
    const shouldReplaceCachedElectron = hasElectronExe || (installedVersion !== "" && installedVersion !== electronVersion);
    if (shouldReplaceCachedElectron) {
        (0, exec_1.writeInfo)(`Refreshing cached Electron runtime: expected ${electronVersion}, found ${installedVersion || "unknown"}.`);
        (0, exec_1.removePath)(electronRoot);
        (0, exec_1.removePath)(path.join(nativeDir, "node_modules", ".bin", "electron"));
        (0, exec_1.removePath)(path.join(nativeDir, "node_modules", ".bin", "electron.cmd"));
        (0, exec_1.removePath)(path.join(nativeDir, "node_modules", ".bin", "electron.ps1"));
    }
    else if (installedVersion === electronVersion) {
        (0, exec_1.writeInfo)(`Repairing incomplete cached Electron runtime: ${electronVersion} is present but electron.exe is missing.`);
        if (tryRepairElectronRuntimeInPlace(electronRoot, electronExe, electronVersion)) {
            return createRuntimeDescriptor("electron-dist-cache", electronExe, electronVersion, electronRoot);
        }
    }
    for (const runtimeCandidate of [
        { sourceKind: "electron-dist-cache", label: "donor", appDirs: donorAppDirs },
        { sourceKind: "seed", label: "bundled seed", appDirs: seedAppDirs },
    ]) {
        for (const sourceAppDir of runtimeCandidate.appDirs) {
            const srcElectronRoot = path.join(sourceAppDir, "node_modules", "electron");
            const srcDist = path.join(sourceAppDir, "node_modules", "electron", "dist");
            if (!(0, exec_1.fileExists)(path.join(srcDist, "electron.exe")))
                continue;
            (0, exec_1.copyDirectory)(srcDist, path.join(electronRoot, "dist"));
            const srcPackageJson = path.join(srcElectronRoot, "package.json");
            if ((0, exec_1.fileExists)(srcPackageJson)) {
                (0, exec_1.copyFileSafe)(srcPackageJson, path.join(electronRoot, "package.json"));
            }
            else {
                (0, exec_1.ensureDir)(electronRoot);
                fs.writeFileSync(path.join(electronRoot, "package.json"), `${JSON.stringify({ name: "electron", version: electronVersion }, null, 2)}\n`, "utf8");
            }
            if ((0, exec_1.fileExists)(electronExe) && testElectronRuntimeExecutable(electronExe)) {
                (0, exec_1.writeSuccess)(`Using Electron runtime from ${runtimeCandidate.label}: ${sourceAppDir}`);
                return createRuntimeDescriptor(runtimeCandidate.sourceKind, electronExe, electronVersion, sourceAppDir);
            }
        }
    }
    (0, exec_1.ensureDir)(nativeDir);
    if (!(0, exec_1.fileExists)(path.join(nativeDir, "package.json"))) {
        const npmInitExit = (0, npm_1.invokeNpm)(["init", "-y"], nativeDir);
        if (npmInitExit !== 0)
            throw new Error("npm init failed while preparing Electron runtime.");
    }
    const npmInstallExit = (0, npm_1.invokeNpm)(["install", "--no-save", `electron@${electronVersion}`], nativeDir);
    if (npmInstallExit !== 0)
        throw new Error(`npm install electron@${electronVersion} failed.`);
    if (!(0, exec_1.fileExists)(electronExe))
        throw new Error(`electron.exe not found after runtime preparation: ${electronExe}`);
    if (!testElectronRuntimeExecutable(electronExe)) {
        throw new Error(`Electron runtime did not validate after npm fallback: ${electronExe}`);
    }
    return createRuntimeDescriptor("npm-fallback", electronExe, electronVersion, `electron@${electronVersion}`);
}
function ensureElectronRuntime(nativeDir, electronVersion, donorAppDirs, seedAppDirs) {
    const packagedRuntime = preparePackagedElectronRuntime(nativeDir, electronVersion);
    if (packagedRuntime)
        return packagedRuntime;
    return ensureElectronDistCache(nativeDir, electronVersion, donorAppDirs, seedAppDirs);
}
function ensureElectronDistCacheForPackaging(nativeDir, electronVersion, arch) {
    const workDir = path.dirname(nativeDir);
    const donorDirs = (0, exec_1.uniqueExistingDirs)(getNativeDonorAppDirs(workDir));
    const seedDirs = (0, exec_1.uniqueExistingDirs)(getNativeSeedAppDirs(workDir, arch));
    return ensureElectronDistCache(nativeDir, electronVersion, donorDirs, seedDirs);
}
function shouldRunInteractiveNativeValidation(runtime) {
    return runtime.sourceKind !== "packaged-runtime-cache" && runtime.sourceKind !== "windows-runtime-donor-copy";
}
function tryRecoverNativeFromCandidateDirs(candidateDirs, candidateKind, appDir, nativeDir, arch, electronExe, validateWithRuntime) {
    for (const candidate of candidateDirs) {
        const copied = copyNativeArtifactsFromAppLayout(candidate, appDir, nativeDir, arch);
        if (!copied)
            continue;
        (0, exec_1.writeInfo)(`Trying native ${candidateKind} artifacts from: ${candidate}`);
        if (!validateWithRuntime) {
            (0, exec_1.writeSuccess)(`Recovered native modules from ${candidateKind} artifacts without packaged runtime smoke tests.`);
            return true;
        }
        const betterOk = testBetterSqlite3Usable(electronExe, appDir, `App better-sqlite3 ${candidateKind} validation`, "info");
        const ptyOk = testElectronRequire(electronExe, appDir, "./node_modules/node-pty", `App node-pty ${candidateKind} validation`, "info");
        if (betterOk && ptyOk) {
            (0, exec_1.writeSuccess)(`Recovered native modules from ${candidateKind} artifacts.`);
            return true;
        }
    }
    return false;
}
function invokeNativeStage(appDir, nativeDir, electronVersion, betterVersion, ptyVersion, arch, manifest, manifestPath, nativeSignature) {
    const workDir = path.dirname(nativeDir);
    const allowNativeRebuild = process.env.CODEX_ENABLE_NATIVE_REBUILD === "1";
    const nativeSupport = inspectNativeSupport(workDir, arch);
    const donorDirs = nativeSupport.donorAppDirs;
    const seedDirs = nativeSupport.seedAppDirs;
    const runtime = ensureElectronRuntime(nativeDir, electronVersion, (0, exec_1.uniqueExistingDirs)(donorDirs), (0, exec_1.uniqueExistingDirs)(seedDirs));
    const electronExe = runtime.executablePath;
    const shouldValidateNativeWithRuntime = shouldRunInteractiveNativeValidation(runtime);
    const bsApp = path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    const ptyAppPre = path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, "pty.node");
    const ptyAppRel = path.join(appDir, "node_modules", "node-pty", "build", "Release", "pty.node");
    const appArtifactsPresent = (0, exec_1.fileExists)(bsApp) && ((0, exec_1.fileExists)(ptyAppPre) || (0, exec_1.fileExists)(ptyAppRel));
    const appArtifactsUsable = hasUsableAppNativeArtifacts(appDir, arch);
    let appReady = false;
    if (appArtifactsPresent && appArtifactsUsable) {
        if (!shouldValidateNativeWithRuntime) {
            (0, exec_1.writeSuccess)("Native cache hit: reusing app binaries without packaged runtime smoke tests.");
            appReady = true;
        }
        else {
            const appBetterOk = testBetterSqlite3Usable(electronExe, appDir, "App better-sqlite3 usability test (cache)", "info");
            const appPtyOk = testElectronRequire(electronExe, appDir, "./node_modules/node-pty", "App node-pty smoke test (cache)", "info");
            if (appBetterOk && appPtyOk) {
                (0, exec_1.writeSuccess)("Native cache hit: reusing validated app binaries.");
                appReady = true;
            }
        }
    }
    else if (appArtifactsPresent && !appArtifactsUsable) {
        (0, exec_1.writeInfo)("Native app cache present but not usable on Windows; refreshing native binaries from donor artifacts.");
    }
    if (!appReady) {
        const recoveredDonor = tryRecoverNativeFromCandidateDirs(donorDirs, "donor", appDir, nativeDir, arch, electronExe, shouldValidateNativeWithRuntime);
        appReady = recoveredDonor || tryRecoverNativeFromCandidateDirs(seedDirs, "bundled seed", appDir, nativeDir, arch, electronExe, shouldValidateNativeWithRuntime);
    }
    if (!appReady) {
        const supportSummary = `donorSupport=${nativeSupport.usableDonorAppDirs.length}/${nativeSupport.donorAppDirs.length} ` +
            `seedSupport=${nativeSupport.usableSeedAppDirs.length}/${nativeSupport.seedAppDirs.length}`;
        if (allowNativeRebuild) {
            throw new Error(`No usable native artifacts found (${supportSummary}). Rebuild path is explicitly enabled, but this script no longer performs node-gyp builds. Provide prebuilt artifacts in Setup-Codex/native-seeds/${arch}/app (or legacy scripts/native-seeds/${arch}/app) or donor install.`);
        }
        throw new Error(`No usable native artifacts found for better-sqlite3/node-pty (${supportSummary}), and native rebuild is disabled by policy. Use a donor installation or provide bundled seeds under Setup-Codex/native-seeds/<arch>/app.`);
    }
    if (shouldValidateNativeWithRuntime) {
        if (!testBetterSqlite3Usable(electronExe, appDir, "App better-sqlite3 usability validation")) {
            throw new Error("better-sqlite3 failed final validation in app directory.");
        }
        if (!testElectronRequire(electronExe, appDir, "./node_modules/node-pty", "App node-pty validation")) {
            throw new Error("node-pty failed final validation in app directory.");
        }
    }
    else {
        (0, exec_1.writeInfo)("Skipping packaged runtime native validation to avoid interactive Codex launches.");
    }
    (0, manifest_1.setManifestStepState)(manifest, "native", nativeSignature, "ok", {
        electronVersion,
        betterSqlite3: betterVersion,
        nodePty: ptyVersion,
        arch,
        rebuildEnabled: allowNativeRebuild,
        nativeValidationMode: shouldValidateNativeWithRuntime ? "runtime-smoke" : "file-presence",
        runtime,
    });
    (0, manifest_1.writeStateManifest)(manifestPath, manifest);
    return { runtime, performed: true };
}
