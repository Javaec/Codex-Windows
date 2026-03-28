import * as path from "node:path";
import { ForgePaths } from "./paths";

const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs")) as {
  loadModCatalog: (options: { modsRoot: string; loaderRoot: string }) => {
    mods: Array<{
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
      enabled: boolean;
      priority: number;
      entrypoints: { renderer: string[]; main: string[] };
      capabilities: { renderer: string[]; main: string[] };
      rootPath: string;
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

function collectEntrypoints(entrypoints: { renderer: string[]; main: string[] }): string[] {
  const out: string[] = [];
  if (entrypoints.main.length > 0) out.push("main");
  if (entrypoints.renderer.length > 0) out.push("renderer");
  return out;
}

function detectLane(entrypoints: { renderer: string[]; main: string[] }): ForgeDiscoveredModContainer["lane"] {
  if (entrypoints.renderer.length > 0 && entrypoints.main.length > 0) return "mixed";
  if (entrypoints.main.length > 0) return "main";
  return "renderer";
}

export function discoverForgeMods(paths: ForgePaths): ForgeDiscoveredModContainer[] {
  const catalog = compatibility.loadModCatalog({
    modsRoot: paths.sourceModsRoot,
    loaderRoot: paths.sourceModLoaderRoot,
  });

  return catalog.mods
    .map((mod) => {
      return {
        id: mod.id,
        name: mod.name,
        description: mod.description,
        version: mod.version || "0.0.0-local",
        authors: [...mod.authors],
        contact: { ...mod.contact },
        licenses: [...mod.licenses],
        environment: mod.environment || "*",
        iconPath: mod.iconPath ? path.join(mod.rootPath, mod.iconPath) : "",
        provides: [...mod.provides],
        priority: mod.priority,
        enabledInManifest: mod.enabled,
        entrypoints: collectEntrypoints(mod.entrypoints),
        lane: detectLane(mod.entrypoints),
        capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
        manifestPath: mod.manifestPath,
        rootPath: mod.rootPath,
        codeSourcePaths: [mod.rootPath],
        origin: {
          kind: "directory" as const,
          paths: [mod.rootPath],
        },
        builtin: false as const,
      };
    })
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}
