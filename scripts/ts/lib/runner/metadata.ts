import * as fs from "node:fs";
import * as path from "node:path";

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
    bundledRipgrepPath: path.join(outputDir, "resources", "rg.exe"),
    runtimeModCompatibility,
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return targetPath;
}
