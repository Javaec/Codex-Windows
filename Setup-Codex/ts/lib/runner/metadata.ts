import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeDescriptor } from "../runtime-donor/native";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { resolveRuntimeModCompatibility } = require(path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs")) as {
  resolveRuntimeModCompatibility: (input: {
    modsRoot: string;
    loaderRoot: string;
    snapshotLabel: string;
    appVersion: string;
    buildNumber: string;
  }) => {
    build: { buildHint: number; matchedBuild: { id: string } | null };
    selectedModIds: string[];
    loadOrder: string[];
    recommendedDisabledMods: Array<{ id: string; reason: string }>;
    incompatibleMods: Array<{ id: string; reason: string }>;
    softIncompatibilities: Array<{ left: string; right: string }>;
  };
};

function describeRuntime(runtime: RuntimeDescriptor): {
  source: RuntimeDescriptor["sourceKind"];
  sourceLabel: string;
  executablePath: string;
  runtimeRoot: string;
  electronVersion: string;
  fingerprint: string;
  validationMode: RuntimeDescriptor["validationMode"];
} {
  return {
    source: runtime.sourceKind,
    sourceLabel: runtime.sourceLabel,
    executablePath: runtime.executablePath,
    runtimeRoot: runtime.runtimeRoot,
    electronVersion: runtime.electronVersion,
    fingerprint: runtime.fingerprint,
    validationMode: runtime.validationMode,
  };
}

function writeLiteContract(outputDir: string, payload: {
  appVersion: string;
  buildNumber: string;
  knownBuildId: string;
  knownBuildSource: string;
  patchProfileId: string;
  cliSource: string | null;
  ripgrepSource: string | null;
  runtimeFlavor: "lite" | "forge";
  includeRuntimeMods: boolean;
  portableShellRuntime: RuntimeDescriptor;
  nativeRuntime: RuntimeDescriptor;
  canonicalOutputReady: boolean;
  latestLaunchersReady: boolean;
}): void {
  const targetPath = path.join(outputDir, "lite-contract.json");
  const contract = {
    version: 1,
    runtimeFlavor: payload.runtimeFlavor,
    appVersion: payload.appVersion,
    buildNumber: payload.buildNumber,
    knownBuildId: payload.knownBuildId,
    knownBuildSource: payload.knownBuildSource,
    patchProfileId: payload.patchProfileId,
    directExeReady: true,
    bundledTools: {
      codexCli: fs.existsSync(path.join(outputDir, "resources", "codex.exe")),
      ripgrep: fs.existsSync(path.join(outputDir, "resources", "rg.exe")),
      windowsPathContract: fs.existsSync(path.join(outputDir, "resources", "app", ".vite", "build", "codex-windows-path-contract.cjs")),
    },
    runtimeModsBundled: payload.includeRuntimeMods,
    launchers: [
      "Launch-Codex.cmd",
      ...(payload.includeRuntimeMods ? ["Launch-Codex-with-mods.cmd"] : []),
    ],
    electronRuntimeSource: payload.portableShellRuntime.sourceKind,
    nativeElectronRuntimeSource: payload.nativeRuntime.sourceKind,
    shellRuntimeMatchesNative:
      path.resolve(payload.portableShellRuntime.executablePath) === path.resolve(payload.nativeRuntime.executablePath),
    canonicalOutputReady: payload.canonicalOutputReady,
    latestLaunchersReady: payload.latestLaunchersReady,
    cliSource: payload.cliSource || "",
    ripgrepSource: payload.ripgrepSource || "",
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
}

export function writeBuildMetadata(
  outputDir: string,
  metadata: {
    dmgPath: string;
    appVersion: string;
    buildNumber: string;
    buildFlavor: string;
    profileName: string;
    runtimeFlavor: "lite" | "forge";
    includeRuntimeMods: boolean;
    knownBuildId: string;
    knownBuildSource: string;
    patchProfileId: string;
    patchReportPath: string;
    cliPath: string | null;
    cliSource: string | null;
    ripgrepSource: string | null;
    bundledRipgrepPath: string;
    bundledRipgrepSourcePath: string;
    portableShellRuntime: RuntimeDescriptor;
    nativeRuntime: RuntimeDescriptor;
    canonicalOutputReady: boolean;
    latestLaunchersReady: boolean;
  },
): string {
  const resolvedRuntimeModCompatibility = resolveRuntimeModCompatibility({
    modsRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods"),
    loaderRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader"),
    snapshotLabel: metadata.dmgPath,
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
  });
  const runtimeModCompatibility = {
    bundled: metadata.includeRuntimeMods,
    buildHint: resolvedRuntimeModCompatibility.build.buildHint,
    matchedBuildId: resolvedRuntimeModCompatibility.build.matchedBuild ? resolvedRuntimeModCompatibility.build.matchedBuild.id : "",
    selectedModIds: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.selectedModIds : [],
    loadOrder: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.loadOrder : [],
    recommendedDisabledMods: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.recommendedDisabledMods : [],
    incompatibleMods: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.incompatibleMods : [],
    softIncompatibilities: metadata.includeRuntimeMods ? resolvedRuntimeModCompatibility.softIncompatibilities : [],
  };
  const targetPath = path.join(outputDir, "build-metadata.json");
  const payload = {
    builtAtIso: new Date().toISOString(),
    dmgPath: metadata.dmgPath,
    dmgFileName: path.basename(metadata.dmgPath),
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
    buildFlavor: metadata.buildFlavor,
    profileName: metadata.profileName,
    runtimeFlavor: metadata.runtimeFlavor,
    knownBuildId: metadata.knownBuildId,
    knownBuildSource: metadata.knownBuildSource,
    patchProfileId: metadata.patchProfileId,
    patchReportPath: metadata.patchReportPath,
    codexCliPath: metadata.cliPath,
    codexCliSource: metadata.cliSource,
    bundledRipgrepPath: metadata.bundledRipgrepPath,
    bundledRipgrepSource: metadata.ripgrepSource,
    bundledRipgrepSourcePath: metadata.bundledRipgrepSourcePath,
    electronRuntimeRole: "portable-shell",
    electronRuntimeSource: metadata.portableShellRuntime.sourceKind,
    electronRuntimeSourceLabel: metadata.portableShellRuntime.sourceLabel,
    electronRuntimePath: metadata.portableShellRuntime.executablePath,
    electronRuntimeVersion: metadata.portableShellRuntime.electronVersion,
    electronRuntimeFingerprint: metadata.portableShellRuntime.fingerprint,
    electronRuntimeValidationMode: metadata.portableShellRuntime.validationMode,
    packagedRuntimeCached: metadata.portableShellRuntime.sourceKind === "packaged-runtime-cache",
    nativePackagedRuntimeCached: metadata.nativeRuntime.sourceKind === "packaged-runtime-cache",
    shellRuntimeMatchesNative:
      path.resolve(metadata.portableShellRuntime.executablePath) === path.resolve(metadata.nativeRuntime.executablePath),
    portableShellRuntime: describeRuntime(metadata.portableShellRuntime),
    nativeRuntime: describeRuntime(metadata.nativeRuntime),
    runtimeModCompatibility,
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeLiteContract(outputDir, {
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
    knownBuildId: metadata.knownBuildId,
    knownBuildSource: metadata.knownBuildSource,
    patchProfileId: metadata.patchProfileId,
    cliSource: metadata.cliSource,
    ripgrepSource: metadata.ripgrepSource,
    runtimeFlavor: metadata.runtimeFlavor,
    includeRuntimeMods: metadata.includeRuntimeMods,
    portableShellRuntime: metadata.portableShellRuntime,
    nativeRuntime: metadata.nativeRuntime,
    canonicalOutputReady: metadata.canonicalOutputReady,
    latestLaunchersReady: metadata.latestLaunchersReady,
  });
  return targetPath;
}
