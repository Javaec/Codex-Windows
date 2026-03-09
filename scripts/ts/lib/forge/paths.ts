import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists } from "../exec";
import { REPO_ROOT } from "../runner/context";

export type ForgeConfig = {
  version: number;
  name: string;
  mode: "repo-backed-dev";
  runtime: {
    source: "repo-dist";
    currentDir: string;
  };
  mods: {
    sourceDir: string;
  };
  logs: {
    rootDir: string;
  };
};

export type ForgePaths = {
  repoRoot: string;
  forgeRoot: string;
  launcherUiDir: string;
  configPath: string;
  logsDir: string;
  cacheDir: string;
  runtimeRoot: string;
  runtimeDownloadsDir: string;
  runtimeCurrentDir: string;
  distDir: string;
  repoDistRuntimeDir: string;
  sourceModsRoot: string;
  sourceModApiRoot: string;
  sourceModLoaderRoot: string;
  sourceCompatibilityPath: string;
  sourceVersionIdentityRoot: string;
};

const DEFAULT_FORGE_ROOT_NAME = "codex-forge";

function defaultForgeConfig(paths: ForgePaths): ForgeConfig {
  return {
    version: 1,
    name: "Codex Forge",
    mode: "repo-backed-dev",
    runtime: {
      source: "repo-dist",
      currentDir: paths.repoDistRuntimeDir,
    },
    mods: {
      sourceDir: paths.sourceModsRoot,
    },
    logs: {
      rootDir: paths.logsDir,
    },
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
    runtimeDownloadsDir: path.join(forgeRoot, "downloads"),
    runtimeCurrentDir: path.join(forgeRoot, "runtime", "current"),
    distDir: path.join(REPO_ROOT, "dist"),
    repoDistRuntimeDir: path.join(REPO_ROOT, "dist", "Codex-win32-x64"),
    sourceModsRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods"),
    sourceModApiRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "api"),
    sourceModLoaderRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader"),
    sourceCompatibilityPath: path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs"),
    sourceVersionIdentityRoot: path.join(REPO_ROOT, "shared", "version-identity"),
  };
}

export function ensureForgeWorkspace(paths: ForgePaths): ForgeConfig {
  ensureDir(paths.forgeRoot);
  ensureDir(paths.logsDir);
  ensureDir(paths.cacheDir);
  ensureDir(paths.runtimeRoot);
  ensureDir(paths.runtimeDownloadsDir);
  ensureDir(paths.runtimeCurrentDir);

  if (!fileExists(paths.configPath)) {
    fs.writeFileSync(paths.configPath, `${JSON.stringify(defaultForgeConfig(paths), null, 2)}\n`, "utf8");
  }

  const raw = fs.readFileSync(paths.configPath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as ForgeConfig;
}
