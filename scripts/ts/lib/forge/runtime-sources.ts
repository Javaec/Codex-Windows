import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { listWindowsCodexPackages } from "../runtime-donor/windows-apps";
import { ForgeConfig, ForgePaths } from "./paths";
import { ensureForgeRuntimeRegistry, ForgeRuntimeRegistry, importForgeRuntimeFromDirectory, inspectForgeRuntimeDirectory } from "./runtime-registry";

export type ForgeRuntimeSourceKind = "repo-dist" | "work-build" | "windows-runtime-donor";
export type ForgeRuntimeSourceRecommendation = "managed" | "recommended-import" | "available-import" | "donor-only";

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

function uniqueRuntimeDirs(candidates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !fileExists(candidate)) continue;
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function collectWorkRuntimeCandidates(paths: ForgePaths): string[] {
  const workRoot = path.join(paths.repoRoot, "work");
  if (!fileExists(workRoot)) return [];
  const directCandidates = [path.join(workRoot, "runner-smoke", "dist", "Codex-win32-x64")];
  const nestedCandidates: string[] = [];
  for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    nestedCandidates.push(path.join(workRoot, entry.name, "dist", "Codex-win32-x64"));
  }
  return uniqueRuntimeDirs([...directCandidates, ...nestedCandidates]);
}

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

const workBuildRuntimeSourceFinder: ForgeRuntimeSourceFinder = {
  id: "work-builds",
  findSources(context) {
    const sources: ForgeRuntimeSource[] = [];
    for (const runtimeDir of collectWorkRuntimeCandidates(context.paths)) {
      const workBuildId = path.basename(path.dirname(path.dirname(runtimeDir)));
      const install = inspectForgeRuntimeDirectory(runtimeDir, {
        id: `source-${workBuildId}`,
        label: `Work Build ${workBuildId}`,
        description: "Packaged runtime found under work/*/dist.",
        source: "imported-runtime",
        capturedAtIso: "",
      });
      sources.push({
        id: `source:work:${workBuildId}`,
        finderId: "work-builds",
        fingerprint: `work-build:${path.resolve(runtimeDir).toLowerCase()}`,
        label: install.label,
        description: `Import packaged runtime from ${runtimeDir}`,
        kind: "work-build",
        runtimeDir,
        appVersion: install.appVersion,
        buildNumber: install.buildNumber,
        patchProfileId: install.patchProfileId,
        importable: true,
        alreadyInstalled: isInstalledRuntime(context.registry, runtimeDir),
        recommendation: isInstalledRuntime(context.registry, runtimeDir) ? "managed" : "available-import",
        detail: runtimeDir,
      });
    }
    return sources;
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
  workBuildRuntimeSourceFinder,
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
