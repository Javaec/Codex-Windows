import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, ensureDir, fileExists, removePath } from "../exec";
import {
  DEFAULT_FORGE_RUNTIME_INSTALL_ID,
  ForgeConfig,
  ForgePaths,
  resolveForgeRuntimeDir,
  saveForgeConfig,
} from "./paths";

export type ForgeRuntimeInstallSource = "repo-dist" | "snapshot" | "imported-runtime";

export type ForgeRuntimeInstall = {
  id: string;
  label: string;
  description: string;
  source: ForgeRuntimeInstallSource;
  originPath: string;
  runtimeDir: string;
  appVersion: string;
  buildNumber: string;
  patchProfileId: string;
  cliSource: string;
  rgExists: boolean;
  hasModApi: boolean;
  hasModLoader: boolean;
  hasCompatibilityHelper: boolean;
  hasVersionIdentity: boolean;
  capturedAtIso: string;
};

export type ForgeRuntimeRegistry = {
  version: number;
  currentInstallId: string;
  installs: ForgeRuntimeInstall[];
};

export type ForgeRuntimeCaptureResult = {
  registry: ForgeRuntimeRegistry;
  install: ForgeRuntimeInstall;
};

function readJson<T>(filePath: string, fallback: T): T {
  if (!fileExists(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, payload: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRuntimeBuildMetadata(runtimeDir: string): Record<string, unknown> {
  return readJson(path.join(runtimeDir, "build-metadata.json"), {});
}

export function inspectForgeRuntimeDirectory(runtimeDir: string, install: {
  id: string;
  label: string;
  description: string;
  source: ForgeRuntimeInstallSource;
  capturedAtIso: string;
  originPath?: string;
}): ForgeRuntimeInstall {
  const metadata = readRuntimeBuildMetadata(runtimeDir);
  return {
    id: install.id,
    label: install.label,
    description: install.description,
    source: install.source,
    originPath: normalizeString(install.originPath) || runtimeDir,
    runtimeDir,
    appVersion: normalizeString(metadata.appVersion),
    buildNumber: normalizeString(metadata.buildNumber),
    patchProfileId: normalizeString(metadata.patchProfileId),
    cliSource: normalizeString(metadata.codexCliSource),
    rgExists: fileExists(path.join(runtimeDir, "resources", "rg.exe")),
    hasModApi: fileExists(path.join(runtimeDir, "resources", "mod-api")),
    hasModLoader: fileExists(path.join(runtimeDir, "resources", "mod-loader")),
    hasCompatibilityHelper: fileExists(path.join(runtimeDir, "resources", "compatibility.cjs")),
    hasVersionIdentity: fileExists(path.join(runtimeDir, "resources", "version-identity")),
    capturedAtIso: install.capturedAtIso,
  };
}

function upsertInstall(registry: ForgeRuntimeRegistry, install: ForgeRuntimeInstall): ForgeRuntimeRegistry {
  const nextInstalls = registry.installs.filter((entry) => entry.id !== install.id);
  nextInstalls.push(install);
  nextInstalls.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return {
    ...registry,
    installs: nextInstalls,
  };
}

function coerceRuntimeRegistry(rawValue: unknown): ForgeRuntimeRegistry {
  const parsed = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue as Partial<ForgeRuntimeRegistry> : {};
  const installs: ForgeRuntimeInstall[] = Array.isArray(parsed.installs)
    ? parsed.installs
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry): ForgeRuntimeInstall => ({
          id: normalizeString((entry as ForgeRuntimeInstall).id),
          label: normalizeString((entry as ForgeRuntimeInstall).label),
          description: normalizeString((entry as ForgeRuntimeInstall).description),
          source:
            (entry as ForgeRuntimeInstall).source === "snapshot"
              ? "snapshot"
              : ((entry as ForgeRuntimeInstall).source === "imported-runtime" ? "imported-runtime" : "repo-dist"),
          originPath: normalizeString((entry as ForgeRuntimeInstall).originPath) || normalizeString((entry as ForgeRuntimeInstall).runtimeDir),
          runtimeDir: normalizeString((entry as ForgeRuntimeInstall).runtimeDir),
          appVersion: normalizeString((entry as ForgeRuntimeInstall).appVersion),
          buildNumber: normalizeString((entry as ForgeRuntimeInstall).buildNumber),
          patchProfileId: normalizeString((entry as ForgeRuntimeInstall).patchProfileId),
          cliSource: normalizeString((entry as ForgeRuntimeInstall).cliSource),
          rgExists: (entry as ForgeRuntimeInstall).rgExists === true,
          hasModApi: (entry as ForgeRuntimeInstall).hasModApi === true,
          hasModLoader: (entry as ForgeRuntimeInstall).hasModLoader === true,
          hasCompatibilityHelper: (entry as ForgeRuntimeInstall).hasCompatibilityHelper === true,
          hasVersionIdentity: (entry as ForgeRuntimeInstall).hasVersionIdentity === true,
          capturedAtIso: normalizeString((entry as ForgeRuntimeInstall).capturedAtIso),
        }))
        .filter((entry) => entry.id && entry.runtimeDir)
    : [];

  return {
    version: typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : 1,
    currentInstallId: normalizeString(parsed.currentInstallId) || DEFAULT_FORGE_RUNTIME_INSTALL_ID,
    installs,
  };
}

function extractLegacyImportOrigin(install: ForgeRuntimeInstall): string {
  if (install.source !== "imported-runtime") return install.originPath;
  for (const pattern of [/^Imported manually from (.+)$/i, /^Import packaged runtime from (.+)$/i, /^Imported from (.+)$/i]) {
    const match = pattern.exec(install.description);
    if (match && match[1]) {
      return normalizeString(match[1]) || install.originPath;
    }
  }
  return install.originPath;
}

function capturedAtValue(install: ForgeRuntimeInstall): number {
  const parsed = Date.parse(install.capturedAtIso || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAndDedupeRegistryInstalls(installs: ForgeRuntimeInstall[], currentInstallId: string): {
  installs: ForgeRuntimeInstall[];
  currentInstallId: string;
} {
  const byKey = new Map<string, ForgeRuntimeInstall>();
  let nextCurrentInstallId = currentInstallId;

  for (const install of installs) {
    const normalizedOriginPath = extractLegacyImportOrigin(install) || install.originPath || install.runtimeDir;
    const normalizedInstall: ForgeRuntimeInstall = {
      ...install,
      originPath: normalizedOriginPath,
    };
    const dedupeKey =
      normalizedInstall.source === "imported-runtime"
        ? `imported:${path.resolve(normalizedOriginPath).toLowerCase()}`
        : `id:${normalizedInstall.id.toLowerCase()}`;
    const previous = byKey.get(dedupeKey);
    if (!previous) {
      byKey.set(dedupeKey, normalizedInstall);
      continue;
    }

    const keepCurrent =
      previous.id === currentInstallId
        ? previous
        : normalizedInstall.id === currentInstallId
          ? normalizedInstall
          : (capturedAtValue(normalizedInstall) >= capturedAtValue(previous) ? normalizedInstall : previous);
    const dropped = keepCurrent.id === previous.id ? normalizedInstall : previous;
    byKey.set(dedupeKey, keepCurrent);
    if (dropped.id === nextCurrentInstallId) {
      nextCurrentInstallId = keepCurrent.id;
    }
  }

  return {
    installs: [...byKey.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)),
    currentInstallId: nextCurrentInstallId,
  };
}

function saveRuntimeRegistry(paths: ForgePaths, registry: ForgeRuntimeRegistry): void {
  writeJson(paths.runtimeRegistryPath, registry);
}

function alignConfigToRegistry(paths: ForgePaths, config: ForgeConfig, registry: ForgeRuntimeRegistry): ForgeConfig {
  const activeInstall =
    registry.installs.find((entry) => entry.id === config.runtime.currentInstallId) ||
    registry.installs.find((entry) => entry.id === registry.currentInstallId) ||
    registry.installs.find((entry) => entry.id === DEFAULT_FORGE_RUNTIME_INSTALL_ID) ||
    null;

  if (!activeInstall) return config;

  const nextSource = activeInstall.source === "repo-dist" ? "repo-dist" : "forge-install";
  if (
    config.runtime.currentInstallId === activeInstall.id &&
    config.runtime.currentDir === activeInstall.runtimeDir &&
    config.runtime.source === nextSource
  ) {
    return config;
  }

  const nextConfig: ForgeConfig = {
    ...config,
    runtime: {
      source: nextSource,
      currentDir: activeInstall.runtimeDir,
      currentInstallId: activeInstall.id,
    },
  };
  saveForgeConfig(paths, nextConfig);
  return nextConfig;
}

export function ensureForgeRuntimeRegistry(paths: ForgePaths, config: ForgeConfig): {
  registry: ForgeRuntimeRegistry;
  config: ForgeConfig;
} {
  ensureDir(paths.runtimeRoot);
  ensureDir(paths.runtimeInstallsDir);
  const existing = coerceRuntimeRegistry(readJson(paths.runtimeRegistryPath, {}));
  const normalizedExisting = normalizeAndDedupeRegistryInstalls(existing.installs, existing.currentInstallId);
  const existingRepoDistInstall = existing.installs.find((entry) => entry.id === DEFAULT_FORGE_RUNTIME_INSTALL_ID);
  const repoDistInstall = inspectForgeRuntimeDirectory(paths.repoDistRuntimeDir, {
    id: DEFAULT_FORGE_RUNTIME_INSTALL_ID,
    label: "Repo Dist Current",
    description: "Current repo-backed dist runtime.",
    source: "repo-dist",
    capturedAtIso: existingRepoDistInstall?.capturedAtIso || new Date().toISOString(),
    originPath: paths.repoDistRuntimeDir,
  });

  let registry = upsertInstall({
    ...existing,
    installs: normalizedExisting.installs,
    currentInstallId: normalizedExisting.currentInstallId,
  }, repoDistInstall);
  if (!registry.currentInstallId || !registry.installs.find((entry) => entry.id === registry.currentInstallId)) {
    registry = {
      ...registry,
      currentInstallId: config.runtime.currentInstallId || DEFAULT_FORGE_RUNTIME_INSTALL_ID,
    };
  }

  let nextConfig = alignConfigToRegistry(paths, config, registry);
  if (!registry.installs.find((entry) => entry.id === nextConfig.runtime.currentInstallId)) {
    registry = {
      ...registry,
      currentInstallId: DEFAULT_FORGE_RUNTIME_INSTALL_ID,
    };
    nextConfig = alignConfigToRegistry(paths, nextConfig, registry);
  }

  saveRuntimeRegistry(paths, registry);
  return { registry, config: nextConfig };
}

function isTransientRuntimeEntry(entryName: string): boolean {
  return /^runtime-logs/i.test(entryName) || /^userdata/i.test(entryName) || /^cache/i.test(entryName);
}

function copyRuntimeSnapshot(sourceRuntimeDir: string, destinationRuntimeDir: string): void {
  removePath(destinationRuntimeDir);
  ensureDir(destinationRuntimeDir);
  const entries = fs.readdirSync(sourceRuntimeDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isTransientRuntimeEntry(entry.name)) continue;
    const sourcePath = path.join(sourceRuntimeDir, entry.name);
    const destinationPath = path.join(destinationRuntimeDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      copyFileSafe(sourcePath, destinationPath);
    }
  }
}

function slugifyRuntimeLabel(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "runtime";
}

function allocateSnapshotInstallId(paths: ForgePaths, registry: ForgeRuntimeRegistry, sourceRuntimeDir: string): string {
  const metadata = readRuntimeBuildMetadata(sourceRuntimeDir);
  const base = slugifyRuntimeLabel(
    `snapshot-${normalizeString(metadata.patchProfileId) || normalizeString(metadata.appVersion) || "runtime"}-${normalizeString(metadata.buildNumber) || "unknown"}`,
  );
  let candidate = base;
  let index = 2;
  const existingIds = new Set(registry.installs.map((entry) => entry.id));
  while (existingIds.has(candidate) || fileExists(path.join(paths.runtimeInstallsDir, candidate))) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function captureActiveForgeRuntime(paths: ForgePaths, config: ForgeConfig): ForgeRuntimeCaptureResult {
  const ensured = ensureForgeRuntimeRegistry(paths, config);
  const activeRuntimeDir = resolveForgeRuntimeDir(paths, ensured.config);
  const snapshotInstallId = allocateSnapshotInstallId(paths, ensured.registry, activeRuntimeDir);
  const targetRuntimeDir = path.join(paths.runtimeInstallsDir, snapshotInstallId);
  copyRuntimeSnapshot(activeRuntimeDir, targetRuntimeDir);

  const snapshotInstall = inspectForgeRuntimeDirectory(targetRuntimeDir, {
    id: snapshotInstallId,
    label: `Snapshot ${snapshotInstallId}`,
    description: `Captured from ${activeRuntimeDir}`,
    source: "snapshot",
    capturedAtIso: new Date().toISOString(),
    originPath: activeRuntimeDir,
  });

  const registry = upsertInstall(ensured.registry, snapshotInstall);
  saveRuntimeRegistry(paths, registry);
  return { registry, install: snapshotInstall };
}

function allocateImportedInstallId(paths: ForgePaths, registry: ForgeRuntimeRegistry, sourceRuntimeDir: string): string {
  const metadata = readRuntimeBuildMetadata(sourceRuntimeDir);
  const base = slugifyRuntimeLabel(
    `import-${normalizeString(metadata.patchProfileId) || normalizeString(metadata.appVersion) || "runtime"}-${normalizeString(metadata.buildNumber) || "unknown"}`,
  );
  let candidate = base;
  let index = 2;
  const existingIds = new Set(registry.installs.map((entry) => entry.id));
  while (existingIds.has(candidate) || fileExists(path.join(paths.runtimeInstallsDir, candidate))) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function importForgeRuntimeFromDirectory(
  paths: ForgePaths,
  config: ForgeConfig,
  sourceRuntimeDir: string,
  options?: {
    label?: string;
    description?: string;
  },
): ForgeRuntimeCaptureResult {
  if (!fileExists(sourceRuntimeDir)) {
    throw new Error(`Forge runtime source directory not found: ${sourceRuntimeDir}`);
  }
  const ensured = ensureForgeRuntimeRegistry(paths, config);
  const normalizedOriginPath = path.resolve(sourceRuntimeDir);
  const existingInstall = ensured.registry.installs.find(
    (install) => path.resolve(install.originPath || install.runtimeDir).toLowerCase() === normalizedOriginPath.toLowerCase(),
  );
  if (existingInstall) {
    return { registry: ensured.registry, install: existingInstall };
  }
  const importInstallId = allocateImportedInstallId(paths, ensured.registry, sourceRuntimeDir);
  const targetRuntimeDir = path.join(paths.runtimeInstallsDir, importInstallId);
  copyRuntimeSnapshot(sourceRuntimeDir, targetRuntimeDir);
  const importedInstall = inspectForgeRuntimeDirectory(targetRuntimeDir, {
    id: importInstallId,
    label: options?.label || `Imported ${importInstallId}`,
    description: options?.description || `Imported from ${sourceRuntimeDir}`,
    source: "imported-runtime",
    capturedAtIso: new Date().toISOString(),
    originPath: normalizedOriginPath,
  });
  const registry = upsertInstall(ensured.registry, importedInstall);
  saveRuntimeRegistry(paths, registry);
  return { registry, install: importedInstall };
}

export function activateForgeRuntimeInstall(paths: ForgePaths, config: ForgeConfig, installId: string): {
  registry: ForgeRuntimeRegistry;
  config: ForgeConfig;
  install: ForgeRuntimeInstall;
} {
  const ensured = ensureForgeRuntimeRegistry(paths, config);
  const install = ensured.registry.installs.find((entry) => entry.id === installId);
  if (!install) {
    throw new Error(`Forge runtime install not found: ${installId}`);
  }
  const nextRegistry: ForgeRuntimeRegistry = {
    ...ensured.registry,
    currentInstallId: install.id,
  };
  saveRuntimeRegistry(paths, nextRegistry);

  const nextConfig: ForgeConfig = {
    ...ensured.config,
    runtime: {
      source: install.source === "repo-dist" ? "repo-dist" : "forge-install",
      currentDir: install.runtimeDir,
      currentInstallId: install.id,
    },
  };
  saveForgeConfig(paths, nextConfig);
  return {
    registry: nextRegistry,
    config: nextConfig,
    install,
  };
}
