import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { listWindowsCodexPackages } from "../runtime-donor/windows-apps";
import { ForgeConfig, ForgePaths } from "./paths";
import { ensureForgeRuntimeRegistry, ForgeRuntimeRegistry, importForgeRuntimeFromDirectory, inspectForgeRuntimeDirectory } from "./runtime-registry";

export type ForgeRuntimeSourceKind = "repo-dist" | "work-build" | "windows-runtime-donor";

export type ForgeRuntimeSource = {
  id: string;
  label: string;
  description: string;
  kind: ForgeRuntimeSourceKind;
  runtimeDir: string;
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  importable: boolean;
  alreadyInstalled: boolean;
  detail: string;
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
  return registry.installs.some((install) => path.resolve(install.runtimeDir).toLowerCase() === path.resolve(runtimeDir).toLowerCase());
}

export function discoverForgeRuntimeSources(paths: ForgePaths, config: ForgeConfig): ForgeRuntimeSource[] {
  const { registry } = ensureForgeRuntimeRegistry(paths, config);
  const sources: ForgeRuntimeSource[] = [];

  const repoDistInstall = inspectForgeRuntimeDirectory(paths.repoDistRuntimeDir, {
    id: "source-repo-dist",
    label: "Repo Dist Runtime",
    description: "Current repo-backed dist runtime source.",
    source: "repo-dist",
    capturedAtIso: "",
  });
  sources.push({
    id: "source:repo-dist",
    label: "Repo Dist Runtime",
    description: "Current repo-backed dist runtime source.",
    kind: "repo-dist",
    runtimeDir: paths.repoDistRuntimeDir,
    appVersion: repoDistInstall.appVersion,
    buildNumber: repoDistInstall.buildNumber,
    patchProfileId: repoDistInstall.patchProfileId,
    importable: false,
    alreadyInstalled: true,
    detail: "Already managed as repo-dist-current",
  });

  for (const runtimeDir of collectWorkRuntimeCandidates(paths)) {
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
      label: install.label,
      description: `Import packaged runtime from ${runtimeDir}`,
      kind: "work-build",
      runtimeDir,
      appVersion: install.appVersion,
      buildNumber: install.buildNumber,
      patchProfileId: install.patchProfileId,
      importable: true,
      alreadyInstalled: isInstalledRuntime(registry, runtimeDir),
      detail: runtimeDir,
    });
  }

  for (const runtimePackage of listWindowsCodexPackages()) {
    sources.push({
      id: `source:windows-donor:${runtimePackage.packageFullName}`,
      label: `Windows Donor ${runtimePackage.packageFullName}`,
      description: "Official Windows Codex runtime donor package.",
      kind: "windows-runtime-donor",
      runtimeDir: runtimePackage.resourcesDir,
      appVersion: "",
      buildNumber: "",
      patchProfileId: "",
      importable: false,
      alreadyInstalled: false,
      detail: runtimePackage.packageRoot,
    });
  }

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
  });
}
