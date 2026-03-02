import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ArchetypeId, LayerId } from "../contracts";
import { readJsonFile } from "../utils/fs-json";

export const MANUAL_SYNC_CONTRACT_VERSION = 2;
export const MANUAL_SYNC_MIGRATION_VERSION = 1;

export interface ManualSyncSymbolFingerprint {
  version: number;
  role: string;
  apiShape: string;
  mutationProfile: string;
  parameterCount: number;
  incomingBucket: number;
  outgoingBucket: number;
  stateTokens: string[];
  callTokens: string[];
}

export interface ManualSyncSymbolNameOverride {
  symbolKey: string;
  preferredName: string;
  confidence: number;
  evidence?: string;
  provenance: string;
  updatedAtIso: string;
  symbolFingerprint?: ManualSyncSymbolFingerprint;
  enabled?: boolean;
}

export interface ManualSyncSymbolNameOverridesModel {
  contractVersion: number;
  migrationVersion: number;
  generatedAtIso: string;
  overrides: ManualSyncSymbolNameOverride[];
}

export interface ManualSyncModulePathOverride {
  symbolKey: string;
  filePath: string;
  layer?: LayerId;
  archetype?: ArchetypeId;
  topic?: string;
  confidence: number;
  evidence?: string;
  provenance: string;
  updatedAtIso: string;
  symbolFingerprint?: ManualSyncSymbolFingerprint;
  enabled?: boolean;
}

export interface ManualSyncModulePathOverridesModel {
  contractVersion: number;
  migrationVersion: number;
  generatedAtIso: string;
  overrides: ManualSyncModulePathOverride[];
}

export interface ManualSyncModuleSurfaceOverride {
  moduleFilePath: string;
  ownerLayer: LayerId;
  archetype?: ArchetypeId;
  exportSurface: string[];
  symbolKeys: string[];
  confidence: number;
  evidence?: string;
  provenance: string;
  updatedAtIso: string;
  enabled?: boolean;
}

export interface ManualSyncModuleSurfaceOverridesModel {
  contractVersion: number;
  migrationVersion: number;
  generatedAtIso: string;
  overrides: ManualSyncModuleSurfaceOverride[];
}

export interface ManualSyncPaths {
  rootPath: string;
  symbolNameOverridesPath: string;
  modulePathOverridesPath: string;
  moduleSurfaceOverridesPath: string;
  exportReportPath: string;
  contractChangelogPath: string;
}

const ARCHETYPE_KEYWORDS: Array<{ token: string; archetype: ArchetypeId }> = [
  { token: "hook", archetype: "hook" },
  { token: "service", archetype: "service" },
  { token: "transport", archetype: "transport" },
  { token: "store", archetype: "store" },
  { token: "ui", archetype: "ui" },
];

function assertValidIsoDate(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}: invalid ISO date "${value}"`);
  }
}

export function defaultManualSyncRootPath(projectRoot: string): string {
  return path.join(projectRoot, "shared", "manual-sync");
}

export function resolveManualSyncPaths(projectRoot: string, explicitRootPath: string): ManualSyncPaths {
  const rootPath = path.resolve(explicitRootPath || defaultManualSyncRootPath(projectRoot));
  return {
    rootPath,
    symbolNameOverridesPath: path.join(rootPath, "symbol-name-overrides.json"),
    modulePathOverridesPath: path.join(rootPath, "module-path-overrides.json"),
    moduleSurfaceOverridesPath: path.join(rootPath, "module-surface-overrides.json"),
    exportReportPath: path.join(rootPath, "last-export-report.json"),
    contractChangelogPath: path.join(rootPath, "contract-changelog.md"),
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

export async function readManualSyncSymbolNameOverrides(
  filePath: string,
): Promise<ManualSyncSymbolNameOverridesModel | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  const model = await readJsonFile<ManualSyncSymbolNameOverridesModel>(filePath);
  if (!model || !Array.isArray(model.overrides)) {
    throw new Error(`readManualSyncSymbolNameOverrides: invalid model at ${filePath}`);
  }
  if (model.contractVersion !== MANUAL_SYNC_CONTRACT_VERSION) {
    throw new Error(
      `readManualSyncSymbolNameOverrides: unsupported contractVersion ${String(model.contractVersion)} at ${filePath}; expected ${MANUAL_SYNC_CONTRACT_VERSION}. Run manual-sync migration.`,
    );
  }
  if (model.migrationVersion !== MANUAL_SYNC_MIGRATION_VERSION) {
    throw new Error(
      `readManualSyncSymbolNameOverrides: unsupported migrationVersion ${String(model.migrationVersion)} at ${filePath}; expected ${MANUAL_SYNC_MIGRATION_VERSION}. Run manual-sync migration.`,
    );
  }
  for (const entry of model.overrides) {
    if (!entry || entry.enabled === false) {
      continue;
    }
    if (typeof entry.symbolKey !== "string" || entry.symbolKey.trim().length < 1) {
      throw new Error(`readManualSyncSymbolNameOverrides: missing symbolKey in ${filePath}`);
    }
    if (typeof entry.preferredName !== "string" || entry.preferredName.trim().length < 1) {
      throw new Error(`readManualSyncSymbolNameOverrides: missing preferredName for ${entry.symbolKey}`);
    }
    if (typeof entry.provenance !== "string" || entry.provenance.trim().length < 1) {
      throw new Error(`readManualSyncSymbolNameOverrides: missing provenance for ${entry.symbolKey}`);
    }
    if (typeof entry.updatedAtIso !== "string" || entry.updatedAtIso.trim().length < 1) {
      throw new Error(`readManualSyncSymbolNameOverrides: missing updatedAtIso for ${entry.symbolKey}`);
    }
    assertValidIsoDate(entry.updatedAtIso, `readManualSyncSymbolNameOverrides:${entry.symbolKey}:updatedAtIso`);
    if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence)) {
      throw new Error(`readManualSyncSymbolNameOverrides: missing confidence for ${entry.symbolKey}`);
    }
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new Error(`readManualSyncSymbolNameOverrides: confidence out of range for ${entry.symbolKey}`);
    }
  }
  return model;
}

export async function readManualSyncModulePathOverrides(
  filePath: string,
): Promise<ManualSyncModulePathOverridesModel | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  const model = await readJsonFile<ManualSyncModulePathOverridesModel>(filePath);
  if (!model || !Array.isArray(model.overrides)) {
    throw new Error(`readManualSyncModulePathOverrides: invalid model at ${filePath}`);
  }
  if (model.contractVersion !== MANUAL_SYNC_CONTRACT_VERSION) {
    throw new Error(
      `readManualSyncModulePathOverrides: unsupported contractVersion ${String(model.contractVersion)} at ${filePath}; expected ${MANUAL_SYNC_CONTRACT_VERSION}. Run manual-sync migration.`,
    );
  }
  if (model.migrationVersion !== MANUAL_SYNC_MIGRATION_VERSION) {
    throw new Error(
      `readManualSyncModulePathOverrides: unsupported migrationVersion ${String(model.migrationVersion)} at ${filePath}; expected ${MANUAL_SYNC_MIGRATION_VERSION}. Run manual-sync migration.`,
    );
  }
  for (const entry of model.overrides) {
    if (!entry || entry.enabled === false) {
      continue;
    }
    if (typeof entry.symbolKey !== "string" || entry.symbolKey.trim().length < 1) {
      throw new Error(`readManualSyncModulePathOverrides: missing symbolKey in ${filePath}`);
    }
    if (typeof entry.filePath !== "string" || entry.filePath.trim().length < 1) {
      throw new Error(`readManualSyncModulePathOverrides: missing filePath for ${entry.symbolKey}`);
    }
    if (typeof entry.provenance !== "string" || entry.provenance.trim().length < 1) {
      throw new Error(`readManualSyncModulePathOverrides: missing provenance for ${entry.symbolKey}`);
    }
    if (typeof entry.updatedAtIso !== "string" || entry.updatedAtIso.trim().length < 1) {
      throw new Error(`readManualSyncModulePathOverrides: missing updatedAtIso for ${entry.symbolKey}`);
    }
    assertValidIsoDate(entry.updatedAtIso, `readManualSyncModulePathOverrides:${entry.symbolKey}:updatedAtIso`);
    if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence)) {
      throw new Error(`readManualSyncModulePathOverrides: missing confidence for ${entry.symbolKey}`);
    }
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new Error(`readManualSyncModulePathOverrides: confidence out of range for ${entry.symbolKey}`);
    }
  }
  return model;
}

export async function readManualSyncModuleSurfaceOverrides(
  filePath: string,
): Promise<ManualSyncModuleSurfaceOverridesModel | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  const model = await readJsonFile<ManualSyncModuleSurfaceOverridesModel>(filePath);
  if (!model || !Array.isArray(model.overrides)) {
    throw new Error(`readManualSyncModuleSurfaceOverrides: invalid model at ${filePath}`);
  }
  if (model.contractVersion !== MANUAL_SYNC_CONTRACT_VERSION) {
    throw new Error(
      `readManualSyncModuleSurfaceOverrides: unsupported contractVersion ${String(model.contractVersion)} at ${filePath}; expected ${MANUAL_SYNC_CONTRACT_VERSION}. Run manual-sync migration.`,
    );
  }
  if (model.migrationVersion !== MANUAL_SYNC_MIGRATION_VERSION) {
    throw new Error(
      `readManualSyncModuleSurfaceOverrides: unsupported migrationVersion ${String(model.migrationVersion)} at ${filePath}; expected ${MANUAL_SYNC_MIGRATION_VERSION}. Run manual-sync migration.`,
    );
  }
  for (const entry of model.overrides) {
    if (!entry || entry.enabled === false) {
      continue;
    }
    if (typeof entry.moduleFilePath !== "string" || entry.moduleFilePath.trim().length < 1) {
      throw new Error("readManualSyncModuleSurfaceOverrides: missing moduleFilePath");
    }
    const normalizedFilePath = normalizeModuleFilePath(entry.moduleFilePath);
    if (typeof entry.ownerLayer !== "string" || entry.ownerLayer.trim().length < 1) {
      throw new Error(`readManualSyncModuleSurfaceOverrides: missing ownerLayer for ${normalizedFilePath}`);
    }
    const inferredLayer = inferLayerFromModuleFilePath(normalizedFilePath);
    if (inferredLayer && entry.ownerLayer !== inferredLayer) {
      throw new Error(
        `readManualSyncModuleSurfaceOverrides: ownerLayer mismatch for ${normalizedFilePath}: entry=${entry.ownerLayer} inferred=${inferredLayer}`,
      );
    }
    const inferredArchetype = inferArchetypeFromModuleFilePath(normalizedFilePath);
    if (entry.archetype && inferredArchetype && entry.archetype !== inferredArchetype) {
      throw new Error(
        `readManualSyncModuleSurfaceOverrides: archetype mismatch for ${normalizedFilePath}: entry=${entry.archetype} inferred=${inferredArchetype}`,
      );
    }
    if (!Array.isArray(entry.exportSurface) || entry.exportSurface.length < 1) {
      throw new Error(
        `readManualSyncModuleSurfaceOverrides: exportSurface must contain at least one export for ${normalizedFilePath}`,
      );
    }
    if (!Array.isArray(entry.symbolKeys)) {
      throw new Error(`readManualSyncModuleSurfaceOverrides: symbolKeys must be an array for ${normalizedFilePath}`);
    }
    for (const exportName of entry.exportSurface) {
      if (typeof exportName !== "string" || exportName.trim().length < 1) {
        throw new Error(
          `readManualSyncModuleSurfaceOverrides: exportSurface contains empty export name for ${normalizedFilePath}`,
        );
      }
    }
    for (const symbolKey of entry.symbolKeys) {
      if (typeof symbolKey !== "string" || symbolKey.trim().length < 1) {
        throw new Error(
          `readManualSyncModuleSurfaceOverrides: symbolKeys contains empty key for ${normalizedFilePath}`,
        );
      }
    }
    if (typeof entry.provenance !== "string" || entry.provenance.trim().length < 1) {
      throw new Error(`readManualSyncModuleSurfaceOverrides: missing provenance for ${normalizedFilePath}`);
    }
    if (typeof entry.updatedAtIso !== "string" || entry.updatedAtIso.trim().length < 1) {
      throw new Error(`readManualSyncModuleSurfaceOverrides: missing updatedAtIso for ${normalizedFilePath}`);
    }
    assertValidIsoDate(
      entry.updatedAtIso,
      `readManualSyncModuleSurfaceOverrides:${normalizedFilePath}:updatedAtIso`,
    );
    if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence)) {
      throw new Error(`readManualSyncModuleSurfaceOverrides: missing confidence for ${normalizedFilePath}`);
    }
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new Error(`readManualSyncModuleSurfaceOverrides: confidence out of range for ${normalizedFilePath}`);
    }
  }
  return model;
}

export function normalizeModuleFilePath(filePathValue: string): string {
  const normalized = filePathValue.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized.endsWith(".ts")) {
    throw new Error(`normalizeModuleFilePath: expected .ts path, got ${filePathValue}`);
  }
  if (normalized.startsWith("src/") || normalized.startsWith("src-tauri-adapter/")) {
    return normalized;
  }
  throw new Error(
    `normalizeModuleFilePath: file path must start with src/ or src-tauri-adapter/, got ${filePathValue}`,
  );
}

export function inferLayerFromModuleFilePath(filePathValue: string): LayerId | undefined {
  const normalized = normalizeModuleFilePath(filePathValue);
  if (normalized.startsWith("src/main/")) {
    return "main";
  }
  if (normalized.startsWith("src/renderer/")) {
    return "renderer";
  }
  if (normalized.startsWith("src/services/")) {
    return "services";
  }
  if (normalized.startsWith("src-tauri-adapter/")) {
    return "tauri";
  }
  return undefined;
}

export function inferArchetypeFromModuleFilePath(filePathValue: string): ArchetypeId | undefined {
  const normalized = normalizeModuleFilePath(filePathValue).toLowerCase();
  for (const keyword of ARCHETYPE_KEYWORDS) {
    if (normalized.includes(`/${keyword.token}/`) || normalized.includes(`-${keyword.token}-`)) {
      return keyword.archetype;
    }
  }
  const fileName = path.basename(normalized, ".ts");
  if (fileName.startsWith("hook-") || fileName.startsWith("use-")) {
    return "hook";
  }
  if (fileName.startsWith("service-")) {
    return "service";
  }
  if (fileName.startsWith("store-")) {
    return "store";
  }
  if (fileName.startsWith("transport-")) {
    return "transport";
  }
  return undefined;
}
