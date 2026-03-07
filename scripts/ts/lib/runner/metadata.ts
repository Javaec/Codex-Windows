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
    patchProfileId: string;
    patchReportPath: string;
    cliPath: string | null;
    cliSource: string | null;
  },
): string {
  const runtimeModCompatibility = resolveRuntimeModCompatibility({
    modsRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods"),
    loaderRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader"),
    snapshotLabel: metadata.dmgPath,
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
  });
  const targetPath = path.join(outputDir, "build-metadata.json");
  const payload = {
    builtAtIso: new Date().toISOString(),
    dmgPath: metadata.dmgPath,
    dmgFileName: path.basename(metadata.dmgPath),
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
    buildFlavor: metadata.buildFlavor,
    profileName: metadata.profileName,
    patchProfileId: metadata.patchProfileId,
    patchReportPath: metadata.patchReportPath,
    codexCliPath: metadata.cliPath,
    codexCliSource: metadata.cliSource,
    runtimeModCompatibility: {
      buildHint: runtimeModCompatibility.build.buildHint,
      matchedBuildId: runtimeModCompatibility.build.matchedBuild ? runtimeModCompatibility.build.matchedBuild.id : "",
      selectedModIds: runtimeModCompatibility.selectedModIds,
      loadOrder: runtimeModCompatibility.loadOrder,
      recommendedDisabledMods: runtimeModCompatibility.recommendedDisabledMods,
      incompatibleMods: runtimeModCompatibility.incompatibleMods,
      softIncompatibilities: runtimeModCompatibility.softIncompatibilities,
    },
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return targetPath;
}
