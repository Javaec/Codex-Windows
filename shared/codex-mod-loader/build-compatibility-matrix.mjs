import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readKnownBuilds } = require("../version-identity/index.cjs");
const { loadModCatalog, resolveRuntimeModCompatibility } = require("./compatibility.cjs");

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(MODULE_DIR, "mods");
const LOADER_ROOT = path.resolve(MODULE_DIR, "loader");
const OUTPUT_PATH = path.resolve(MODULE_DIR, "compatibility-matrix.json");

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`compat-matrix: missing ${label}: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function matchesManifestCompatibility(manifest, build) {
  const compatibility = manifest.compatibility && typeof manifest.compatibility === "object" ? manifest.compatibility : {};
  const minBuild = Number(compatibility.minBuild || 0);
  const maxBuild = Number(compatibility.maxBuild || 0);
  const appVersionRegex = typeof compatibility.appVersionRegex === "string" ? compatibility.appVersionRegex.trim() : "";
  if (minBuild > 0 && build.buildHint < minBuild) return { compatible: false, reason: `buildHint<minBuild(${minBuild})` };
  if (maxBuild > 0 && build.buildHint > maxBuild) return { compatible: false, reason: `buildHint>maxBuild(${maxBuild})` };
  if (appVersionRegex) {
    const matcher = new RegExp(appVersionRegex, "i");
    if (!matcher.test(build.appVersion)) {
      return { compatible: false, reason: `appVersion !~ /${appVersionRegex}/` };
    }
  }
  return { compatible: true, reason: "" };
}

function main() {
  const capabilityRegistry = readJson(path.join(LOADER_ROOT, "capability-registry.json"), "capability registry");
  const knownBuilds = readKnownBuilds();
  const catalog = loadModCatalog({ modsRoot: MOD_ROOT, loaderRoot: LOADER_ROOT });
  const mods = catalog.mods.map((mod) => {
    const compatibility = mod.compatibility || {};
    return {
      id: mod.id,
      name: mod.name,
      description: mod.description,
      enabled: mod.enabled,
      priority: mod.priority,
      entrypoints: Object.keys(mod.entrypoints).filter((key) => mod.entrypoints[key]).sort(),
      compatibility: {
        appVersionRegex: String(compatibility.appVersionRegex || ""),
        minBuild: Number(compatibility.minBuild || 0),
        maxBuild: Number(compatibility.maxBuild || 0),
      },
      capabilities: {
        renderer: [...mod.capabilities.renderer].sort(),
        main: [...mod.capabilities.main].sort(),
      },
      conflicts: [...mod.conflicts].sort(),
      dependencies: [...mod.dependencies].sort(),
      softIncompatibilities: [...mod.softIncompatibilities].sort(),
      loadAfter: [...mod.loadAfter].sort(),
      loadBefore: [...mod.loadBefore].sort(),
      knownBuilds: knownBuilds.map((build) => {
        const verdict = matchesManifestCompatibility({ compatibility: mod.compatibility }, build);
        return {
          id: build.id,
          appVersion: build.appVersion,
          buildNumber: build.buildNumber,
          buildHint: build.buildHint,
          patchProfileId: build.patchProfileId,
          compatible: verdict.compatible,
          reason: verdict.reason,
        };
      }),
    };
  });

  const matrix = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    capabilityRegistry: {
      renderer: Array.isArray(capabilityRegistry.renderer) ? capabilityRegistry.renderer : [],
      main: Array.isArray(capabilityRegistry.main) ? capabilityRegistry.main : [],
    },
    knownBuilds,
    mods,
    builds: knownBuilds.map((build) => {
      const runtimeCompatibility = resolveRuntimeModCompatibility({
        modsRoot: MOD_ROOT,
        loaderRoot: LOADER_ROOT,
        snapshotLabel: build.id,
        appVersion: build.appVersion,
        buildNumber: build.buildNumber,
      });
      return {
        id: build.id,
        appVersion: build.appVersion,
        buildNumber: build.buildNumber,
        buildHint: build.buildHint,
        patchProfileId: build.patchProfileId,
        compatibleMods: runtimeCompatibility.selectedModIds,
        incompatibleMods: runtimeCompatibility.incompatibleMods,
        loadOrder: runtimeCompatibility.loadOrder,
        softIncompatibilities: runtimeCompatibility.softIncompatibilities,
        recommendedDisabledMods: runtimeCompatibility.recommendedDisabledMods,
      };
    }),
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath: OUTPUT_PATH, modCount: mods.length, knownBuildCount: knownBuilds.length }, null, 2)}\n`);
}

main();
