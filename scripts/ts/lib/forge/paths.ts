import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists } from "../exec";
import { REPO_ROOT } from "../runner/context";

export type ForgeLaunchProfileId = "default" | "with-mods" | "no-mods" | "minimal" | "isolated-home";

export type ForgeLaunchProfile = {
  id: ForgeLaunchProfileId;
  label: string;
  description: string;
};

export type ForgeConfig = {
  version: number;
  name: string;
  mode: "repo-backed-dev";
  runtime: {
    source: "repo-dist" | "forge-install";
    currentDir: string;
    currentInstallId: string;
  };
  mods: {
    sourceDir: string;
  };
  logs: {
    rootDir: string;
  };
  modState: Record<string, { enabled: boolean }>;
  launchProfiles: ForgeLaunchProfile[];
};

export type ForgePaths = {
  repoRoot: string;
  forgeRoot: string;
  launcherUiDir: string;
  configPath: string;
  logsDir: string;
  cacheDir: string;
  runtimeRoot: string;
  runtimeInstallsDir: string;
  runtimeRegistryPath: string;
  runtimeDownloadsDir: string;
  runtimeCurrentDir: string;
  distDir: string;
  repoDistRuntimeDir: string;
  sourceModsRoot: string;
  sourceModApiRoot: string;
  sourceModLoaderRoot: string;
  sourceCompatibilityPath: string;
  sourceVersionIdentityRoot: string;
  forgeResolvedGraphPath: string;
  forgeDiscoveredModsPath: string;
};

const DEFAULT_FORGE_ROOT_NAME = "codex-forge";
export const DEFAULT_FORGE_RUNTIME_INSTALL_ID = "repo-dist-current";

function defaultLaunchProfiles(): ForgeLaunchProfile[] {
  return [
    {
      id: "default",
      label: "Safe Default",
      description: "Launch the current runtime without runtime mods.",
    },
    {
      id: "with-mods",
      label: "With Mods",
      description: "Launch the current runtime with the active Forge mod graph.",
    },
    {
      id: "no-mods",
      label: "No Mods",
      description: "Launch a clean lane with dedicated user data and cache.",
    },
    {
      id: "minimal",
      label: "Minimal",
      description: "Launch the reduced Windows minimal lane for runtime diagnostics.",
    },
    {
      id: "isolated-home",
      label: "Isolated Home",
      description: "Launch with an isolated CODEX_HOME inside the portable runtime.",
    },
  ];
}

function defaultForgeConfig(paths: ForgePaths): ForgeConfig {
  return {
    version: 3,
    name: "Codex Forge",
    mode: "repo-backed-dev",
    runtime: {
      source: "repo-dist",
      currentDir: paths.repoDistRuntimeDir,
      currentInstallId: DEFAULT_FORGE_RUNTIME_INSTALL_ID,
    },
    mods: {
      sourceDir: paths.sourceModsRoot,
    },
    logs: {
      rootDir: paths.logsDir,
    },
    modState: {},
    launchProfiles: defaultLaunchProfiles(),
  };
}

function normalizePathString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModState(value: unknown): ForgeConfig["modState"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ForgeConfig["modState"] = {};
  for (const [modId, rawState] of Object.entries(value)) {
    if (!modId || !rawState || typeof rawState !== "object" || Array.isArray(rawState)) continue;
    const enabled = (rawState as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") continue;
    out[modId] = { enabled };
  }
  return out;
}

function normalizeLaunchProfileId(value: unknown): ForgeLaunchProfileId | null {
  switch (value) {
    case "default":
    case "with-mods":
    case "no-mods":
    case "minimal":
    case "isolated-home":
      return value;
    default:
      return null;
  }
}

function normalizeLaunchProfiles(value: unknown): ForgeLaunchProfile[] {
  if (!Array.isArray(value)) return defaultLaunchProfiles();
  const out: ForgeLaunchProfile[] = [];
  const seen = new Set<ForgeLaunchProfileId>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = normalizeLaunchProfileId((item as { id?: unknown }).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: normalizePathString((item as { label?: unknown }).label) || defaultLaunchProfiles().find((profile) => profile.id === id)!.label,
      description:
        normalizePathString((item as { description?: unknown }).description) ||
        defaultLaunchProfiles().find((profile) => profile.id === id)!.description,
    });
  }
  if (out.length < 1) return defaultLaunchProfiles();
  return out;
}

function normalizeForgeConfig(paths: ForgePaths, rawValue: unknown): ForgeConfig {
  const defaults = defaultForgeConfig(paths);
  const parsed = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? (rawValue as Partial<ForgeConfig>) : {};
  return {
    version: typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : defaults.version,
    name: normalizePathString(parsed.name) || defaults.name,
    mode: parsed.mode === "repo-backed-dev" ? parsed.mode : defaults.mode,
    runtime: {
      source:
        parsed.runtime && (parsed.runtime.source === "repo-dist" || parsed.runtime.source === "forge-install")
          ? parsed.runtime.source
          : defaults.runtime.source,
      currentDir: normalizePathString(parsed.runtime?.currentDir) || defaults.runtime.currentDir,
      currentInstallId: normalizePathString(parsed.runtime?.currentInstallId) || defaults.runtime.currentInstallId,
    },
    mods: {
      sourceDir: normalizePathString(parsed.mods?.sourceDir) || defaults.mods.sourceDir,
    },
    logs: {
      rootDir: normalizePathString(parsed.logs?.rootDir) || defaults.logs.rootDir,
    },
    modState: normalizeModState(parsed.modState),
    launchProfiles: normalizeLaunchProfiles((parsed as { launchProfiles?: unknown }).launchProfiles),
  };
}

export function resolveForgePaths(): ForgePaths {
  const forgeRoot = path.join(REPO_ROOT, DEFAULT_FORGE_ROOT_NAME);
  return {
    repoRoot: REPO_ROOT,
    forgeRoot,
    launcherUiDir: path.join(forgeRoot, "launcher"),
    configPath: path.join(forgeRoot, "forge.json"),
    logsDir: path.join(forgeRoot, "logs"),
    cacheDir: path.join(forgeRoot, "cache"),
    runtimeRoot: path.join(forgeRoot, "runtime"),
    runtimeInstallsDir: path.join(forgeRoot, "runtime", "installs"),
    runtimeRegistryPath: path.join(forgeRoot, "runtime", "registry.json"),
    runtimeDownloadsDir: path.join(forgeRoot, "downloads"),
    runtimeCurrentDir: path.join(forgeRoot, "runtime", "current"),
    distDir: path.join(REPO_ROOT, "dist"),
    repoDistRuntimeDir: path.join(REPO_ROOT, "dist", "Codex-win32-x64"),
    sourceModsRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods"),
    sourceModApiRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "api"),
    sourceModLoaderRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader"),
    sourceCompatibilityPath: path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs"),
    sourceVersionIdentityRoot: path.join(REPO_ROOT, "shared", "version-identity"),
    forgeResolvedGraphPath: path.join(forgeRoot, "cache", "resolved-mod-graph.json"),
    forgeDiscoveredModsPath: path.join(forgeRoot, "cache", "discovered-mods.json"),
  };
}

export function resolveForgeRuntimeDir(paths: ForgePaths, config: ForgeConfig): string {
  return normalizePathString(config.runtime.currentDir) || paths.repoDistRuntimeDir;
}

export function resolveForgeRuntimeArtifactPaths(runtimeDir: string): {
  runtimeForgeStateDir: string;
  runtimeForgeLoaderStatePath: string;
  runtimeForgeResolvedGraphPath: string;
  runtimeForgeDiscoveredModsPath: string;
} {
  const runtimeForgeStateDir = path.join(runtimeDir, "resources", "codex-forge");
  return {
    runtimeForgeStateDir,
    runtimeForgeLoaderStatePath: path.join(runtimeForgeStateDir, "loader-state.json"),
    runtimeForgeResolvedGraphPath: path.join(runtimeForgeStateDir, "resolved-mod-graph.json"),
    runtimeForgeDiscoveredModsPath: path.join(runtimeForgeStateDir, "discovered-mods.json"),
  };
}

export function saveForgeConfig(paths: ForgePaths, config: ForgeConfig): void {
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function ensureForgeWorkspace(paths: ForgePaths): ForgeConfig {
  ensureDir(paths.forgeRoot);
  ensureDir(paths.logsDir);
  ensureDir(paths.cacheDir);
  ensureDir(paths.runtimeRoot);
  ensureDir(paths.runtimeInstallsDir);
  ensureDir(paths.runtimeDownloadsDir);
  ensureDir(paths.runtimeCurrentDir);

  if (!fileExists(paths.configPath)) {
    fs.writeFileSync(paths.configPath, `${JSON.stringify(defaultForgeConfig(paths), null, 2)}\n`, "utf8");
  }

  const raw = fs.readFileSync(paths.configPath, "utf8").replace(/^\uFEFF/, "");
  const normalized = normalizeForgeConfig(paths, JSON.parse(raw));
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (raw !== serialized) {
    saveForgeConfig(paths, normalized);
  }
  return normalized;
}
