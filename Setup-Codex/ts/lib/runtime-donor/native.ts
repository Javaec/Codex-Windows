import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  copyDirectory,
  copyFileSafe,
  ensureDir,
  fileExists,
  movePathSafe,
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
import { getWindowsRuntimeDonorAppDirs, listWindowsCodexPackages, type WindowsCodexPackage } from "./windows-apps";

export type RuntimeSourceKind =
  | "packaged-runtime-cache"
  | "windows-runtime-donor-copy"
  | "electron-dist-cache"
  | "seed"
  | "npm-fallback";

export interface RuntimeDescriptor {
  sourceKind: RuntimeSourceKind;
  executablePath: string;
  runtimeRoot: string;
  electronVersion: string;
  sourceLabel: string;
  fingerprint: string;
  validationMode: "electron-run-as-node";
}

export interface NativeStageResult {
  runtime: RuntimeDescriptor;
  performed: boolean;
}

export interface RuntimePreflight {
  selectedSourceKind: RuntimeSourceKind;
  sourceLabel: string;
  packagedRuntimeCacheAvailable: boolean;
  packagedRuntimeCacheValid: boolean;
  fallbackRequired: boolean;
}

const PACKAGED_RUNTIME_DIR_NAME = "packaged-runtime";
const PACKAGED_RUNTIME_TMP_DIR_NAME = "packaged-runtime.tmp";
const RUNTIME_DESCRIPTOR_FILE_NAME = "runtime-descriptor.json";
const RUNTIME_VALIDATION_MODE = "electron-run-as-node";

function getFileSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function createRuntimeDescriptor(
  sourceKind: RuntimeSourceKind,
  executablePath: string,
  electronVersion: string,
  sourceLabel: string,
  fingerprint = getFileSha256(executablePath),
): RuntimeDescriptor {
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

function readRuntimeDescriptor(descriptorPath: string): RuntimeDescriptor | null {
  if (!fileExists(descriptorPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as Partial<RuntimeDescriptor>;
    if (
      typeof parsed.sourceKind !== "string" ||
      typeof parsed.executablePath !== "string" ||
      typeof parsed.runtimeRoot !== "string" ||
      typeof parsed.electronVersion !== "string" ||
      typeof parsed.sourceLabel !== "string" ||
      typeof parsed.fingerprint !== "string" ||
      parsed.validationMode !== RUNTIME_VALIDATION_MODE
    ) {
      return null;
    }
    return {
      sourceKind: parsed.sourceKind as RuntimeSourceKind,
      executablePath: path.resolve(parsed.executablePath),
      runtimeRoot: path.resolve(parsed.runtimeRoot),
      electronVersion: parsed.electronVersion,
      sourceLabel: parsed.sourceLabel,
      fingerprint: parsed.fingerprint,
      validationMode: RUNTIME_VALIDATION_MODE,
    };
  } catch {
    return null;
  }
}

function writeRuntimeDescriptor(runtimeRoot: string, descriptor: RuntimeDescriptor): void {
  ensureDir(runtimeRoot);
  fs.writeFileSync(
    path.join(runtimeRoot, RUNTIME_DESCRIPTOR_FILE_NAME),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    "utf8",
  );
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

function readPeMachineType(filePath: string): number {
  const fd = fs.openSync(filePath, "r");
  try {
    const dosHeader = Buffer.allocUnsafe(64);
    const dosRead = fs.readSync(fd, dosHeader, 0, dosHeader.length, 0);
    if (dosRead < 64) return 0;
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) return 0;
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (!Number.isFinite(peOffset) || peOffset < 0) return 0;
    const peHeader = Buffer.allocUnsafe(6);
    const peRead = fs.readSync(fd, peHeader, 0, peHeader.length, peOffset);
    if (peRead < 6) return 0;
    if (
      peHeader[0] !== 0x50 ||
      peHeader[1] !== 0x45 ||
      peHeader[2] !== 0x00 ||
      peHeader[3] !== 0x00
    ) {
      return 0;
    }
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

function expectedPeMachineTypes(arch: string): number[] {
  if (arch === "arm64") return [0xaa64];
  return [0x8664];
}

function isUsableWindowsNativeAddon(filePath: string, arch: string): boolean {
  if (!fileExists(filePath)) return false;
  return expectedPeMachineTypes(arch).includes(readPeMachineType(filePath));
}

function hasUsableAppNativeArtifacts(appDir: string, arch: string): boolean {
  const betterSqlite3Path = path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const nodePtyCandidates = [
    path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, "pty.node"),
    path.join(appDir, "node_modules", "node-pty", "build", "Release", "pty.node"),
  ];
  return (
    isUsableWindowsNativeAddon(betterSqlite3Path, arch) &&
    nodePtyCandidates.some((candidate) => isUsableWindowsNativeAddon(candidate, arch))
  );
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

function testElectronRuntimeExecutable(executablePath: string): boolean {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const result = runCommand(executablePath, ["-e", "process.exit(0)"], {
    env,
    allowNonZero: true,
    capture: true,
  });
  return result.status === 0;
}

function tryReusePackagedRuntimeCache(
  nativeDir: string,
  donorPackage: WindowsCodexPackage,
  electronVersion: string,
  quiet = false,
): RuntimeDescriptor | null {
  const packagedRuntimeDir = path.join(nativeDir, PACKAGED_RUNTIME_DIR_NAME);
  const packagedRuntimeExe = path.join(packagedRuntimeDir, "Codex.exe");
  const descriptorPath = path.join(packagedRuntimeDir, RUNTIME_DESCRIPTOR_FILE_NAME);
  if (!fileExists(packagedRuntimeExe)) return null;

  const descriptor = readRuntimeDescriptor(descriptorPath);
  const actualFingerprint = getFileSha256(packagedRuntimeExe);
  const descriptorMatches = Boolean(
    descriptor &&
    descriptor.sourceLabel === donorPackage.packageFullName &&
    descriptor.electronVersion === electronVersion &&
    descriptor.fingerprint === actualFingerprint,
  );
  if (!descriptorMatches) {
    if (!quiet) {
      writeInfo(
        `Refreshing packaged Electron runtime cache: expected ${donorPackage.packageFullName} / ${electronVersion}, found ${descriptor?.sourceLabel || "unknown"} / ${descriptor?.electronVersion || "unknown"}.`,
      );
    }
    return null;
  }
  return createRuntimeDescriptor(
    "packaged-runtime-cache",
    packagedRuntimeExe,
    electronVersion,
    donorPackage.packageFullName,
    actualFingerprint,
  );
}

function materializePackagedRuntimeCopy(
  nativeDir: string,
  donorPackage: WindowsCodexPackage,
  electronVersion: string,
): RuntimeDescriptor | null {
  const donorRuntimeDir = donorPackage.appDir;
  const donorExe = path.join(donorRuntimeDir, "Codex.exe");
  if (!fileExists(donorExe)) return null;

  const packagedRuntimeDir = path.join(nativeDir, PACKAGED_RUNTIME_DIR_NAME);
  const packagedRuntimeTmpDir = path.join(nativeDir, PACKAGED_RUNTIME_TMP_DIR_NAME);
  const packagedRuntimeTmpExe = path.join(packagedRuntimeTmpDir, "Codex.exe");
  const packagedRuntimeExe = path.join(packagedRuntimeDir, "Codex.exe");

  removePath(packagedRuntimeTmpDir);
  copyDirectory(donorRuntimeDir, packagedRuntimeTmpDir);
  if (!fileExists(packagedRuntimeTmpExe)) {
    removePath(packagedRuntimeTmpDir);
    return null;
  }

  removePath(packagedRuntimeDir);
  movePathSafe(packagedRuntimeTmpDir, packagedRuntimeDir);

  const descriptor = createRuntimeDescriptor(
    "windows-runtime-donor-copy",
    packagedRuntimeExe,
    electronVersion,
    donorPackage.packageFullName,
  );
  writeRuntimeDescriptor(packagedRuntimeDir, descriptor);
  writeSuccess(`Using packaged Electron runtime from donor copy: ${packagedRuntimeExe} (source=${donorExe})`);
  return descriptor;
}

function preparePackagedElectronRuntime(nativeDir: string, electronVersion: string): RuntimeDescriptor | null {
  const donorPackages = listWindowsCodexPackages().filter((runtimePackage) =>
    fileExists(path.join(runtimePackage.appDir, "Codex.exe")),
  );
  if (donorPackages.length === 0) return null;

  const reusableCache = tryReusePackagedRuntimeCache(nativeDir, donorPackages[0], electronVersion);
  if (reusableCache) {
    writeSuccess(`Using packaged Electron runtime cache: ${reusableCache.executablePath}`);
    return reusableCache;
  }

  for (const donorPackage of donorPackages) {
    const materialized = materializePackagedRuntimeCopy(nativeDir, donorPackage, electronVersion);
    if (materialized) return materialized;
  }
  return null;
}

function getReusableElectronDistCache(nativeDir: string, electronVersion: string): RuntimeDescriptor | null {
  const electronRoot = path.join(nativeDir, "node_modules", "electron");
  const electronExe = path.join(electronRoot, "dist", "electron.exe");
  const installedVersion = readElectronPackageVersion(electronRoot);
  if (!fileExists(electronExe) || installedVersion !== electronVersion) return null;
  if (!testElectronRuntimeExecutable(electronExe)) return null;
  return createRuntimeDescriptor("electron-dist-cache", electronExe, electronVersion, electronRoot);
}

function findFirstElectronDistSource(appDirs: string[]): string {
  for (const appDir of appDirs) {
    const candidate = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
    if (fileExists(candidate)) return appDir;
  }
  return "";
}

export function inspectRuntimePreflight(workDir: string, electronVersion: string, arch: string): RuntimePreflight {
  const nativeDir = path.join(workDir, "native-builds");
  const donorDirs = getNativeDonorAppDirs(workDir);
  const seedDirs = getNativeSeedAppDirs(workDir, arch);
  const donorPackages = listWindowsCodexPackages().filter((runtimePackage) =>
    fileExists(path.join(runtimePackage.appDir, "Codex.exe")),
  );
  const packagedRuntimeCacheAvailable = fileExists(path.join(nativeDir, PACKAGED_RUNTIME_DIR_NAME, "Codex.exe"));
  const packagedRuntimeCacheValid = donorPackages.length > 0 && Boolean(
    tryReusePackagedRuntimeCache(nativeDir, donorPackages[0], electronVersion, true),
  );
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

function ensureElectronDistCache(
  nativeDir: string,
  electronVersion: string,
  donorAppDirs: string[],
  seedAppDirs: string[],
): RuntimeDescriptor {
  const electronRoot = path.join(nativeDir, "node_modules", "electron");
  const electronExe = path.join(electronRoot, "dist", "electron.exe");
  const installedVersion = readElectronPackageVersion(electronRoot);
  const hasElectronExe = fileExists(electronExe);
  if (hasElectronExe && installedVersion === electronVersion && testElectronRuntimeExecutable(electronExe)) {
    return createRuntimeDescriptor("electron-dist-cache", electronExe, electronVersion, electronRoot);
  }
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
      return createRuntimeDescriptor("electron-dist-cache", electronExe, electronVersion, electronRoot);
    }
  }

  for (const runtimeCandidate of [
    { sourceKind: "electron-dist-cache" as const, label: "donor", appDirs: donorAppDirs },
    { sourceKind: "seed" as const, label: "bundled seed", appDirs: seedAppDirs },
  ]) {
    for (const sourceAppDir of runtimeCandidate.appDirs) {
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
      if (fileExists(electronExe) && testElectronRuntimeExecutable(electronExe)) {
        writeSuccess(`Using Electron runtime from ${runtimeCandidate.label}: ${sourceAppDir}`);
        return createRuntimeDescriptor(runtimeCandidate.sourceKind, electronExe, electronVersion, sourceAppDir);
      }
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
  if (!testElectronRuntimeExecutable(electronExe)) {
    throw new Error(`Electron runtime did not validate after npm fallback: ${electronExe}`);
  }
  return createRuntimeDescriptor("npm-fallback", electronExe, electronVersion, `electron@${electronVersion}`);
}

function ensureElectronRuntime(
  nativeDir: string,
  electronVersion: string,
  donorAppDirs: string[],
  seedAppDirs: string[],
): RuntimeDescriptor {
  const packagedRuntime = preparePackagedElectronRuntime(nativeDir, electronVersion);
  if (packagedRuntime) return packagedRuntime;
  return ensureElectronDistCache(nativeDir, electronVersion, donorAppDirs, seedAppDirs);
}

export function ensureElectronDistCacheForPackaging(
  nativeDir: string,
  electronVersion: string,
  arch: string,
): RuntimeDescriptor {
  const workDir = path.dirname(nativeDir);
  const donorDirs = uniqueExistingDirs(getNativeDonorAppDirs(workDir));
  const seedDirs = uniqueExistingDirs(getNativeSeedAppDirs(workDir, arch));
  return ensureElectronDistCache(nativeDir, electronVersion, donorDirs, seedDirs);
}

function shouldRunInteractiveNativeValidation(runtime: RuntimeDescriptor): boolean {
  return runtime.sourceKind !== "packaged-runtime-cache" && runtime.sourceKind !== "windows-runtime-donor-copy";
}

function tryRecoverNativeFromCandidateDirs(
  candidateDirs: string[],
  candidateKind: string,
  appDir: string,
  nativeDir: string,
  arch: string,
  electronExe: string,
  validateWithRuntime: boolean,
): boolean {
  for (const candidate of candidateDirs) {
    const copied = copyNativeArtifactsFromAppLayout(candidate, appDir, nativeDir, arch);
    if (!copied) continue;
    writeInfo(`Trying native ${candidateKind} artifacts from: ${candidate}`);
    if (!validateWithRuntime) {
      writeSuccess(`Recovered native modules from ${candidateKind} artifacts without packaged runtime smoke tests.`);
      return true;
    }
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
  const runtime = ensureElectronRuntime(
    nativeDir,
    electronVersion,
    uniqueExistingDirs(donorDirs),
    uniqueExistingDirs(seedDirs),
  );
  const electronExe = runtime.executablePath;
  const shouldValidateNativeWithRuntime = shouldRunInteractiveNativeValidation(runtime);

  const bsApp = path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const ptyAppPre = path.join(appDir, "node_modules", "node-pty", "prebuilds", arch, "pty.node");
  const ptyAppRel = path.join(appDir, "node_modules", "node-pty", "build", "Release", "pty.node");
  const appArtifactsPresent = fileExists(bsApp) && (fileExists(ptyAppPre) || fileExists(ptyAppRel));
  const appArtifactsUsable = hasUsableAppNativeArtifacts(appDir, arch);

  let appReady = false;
  if (appArtifactsPresent && appArtifactsUsable) {
    if (!shouldValidateNativeWithRuntime) {
      writeSuccess("Native cache hit: reusing app binaries without packaged runtime smoke tests.");
      appReady = true;
    } else {
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
  } else if (appArtifactsPresent && !appArtifactsUsable) {
    writeInfo("Native app cache present but not usable on Windows; refreshing native binaries from donor artifacts.");
  }

  if (!appReady) {
    const recoveredDonor = tryRecoverNativeFromCandidateDirs(
      donorDirs,
      "donor",
      appDir,
      nativeDir,
      arch,
      electronExe,
      shouldValidateNativeWithRuntime,
    );
    appReady = recoveredDonor || tryRecoverNativeFromCandidateDirs(
      seedDirs,
      "bundled seed",
      appDir,
      nativeDir,
      arch,
      electronExe,
      shouldValidateNativeWithRuntime,
    );
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

  if (shouldValidateNativeWithRuntime) {
    if (!testBetterSqlite3Usable(electronExe, appDir, "App better-sqlite3 usability validation")) {
      throw new Error("better-sqlite3 failed final validation in app directory.");
    }
    if (!testElectronRequire(electronExe, appDir, "./node_modules/node-pty", "App node-pty validation")) {
      throw new Error("node-pty failed final validation in app directory.");
    }
  } else {
    writeInfo("Skipping packaged runtime native validation to avoid interactive Codex launches.");
  }

  setManifestStepState(manifest, "native", nativeSignature, "ok", {
    electronVersion,
    betterSqlite3: betterVersion,
    nodePty: ptyVersion,
    arch,
    rebuildEnabled: allowNativeRebuild,
    nativeValidationMode: shouldValidateNativeWithRuntime ? "runtime-smoke" : "file-presence",
    runtime,
  });
  writeStateManifest(manifestPath, manifest);

  return { runtime, performed: true };
}
