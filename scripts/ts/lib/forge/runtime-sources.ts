import * as path from "node:path";
import { listWindowsCodexPackages } from "../runtime-donor/windows-apps";
import { ForgeConfig, ForgePaths } from "./paths";
import { ensureForgeRuntimeRegistry, ForgeRuntimeRegistry, importForgeRuntimeFromDirectory, inspectForgeRuntimeDirectory } from "./runtime-registry";

export type ForgeRuntimeSourceKind = "repo-dist" | "windows-runtime-donor";
export type ForgeRuntimeSourceRecommendation = "managed" | "recommended-import";

export type ForgeRuntimeSource = {
  id: string;
  finderId: string;
  fingerprint: string;
  label: string;
  description: string;
  kind: ForgeRuntimeSourceKind;
  runtimeDir: string;
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  importable: boolean;
  alreadyInstalled: boolean;
  recommendation: ForgeRuntimeSourceRecommendation;
  detail: string;
};

type ForgeRuntimeSourceFinderContext = {
  paths: ForgePaths;
  config: ForgeConfig;
  registry: ForgeRuntimeRegistry;
};

type ForgeRuntimeSourceFinder = {
  id: string;
  findSources: (context: ForgeRuntimeSourceFinderContext) => ForgeRuntimeSource[];
};

function isInstalledRuntime(registry: ForgeRuntimeRegistry, runtimeDir: string): boolean {
  const normalizedRuntimeDir = path.resolve(runtimeDir).toLowerCase();
  return registry.installs.some((install) => {
    const originPath = path.resolve(install.originPath || install.runtimeDir).toLowerCase();
    return originPath === normalizedRuntimeDir;
  });
}

const repoDistRuntimeSourceFinder: ForgeRuntimeSourceFinder = {
  id: "repo-dist",
  findSources(context) {
    const repoDistInstall = inspectForgeRuntimeDirectory(context.paths.repoDistRuntimeDir, {
      id: "source-repo-dist",
      label: "Repo Dist Runtime",
      description: "Current repo-backed dist runtime source.",
      source: "repo-dist",
      capturedAtIso: "",
    });
    return [{
      id: "source:repo-dist",
      finderId: "repo-dist",
      fingerprint: `repo-dist:${path.resolve(context.paths.repoDistRuntimeDir).toLowerCase()}`,
      label: "Repo Dist Runtime",
      description: "Current repo-backed dist runtime source.",
      kind: "repo-dist",
      runtimeDir: context.paths.repoDistRuntimeDir,
      appVersion: repoDistInstall.appVersion,
      buildNumber: repoDistInstall.buildNumber,
      patchProfileId: repoDistInstall.patchProfileId,
      importable: false,
      alreadyInstalled: true,
      recommendation: "managed",
      detail: "Already managed as repo-dist-current",
    }];
  },
};

const windowsRuntimeDonorSourceFinder: ForgeRuntimeSourceFinder = {
  id: "windows-runtime-donor",
  findSources(context) {
    return listWindowsCodexPackages().map((runtimePackage) => ({
      id: `source:windows-donor:${runtimePackage.packageFullName}`,
      finderId: "windows-runtime-donor",
      fingerprint: `windows-donor:${runtimePackage.packageFullName.toLowerCase()}`,
      label: `Official Windows Codex ${runtimePackage.packageVersion}`,
      description: "Official Windows Codex package available from WindowsApps.",
      kind: "windows-runtime-donor" as const,
      runtimeDir: runtimePackage.appDir,
      appVersion: runtimePackage.packageVersion,
      buildNumber: "",
      patchProfileId: "",
      importable: true,
      alreadyInstalled: isInstalledRuntime(context.registry, runtimePackage.appDir),
      recommendation: isInstalledRuntime(context.registry, runtimePackage.appDir) ? "managed" as const : "recommended-import" as const,
      detail: runtimePackage.packageRoot,
    }));
  },
};

const defaultRuntimeSourceFinders: ForgeRuntimeSourceFinder[] = [
  repoDistRuntimeSourceFinder,
  windowsRuntimeDonorSourceFinder,
];

export function discoverForgeRuntimeSources(paths: ForgePaths, config: ForgeConfig): ForgeRuntimeSource[] {
  const { registry } = ensureForgeRuntimeRegistry(paths, config);
  const sources = defaultRuntimeSourceFinders.flatMap((finder) => finder.findSources({ paths, config, registry }));
  return sources.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export function importForgeRuntimeSource(paths: ForgePaths, config: ForgeConfig, sourceId: string) {
  const sources = discoverForgeRuntimeSources(paths, config);
  const source = sources.find((entry) => entry.id === sourceId);
  if (!source) {
    throw new Error(`Forge runtime source not found: ${sourceId}`);
  }
  if (!source.importable) {
    throw new Error(`Forge runtime source is not importable: ${sourceId}`);
  }
  return importForgeRuntimeFromDirectory(paths, config, source.runtimeDir, {
    label: source.label,
    description: source.description,
    buildMetadata: {
      appVersion: source.appVersion,
      buildNumber: source.buildNumber,
      patchProfileId: source.patchProfileId,
      codexCliSource: source.kind === "windows-runtime-donor" ? "windows-runtime-donor" : "",
      importSourceKind: source.kind,
      importSourceDetail: source.detail,
    },
  });
}

export function importForgeRuntimeDirectory(paths: ForgePaths, config: ForgeConfig, runtimeDir: string) {
  const runtimeInstall = inspectForgeRuntimeDirectory(runtimeDir, {
    id: "manual-import",
    label: `Imported ${path.basename(runtimeDir) || "runtime"}`,
    description: `Imported manually from ${runtimeDir}`,
    source: "imported-runtime",
    capturedAtIso: "",
  });
  return importForgeRuntimeFromDirectory(paths, config, runtimeDir, {
    label: runtimeInstall.label,
    description: runtimeInstall.description,
    buildMetadata: {
      appVersion: runtimeInstall.appVersion,
      buildNumber: runtimeInstall.buildNumber,
      patchProfileId: runtimeInstall.patchProfileId,
      codexCliSource: runtimeInstall.cliSource,
      importSourceKind: "manual-directory",
      importSourceDetail: runtimeDir,
    },
  });
}

export function getForgeRuntimeSourceFinderIds(): string[] {
  return defaultRuntimeSourceFinders.map((finder) => finder.id);
}
