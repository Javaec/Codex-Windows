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
exports.discoverForgeRuntimeSources = discoverForgeRuntimeSources;
exports.importForgeRuntimeSource = importForgeRuntimeSource;
exports.importForgeRuntimeDirectory = importForgeRuntimeDirectory;
exports.getForgeRuntimeSourceFinderIds = getForgeRuntimeSourceFinderIds;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const windows_apps_1 = require("../runtime-donor/windows-apps");
const runtime_registry_1 = require("./runtime-registry");
function uniqueRuntimeDirs(candidates) {
    const seen = new Set();
    const out = [];
    for (const candidate of candidates) {
        if (!candidate || !(0, exec_1.fileExists)(candidate))
            continue;
        const resolved = path.resolve(candidate);
        const key = resolved.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(resolved);
    }
    return out;
}
function collectWorkRuntimeCandidates(paths) {
    const workRoot = path.join(paths.repoRoot, "work");
    if (!(0, exec_1.fileExists)(workRoot))
        return [];
    const directCandidates = [path.join(workRoot, "runner-smoke", "dist", "Codex-win32-x64")];
    const nestedCandidates = [];
    for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        nestedCandidates.push(path.join(workRoot, entry.name, "dist", "Codex-win32-x64"));
    }
    return uniqueRuntimeDirs([...directCandidates, ...nestedCandidates]);
}
function isInstalledRuntime(registry, runtimeDir) {
    return registry.installs.some((install) => path.resolve(install.runtimeDir).toLowerCase() === path.resolve(runtimeDir).toLowerCase());
}
const repoDistRuntimeSourceFinder = {
    id: "repo-dist",
    findSources(context) {
        const repoDistInstall = (0, runtime_registry_1.inspectForgeRuntimeDirectory)(context.paths.repoDistRuntimeDir, {
            id: "source-repo-dist",
            label: "Repo Dist Runtime",
            description: "Current repo-backed dist runtime source.",
            source: "repo-dist",
            capturedAtIso: "",
        });
        return [{
                id: "source:repo-dist",
                label: "Repo Dist Runtime",
                description: "Current repo-backed dist runtime source.",
                kind: "repo-dist",
                runtimeDir: context.paths.repoDistRuntimeDir,
                appVersion: repoDistInstall.appVersion,
                buildNumber: repoDistInstall.buildNumber,
                patchProfileId: repoDistInstall.patchProfileId,
                importable: false,
                alreadyInstalled: true,
                detail: "Already managed as repo-dist-current",
            }];
    },
};
const workBuildRuntimeSourceFinder = {
    id: "work-builds",
    findSources(context) {
        const sources = [];
        for (const runtimeDir of collectWorkRuntimeCandidates(context.paths)) {
            const workBuildId = path.basename(path.dirname(path.dirname(runtimeDir)));
            const install = (0, runtime_registry_1.inspectForgeRuntimeDirectory)(runtimeDir, {
                id: `source-${workBuildId}`,
                label: `Work Build ${workBuildId}`,
                description: "Packaged runtime found under work/*/dist.",
                source: "imported-runtime",
                capturedAtIso: "",
            });
            sources.push({
                id: `source:work:${workBuildId}`,
                label: install.label,
                description: `Import packaged runtime from ${runtimeDir}`,
                kind: "work-build",
                runtimeDir,
                appVersion: install.appVersion,
                buildNumber: install.buildNumber,
                patchProfileId: install.patchProfileId,
                importable: true,
                alreadyInstalled: isInstalledRuntime(context.registry, runtimeDir),
                detail: runtimeDir,
            });
        }
        return sources;
    },
};
const windowsRuntimeDonorSourceFinder = {
    id: "windows-runtime-donor",
    findSources() {
        return (0, windows_apps_1.listWindowsCodexPackages)().map((runtimePackage) => ({
            id: `source:windows-donor:${runtimePackage.packageFullName}`,
            label: `Windows Donor ${runtimePackage.packageFullName}`,
            description: "Official Windows Codex runtime donor package.",
            kind: "windows-runtime-donor",
            runtimeDir: runtimePackage.resourcesDir,
            appVersion: "",
            buildNumber: "",
            patchProfileId: "",
            importable: false,
            alreadyInstalled: false,
            detail: runtimePackage.packageRoot,
        }));
    },
};
const defaultRuntimeSourceFinders = [
    repoDistRuntimeSourceFinder,
    workBuildRuntimeSourceFinder,
    windowsRuntimeDonorSourceFinder,
];
function discoverForgeRuntimeSources(paths, config) {
    const { registry } = (0, runtime_registry_1.ensureForgeRuntimeRegistry)(paths, config);
    const sources = defaultRuntimeSourceFinders.flatMap((finder) => finder.findSources({ paths, config, registry }));
    return sources.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}
function importForgeRuntimeSource(paths, config, sourceId) {
    const sources = discoverForgeRuntimeSources(paths, config);
    const source = sources.find((entry) => entry.id === sourceId);
    if (!source) {
        throw new Error(`Forge runtime source not found: ${sourceId}`);
    }
    if (!source.importable) {
        throw new Error(`Forge runtime source is not importable: ${sourceId}`);
    }
    return (0, runtime_registry_1.importForgeRuntimeFromDirectory)(paths, config, source.runtimeDir, {
        label: source.label,
        description: source.description,
    });
}
function importForgeRuntimeDirectory(paths, config, runtimeDir) {
    const runtimeInstall = (0, runtime_registry_1.inspectForgeRuntimeDirectory)(runtimeDir, {
        id: "manual-import",
        label: `Imported ${path.basename(runtimeDir) || "runtime"}`,
        description: `Imported manually from ${runtimeDir}`,
        source: "imported-runtime",
        capturedAtIso: "",
    });
    return (0, runtime_registry_1.importForgeRuntimeFromDirectory)(paths, config, runtimeDir, {
        label: runtimeInstall.label,
        description: runtimeInstall.description,
    });
}
function getForgeRuntimeSourceFinderIds() {
    return defaultRuntimeSourceFinders.map((finder) => finder.id);
}
