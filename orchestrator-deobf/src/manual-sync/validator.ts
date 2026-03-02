import * as path from "node:path";
import { isGenericName, isIdentifierName } from "../ir/name-quality";
import {
  defaultManualSyncRootPath,
  fileExists,
  inferArchetypeFromModuleFilePath,
  inferLayerFromModuleFilePath,
  normalizeModuleFilePath,
  readManualSyncModuleSurfaceOverrides,
  readManualSyncModulePathOverrides,
  readManualSyncSymbolNameOverrides,
  resolveManualSyncPaths,
} from "./contracts";

export interface ManualSyncValidationIssue {
  kind: "error" | "warning";
  source: "symbol-name-overrides" | "module-path-overrides" | "module-surface-overrides";
  message: string;
}

export interface ManualSyncValidationSummary {
  rootPath: string;
  symbolOverrides: number;
  modulePathOverrides: number;
  moduleSurfaceOverrides: number;
  errorCount: number;
  warningCount: number;
}

export interface ManualSyncValidationResult {
  summary: ManualSyncValidationSummary;
  errors: ManualSyncValidationIssue[];
  warnings: ManualSyncValidationIssue[];
}

export interface ManualSyncValidationOptions {
  requireFiles: boolean;
}

function validateConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateIsoDateString(value: string): boolean {
  if (value.trim().length < 1) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export async function validateManualSyncContracts(
  projectRoot: string,
  manualSyncRootPath: string,
  options?: Partial<ManualSyncValidationOptions>,
): Promise<ManualSyncValidationResult> {
  const resolvedRootPath =
    manualSyncRootPath.trim().length > 0
      ? path.resolve(manualSyncRootPath)
      : defaultManualSyncRootPath(projectRoot);
  const manualSyncPaths = resolveManualSyncPaths(projectRoot, resolvedRootPath);
  const requireFiles = options?.requireFiles === true;
  const issues: ManualSyncValidationIssue[] = [];

  const symbolExists = await fileExists(manualSyncPaths.symbolNameOverridesPath);
  const pathExists = await fileExists(manualSyncPaths.modulePathOverridesPath);
  const surfaceExists = await fileExists(manualSyncPaths.moduleSurfaceOverridesPath);
  if (requireFiles && !symbolExists) {
    issues.push({
      kind: "error",
      source: "symbol-name-overrides",
      message: `Missing required file ${manualSyncPaths.symbolNameOverridesPath}`,
    });
  }
  if (requireFiles && !pathExists) {
    issues.push({
      kind: "error",
      source: "module-path-overrides",
      message: `Missing required file ${manualSyncPaths.modulePathOverridesPath}`,
    });
  }
  if (requireFiles && !surfaceExists) {
    issues.push({
      kind: "error",
      source: "module-surface-overrides",
      message: `Missing required file ${manualSyncPaths.moduleSurfaceOverridesPath}`,
    });
  }

  let symbolModel: Awaited<ReturnType<typeof readManualSyncSymbolNameOverrides>> | undefined;
  let moduleModel: Awaited<ReturnType<typeof readManualSyncModulePathOverrides>> | undefined;
  let surfaceModel: Awaited<ReturnType<typeof readManualSyncModuleSurfaceOverrides>> | undefined;
  if (symbolExists) {
    try {
      symbolModel = await readManualSyncSymbolNameOverrides(manualSyncPaths.symbolNameOverridesPath);
    } catch (error) {
      issues.push({
        kind: "error",
        source: "symbol-name-overrides",
        message: (error as Error).message,
      });
    }
  }
  if (surfaceExists) {
    try {
      surfaceModel = await readManualSyncModuleSurfaceOverrides(manualSyncPaths.moduleSurfaceOverridesPath);
    } catch (error) {
      issues.push({
        kind: "error",
        source: "module-surface-overrides",
        message: (error as Error).message,
      });
    }
  }
  if (pathExists) {
    try {
      moduleModel = await readManualSyncModulePathOverrides(manualSyncPaths.modulePathOverridesPath);
    } catch (error) {
      issues.push({
        kind: "error",
        source: "module-path-overrides",
        message: (error as Error).message,
      });
    }
  }

  const seenSymbolKeys = new Set<string>();
  if (symbolModel) {
    for (const entry of symbolModel.overrides) {
      if (!entry.enabled && typeof entry.enabled === "boolean") {
        continue;
      }
      if (seenSymbolKeys.has(entry.symbolKey)) {
        issues.push({
          kind: "error",
          source: "symbol-name-overrides",
          message: `Duplicate symbolKey: ${entry.symbolKey}`,
        });
      } else {
        seenSymbolKeys.add(entry.symbolKey);
      }
      if (entry.symbolKey.trim().length < 1) {
        issues.push({
          kind: "error",
          source: "symbol-name-overrides",
          message: "Empty symbolKey",
        });
      }
      if (!isIdentifierName(entry.preferredName)) {
        issues.push({
          kind: "error",
          source: "symbol-name-overrides",
          message: `Invalid identifier preferredName for ${entry.symbolKey}: ${entry.preferredName}`,
        });
      }
      if (!validateConfidence(entry.confidence)) {
        issues.push({
          kind: "error",
          source: "symbol-name-overrides",
          message: `Invalid confidence for ${entry.symbolKey}: ${String(entry.confidence)}`,
        });
      }
      if (entry.provenance.trim().length < 1) {
        issues.push({
          kind: "error",
          source: "symbol-name-overrides",
          message: `Missing provenance for ${entry.symbolKey}`,
        });
      }
      if (!validateIsoDateString(entry.updatedAtIso)) {
        issues.push({
          kind: "error",
          source: "symbol-name-overrides",
          message: `Invalid updatedAtIso for ${entry.symbolKey}: ${entry.updatedAtIso}`,
        });
      }
      if (isGenericName(entry.preferredName)) {
        issues.push({
          kind: "warning",
          source: "symbol-name-overrides",
          message: `Low-quality generic preferredName for ${entry.symbolKey}: ${entry.preferredName}`,
        });
      }
    }
  }

  const seenModulePathKeys = new Set<string>();
  if (moduleModel) {
    for (const entry of moduleModel.overrides) {
      if (!entry.enabled && typeof entry.enabled === "boolean") {
        continue;
      }
      if (seenModulePathKeys.has(entry.symbolKey)) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Duplicate symbolKey: ${entry.symbolKey}`,
        });
      } else {
        seenModulePathKeys.add(entry.symbolKey);
      }
      if (entry.symbolKey.trim().length < 1) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: "Empty symbolKey",
        });
      }
      if (!validateConfidence(entry.confidence)) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Invalid confidence for ${entry.symbolKey}: ${String(entry.confidence)}`,
        });
      }
      if (entry.provenance.trim().length < 1) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Missing provenance for ${entry.symbolKey}`,
        });
      }
      if (!validateIsoDateString(entry.updatedAtIso)) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Invalid updatedAtIso for ${entry.symbolKey}: ${entry.updatedAtIso}`,
        });
      }
      let normalizedFilePath = "";
      try {
        normalizedFilePath = normalizeModuleFilePath(entry.filePath);
      } catch (error) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Invalid filePath for ${entry.symbolKey}: ${(error as Error).message}`,
        });
      }
      if (normalizedFilePath.length < 1) {
        continue;
      }
      const inferredLayer = inferLayerFromModuleFilePath(normalizedFilePath);
      if (entry.layer && inferredLayer && entry.layer !== inferredLayer) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Layer mismatch for ${entry.symbolKey}: entry=${entry.layer} inferred=${inferredLayer} path=${normalizedFilePath}`,
        });
      }
      const inferredArchetype = inferArchetypeFromModuleFilePath(normalizedFilePath);
      if (entry.archetype && inferredArchetype && entry.archetype !== inferredArchetype) {
        issues.push({
          kind: "error",
          source: "module-path-overrides",
          message: `Archetype mismatch for ${entry.symbolKey}: entry=${entry.archetype} inferred=${inferredArchetype} path=${normalizedFilePath}`,
        });
      }
    }
  }

  const seenSurfaceModulePaths = new Set<string>();
  if (surfaceModel) {
    for (const entry of surfaceModel.overrides) {
      if (!entry.enabled && typeof entry.enabled === "boolean") {
        continue;
      }
      const normalizedFilePath = normalizeModuleFilePath(entry.moduleFilePath);
      if (seenSurfaceModulePaths.has(normalizedFilePath)) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `Duplicate moduleFilePath: ${normalizedFilePath}`,
        });
      } else {
        seenSurfaceModulePaths.add(normalizedFilePath);
      }
      if (!validateConfidence(entry.confidence)) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `Invalid confidence for ${normalizedFilePath}: ${String(entry.confidence)}`,
        });
      }
      if (entry.provenance.trim().length < 1) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `Missing provenance for ${normalizedFilePath}`,
        });
      }
      if (!validateIsoDateString(entry.updatedAtIso)) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `Invalid updatedAtIso for ${normalizedFilePath}: ${entry.updatedAtIso}`,
        });
      }
      const inferredLayer = inferLayerFromModuleFilePath(normalizedFilePath);
      if (inferredLayer && inferredLayer !== entry.ownerLayer) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `ownerLayer mismatch for ${normalizedFilePath}: entry=${entry.ownerLayer} inferred=${inferredLayer}`,
        });
      }
      const inferredArchetype = inferArchetypeFromModuleFilePath(normalizedFilePath);
      if (entry.archetype && inferredArchetype && entry.archetype !== inferredArchetype) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `Archetype mismatch for ${normalizedFilePath}: entry=${entry.archetype} inferred=${inferredArchetype}`,
        });
      }
      const nonEmptyExports = entry.exportSurface
        .filter((exportName) => typeof exportName === "string")
        .map((exportName) => exportName.trim())
        .filter((exportName) => exportName.length > 0);
      if (nonEmptyExports.length < 1) {
        issues.push({
          kind: "error",
          source: "module-surface-overrides",
          message: `Empty exportSurface for ${normalizedFilePath}`,
        });
      }
    }
  }

  const errors = issues.filter((issue) => issue.kind === "error");
  const warnings = issues.filter((issue) => issue.kind === "warning");
  return {
    summary: {
      rootPath: manualSyncPaths.rootPath,
      symbolOverrides: symbolModel ? symbolModel.overrides.length : 0,
      modulePathOverrides: moduleModel ? moduleModel.overrides.length : 0,
      moduleSurfaceOverrides: surfaceModel ? surfaceModel.overrides.length : 0,
      errorCount: errors.length,
      warningCount: warnings.length,
    },
    errors,
    warnings,
  };
}
