import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readKnownBuilds } = require("../version-identity/index.cjs");

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
  const modEntries = fs
    .readdirSync(MOD_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const mods = modEntries.map((modId) => {
    const manifest = readJson(path.join(MOD_ROOT, modId, "mod.json"), `mod ${modId}`);
    const compatibility = manifest.compatibility && typeof manifest.compatibility === "object" ? manifest.compatibility : {};
    return {
      id: modId,
      name: String(manifest.name || ""),
      description: String(manifest.description || ""),
      enabled: manifest.enabled !== false,
      priority: Number(manifest.priority || 0),
      entrypoints: Object.keys(manifest.entrypoints || {}).sort(),
      compatibility: {
        appVersionRegex: String(compatibility.appVersionRegex || ""),
        minBuild: Number(compatibility.minBuild || 0),
        maxBuild: Number(compatibility.maxBuild || 0),
      },
      capabilities: {
        renderer: Array.isArray(manifest.requiresCapabilities?.renderer) ? [...manifest.requiresCapabilities.renderer].sort() : [],
        main: Array.isArray(manifest.requiresCapabilities?.main) ? [...manifest.requiresCapabilities.main].sort() : [],
      },
      conflicts: Array.isArray(manifest.conflicts) ? [...manifest.conflicts].sort() : [],
      knownBuilds: knownBuilds.map((build) => {
        const verdict = matchesManifestCompatibility(manifest, build);
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
    builds: knownBuilds.map((build) => ({
      id: build.id,
      appVersion: build.appVersion,
      buildNumber: build.buildNumber,
      buildHint: build.buildHint,
      patchProfileId: build.patchProfileId,
      compatibleMods: mods.filter((mod) => mod.knownBuilds.some((item) => item.id === build.id && item.compatible)).map((mod) => mod.id),
      incompatibleMods: mods.filter((mod) => mod.knownBuilds.some((item) => item.id === build.id && !item.compatible)).map((mod) => mod.id),
    })),
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath: OUTPUT_PATH, modCount: mods.length, knownBuildCount: knownBuilds.length }, null, 2)}\n`);
}

main();
