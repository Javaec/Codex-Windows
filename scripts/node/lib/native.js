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
exports.invokeNativeStage = invokeNativeStage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const manifest_1 = require("./manifest");
const npm_1 = require("./npm");
function resolveValidationRuntime(electronExe, allowNodeFallback) {
    if (electronExe && (0, exec_1.fileExists)(electronExe))
        return { exe: electronExe, mode: "electron" };
    if (allowNodeFallback) {
        const node = require("./exec").resolveCommand("node.exe") ?? require("./exec").resolveCommand("node");
        if (node)
            return { exe: node, mode: "node" };
    }
    return null;
}
function runValidationScript(electronExe, workingDir, script, label, allowNodeFallback = false) {
    const runtime = resolveValidationRuntime(electronExe, allowNodeFallback);
    if (!runtime) {
        (0, exec_1.writeWarn)(`${label}: runtime not available for validation.`);
        return false;
    }
    if (!(0, exec_1.fileExists)(workingDir)) {
        (0, exec_1.writeWarn)(`${label}: working dir not found at ${workingDir}`);
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
        (0, exec_1.writeWarn)(`${label} failed (exit code ${result.status}).`);
        return false;
    }
    return true;
}
function testElectronRequire(electronExe, workingDir, requireTarget, label) {
    const script = `try{require('${requireTarget}');process.exit(0)}catch(e){console.error(e&&e.stack?e.stack:e);process.exit(1)}`;
    return runValidationScript(electronExe, workingDir, script, label);
}
function testBetterSqlite3Usable(electronExe, workingDir, label) {
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
    return runValidationScript(electronExe, workingDir, script, label);
}
function copyNativeFile(sourcePath, destinationPath, label) {
    (0, exec_1.ensureDir)(path.dirname(destinationPath));
    try {
        fs.copyFileSync(sourcePath, destinationPath);
    }
    catch (error) {
        if ((0, exec_1.fileExists)(destinationPath)) {
            throw new Error(`${label} is locked by another process at ${destinationPath}. Close running Codex and rerun.`);
        }
        throw error;
    }
}
function copyNativeArtifactsFromAppLayout(sourceAppDir, appDir, nativeDir, arch) {
    const bsSrc = path.join(sourceAppDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    if (!(0, exec_1.fileExists)(bsSrc))
        return false;
    let ptySrcDir = path.join(sourceAppDir, "node_modules", "node-pty", "prebuilds", arch);
    if (!(0, exec_1.fileExists)(path.join(ptySrcDir, "pty.node"))) {
        ptySrcDir = path.join(sourceAppDir, "node_modules", "node-pty", "build", "Release");
    }
    if (!(0, exec_1.fileExists)(path.join(ptySrcDir, "pty.node")))
        return false;
    copyNativeFile(bsSrc, path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "better-sqlite3 app artifact");
    copyNativeFile(bsSrc, path.join(nativeDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "better-sqlite3 native cache artifact");
    for (const fileName of ["pty.node", "conpty.node", "conpty_console_list.node"]) {
        const src = path.join(ptySrcDir, fileName);
        if (!(0, exec_1.fileExists)(src))
            continue;
        copyNativeFile(src, path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, fileName), "node-pty app prebuild artifact");
        copyNativeFile(src, path.join(appDir, "node_modules", "node-pty", "build", "Release", fileName), "node-pty app release artifact");
        copyNativeFile(src, path.join(nativeDir, "node_modules", "node-pty", "prebuilds", arch, fileName), "node-pty native cache artifact");
    }
    return true;
}
function getNativeDonorAppDirs(workDir) {
    const candidates = [];
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "resources", "app"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI Codex", "resources", "app"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "codex", "resources", "app"));
    }
    const repoRoot = path.dirname(workDir);
    const distRoot = path.join(repoRoot, "dist");
    if ((0, exec_1.fileExists)(distRoot)) {
        for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            candidates.push(path.join(distRoot, entry.name, "resources", "app"));
        }
    }
    return (0, exec_1.uniqueExistingDirs)(candidates);
}
function getNativeSeedAppDirs(workDir, arch) {
    const repoRoot = path.dirname(workDir);
    return (0, exec_1.uniqueExistingDirs)([
        path.join(repoRoot, "scripts", "native-seeds", arch, "app"),
        path.join(repoRoot, "native-seeds", arch, "app"),
    ]);
}
function ensureElectronRuntime(nativeDir, electronVersion, sourceAppDirs) {
    const electronExe = path.join(nativeDir, "node_modules", "electron", "dist", "electron.exe");
    if ((0, exec_1.fileExists)(electronExe))
        return electronExe;
    for (const sourceAppDir of sourceAppDirs) {
        const srcDist = path.join(sourceAppDir, "node_modules", "electron", "dist");
        if (!(0, exec_1.fileExists)(path.join(srcDist, "electron.exe")))
            continue;
        (0, exec_1.runRobocopy)(srcDist, path.join(nativeDir, "node_modules", "electron", "dist"));
        if ((0, exec_1.fileExists)(electronExe)) {
            (0, exec_1.writeSuccess)(`Using Electron runtime from donor: ${sourceAppDir}`);
            return electronExe;
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
    return electronExe;
}
function tryRecoverNativeFromCandidateDirs(candidateDirs, candidateKind, appDir, nativeDir, arch, electronExe) {
    for (const candidate of candidateDirs) {
        const copied = copyNativeArtifactsFromAppLayout(candidate, appDir, nativeDir, arch);
        if (!copied)
            continue;
        (0, exec_1.writeWarn)(`Trying native ${candidateKind} artifacts from: ${candidate}`);
        const betterOk = testBetterSqlite3Usable(electronExe, appDir, `App better-sqlite3 ${candidateKind} validation`);
        const ptyOk = testElectronRequire(electronExe, appDir, "./node_modules/node-pty", `App node-pty ${candidateKind} validation`);
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
    const donorDirs = getNativeDonorAppDirs(workDir);
    const seedDirs = getNativeSeedAppDirs(workDir, arch);
    const electronExe = ensureElectronRuntime(nativeDir, electronVersion, (0, exec_1.uniqueExistingDirs)([...donorDirs, ...seedDirs]));
    const bsApp = path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    const ptyAppPre = path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, "pty.node");
    const ptyAppRel = path.join(appDir, "node_modules", "node-pty", "build", "Release", "pty.node");
    const appArtifactsPresent = (0, exec_1.fileExists)(bsApp) && ((0, exec_1.fileExists)(ptyAppPre) || (0, exec_1.fileExists)(ptyAppRel));
    let appReady = false;
    if (appArtifactsPresent) {
        const appBetterOk = testBetterSqlite3Usable(electronExe, appDir, "App better-sqlite3 usability test (cache)");
        const appPtyOk = testElectronRequire(electronExe, appDir, "./node_modules/node-pty", "App node-pty smoke test (cache)");
        if (appBetterOk && appPtyOk) {
            (0, exec_1.writeSuccess)("Native cache hit: reusing validated app binaries.");
            appReady = true;
        }
    }
    if (!appReady) {
        const recoveredDonor = tryRecoverNativeFromCandidateDirs(donorDirs, "donor", appDir, nativeDir, arch, electronExe);
        appReady = recoveredDonor || tryRecoverNativeFromCandidateDirs(seedDirs, "bundled seed", appDir, nativeDir, arch, electronExe);
    }
    if (!appReady) {
        if (allowNativeRebuild) {
            throw new Error(`No usable native artifacts found. Rebuild path is explicitly enabled, but this script no longer performs node-gyp builds. Provide prebuilt artifacts in scripts/native-seeds/${arch}/app or donor install.`);
        }
        throw new Error("No usable native artifacts found for better-sqlite3/node-pty, and native rebuild is disabled by policy. Use a donor installation or provide bundled seeds under scripts/native-seeds/<arch>/app.");
    }
    if (!testBetterSqlite3Usable(electronExe, appDir, "App better-sqlite3 usability validation")) {
        throw new Error("better-sqlite3 failed final validation in app directory.");
    }
    if (!testElectronRequire(electronExe, appDir, "./node_modules/node-pty", "App node-pty validation")) {
        throw new Error("node-pty failed final validation in app directory.");
    }
    (0, manifest_1.setManifestStepState)(manifest, "native", nativeSignature, "ok", {
        electronVersion,
        betterSqlite3: betterVersion,
        nodePty: ptyVersion,
        arch,
        rebuildEnabled: allowNativeRebuild,
    });
    (0, manifest_1.writeStateManifest)(manifestPath, manifest);
    return { electronExe, performed: true };
}
