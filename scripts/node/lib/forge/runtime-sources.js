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
const path = __importStar(require("node:path"));
const windows_apps_1 = require("../runtime-donor/windows-apps");
const runtime_registry_1 = require("./runtime-registry");
function isInstalledRuntime(registry, runtimeDir) {
    const normalizedRuntimeDir = path.resolve(runtimeDir).toLowerCase();
    return registry.installs.some((install) => {
        const originPath = path.resolve(install.originPath || install.runtimeDir).toLowerCase();
        return originPath === normalizedRuntimeDir;
    });
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
                finderId: "repo-dist",
                fingerprint: `repo-dist:${path.resolve(context.paths.repoDistRuntimeDir).toLowerCase()}`,
                label: "Repo Dist Runtime",
                description: "Current repo-backed dist runtime source.",
                kind: "repo-dist",
                runtimeDir: context.paths.repoDistRuntimeDir,
                appVersion: repoDistInstall.appVersion,
                buildNumber: repoDistInstall.buildNumber,
                patchProfileId: repoDistInstall.patchProfileId,
                importable: false,
                alreadyInstalled: true,
                recommendation: "managed",
                detail: "Already managed as repo-dist-current",
            }];
    },
};
const windowsRuntimeDonorSourceFinder = {
    id: "windows-runtime-donor",
    findSources(context) {
        return (0, windows_apps_1.listWindowsCodexPackages)().map((runtimePackage) => ({
            id: `source:windows-donor:${runtimePackage.packageFullName}`,
            finderId: "windows-runtime-donor",
            fingerprint: `windows-donor:${runtimePackage.packageFullName.toLowerCase()}`,
            label: `Official Windows Codex ${runtimePackage.packageVersion}`,
            description: "Official Windows Codex package available from WindowsApps.",
            kind: "windows-runtime-donor",
            runtimeDir: runtimePackage.appDir,
            appVersion: runtimePackage.packageVersion,
            buildNumber: "",
            patchProfileId: "",
            importable: true,
            alreadyInstalled: isInstalledRuntime(context.registry, runtimePackage.appDir),
            recommendation: isInstalledRuntime(context.registry, runtimePackage.appDir) ? "managed" : "recommended-import",
            detail: runtimePackage.packageRoot,
        }));
    },
};
const defaultRuntimeSourceFinders = [
    repoDistRuntimeSourceFinder,
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
        buildMetadata: {
            appVersion: source.appVersion,
            buildNumber: source.buildNumber,
            patchProfileId: source.patchProfileId,
            codexCliSource: source.kind === "windows-runtime-donor" ? "windows-runtime-donor" : "",
            importSourceKind: source.kind,
            importSourceDetail: source.detail,
        },
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
        buildMetadata: {
            appVersion: runtimeInstall.appVersion,
            buildNumber: runtimeInstall.buildNumber,
            patchProfileId: runtimeInstall.patchProfileId,
            codexCliSource: runtimeInstall.cliSource,
            importSourceKind: "manual-directory",
            importSourceDetail: runtimeDir,
        },
    });
}
function getForgeRuntimeSourceFinderIds() {
    return defaultRuntimeSourceFinders.map((finder) => finder.id);
}
