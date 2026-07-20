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
exports.buildPortablePackage = buildPortablePackage;
exports.main = main;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const PORTABLE_FOLDER = "Codex-WorkLouder-Bypass";
const ARCHIVE_NAME = `${PORTABLE_FOLDER}.zip`;
const LAUNCHER_NAME = "Launch-Codex-WorkLouder-Bypass.cmd";
const PATCH_MANAGER_NAME = "Manage-Persistent-Patch.ps1";
function repositoryRoot() {
    return path.resolve(__dirname, "../..");
}
function escapePowerShellLiteral(value) {
    return value.replace(/'/g, "''");
}
function readSourceCommit(repoRoot) {
    const result = (0, node_child_process_1.spawnSync)("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "unknown";
}
function sha256(filePath) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex").toUpperCase();
}
function writePortableLauncher(filePath) {
    fs.writeFileSync(filePath, `@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "NODE_SCRIPT=%ROOT%worklouder-bypass.js"
set "PATCH_MANAGER=%ROOT%${PATCH_MANAGER_NAME}"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer was not found in PATH.
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required for the Inspector WebSocket client.
  exit /b 1
)

set "CODEX_WORKLOUDER_LOG_DIR=%ROOT%logs"
if not exist "%CODEX_WORKLOUDER_LOG_DIR%" mkdir "%CODEX_WORKLOUDER_LOG_DIR%" >nul 2>nul
if /I "%~1"=="--install-persistent" (
  echo [ERROR] Persistent install is disabled because it invalidates the signed AppX package.
  exit /b 2
)
if /I "%~1"=="--restore-persistent" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_MANAGER%" -Mode Restore -NodeScript "%NODE_SCRIPT%"
  exit /b !ERRORLEVEL!
)
if /I "%~1"=="--patch-status" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_MANAGER%" -Mode Status -NodeScript "%NODE_SCRIPT%"
  exit /b !ERRORLEVEL!
)

node "%NODE_SCRIPT%" %*
exit /b %ERRORLEVEL%
`, "ascii");
}
function writePersistentModeLauncher(filePath, mode) {
    fs.writeFileSync(filePath, `@echo off
setlocal
call "%~dp0${LAUNCHER_NAME}" ${mode}
exit /b %ERRORLEVEL%
`, "ascii");
}
function writePortableReadme(filePath) {
    fs.writeFileSync(filePath, `Codex Work Louder Bypass
=========================

This is an unofficial, reversible workaround for Windows Codex Desktop freezes
associated with the optional Work Louder / Codex Micro native integration.

Requirements
------------

- Windows 10 or Windows 11
- Node.js 22 or newer available as "node" in PATH
- OpenAI Codex installed from Microsoft Store

Usage
-----

1. Exit every ChatGPT.exe window.
2. Run Launch-Codex-WorkLouder-Bypass.cmd without arguments.
3. The launcher starts Codex with Work Louder disabled for that process.

Use Check-Persistent-Patch.cmd to inspect the current state and
Restore-Persistent-Patch.cmd to restore the original ASAR bytes.

The default and --launch-once modes are the same safe inspector launcher. Use
--dry-run to validate the installed package without launching Codex. Use
--diagnose for a read-only, path-free status report.

The launcher discovers the current OpenAI.Codex AppX install path automatically.
During the new process bootstrap it intercepts only the Work Louder integration,
its codex-micro-service entry, and its HID watcher native module. Device discovery
returns an empty list. It does not modify the signed package, credentials,
conversations, MCP configuration, or ChatGPT Classic.

Persistent install is disabled because modifying app.asar invalidates the signed
AppX block map. Restore-Persistent-Patch.cmd remains available only to recover a
package changed by an older launcher version.

Safety behavior
---------------

- The launcher refuses to attach to an already running ChatGPT.exe process.
- It fails closed if the expected Work Louder native package contract is absent.
- Inspector access is bound to 127.0.0.1 and closed immediately after bootstrap.
- Persistent restore refuses to run while ChatGPT.exe is active.
- Store package ACLs are restored after the elevated restore operation.
- Runtime logs are written to the logs folder next to this launcher.

This workaround disables Work Louder / Codex Micro. Do not use it if you need that
hardware integration. It is not an official OpenAI fix.
`, "ascii");
}
function createArchive(stagingDir, archivePath) {
    const source = escapePowerShellLiteral(path.join(stagingDir, "*"));
    const archive = escapePowerShellLiteral(archivePath);
    const script = `Compress-Archive -Path '${source}' -DestinationPath '${archive}' -CompressionLevel Optimal -Force`;
    const result = (0, node_child_process_1.spawnSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (result.error || result.status !== 0 || !fs.existsSync(archivePath)) {
        throw new Error("Unable to create the portable ZIP archive.");
    }
}
function buildPortablePackage() {
    const root = repositoryRoot();
    const outputDir = path.join(root, "work", "portable-output");
    const stagingDir = path.join(outputDir, PORTABLE_FOLDER);
    const archivePath = path.join(outputDir, ARCHIVE_NAME);
    const sourceLauncher = path.join(root, "Setup-Codex", "node", "lib", "worklouder-bypass.js");
    const sourcePersistentPatch = path.join(root, "Setup-Codex", "node", "lib", "worklouder-persistent-patch.js");
    const sourcePatchManager = path.join(root, "shared", "worklouder-persistent", "Manage-Persistent-Patch.ps1");
    if (!fs.existsSync(sourceLauncher) || !fs.existsSync(sourcePersistentPatch) || !fs.existsSync(sourcePatchManager)) {
        throw new Error("Compiled Work Louder launcher is missing. Run npm run build:runner first.");
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.copyFileSync(sourceLauncher, path.join(stagingDir, "worklouder-bypass.js"));
    fs.copyFileSync(sourcePersistentPatch, path.join(stagingDir, "worklouder-persistent-patch.js"));
    fs.copyFileSync(sourcePatchManager, path.join(stagingDir, PATCH_MANAGER_NAME));
    writePortableLauncher(path.join(stagingDir, LAUNCHER_NAME));
    writePersistentModeLauncher(path.join(stagingDir, "Restore-Persistent-Patch.cmd"), "--restore-persistent");
    writePersistentModeLauncher(path.join(stagingDir, "Check-Persistent-Patch.cmd"), "--patch-status");
    writePortableReadme(path.join(stagingDir, "README.md"));
    const metadata = {
        schemaVersion: 1,
        artifact: PORTABLE_FOLDER,
        sourceCommit: readSourceCommit(root),
        generatedAtIso: new Date().toISOString(),
        runtime: "Node.js >= 22",
        files: [
            LAUNCHER_NAME,
            "Restore-Persistent-Patch.cmd",
            "Check-Persistent-Patch.cmd",
            PATCH_MANAGER_NAME,
            "worklouder-bypass.js",
            "worklouder-persistent-patch.js",
            "README.md",
            "build-metadata.json",
        ],
    };
    fs.writeFileSync(path.join(stagingDir, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "ascii");
    const checksums = Object.fromEntries(metadata.files.map((fileName) => [fileName, sha256(path.join(stagingDir, fileName))]));
    fs.writeFileSync(path.join(stagingDir, "SHA256SUMS.txt"), `${Object.entries(checksums).map(([file, hash]) => `${hash} *${file}`).join("\n")}\n`, "ascii");
    createArchive(stagingDir, archivePath);
    return { stagingDir, archivePath };
}
function main() {
    const result = buildPortablePackage();
    process.stdout.write(`Portable staging: ${result.stagingDir}\nPortable archive: ${result.archivePath}\n`);
    return 0;
}
if (require.main === module) {
    try {
        process.exit(main());
    }
    catch (error) {
        process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    }
}
