import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { ForgeConfig, ForgePaths } from "./paths";

const { loadModCatalog } = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs")) as {
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
};

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
  enabled: boolean;
  priority: number;
  entrypoints: string[];
  lane: "main" | "renderer" | "mixed";
  capabilities: string[];
  manifestPath: string;
  runtimeInstalled: boolean;
};

export type ForgeState = {
  name: string;
  mode: ForgeConfig["mode"];
  forgeRoot: string;
  configPath: string;
  logsDir: string;
  runtime: ForgeRuntimeState;
  mods: ForgeModState[];
  modCounts: {
    total: number;
    enabled: number;
    renderer: number;
    main: number;
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

function detectLane(entrypoints: { renderer: string; main: string }): ForgeModState["lane"] {
  if (entrypoints.renderer && entrypoints.main) return "mixed";
  if (entrypoints.main) return "main";
  return "renderer";
}

function collectEntrypoints(entrypoints: { renderer: string; main: string }): string[] {
  const out: string[] = [];
  if (entrypoints.main) out.push("main");
  if (entrypoints.renderer) out.push("renderer");
  return out;
}

function readRuntimeState(paths: ForgePaths): ForgeRuntimeState {
  const runtimeDir = paths.repoDistRuntimeDir;
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

function readLatestRuntimeLog(paths: ForgePaths, relativeDir: string): string {
  const targetDir = path.join(paths.repoDistRuntimeDir, relativeDir);
  if (!fileExists(targetDir)) return "";
  const candidates = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetDir, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] || "";
}

export function getForgeState(paths: ForgePaths, config: ForgeConfig): ForgeState {
  const catalog = loadModCatalog({ modsRoot: paths.sourceModsRoot, loaderRoot: paths.sourceModLoaderRoot });
  const runtime = readRuntimeState(paths);
  const runtimeModsRoot = path.join(runtime.runtimeDir, "resources", "mods");
  const runtimeInstalledIds = new Set(
    fileExists(runtimeModsRoot)
      ? fs.readdirSync(runtimeModsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [],
  );

  const mods: ForgeModState[] = catalog.mods
    .map((mod) => ({
      id: mod.id,
      name: mod.name,
      description: mod.description,
      enabled: mod.enabled,
      priority: mod.priority,
      entrypoints: collectEntrypoints(mod.entrypoints),
      lane: detectLane(mod.entrypoints),
      capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
      manifestPath: mod.manifestPath,
      runtimeInstalled: runtimeInstalledIds.has(mod.id),
    }))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  return {
    name: config.name,
    mode: config.mode,
    forgeRoot: paths.forgeRoot,
    configPath: paths.configPath,
    logsDir: paths.logsDir,
    runtime,
    mods,
    modCounts: {
      total: mods.length,
      enabled: mods.filter((mod) => mod.enabled).length,
      renderer: mods.filter((mod) => mod.lane === "renderer" || mod.lane === "mixed").length,
      main: mods.filter((mod) => mod.lane === "main" || mod.lane === "mixed").length,
    },
    latestRuntimeLog: readLatestRuntimeLog(paths, path.join("runtime-logs", "with-mods")),
    latestAuthenticatedLog: readLatestRuntimeLog(paths, path.join("runtime-logs-authenticated", "with-mods")),
  };
}

export function readLogTail(filePath: string, maxLines = 120): string {
  if (!fileExists(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split(/\r?\n/).slice(-maxLines).join("\n");
}
