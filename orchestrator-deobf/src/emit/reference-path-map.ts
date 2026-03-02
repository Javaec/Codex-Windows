import * as fs from "node:fs";
import * as path from "node:path";
import { ArchetypeId, LayerId } from "../contracts";

interface SymbolMapEntry {
  file?: string;
}

interface SymbolMapModel {
  centralFiles?: SymbolMapEntry[];
  topClasses?: SymbolMapEntry[];
  topFunctions?: SymbolMapEntry[];
}

interface ReferencePathFamilies {
  main: Set<string>;
  renderer: Set<string>;
  services: Set<string>;
  tauri: Set<string>;
}

const ANALYSIS_FILE_NAMES = [
  "1code-symbol-map.json",
  "CodexMonitor-symbol-map.json",
];

const DEFAULT_FAMILIES: Record<LayerId, string[]> = {
  main: ["workspace", "session", "transport", "state", "events", "settings", "threads", "routing"],
  renderer: ["workspaces", "threads", "messages", "settings", "layout", "terminal", "git", "app", "prompts", "ui"],
  services: ["store", "service", "transport", "events", "session", "workspace"],
  tauri: ["backend", "workspace", "transport", "state", "events"],
};

let cachedFamilies: ReferencePathFamilies | undefined;

function sanitizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function splitTokens(value: string): string[] {
  return value
    .split(/[^a-zA-Z0-9]+/g)
    .map((token) => sanitizeToken(token))
    .filter((token) => token.length >= 3)
    .filter((token) => !/^[0-9]+$/.test(token));
}

function resolveAnalysisDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "reference", "analysis"),
    path.resolve(process.cwd(), "reference", "analysis"),
    path.resolve(process.cwd(), "..", "..", "reference", "analysis"),
    path.resolve(__dirname, "..", "..", "..", "reference", "analysis"),
  ];
  for (const candidate of candidates) {
    const firstFile = path.join(candidate, ANALYSIS_FILE_NAMES[0] ?? "");
    if (fs.existsSync(firstFile)) {
      return candidate;
    }
  }
  throw new Error("reference path map is required: analysis directory with symbol maps was not found");
}

function readSymbolMapPaths(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const model = JSON.parse(raw) as SymbolMapModel;
  const paths: string[] = [];
  const append = (entries: SymbolMapEntry[] | undefined): void => {
    for (const entry of entries ?? []) {
      if (!entry.file) {
        continue;
      }
      paths.push(entry.file.replace(/\\/g, "/"));
    }
  };
  append(model.centralFiles);
  append(model.topClasses);
  append(model.topFunctions);
  return paths;
}

function readArchitecturePaths(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const matches = raw.match(/\b(?:src|src-tauri)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|rs)\b/g) ?? [];
  return matches.map((entry) => entry.replace(/\\/g, "/"));
}

function resolveReferenceLayer(referencePath: string): LayerId | undefined {
  const normalized = referencePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("src/main/")) {
    return "main";
  }
  if (normalized.startsWith("src/renderer/")) {
    return "renderer";
  }
  if (normalized.startsWith("src/services/")) {
    return "services";
  }
  if (normalized.startsWith("src-tauri/")) {
    return "tauri";
  }
  if (normalized.startsWith("src/features/") || normalized.startsWith("src/components/") || normalized.startsWith("src/utils/")) {
    return "renderer";
  }
  return undefined;
}

function extractFamilyFromReferencePath(referencePath: string, layer: LayerId): string | undefined {
  const normalized = referencePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }

  if (layer === "main") {
    if (segments[0] === "src" && segments[1] === "main") {
      if (segments[2] === "lib" && segments[3]) {
        return sanitizeToken(segments[3]);
      }
      if (segments[2]) {
        return sanitizeToken(segments[2]);
      }
    }
    return undefined;
  }

  if (layer === "renderer") {
    if (segments[0] === "src" && segments[1] === "renderer" && segments[2] === "features" && segments[3]) {
      return sanitizeToken(segments[3]);
    }
    if (segments[0] === "src" && segments[1] === "features" && segments[2]) {
      return sanitizeToken(segments[2]);
    }
    if (segments[0] === "src" && segments[1] === "renderer" && segments[2] === "components" && segments[3]) {
      return sanitizeToken(segments[3]);
    }
    if (segments[0] === "src" && segments[1] === "components" && segments[2]) {
      return sanitizeToken(segments[2]);
    }
    return undefined;
  }

  if (layer === "services") {
    if (segments[0] === "src" && segments[1] === "services" && segments[2]) {
      return sanitizeToken(segments[2]);
    }
    return undefined;
  }

  if (segments[0] === "src-tauri" && segments[1] === "src" && segments[2]) {
    return sanitizeToken(segments[2]);
  }
  return undefined;
}

function loadReferenceFamilies(): ReferencePathFamilies {
  if (cachedFamilies) {
    return cachedFamilies;
  }

  const analysisDirectory = resolveAnalysisDirectory();
  const rawPaths: string[] = [];
  for (const fileName of ANALYSIS_FILE_NAMES) {
    const absolutePath = path.join(analysisDirectory, fileName);
    rawPaths.push(...readSymbolMapPaths(absolutePath));
  }
  rawPaths.push(...readArchitecturePaths(path.join(analysisDirectory, "1code-codexmonitor-architecture-map.md")));

  const families: ReferencePathFamilies = {
    main: new Set(DEFAULT_FAMILIES.main),
    renderer: new Set(DEFAULT_FAMILIES.renderer),
    services: new Set(DEFAULT_FAMILIES.services),
    tauri: new Set(DEFAULT_FAMILIES.tauri),
  };

  for (const referencePath of rawPaths) {
    const layer = resolveReferenceLayer(referencePath);
    if (!layer) {
      continue;
    }
    const family = extractFamilyFromReferencePath(referencePath, layer);
    if (!family || family.length < 3) {
      continue;
    }
    families[layer].add(family);
  }

  cachedFamilies = families;
  return families;
}

function fallbackFamilyByArchetype(archetype: ArchetypeId): string {
  if (archetype === "hook") {
    return "hooks";
  }
  if (archetype === "service") {
    return "service";
  }
  if (archetype === "ui") {
    return "ui";
  }
  if (archetype === "transport") {
    return "transport";
  }
  return "store";
}

function selectFamilyFromTopic(topic: string, archetype: ArchetypeId, availableFamilies: Set<string>): string {
  const topicTokens = splitTokens(topic);
  for (const token of topicTokens) {
    if (availableFamilies.has(token)) {
      return token;
    }
  }

  const heuristicCandidates = new Map<string, string[]>([
    ["workspace", ["workspaces", "workspace"]],
    ["session", ["threads", "session"]],
    ["thread", ["threads", "messages"]],
    ["chat", ["threads", "messages"]],
    ["message", ["messages", "threads"]],
    ["route", ["routing", "layout"]],
    ["navigate", ["routing", "layout"]],
    ["settings", ["settings", "preferences"]],
    ["terminal", ["terminal"]],
    ["git", ["git"]],
    ["prompt", ["prompts"]],
    ["file", ["files", "file-viewer"]],
    ["event", ["events", "transport"]],
    ["rpc", ["transport"]],
    ["ipc", ["transport"]],
    ["state", ["state", "store"]],
    ["store", ["store", "state"]],
    ["ui", ["ui", "components"]],
    ["view", ["ui", "components"]],
    ["hook", ["hooks"]],
  ]);

  for (const token of topicTokens) {
    const candidates = heuristicCandidates.get(token);
    if (!candidates) {
      continue;
    }
    for (const candidate of candidates) {
      if (availableFamilies.has(candidate)) {
        return candidate;
      }
    }
  }

  const fallback = fallbackFamilyByArchetype(archetype);
  if (availableFamilies.has(fallback)) {
    return fallback;
  }
  return fallback;
}

export function resolveReferenceAnchoredDirectory(layer: LayerId, archetype: ArchetypeId, topic: string): string {
  const families = loadReferenceFamilies();

  if (layer === "services") {
    const fixedServiceFamily = archetype === "store" ? "store" : archetype === "service" ? "service" : fallbackFamilyByArchetype(archetype);
    return `src/services/${fixedServiceFamily}`;
  }

  if (layer === "main") {
    const family = selectFamilyFromTopic(topic, archetype, families.main);
    return `src/main/lib/${family}`;
  }

  if (layer === "renderer") {
    const family = selectFamilyFromTopic(topic, archetype, families.renderer);
    return `src/renderer/features/${family}`;
  }

  const family = selectFamilyFromTopic(topic, archetype, families.tauri);
  return `src-tauri-adapter/${family}`;
}

