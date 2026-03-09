"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectForgeRuntimeDirectory = inspectForgeRuntimeDirectory;
exports.ensureForgeRuntimeRegistry = ensureForgeRuntimeRegistry;
exports.captureActiveForgeRuntime = captureActiveForgeRuntime;
exports.importForgeRuntimeFromDirectory = importForgeRuntimeFromDirectory;
exports.activateForgeRuntimeInstall = activateForgeRuntimeInstall;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const paths_1 = require("./paths");
function readJson(filePath, fallback) {
    if (!(0, exec_1.fileExists)(filePath))
        return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return fallback;
    }
}
function writeJson(filePath, payload) {
    (0, exec_1.ensureDir)(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function readRuntimeBuildMetadata(runtimeDir) {
    return readJson(path.join(runtimeDir, "build-metadata.json"), {});
}
function inspectForgeRuntimeDirectory(runtimeDir, install) {
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
        rgExists: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "rg.exe")),
        hasModApi: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "mod-api")),
        hasModLoader: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "mod-loader")),
        hasCompatibilityHelper: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "compatibility.cjs")),
        hasVersionIdentity: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "version-identity")),
        capturedAtIso: install.capturedAtIso,
    };
}
function upsertInstall(registry, install) {
    const nextInstalls = registry.installs.filter((entry) => entry.id !== install.id);
    nextInstalls.push(install);
    nextInstalls.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    return {
        ...registry,
        installs: nextInstalls,
    };
}
function coerceRuntimeRegistry(rawValue) {
    const parsed = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : {};
    const installs = Array.isArray(parsed.installs)
        ? parsed.installs
            .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => ({
            id: normalizeString(entry.id),
            label: normalizeString(entry.label),
            description: normalizeString(entry.description),
            source: entry.source === "snapshot"
                ? "snapshot"
                : (entry.source === "imported-runtime" ? "imported-runtime" : "repo-dist"),
            originPath: normalizeString(entry.originPath) || normalizeString(entry.runtimeDir),
            runtimeDir: normalizeString(entry.runtimeDir),
            appVersion: normalizeString(entry.appVersion),
            buildNumber: normalizeString(entry.buildNumber),
            patchProfileId: normalizeString(entry.patchProfileId),
            cliSource: normalizeString(entry.cliSource),
            rgExists: entry.rgExists === true,
            hasModApi: entry.hasModApi === true,
            hasModLoader: entry.hasModLoader === true,
            hasCompatibilityHelper: entry.hasCompatibilityHelper === true,
            hasVersionIdentity: entry.hasVersionIdentity === true,
            capturedAtIso: normalizeString(entry.capturedAtIso),
        }))
            .filter((entry) => entry.id && entry.runtimeDir)
        : [];
    return {
        version: typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : 1,
        currentInstallId: normalizeString(parsed.currentInstallId) || paths_1.DEFAULT_FORGE_RUNTIME_INSTALL_ID,
        installs,
    };
}
function extractLegacyImportOrigin(install) {
    if (install.source !== "imported-runtime")
        return install.originPath;
    for (const pattern of [/^Imported manually from (.+)$/i, /^Import packaged runtime from (.+)$/i, /^Imported from (.+)$/i]) {
        const match = pattern.exec(install.description);
        if (match && match[1]) {
            return normalizeString(match[1]) || install.originPath;
        }
    }
    return install.originPath;
}
function capturedAtValue(install) {
    const parsed = Date.parse(install.capturedAtIso || "");
    return Number.isFinite(parsed) ? parsed : 0;
}
function normalizeAndDedupeRegistryInstalls(installs, currentInstallId) {
    const byKey = new Map();
    let nextCurrentInstallId = currentInstallId;
    for (const install of installs) {
        const normalizedOriginPath = extractLegacyImportOrigin(install) || install.originPath || install.runtimeDir;
        const normalizedInstall = {
            ...install,
            originPath: normalizedOriginPath,
        };
        const dedupeKey = normalizedInstall.source === "imported-runtime"
            ? `imported:${path.resolve(normalizedOriginPath).toLowerCase()}`
            : `id:${normalizedInstall.id.toLowerCase()}`;
        const previous = byKey.get(dedupeKey);
        if (!previous) {
            byKey.set(dedupeKey, normalizedInstall);
            continue;
        }
        const keepCurrent = previous.id === currentInstallId
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
function saveRuntimeRegistry(paths, registry) {
    writeJson(paths.runtimeRegistryPath, registry);
}
function alignConfigToRegistry(paths, config, registry) {
    const activeInstall = registry.installs.find((entry) => entry.id === config.runtime.currentInstallId) ||
        registry.installs.find((entry) => entry.id === registry.currentInstallId) ||
        registry.installs.find((entry) => entry.id === paths_1.DEFAULT_FORGE_RUNTIME_INSTALL_ID) ||
        null;
    if (!activeInstall)
        return config;
    const nextSource = activeInstall.source === "repo-dist" ? "repo-dist" : "forge-install";
    if (config.runtime.currentInstallId === activeInstall.id &&
        config.runtime.currentDir === activeInstall.runtimeDir &&
        config.runtime.source === nextSource) {
        return config;
    }
    const nextConfig = {
        ...config,
        runtime: {
            source: nextSource,
            currentDir: activeInstall.runtimeDir,
            currentInstallId: activeInstall.id,
        },
    };
    (0, paths_1.saveForgeConfig)(paths, nextConfig);
    return nextConfig;
}
function ensureForgeRuntimeRegistry(paths, config) {
    (0, exec_1.ensureDir)(paths.runtimeRoot);
    (0, exec_1.ensureDir)(paths.runtimeInstallsDir);
    const existing = coerceRuntimeRegistry(readJson(paths.runtimeRegistryPath, {}));
    const normalizedExisting = normalizeAndDedupeRegistryInstalls(existing.installs, existing.currentInstallId);
    const existingRepoDistInstall = existing.installs.find((entry) => entry.id === paths_1.DEFAULT_FORGE_RUNTIME_INSTALL_ID);
    const repoDistInstall = inspectForgeRuntimeDirectory(paths.repoDistRuntimeDir, {
        id: paths_1.DEFAULT_FORGE_RUNTIME_INSTALL_ID,
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
            currentInstallId: config.runtime.currentInstallId || paths_1.DEFAULT_FORGE_RUNTIME_INSTALL_ID,
        };
    }
    let nextConfig = alignConfigToRegistry(paths, config, registry);
    if (!registry.installs.find((entry) => entry.id === nextConfig.runtime.currentInstallId)) {
        registry = {
            ...registry,
            currentInstallId: paths_1.DEFAULT_FORGE_RUNTIME_INSTALL_ID,
        };
        nextConfig = alignConfigToRegistry(paths, nextConfig, registry);
    }
    saveRuntimeRegistry(paths, registry);
    return { registry, config: nextConfig };
}
function isTransientRuntimeEntry(entryName) {
    return /^runtime-logs/i.test(entryName) || /^userdata/i.test(entryName) || /^cache/i.test(entryName);
}
function copyRuntimeSnapshot(sourceRuntimeDir, destinationRuntimeDir) {
    (0, exec_1.removePath)(destinationRuntimeDir);
    (0, exec_1.ensureDir)(destinationRuntimeDir);
    const entries = fs.readdirSync(sourceRuntimeDir, { withFileTypes: true });
    for (const entry of entries) {
        if (isTransientRuntimeEntry(entry.name))
            continue;
        const sourcePath = path.join(sourceRuntimeDir, entry.name);
        const destinationPath = path.join(destinationRuntimeDir, entry.name);
        if (entry.isDirectory()) {
            (0, exec_1.copyDirectory)(sourcePath, destinationPath);
        }
        else {
            (0, exec_1.copyFileSafe)(sourcePath, destinationPath);
        }
    }
}
function slugifyRuntimeLabel(value) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "runtime";
}
function allocateSnapshotInstallId(paths, registry, sourceRuntimeDir) {
    const metadata = readRuntimeBuildMetadata(sourceRuntimeDir);
    const base = slugifyRuntimeLabel(`snapshot-${normalizeString(metadata.patchProfileId) || normalizeString(metadata.appVersion) || "runtime"}-${normalizeString(metadata.buildNumber) || "unknown"}`);
    let candidate = base;
    let index = 2;
    const existingIds = new Set(registry.installs.map((entry) => entry.id));
    while (existingIds.has(candidate) || (0, exec_1.fileExists)(path.join(paths.runtimeInstallsDir, candidate))) {
        candidate = `${base}-${index}`;
        index += 1;
    }
    return candidate;
}
function captureActiveForgeRuntime(paths, config) {
    const ensured = ensureForgeRuntimeRegistry(paths, config);
    const activeRuntimeDir = (0, paths_1.resolveForgeRuntimeDir)(paths, ensured.config);
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
function allocateImportedInstallId(paths, registry, sourceRuntimeDir) {
    const metadata = readRuntimeBuildMetadata(sourceRuntimeDir);
    const base = slugifyRuntimeLabel(`import-${normalizeString(metadata.patchProfileId) || normalizeString(metadata.appVersion) || "runtime"}-${normalizeString(metadata.buildNumber) || "unknown"}`);
    let candidate = base;
    let index = 2;
    const existingIds = new Set(registry.installs.map((entry) => entry.id));
    while (existingIds.has(candidate) || (0, exec_1.fileExists)(path.join(paths.runtimeInstallsDir, candidate))) {
        candidate = `${base}-${index}`;
        index += 1;
    }
    return candidate;
}
function importForgeRuntimeFromDirectory(paths, config, sourceRuntimeDir, options) {
    if (!(0, exec_1.fileExists)(sourceRuntimeDir)) {
        throw new Error(`Forge runtime source directory not found: ${sourceRuntimeDir}`);
    }
    const ensured = ensureForgeRuntimeRegistry(paths, config);
    const normalizedOriginPath = path.resolve(sourceRuntimeDir);
    const existingInstall = ensured.registry.installs.find((install) => path.resolve(install.originPath || install.runtimeDir).toLowerCase() === normalizedOriginPath.toLowerCase());
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
function activateForgeRuntimeInstall(paths, config, installId) {
    const ensured = ensureForgeRuntimeRegistry(paths, config);
    const install = ensured.registry.installs.find((entry) => entry.id === installId);
    if (!install) {
        throw new Error(`Forge runtime install not found: ${installId}`);
    }
    const nextRegistry = {
        ...ensured.registry,
        currentInstallId: install.id,
    };
    saveRuntimeRegistry(paths, nextRegistry);
    const nextConfig = {
        ...ensured.config,
        runtime: {
            source: install.source === "repo-dist" ? "repo-dist" : "forge-install",
            currentDir: install.runtimeDir,
            currentInstallId: install.id,
        },
    };
    (0, paths_1.saveForgeConfig)(paths, nextConfig);
    return {
        registry: nextRegistry,
        config: nextConfig,
        install,
    };
}
