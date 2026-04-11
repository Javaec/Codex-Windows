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

function writeLiteContract(outputDir: string, payload: {
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  cliSource: string | null;
  runtimeFlavor: "lite" | "forge";
  includeRuntimeMods: boolean;
  runtime: RuntimeDescriptor;
  canonicalOutputReady: boolean;
  latestLaunchersReady: boolean;
}): void {
  const targetPath = path.join(outputDir, "lite-contract.json");
  const contract = {
    version: 1,
    runtimeFlavor: payload.runtimeFlavor,
    appVersion: payload.appVersion,
    buildNumber: payload.buildNumber,
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
    electronRuntimeSource: payload.runtime.sourceKind,
    canonicalOutputReady: payload.canonicalOutputReady,
    latestLaunchersReady: payload.latestLaunchersReady,
    cliSource: payload.cliSource || "",
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
    patchProfileId: string;
    patchReportPath: string;
    cliPath: string | null;
    cliSource: string | null;
    runtime: RuntimeDescriptor;
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
    patchProfileId: metadata.patchProfileId,
    patchReportPath: metadata.patchReportPath,
    codexCliPath: metadata.cliPath,
    codexCliSource: metadata.cliSource,
    electronRuntimeSource: metadata.runtime.sourceKind,
    electronRuntimePath: metadata.runtime.executablePath,
    electronRuntimeVersion: metadata.runtime.electronVersion,
    electronRuntimeFingerprint: metadata.runtime.fingerprint,
    electronRuntimeValidationMode: metadata.runtime.validationMode,
    packagedRuntimeCached: metadata.runtime.sourceKind === "packaged-runtime-cache",
    bundledRipgrepPath: path.join(outputDir, "resources", "rg.exe"),
    runtimeModCompatibility,
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeLiteContract(outputDir, {
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
    patchProfileId: metadata.patchProfileId,
    cliSource: metadata.cliSource,
    runtimeFlavor: metadata.runtimeFlavor,
    includeRuntimeMods: metadata.includeRuntimeMods,
    runtime: metadata.runtime,
    canonicalOutputReady: metadata.canonicalOutputReady,
    latestLaunchersReady: metadata.latestLaunchersReady,
  });
  return targetPath;
}
