import * as fs from "node:fs";
import * as path from "node:path";
import {
  copyDirectory,
  copyFileSafe,
  ensureDir,
  fileExists,
  removePath,
  resolveCommand,
  runCommand,
  writeInfo,
  uniqueExistingDirs,
  writeSuccess,
  writeWarn,
} from "../exec";
import { setManifestStepState, StateManifest, writeStateManifest } from "../manifest";
import { invokeNpm } from "../npm";
import { getWindowsRuntimeDonorAppDirs } from "./windows-apps";

export interface NativeStageResult {
  electronExe: string;
  performed: boolean;
}

function resolveValidationRuntime(
  electronExe: string,
  allowNodeFallback: boolean,
): { exe: string; mode: "electron" | "node" } | null {
  if (electronExe && fileExists(electronExe)) return { exe: electronExe, mode: "electron" };
  if (allowNodeFallback) {
    const node = require("../exec").resolveCommand("node.exe") ?? require("../exec").resolveCommand("node");
    if (node) return { exe: node, mode: "node" };
  }
  return null;
}

function runValidationScript(
  electronExe: string,
  workingDir: string,
  script: string,
  label: string,
  allowNodeFallback = false,
  failureSeverity: "info" | "warn" = "warn",
): boolean {
  const logFailure = failureSeverity === "warn" ? writeWarn : writeInfo;
  const formatFailure = (message: string): string =>
    failureSeverity === "warn" ? message : message.replace(" failed ", " did not validate ");
  const runtime = resolveValidationRuntime(electronExe, allowNodeFallback);
  if (!runtime) {
    logFailure(`${label}: runtime not available for validation.`);
    return false;
  }
  if (!fileExists(workingDir)) {
    logFailure(`${label}: working dir not found at ${workingDir}`);
    return false;
  }
  const env = { ...process.env };
  if (runtime.mode === "electron") env.ELECTRON_RUN_AS_NODE = "1";
  const result = runCommand(runtime.exe, ["-e", script], {
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

function testElectronRequire(
  electronExe: string,
  workingDir: string,
  requireTarget: string,
  label: string,
  failureSeverity: "info" | "warn" = "warn",
): boolean {
  const script = `try{require('${requireTarget}');process.exit(0)}catch(e){console.error(e&&e.stack?e.stack:e);process.exit(1)}`;
  return runValidationScript(electronExe, workingDir, script, label, false, failureSeverity);
}

function testBetterSqlite3Usable(
  electronExe: string,
  workingDir: string,
  label: string,
  failureSeverity: "info" | "warn" = "warn",
): boolean {
  const script = String.raw`
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

function copyNativeFile(sourcePath: string, destinationPath: string, label: string): void {
  try {
    copyFileSafe(sourcePath, destinationPath);
  } catch (error) {
    if (fileExists(destinationPath)) {
      throw new Error(`${label} is locked by another process at ${destinationPath}. Close running Codex and rerun.`);
    }
    throw error;
  }
}

function copyNativeArtifactsFromAppLayout(sourceAppDir: string, appDir: string, nativeDir: string, arch: string): boolean {
  const bsSrc = path.join(sourceAppDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!fileExists(bsSrc)) return false;

  let ptySrcDir = path.join(sourceAppDir, "node_modules", "node-pty", "prebuilds", arch);
  if (!fileExists(path.join(ptySrcDir, "pty.node"))) {
    ptySrcDir = path.join(sourceAppDir, "node_modules", "node-pty", "build", "Release");
  }
  if (!fileExists(path.join(ptySrcDir, "pty.node"))) return false;

  copyNativeFile(
    bsSrc,
    path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    "better-sqlite3 app artifact",
  );
  copyNativeFile(
    bsSrc,
    path.join(nativeDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    "better-sqlite3 native cache artifact",
  );

  for (const fileName of ["pty.node", "conpty.node", "conpty_console_list.node"]) {
    const src = path.join(ptySrcDir, fileName);
    if (!fileExists(src)) continue;
    copyNativeFile(src, path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, fileName), "node-pty app prebuild artifact");
    copyNativeFile(src, path.join(appDir, "node_modules", "node-pty", "build", "Release", fileName), "node-pty app release artifact");
    copyNativeFile(src, path.join(nativeDir, "node_modules", "node-pty", "prebuilds", arch, fileName), "node-pty native cache artifact");
  }
  return true;
}

function isRepoRootCandidate(dir: string): boolean {
  return (
    fileExists(path.join(dir, "package.json")) &&
    fileExists(path.join(dir, "scripts")) &&
    fileExists(path.join(dir, "shared"))
  );
}

function getRepositoryRoots(workDir: string): string[] {
  const candidates: string[] = [];
  const addCandidate = (dir: string): void => {
    if (isRepoRootCandidate(dir)) candidates.push(dir);
  };

  addCandidate(process.cwd());
  addCandidate(path.resolve(__dirname, "..", "..", ".."));

  let currentDir = workDir;
  while (true) {
    addCandidate(currentDir);
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return uniqueExistingDirs(candidates);
}

function getNativeDonorAppDirs(workDir: string): string[] {
  const candidates: string[] = [];
  candidates.push(...getWindowsRuntimeDonorAppDirs());
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "resources", "app"));
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI Codex", "resources", "app"));
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "codex", "resources", "app"));
  }

  for (const repoRoot of getRepositoryRoots(workDir)) {
    const distRoot = path.join(repoRoot, "dist");
    if (!fileExists(distRoot)) continue;
    for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(distRoot, entry.name, "resources", "app"));
    }
  }
  return uniqueExistingDirs(candidates);
}

function getNativeSeedAppDirs(workDir: string, arch: string): string[] {
  const candidates: string[] = [];
  for (const repoRoot of getRepositoryRoots(workDir)) {
    candidates.push(path.join(repoRoot, "scripts", "native-seeds", arch, "app"));
    candidates.push(path.join(repoRoot, "native-seeds", arch, "app"));
  }
  return uniqueExistingDirs(candidates);
}

function readElectronPackageVersion(electronRoot: string): string {
  const packageJsonPath = path.join(electronRoot, "package.json");
  if (!fileExists(packageJsonPath)) return "";
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version.trim() : "";
  } catch {
    return "";
  }
}

function testPackagedElectronRuntime(executablePath: string): boolean {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const result = runCommand(executablePath, ["-e", "process.exit(0)"], {
    env,
    allowNonZero: true,
    capture: true,
  });
  return result.status === 0;
}

function preparePackagedElectronRuntime(nativeDir: string, sourceAppDirs: string[]): string {
  const packagedRuntimeDir = path.join(nativeDir, "packaged-runtime");
  const packagedRuntimeExe = path.join(packagedRuntimeDir, "Codex.exe");
  if (fileExists(packagedRuntimeExe) && testPackagedElectronRuntime(packagedRuntimeExe)) {
    writeSuccess(`Using packaged Electron runtime cache: ${packagedRuntimeExe}`);
    return packagedRuntimeExe;
  }

  for (const sourceAppDir of sourceAppDirs) {
    const packagedAppDir = path.resolve(sourceAppDir, "..", "..");
    const packagedExe = path.join(packagedAppDir, "Codex.exe");
    if (!fileExists(packagedExe)) continue;
    removePath(packagedRuntimeDir);
    copyDirectory(packagedAppDir, packagedRuntimeDir);
    if (!testPackagedElectronRuntime(packagedRuntimeExe)) continue;
    writeSuccess(`Using packaged Electron runtime from donor: ${packagedExe}`);
    return packagedRuntimeExe;
  }
  return "";
}

function tryRepairElectronRuntimeInPlace(
  electronRoot: string,
  electronExe: string,
  electronVersion: string,
): boolean {
  const nodeExe = resolveCommand("node.exe") ?? resolveCommand("node");
  if (!nodeExe) {
    writeInfo(`Repairing incomplete cached Electron runtime skipped: Node.js is not available for ${electronVersion}.`);
    return false;
  }
  const result = runCommand(nodeExe, ["install.js"], {
    cwd: electronRoot,
    allowNonZero: true,
    capture: true,
  });
  if (result.status === 0 && fileExists(electronExe)) {
    writeSuccess(`Repaired cached Electron runtime in place: ${electronVersion}`);
    return true;
  }
  writeInfo(`In-place Electron runtime repair did not validate (exit code ${result.status}).`);
  return false;
}

function ensureElectronRuntime(nativeDir: string, electronVersion: string, sourceAppDirs: string[]): string {
  const packagedRuntime = preparePackagedElectronRuntime(nativeDir, sourceAppDirs);
  if (packagedRuntime) return packagedRuntime;

  const electronRoot = path.join(nativeDir, "node_modules", "electron");
  const electronExe = path.join(electronRoot, "dist", "electron.exe");
  const installedVersion = readElectronPackageVersion(electronRoot);
  const hasElectronExe = fileExists(electronExe);
  if (hasElectronExe && installedVersion === electronVersion) return electronExe;
  const shouldReplaceCachedElectron = hasElectronExe || (installedVersion !== "" && installedVersion !== electronVersion);
  if (shouldReplaceCachedElectron) {
    writeInfo(
      `Refreshing cached Electron runtime: expected ${electronVersion}, found ${installedVersion || "unknown"}.`,
    );
    removePath(electronRoot);
    removePath(path.join(nativeDir, "node_modules", ".bin", "electron"));
    removePath(path.join(nativeDir, "node_modules", ".bin", "electron.cmd"));
    removePath(path.join(nativeDir, "node_modules", ".bin", "electron.ps1"));
  } else if (installedVersion === electronVersion) {
    writeInfo(`Repairing incomplete cached Electron runtime: ${electronVersion} is present but electron.exe is missing.`);
    if (tryRepairElectronRuntimeInPlace(electronRoot, electronExe, electronVersion)) {
      return electronExe;
    }
  }

  for (const sourceAppDir of sourceAppDirs) {
    const srcElectronRoot = path.join(sourceAppDir, "node_modules", "electron");
    const srcDist = path.join(sourceAppDir, "node_modules", "electron", "dist");
    if (!fileExists(path.join(srcDist, "electron.exe"))) continue;
    copyDirectory(srcDist, path.join(electronRoot, "dist"));
    const srcPackageJson = path.join(srcElectronRoot, "package.json");
    if (fileExists(srcPackageJson)) {
      copyFileSafe(srcPackageJson, path.join(electronRoot, "package.json"));
    } else {
      ensureDir(electronRoot);
      fs.writeFileSync(
        path.join(electronRoot, "package.json"),
        `${JSON.stringify({ name: "electron", version: electronVersion }, null, 2)}\n`,
        "utf8",
      );
    }
    if (fileExists(electronExe)) {
      writeSuccess(`Using Electron runtime from donor: ${sourceAppDir}`);
      return electronExe;
    }
  }

  ensureDir(nativeDir);
  if (!fileExists(path.join(nativeDir, "package.json"))) {
    const npmInitExit = invokeNpm(["init", "-y"], nativeDir);
    if (npmInitExit !== 0) throw new Error("npm init failed while preparing Electron runtime.");
  }
  const npmInstallExit = invokeNpm(["install", "--no-save", `electron@${electronVersion}`], nativeDir);
  if (npmInstallExit !== 0) throw new Error(`npm install electron@${electronVersion} failed.`);
  if (!fileExists(electronExe)) throw new Error(`electron.exe not found after runtime preparation: ${electronExe}`);
  return electronExe;
}

function tryRecoverNativeFromCandidateDirs(
  candidateDirs: string[],
  candidateKind: string,
  appDir: string,
  nativeDir: string,
  arch: string,
  electronExe: string,
): boolean {
  for (const candidate of candidateDirs) {
    const copied = copyNativeArtifactsFromAppLayout(candidate, appDir, nativeDir, arch);
    if (!copied) continue;
    writeInfo(`Trying native ${candidateKind} artifacts from: ${candidate}`);
    const betterOk = testBetterSqlite3Usable(
      electronExe,
      appDir,
      `App better-sqlite3 ${candidateKind} validation`,
      "info",
    );
    const ptyOk = testElectronRequire(
      electronExe,
      appDir,
      "./node_modules/node-pty",
      `App node-pty ${candidateKind} validation`,
      "info",
    );
    if (betterOk && ptyOk) {
      writeSuccess(`Recovered native modules from ${candidateKind} artifacts.`);
      return true;
    }
  }
  return false;
}

export function invokeNativeStage(
  appDir: string,
  nativeDir: string,
  electronVersion: string,
  betterVersion: string,
  ptyVersion: string,
  arch: string,
  manifest: StateManifest,
  manifestPath: string,
  nativeSignature: string,
): NativeStageResult {
  const workDir = path.dirname(nativeDir);
  const allowNativeRebuild = process.env.CODEX_ENABLE_NATIVE_REBUILD === "1";
  const donorDirs = getNativeDonorAppDirs(workDir);
  const seedDirs = getNativeSeedAppDirs(workDir, arch);
  const electronExe = ensureElectronRuntime(nativeDir, electronVersion, uniqueExistingDirs([...donorDirs, ...seedDirs]));

  const bsApp = path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const ptyAppPre = path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, "pty.node");
  const ptyAppRel = path.join(appDir, "node_modules", "node-pty", "build", "Release", "pty.node");
  const appArtifactsPresent = fileExists(bsApp) && (fileExists(ptyAppPre) || fileExists(ptyAppRel));

  let appReady = false;
  if (appArtifactsPresent) {
    const appBetterOk = testBetterSqlite3Usable(
      electronExe,
      appDir,
      "App better-sqlite3 usability test (cache)",
      "info",
    );
    const appPtyOk = testElectronRequire(
      electronExe,
      appDir,
      "./node_modules/node-pty",
      "App node-pty smoke test (cache)",
      "info",
    );
    if (appBetterOk && appPtyOk) {
      writeSuccess("Native cache hit: reusing validated app binaries.");
      appReady = true;
    }
  }

  if (!appReady) {
    const recoveredDonor = tryRecoverNativeFromCandidateDirs(donorDirs, "donor", appDir, nativeDir, arch, electronExe);
    appReady = recoveredDonor || tryRecoverNativeFromCandidateDirs(seedDirs, "bundled seed", appDir, nativeDir, arch, electronExe);
  }

  if (!appReady) {
    if (allowNativeRebuild) {
      throw new Error(
        `No usable native artifacts found. Rebuild path is explicitly enabled, but this script no longer performs node-gyp builds. Provide prebuilt artifacts in scripts/native-seeds/${arch}/app or donor install.`,
      );
    }
    throw new Error(
      "No usable native artifacts found for better-sqlite3/node-pty, and native rebuild is disabled by policy. Use a donor installation or provide bundled seeds under scripts/native-seeds/<arch>/app.",
    );
  }

  if (!testBetterSqlite3Usable(electronExe, appDir, "App better-sqlite3 usability validation")) {
    throw new Error("better-sqlite3 failed final validation in app directory.");
  }
  if (!testElectronRequire(electronExe, appDir, "./node_modules/node-pty", "App node-pty validation")) {
    throw new Error("node-pty failed final validation in app directory.");
  }

  setManifestStepState(manifest, "native", nativeSignature, "ok", {
    electronVersion,
    betterSqlite3: betterVersion,
    nodePty: ptyVersion,
    arch,
    rebuildEnabled: allowNativeRebuild,
  });
  writeStateManifest(manifestPath, manifest);

  return { electronExe, performed: true };
}
