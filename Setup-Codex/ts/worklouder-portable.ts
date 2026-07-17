import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const PORTABLE_FOLDER = "Codex-WorkLouder-Bypass";
const ARCHIVE_NAME = `${PORTABLE_FOLDER}.zip`;
const LAUNCHER_NAME = "Launch-Codex-WorkLouder-Bypass.cmd";

function repositoryRoot(): string {
  return path.resolve(__dirname, "../..");
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function readSourceCommit(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "unknown";
}

function sha256(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
}

function writePortableLauncher(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `@echo off
setlocal

set "ROOT=%~dp0"
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
node "%ROOT%worklouder-bypass.js" %*
exit /b %ERRORLEVEL%
`,
    "ascii",
  );
}

function writePortableReadme(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `Codex Work Louder Bypass
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

1. Exit every ChatGPT.exe / Codex window.
2. Run Launch-Codex-WorkLouder-Bypass.cmd.
3. Use --dry-run first if you want to validate the installed package without launching it.

The launcher discovers the current OpenAI.Codex AppX install path automatically.
It intercepts only ${"@worklouder/device-kit-oai"} during the new process bootstrap and
makes device discovery return an empty list. It does not modify the signed package,
credentials, conversations, MCP configuration, or ChatGPT Classic.

Safety behavior
---------------

- The launcher refuses to attach to an already running ChatGPT.exe process.
- It fails closed if the expected Work Louder native package contract is absent.
- Inspector access is bound to 127.0.0.1 and closed immediately after bootstrap.
- Runtime logs are written to the logs folder next to this launcher.

This workaround disables Work Louder / Codex Micro. Do not use it if you need that
hardware integration. It is not an official OpenAI fix.
`,
    "ascii",
  );
}

function createArchive(stagingDir: string, archivePath: string): void {
  const source = escapePowerShellLiteral(path.join(stagingDir, "*"));
  const archive = escapePowerShellLiteral(archivePath);
  const script = `Compress-Archive -Path '${source}' -DestinationPath '${archive}' -CompressionLevel Optimal -Force`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (result.error || result.status !== 0 || !fs.existsSync(archivePath)) {
    throw new Error("Unable to create the portable ZIP archive.");
  }
}

export function buildPortablePackage(): { stagingDir: string; archivePath: string } {
  const root = repositoryRoot();
  const outputDir = path.join(root, "work", "portable-output");
  const stagingDir = path.join(outputDir, PORTABLE_FOLDER);
  const archivePath = path.join(outputDir, ARCHIVE_NAME);
  const sourceLauncher = path.join(root, "Setup-Codex", "node", "lib", "worklouder-bypass.js");
  if (!fs.existsSync(sourceLauncher)) {
    throw new Error("Compiled Work Louder launcher is missing. Run npm run build:runner first.");
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.copyFileSync(sourceLauncher, path.join(stagingDir, "worklouder-bypass.js"));
  writePortableLauncher(path.join(stagingDir, LAUNCHER_NAME));
  writePortableReadme(path.join(stagingDir, "README.md"));

  const metadata = {
    schemaVersion: 1,
    artifact: PORTABLE_FOLDER,
    sourceCommit: readSourceCommit(root),
    generatedAtIso: new Date().toISOString(),
    runtime: "Node.js >= 22",
    files: [LAUNCHER_NAME, "worklouder-bypass.js", "README.md", "build-metadata.json"],
  };
  fs.writeFileSync(path.join(stagingDir, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "ascii");
  const checksums = Object.fromEntries(
    metadata.files.map((fileName) => [fileName, sha256(path.join(stagingDir, fileName))]),
  );
  fs.writeFileSync(path.join(stagingDir, "SHA256SUMS.txt"), `${Object.entries(checksums).map(([file, hash]) => `${hash} *${file}`).join("\n")}\n`, "ascii");
  createArchive(stagingDir, archivePath);
  return { stagingDir, archivePath };
}

export function main(): number {
  const result = buildPortablePackage();
  process.stdout.write(`Portable staging: ${result.stagingDir}\nPortable archive: ${result.archivePath}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
