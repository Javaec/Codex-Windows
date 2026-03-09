import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";
import { ForgePaths } from "./paths";

const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs")) as {
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

export type ForgeDiscoveredModContainer = {
  id: string;
  name: string;
  description: string;
  version: string;
  authors: string[];
  contact: Record<string, string>;
  licenses: string[];
  environment: string;
  iconPath: string;
  provides: string[];
  priority: number;
  enabledInManifest: boolean;
  entrypoints: string[];
  lane: "main" | "renderer" | "mixed";
  capabilities: string[];
  manifestPath: string;
  rootPath: string;
  codeSourcePaths: string[];
  origin: {
    kind: "directory";
    paths: string[];
  };
  builtin: false;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeContact(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = normalizeString(raw);
    if (!key || !normalized) continue;
    out[key] = normalized;
  }
  return out;
}

function readRawManifest(filePath: string): Record<string, unknown> {
  if (!fileExists(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function collectEntrypoints(entrypoints: { renderer: string; main: string }): string[] {
  const out: string[] = [];
  if (entrypoints.main) out.push("main");
  if (entrypoints.renderer) out.push("renderer");
  return out;
}

function detectLane(entrypoints: { renderer: string; main: string }): ForgeDiscoveredModContainer["lane"] {
  if (entrypoints.renderer && entrypoints.main) return "mixed";
  if (entrypoints.main) return "main";
  return "renderer";
}

export function discoverForgeMods(paths: ForgePaths): ForgeDiscoveredModContainer[] {
  const catalog = compatibility.loadModCatalog({
    modsRoot: paths.sourceModsRoot,
    loaderRoot: paths.sourceModLoaderRoot,
  });

  return catalog.mods
    .map((mod) => {
      const rawManifest = readRawManifest(mod.manifestPath);
      const rootPath = path.dirname(mod.manifestPath);
      const iconPath = normalizeString(rawManifest.icon);
      return {
        id: mod.id,
        name: mod.name,
        description: mod.description,
        version: normalizeString(rawManifest.version) || "0.0.0-local",
        authors: normalizeStringList(rawManifest.authors),
        contact: normalizeContact(rawManifest.contact),
        licenses: normalizeStringList(Array.isArray(rawManifest.license) ? rawManifest.license : [rawManifest.license].filter(Boolean)),
        environment: normalizeString(rawManifest.environment) || "*",
        iconPath: iconPath ? path.join(rootPath, iconPath) : "",
        provides: normalizeStringList(rawManifest.provides),
        priority: mod.priority,
        enabledInManifest: mod.enabled,
        entrypoints: collectEntrypoints(mod.entrypoints),
        lane: detectLane(mod.entrypoints),
        capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
        manifestPath: mod.manifestPath,
        rootPath,
        codeSourcePaths: [rootPath],
        origin: {
          kind: "directory" as const,
          paths: [rootPath],
        },
        builtin: false as const,
      };
    })
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}
