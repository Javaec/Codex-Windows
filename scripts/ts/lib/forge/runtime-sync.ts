import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, fileExists, removePath } from "../exec";
import { writeLatestPortableLaunchers } from "../runtime-pack/launchers";
import { ForgePaths } from "./paths";

export type ForgeSyncResult = {
  syncedPaths: string[];
  targetRuntimeDir: string;
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

export function syncForgeRuntimeLayer(paths: ForgePaths): ForgeSyncResult {
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

  if (fileExists(targetRuntimeDir)) {
    writeLatestPortableLaunchers(paths.distDir, targetRuntimeDir);
    syncedPaths.push(path.join(paths.distDir, "Launch-Codex-latest.cmd"));
  }

  return { syncedPaths, targetRuntimeDir };
}

export function setForgeModEnabled(paths: ForgePaths, modId: string, enabled: boolean): void {
  const manifestPath = path.join(paths.sourceModsRoot, modId, "mod.json");
  if (!fileExists(manifestPath)) {
    throw new Error(`Forge mod manifest not found: ${manifestPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  parsed.enabled = enabled;
  fs.writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  syncForgeRuntimeLayer(paths);
}
