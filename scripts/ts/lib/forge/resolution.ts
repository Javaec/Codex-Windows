import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { ForgeConfig, ForgePaths, resolveForgeRuntimeDir } from "./paths";
import { discoverForgeMods } from "./discovery";

const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs")) as {
  loadModCatalog: (options: { modsRoot: string; loaderRoot: string }) => {
    mods: Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      priority: number;
      entrypoints: { renderer: string[]; main: string[] };
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
      entrypoints: { renderer: string[]; main: string[] };
      capabilities: { renderer: string[]; main: string[] };
      manifestPath: string;
    }>;
    selectedMods: Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      priority: number;
      entrypoints: { renderer: string[]; main: string[] };
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
  version: string;
  authors: string[];
  contact: Record<string, string>;
  licenses: string[];
  environment: string;
  iconPath: string;
  provides: string[];
  priority: number;
  entrypoints: string[];
  lane: "main" | "renderer" | "mixed";
  capabilities: string[];
  manifestPath: string;
  rootPath: string;
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

function readRuntimeBuildContext(paths: ForgePaths, config: ForgeConfig): { appVersion: string; buildNumber: string } {
  const runtimeDir = resolveForgeRuntimeDir(paths, config);
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
  const discoveredMods = discoverForgeMods(paths);
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
  const discoveredModsResolved: ForgeResolvedMod[] = discoveredMods
    .map((mod) => {
      const override = config.modState && config.modState[mod.id];
      const userEnabled = typeof override?.enabled === "boolean" ? override.enabled : mod.enabledInManifest;
      const disableReason = !userEnabled
        ? "disabled in Codex Forge"
        : incompatibleReasons.get(mod.id) || "";
      return {
        id: mod.id,
        name: mod.name,
        description: mod.description,
        version: mod.version,
        authors: [...mod.authors],
        contact: { ...mod.contact },
        licenses: [...mod.licenses],
        environment: mod.environment,
        iconPath: mod.iconPath,
        provides: [...mod.provides],
        priority: mod.priority,
        entrypoints: [...mod.entrypoints],
        lane: mod.lane,
        capabilities: [...mod.capabilities],
        manifestPath: mod.manifestPath,
        rootPath: mod.rootPath,
        enabledInManifest: mod.enabledInManifest,
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
    discoveredMods: discoveredModsResolved,
    selectedModIds: [...resolved.selectedModIds],
    loadOrder: [...resolved.loadOrder],
    disabledByUserIds,
    incompatibleMods: resolved.incompatibleMods.map((item) => ({ ...item })),
    recommendedDisabledMods: resolved.recommendedDisabledMods.map((item) => ({ ...item })),
    softIncompatibilities: resolved.softIncompatibilities.map((item) => ({ ...item })),
  };
}
