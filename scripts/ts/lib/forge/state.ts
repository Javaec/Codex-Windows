import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { ForgeConfig, ForgeLaunchProfile, ForgePaths, resolveForgeRuntimeDir } from "./paths";
import { resolveForgeModGraph } from "./resolution";
import { ensureForgeRuntimeRegistry, ForgeRuntimeInstall } from "./runtime-registry";
import { discoverForgeRuntimeSources } from "./runtime-sources";

export type ForgeRuntimeState = {
  exists: boolean;
  runtimeDir: string;
  buildMetadataPath: string;
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  cliSource: string;
  rgPath: string;
  rgExists: boolean;
  hasModApi: boolean;
  hasModLoader: boolean;
  hasCompatibilityHelper: boolean;
  hasVersionIdentity: boolean;
  launchers: Record<string, boolean>;
};

export type ForgeModState = {
  id: string;
  name: string;
  description: string;
  version: string;
  authors: string[];
  licenses: string[];
  environment: string;
  provides: string[];
  enabled: boolean;
  selected: boolean;
  enabledInManifest: boolean;
  priority: number;
  entrypoints: string[];
  lane: "main" | "renderer" | "mixed";
  capabilities: string[];
  manifestPath: string;
  rootPath: string;
  runtimeInstalled: boolean;
  disableReason: string;
};

export type ForgeComponentState = {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  status: "ready" | "degraded" | "missing";
};

export type ForgeRuntimeInstallState = {
  id: string;
  label: string;
  description: string;
  source: "repo-dist" | "snapshot" | "imported-runtime";
  originPath: string;
  runtimeDir: string;
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  cliSource: string;
  rgExists: boolean;
  hasModPlatform: boolean;
  active: boolean;
  capturedAtIso: string;
};

export type ForgeRuntimeSourceState = {
  id: string;
  finderId: string;
  fingerprint: string;
  label: string;
  description: string;
  kind: "repo-dist" | "work-build" | "windows-runtime-donor";
  runtimeDir: string;
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  importable: boolean;
  alreadyInstalled: boolean;
  recommendation: "managed" | "recommended-import" | "available-import" | "donor-only";
  detail: string;
};

export type ForgeState = {
  name: string;
  mode: ForgeConfig["mode"];
  forgeRoot: string;
  configPath: string;
  logsDir: string;
  launchProfiles: ForgeLaunchProfile[];
  runtime: ForgeRuntimeState;
  runtimeRegistry: {
    currentInstallId: string;
    installCount: number;
    installs: ForgeRuntimeInstallState[];
  };
  runtimeSources: ForgeRuntimeSourceState[];
  components: ForgeComponentState[];
  mods: ForgeModState[];
  modCounts: {
    total: number;
    enabled: number;
    selected: number;
    renderer: number;
    main: number;
  };
  resolution: {
    appVersion: string;
    buildNumber: string;
    buildHint: number;
    loadOrder: string[];
    disabledByUserIds: string[];
    incompatibleMods: Array<{ id: string; reason: string }>;
    recommendedDisabledMods: Array<{ id: string; reason: string }>;
    softIncompatibilities: Array<{ left: string; right: string }>;
  };
  latestRuntimeLog: string;
  latestAuthenticatedLog: string;
};

function readJson<T>(filePath: string, fallback: T): T {
  if (!fileExists(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

function readRuntimeState(paths: ForgePaths, config: ForgeConfig): ForgeRuntimeState {
  const runtimeDir = resolveForgeRuntimeDir(paths, config);
  const metadataPath = path.join(runtimeDir, "build-metadata.json");
  const metadata = readJson<Record<string, unknown>>(metadataPath, {});

  return {
    exists: fileExists(runtimeDir),
    runtimeDir,
    buildMetadataPath: metadataPath,
    appVersion: typeof metadata.appVersion === "string" ? metadata.appVersion : "",
    buildNumber: typeof metadata.buildNumber === "string" ? metadata.buildNumber : "",
    patchProfileId: typeof metadata.patchProfileId === "string" ? metadata.patchProfileId : "",
    cliSource: typeof metadata.codexCliSource === "string" ? metadata.codexCliSource : "",
    rgPath: path.join(runtimeDir, "resources", "rg.exe"),
    rgExists: fileExists(path.join(runtimeDir, "resources", "rg.exe")),
    hasModApi: fileExists(path.join(runtimeDir, "resources", "mod-api")),
    hasModLoader: fileExists(path.join(runtimeDir, "resources", "mod-loader")),
    hasCompatibilityHelper: fileExists(path.join(runtimeDir, "resources", "compatibility.cjs")),
    hasVersionIdentity: fileExists(path.join(runtimeDir, "resources", "version-identity")),
    launchers: {
      default: fileExists(path.join(runtimeDir, "Launch-Codex.cmd")),
      noMods: fileExists(path.join(runtimeDir, "Launch-Codex-no-mods.cmd")),
      withMods: fileExists(path.join(runtimeDir, "Launch-Codex-with-mods.cmd")),
      minimal: fileExists(path.join(runtimeDir, "Launch-Codex-minimal.cmd")),
      isolatedHome: fileExists(path.join(runtimeDir, "Launch-Codex-isolated-home.cmd")),
    },
  };
}

function readLatestRuntimeLog(runtimeDir: string, relativeDir: string): string {
  const targetDir = path.join(runtimeDir, relativeDir);
  if (!fileExists(targetDir)) return "";
  const candidates = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetDir, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] || "";
}

function mapRuntimeInstall(install: ForgeRuntimeInstall, currentInstallId: string): ForgeRuntimeInstallState {
  return {
    id: install.id,
    label: install.label,
    description: install.description,
    source: install.source,
    originPath: install.originPath,
    runtimeDir: install.runtimeDir,
    appVersion: install.appVersion,
    buildNumber: install.buildNumber,
    patchProfileId: install.patchProfileId,
    cliSource: install.cliSource,
    rgExists: install.rgExists,
    hasModPlatform: install.hasModApi && install.hasModLoader && install.hasCompatibilityHelper && install.hasVersionIdentity,
    active: install.id === currentInstallId,
    capturedAtIso: install.capturedAtIso,
  };
}

function buildComponentState(runtime: ForgeRuntimeState, installCount: number): ForgeComponentState[] {
  return [
    {
      id: "codex-forge",
      name: "Codex Forge",
      description: "Launcher shell, runtime graph, and external loader state.",
      version: "repo-dev",
      source: "workspace",
      status: "ready",
    },
    {
      id: "codex-desktop-runtime",
      name: "Codex Desktop Runtime",
      description: "Current packaged Codex runtime managed by Forge.",
      version: runtime.appVersion && runtime.buildNumber ? `${runtime.appVersion} (${runtime.buildNumber})` : runtime.appVersion || "unknown",
      source: runtime.patchProfileId || "repo-dist",
      status: runtime.exists ? "ready" : "missing",
    },
    {
      id: "codex-cli",
      name: "Codex CLI",
      description: "Bundled CLI used by the packaged runtime.",
      version: runtime.cliSource || "unknown",
      source: runtime.cliSource || "unknown",
      status: runtime.cliSource ? "ready" : "degraded",
    },
    {
      id: "ripgrep",
      name: "Ripgrep",
      description: "Fast code search tool exposed to the runtime.",
      version: runtime.rgExists ? "bundled" : "missing",
      source: runtime.rgPath,
      status: runtime.rgExists ? "ready" : "missing",
    },
    {
      id: "mod-loader-platform",
      name: "Mod Loader Platform",
      description: "Shared mod API, loader, compatibility helper, and version identity.",
      version: "v1",
      source: "shared/codex-mod-loader",
      status: runtime.hasModApi && runtime.hasModLoader && runtime.hasCompatibilityHelper && runtime.hasVersionIdentity ? "ready" : "degraded",
    },
    {
      id: "runtime-registry",
      name: "Runtime Registry",
      description: "Forge-managed list of runtime installs and the active runtime pointer.",
      version: `${installCount} install${installCount === 1 ? "" : "s"}`,
      source: "codex-forge/runtime/registry.json",
      status: installCount > 0 ? "ready" : "degraded",
    },
  ];
}

export function getForgeState(paths: ForgePaths, config: ForgeConfig): ForgeState {
  const runtimeRegistryState = ensureForgeRuntimeRegistry(paths, config);
  const effectiveConfig = runtimeRegistryState.config;
  const resolvedGraph = resolveForgeModGraph(paths, effectiveConfig);
  const runtime = readRuntimeState(paths, effectiveConfig);
  const runtimeSources = discoverForgeRuntimeSources(paths, effectiveConfig);
  const runtimeModsRoot = path.join(runtime.runtimeDir, "resources", "mods");
  const runtimeInstalledIds = new Set(
    fileExists(runtimeModsRoot)
      ? fs.readdirSync(runtimeModsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [],
  );

  const mods: ForgeModState[] = resolvedGraph.discoveredMods
    .map((mod) => ({
      id: mod.id,
      name: mod.name,
      description: mod.description,
      version: mod.version,
      authors: [...mod.authors],
      licenses: [...mod.licenses],
      environment: mod.environment,
      provides: [...mod.provides],
      enabled: mod.userEnabled,
      selected: mod.selected,
      enabledInManifest: mod.enabledInManifest,
      priority: mod.priority,
      entrypoints: [...mod.entrypoints],
      lane: mod.lane,
      capabilities: [...mod.capabilities],
      manifestPath: mod.manifestPath,
      rootPath: mod.rootPath,
      runtimeInstalled: runtimeInstalledIds.has(mod.id),
      disableReason: mod.disableReason,
    }))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  return {
    name: config.name,
    mode: config.mode,
    forgeRoot: paths.forgeRoot,
    configPath: paths.configPath,
    logsDir: paths.logsDir,
    launchProfiles: effectiveConfig.launchProfiles,
    runtime,
    runtimeRegistry: {
      currentInstallId: runtimeRegistryState.registry.currentInstallId,
      installCount: runtimeRegistryState.registry.installs.length,
      installs: runtimeRegistryState.registry.installs
        .map((install) => mapRuntimeInstall(install, runtimeRegistryState.registry.currentInstallId))
        .sort((left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label)),
    },
    runtimeSources: runtimeSources.map((source) => ({ ...source })),
    components: buildComponentState(runtime, runtimeRegistryState.registry.installs.length),
    mods,
    modCounts: {
      total: mods.length,
      enabled: mods.filter((mod) => mod.enabled).length,
      selected: mods.filter((mod) => mod.selected).length,
      renderer: mods.filter((mod) => mod.lane === "renderer" || mod.lane === "mixed").length,
      main: mods.filter((mod) => mod.lane === "main" || mod.lane === "mixed").length,
    },
    resolution: {
      appVersion: resolvedGraph.build.appVersion,
      buildNumber: resolvedGraph.build.buildNumber,
      buildHint: resolvedGraph.build.buildHint,
      loadOrder: [...resolvedGraph.loadOrder],
      disabledByUserIds: [...resolvedGraph.disabledByUserIds],
      incompatibleMods: resolvedGraph.incompatibleMods.map((item) => ({ ...item })),
      recommendedDisabledMods: resolvedGraph.recommendedDisabledMods.map((item) => ({ ...item })),
      softIncompatibilities: resolvedGraph.softIncompatibilities.map((item) => ({ ...item })),
    },
    latestRuntimeLog: readLatestRuntimeLog(runtime.runtimeDir, path.join("runtime-logs", "with-mods")),
    latestAuthenticatedLog: readLatestRuntimeLog(runtime.runtimeDir, path.join("runtime-logs-authenticated", "with-mods")),
  };
}

export function readLogTail(filePath: string, maxLines = 120): string {
  if (!fileExists(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split(/\r?\n/).slice(-maxLines).join("\n");
}
