import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, ensureDir, fileExists, removePath } from "../exec";
import { writeLatestPortableLaunchers } from "../runtime-pack/launchers";
import { ForgeConfig, ForgePaths } from "./paths";
import { discoverForgeMods } from "./discovery";
import { resolveForgeModGraph } from "./resolution";

export type ForgeSyncResult = {
  syncedPaths: string[];
  targetRuntimeDir: string;
  loaderStatePath: string;
  resolvedGraphPath: string;
  discoveredModsPath: string;
};

function syncPath(sourcePath: string, destinationPath: string): void {
  if (!fileExists(sourcePath)) return;
  removePath(destinationPath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    copyDirectory(sourcePath, destinationPath);
    return;
  }
  copyFileSafe(sourcePath, destinationPath);
}

function writeJson(filePath: string, payload: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function syncForgeRuntimeLayer(paths: ForgePaths, config: ForgeConfig): ForgeSyncResult {
  const targetRuntimeDir = paths.repoDistRuntimeDir;
  const syncedPaths: string[] = [];
  const targets = [
    { source: paths.sourceModApiRoot, destination: path.join(targetRuntimeDir, "resources", "mod-api") },
    { source: paths.sourceModLoaderRoot, destination: path.join(targetRuntimeDir, "resources", "mod-loader") },
    { source: paths.sourceCompatibilityPath, destination: path.join(targetRuntimeDir, "resources", "compatibility.cjs") },
    { source: paths.sourceVersionIdentityRoot, destination: path.join(targetRuntimeDir, "resources", "version-identity") },
    { source: paths.sourceModsRoot, destination: path.join(targetRuntimeDir, "resources", "mods") },
  ];

  for (const target of targets) {
    if (!fileExists(target.source)) continue;
    syncPath(target.source, target.destination);
    syncedPaths.push(target.destination);
  }

  const resolvedGraph = resolveForgeModGraph(paths, config);
  const discoveredMods = discoverForgeMods(paths);
  const loaderState = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "Codex Forge",
    build: resolvedGraph.build,
    disabledIds: resolvedGraph.disabledByUserIds,
    selectedModIds: resolvedGraph.selectedModIds,
    loadOrder: resolvedGraph.loadOrder,
    incompatibleMods: resolvedGraph.incompatibleMods,
    recommendedDisabledMods: resolvedGraph.recommendedDisabledMods,
    softIncompatibilities: resolvedGraph.softIncompatibilities,
    modState: config.modState || {},
  };
  writeJson(paths.runtimeForgeLoaderStatePath, loaderState);
  writeJson(paths.runtimeForgeResolvedGraphPath, resolvedGraph);
  writeJson(paths.runtimeForgeDiscoveredModsPath, discoveredMods);
  writeJson(paths.forgeResolvedGraphPath, resolvedGraph);
  writeJson(paths.forgeDiscoveredModsPath, discoveredMods);
  syncedPaths.push(
    paths.runtimeForgeLoaderStatePath,
    paths.runtimeForgeResolvedGraphPath,
    paths.runtimeForgeDiscoveredModsPath,
    paths.forgeResolvedGraphPath,
    paths.forgeDiscoveredModsPath,
  );

  if (fileExists(targetRuntimeDir)) {
    writeLatestPortableLaunchers(paths.distDir, targetRuntimeDir);
    syncedPaths.push(path.join(paths.distDir, "Launch-Codex-latest.cmd"));
  }

  return {
    syncedPaths,
    targetRuntimeDir,
    loaderStatePath: paths.runtimeForgeLoaderStatePath,
    resolvedGraphPath: paths.runtimeForgeResolvedGraphPath,
    discoveredModsPath: paths.runtimeForgeDiscoveredModsPath,
  };
}

export function setForgeModEnabled(paths: ForgePaths, config: ForgeConfig, modId: string, enabled: boolean): void {
  const manifestPath = path.join(paths.sourceModsRoot, modId, "mod.json");
  if (!fileExists(manifestPath)) {
    throw new Error(`Forge mod manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")) as { enabled?: unknown };
  const defaultEnabled = manifest.enabled !== false;
  config.modState = config.modState || {};
  if (enabled === defaultEnabled) {
    delete config.modState[modId];
  } else {
    config.modState[modId] = { enabled };
  }
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  syncForgeRuntimeLayer(paths, config);
}
