import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { ForgeConfig, ForgePaths } from "./paths";

const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs")) as {
  loadModCatalog: (options: { modsRoot: string; loaderRoot: string }) => {
    mods: Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      priority: number;
      entrypoints: { renderer: string; main: string };
      capabilities: { renderer: string[]; main: string[] };
      manifestPath: string;
    }>;
  };
  resolveRuntimeModCompatibility: (input: {
    modsRoot: string;
    loaderRoot: string;
    appVersion: string;
    buildNumber: string;
    snapshotLabel: string;
    enabledOnlyIds?: string[];
    disabledIds?: string[];
  }) => {
    build: {
      snapshotLabel: string;
      appVersion: string;
      buildNumber: string;
      buildHint: number;
      matchedBuild?: Record<string, unknown> | null;
      knownBuilds?: Array<Record<string, unknown>>;
    };
    mods: Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      priority: number;
      entrypoints: { renderer: string; main: string };
      capabilities: { renderer: string[]; main: string[] };
      manifestPath: string;
    }>;
    selectedMods: Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      priority: number;
      entrypoints: { renderer: string; main: string };
      capabilities: { renderer: string[]; main: string[] };
      manifestPath: string;
    }>;
    selectedModIds: string[];
    incompatibleMods: Array<{ id: string; reason: string }>;
    loadOrder: string[];
    softIncompatibilities: Array<{ left: string; right: string }>;
    recommendedDisabledMods: Array<{ id: string; reason: string }>;
  };
};

export type ForgeResolvedBuildContext = {
  appVersion: string;
  buildNumber: string;
  buildHint: number;
  snapshotLabel: string;
  matchedBuildHint: string;
};

export type ForgeResolvedMod = {
  id: string;
  name: string;
  description: string;
  priority: number;
  entrypoints: string[];
  lane: "main" | "renderer" | "mixed";
  capabilities: string[];
  manifestPath: string;
  enabledInManifest: boolean;
  userEnabled: boolean;
  selected: boolean;
  disableReason: string;
};

export type ForgeResolvedGraph = {
  build: ForgeResolvedBuildContext;
  discoveredMods: ForgeResolvedMod[];
  selectedModIds: string[];
  loadOrder: string[];
  disabledByUserIds: string[];
  incompatibleMods: Array<{ id: string; reason: string }>;
  recommendedDisabledMods: Array<{ id: string; reason: string }>;
  softIncompatibilities: Array<{ left: string; right: string }>;
};

type BuildMetadata = {
  appVersion?: unknown;
  buildNumber?: unknown;
};

function readJson<T>(filePath: string, fallback: T): T {
  if (!fileExists(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

function collectEntrypoints(entrypoints: { renderer: string; main: string }): string[] {
  const out: string[] = [];
  if (entrypoints.main) out.push("main");
  if (entrypoints.renderer) out.push("renderer");
  return out;
}

function detectLane(entrypoints: { renderer: string; main: string }): ForgeResolvedMod["lane"] {
  if (entrypoints.renderer && entrypoints.main) return "mixed";
  if (entrypoints.main) return "main";
  return "renderer";
}

function readRuntimeBuildContext(paths: ForgePaths, config: ForgeConfig): { appVersion: string; buildNumber: string } {
  const runtimeDir = config.runtime.currentDir || paths.repoDistRuntimeDir;
  const metadata = readJson<BuildMetadata>(path.join(runtimeDir, "build-metadata.json"), {});
  return {
    appVersion: typeof metadata.appVersion === "string" ? metadata.appVersion : "",
    buildNumber: typeof metadata.buildNumber === "string" ? metadata.buildNumber : "",
  };
}

export function getForgeUserDisabledModIds(config: ForgeConfig): string[] {
  return Object.entries(config.modState || {})
    .filter(([, state]) => state && state.enabled === false)
    .map(([modId]) => modId)
    .sort((left, right) => left.localeCompare(right));
}

export function resolveForgeModGraph(paths: ForgePaths, config: ForgeConfig): ForgeResolvedGraph {
  const catalog = compatibility.loadModCatalog({
    modsRoot: paths.sourceModsRoot,
    loaderRoot: paths.sourceModLoaderRoot,
  });
  const disabledByUserIds = getForgeUserDisabledModIds(config);
  const buildContext = readRuntimeBuildContext(paths, config);
  const resolved = compatibility.resolveRuntimeModCompatibility({
    modsRoot: paths.sourceModsRoot,
    loaderRoot: paths.sourceModLoaderRoot,
    appVersion: buildContext.appVersion,
    buildNumber: buildContext.buildNumber,
    snapshotLabel: "",
    disabledIds: disabledByUserIds,
  });
  const selectedIds = new Set(resolved.selectedModIds);
  const incompatibleReasons = new Map(resolved.incompatibleMods.map((item) => [item.id, item.reason]));
  const discoveredMods: ForgeResolvedMod[] = catalog.mods
    .map((mod) => {
      const override = config.modState && config.modState[mod.id];
      const userEnabled = typeof override?.enabled === "boolean" ? override.enabled : mod.enabled;
      const disableReason = !userEnabled
        ? "disabled in Codex Forge"
        : incompatibleReasons.get(mod.id) || "";
      return {
        id: mod.id,
        name: mod.name,
        description: mod.description,
        priority: mod.priority,
        entrypoints: collectEntrypoints(mod.entrypoints),
        lane: detectLane(mod.entrypoints),
        capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
        manifestPath: mod.manifestPath,
        enabledInManifest: mod.enabled,
        userEnabled,
        selected: selectedIds.has(mod.id),
        disableReason,
      };
    })
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  return {
    build: {
      appVersion: resolved.build.appVersion || buildContext.appVersion,
      buildNumber: resolved.build.buildNumber || buildContext.buildNumber,
      buildHint: typeof resolved.build.buildHint === "number" ? resolved.build.buildHint : 0,
      snapshotLabel: resolved.build.snapshotLabel || "",
      matchedBuildHint:
        resolved.build.matchedBuild && typeof resolved.build.matchedBuild.buildHint === "number"
          ? String(resolved.build.matchedBuild.buildHint)
          : "",
    },
    discoveredMods,
    selectedModIds: [...resolved.selectedModIds],
    loadOrder: [...resolved.loadOrder],
    disabledByUserIds,
    incompatibleMods: resolved.incompatibleMods.map((item) => ({ ...item })),
    recommendedDisabledMods: resolved.recommendedDisabledMods.map((item) => ({ ...item })),
    softIncompatibilities: resolved.softIncompatibilities.map((item) => ({ ...item })),
  };
}
