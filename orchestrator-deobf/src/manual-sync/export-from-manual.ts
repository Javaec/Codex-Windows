import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { isGenericName, isIdentifierName, scoreNameQuality } from "../ir/name-quality";
import {
  MANUAL_SYNC_CONTRACT_VERSION,
  MANUAL_SYNC_MIGRATION_VERSION,
  ManualSyncModuleSurfaceOverride,
  ManualSyncModuleSurfaceOverridesModel,
  ManualSyncModulePathOverride,
  ManualSyncModulePathOverridesModel,
  ManualSyncPaths,
  ManualSyncSymbolFingerprint,
  ManualSyncSymbolNameOverride,
  ManualSyncSymbolNameOverridesModel,
  defaultManualSyncRootPath,
  inferArchetypeFromModuleFilePath,
  inferLayerFromModuleFilePath,
  normalizeModuleFilePath,
  readManualSyncModuleSurfaceOverrides,
  readManualSyncModulePathOverrides,
  readManualSyncSymbolNameOverrides,
  resolveManualSyncPaths,
} from "./contracts";
import { resolveSymbolByManualFingerprint } from "./fingerprint";
import { appendManualSyncChangelog, ManualSyncChangelogEntry } from "./changelog";
import { writeJsonFile } from "../utils/fs-json";

interface CliOptions {
  generatedProjectPath: string;
  manualProjectPath: string;
  manualSyncRootPath: string;
  mergedEvidencePath?: string;
  promotionTopN: number;
  pathSurfaceOnly: boolean;
  topHotLimit: number;
  topHotReportPath: string;
}

interface ManualSyncSymbolExportEntry {
  symbolKey: string;
  exportName: string;
  localIdentifier: string;
  chunkId: string;
  sourceIdentifier: string;
  symbolFingerprint: ManualSyncSymbolFingerprint;
}

interface ManualSyncModuleExportIndexEntry {
  moduleId: string;
  layer: string;
  archetype: string;
  filePath: string;
  symbolExports: ManualSyncSymbolExportEntry[];
}

interface ManualSyncGeneratedIndex {
  version: number;
  generatedAtIso: string;
  moduleCount: number;
  symbolExportCount: number;
  modules: ManualSyncModuleExportIndexEntry[];
}

interface MergedSymbolEvidence {
  symbolKey: string;
  symbolName: string;
  confidence: number;
  quality: number;
  mergedScore: number;
  provenance: string[];
}

interface MergedEvidenceReport {
  symbolWinners: MergedSymbolEvidence[];
}

interface ManualHotRescueTarget {
  rank: number;
  manualFilePath: string;
  exists: boolean;
}

interface ManualHotRescueReport {
  targets: ManualHotRescueTarget[];
}

interface ExportReport {
  generatedAtIso: string;
  generatedProjectPath: string;
  manualProjectPath: string;
  mergedEvidencePath?: string;
  staleCleanupMandatory: true;
  staleCleanupExecuted: {
    symbolRemoved: number;
    pathRemoved: number;
    surfaceRemoved: number;
  };
  symbolNameCreated: number;
  symbolNameUpdated: number;
  symbolNameRemoved: number;
  symbolNameRekeyed: number;
  symbolNamePromotedFromMergedEvidence: number;
  pathCreated: number;
  pathUpdated: number;
  pathRemoved: number;
  pathRekeyed: number;
  surfaceCreated: number;
  surfaceUpdated: number;
  surfaceRemoved: number;
  missingModuleFiles: string[];
  lengthMismatches: Array<{
    filePath: string;
    generatedExports: number;
    manualExports: number;
  }>;
  mode: "full" | "path-surface-only";
  topHotLimit: number;
  topHotSelectedCount: number;
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/manual-sync/export-from-manual.js --manual-project <path> [options]",
    "",
    "Options:",
    "  --generated-project <path>   default: output/regression-latest/project",
    "  --manual-sync-root <path>    default: shared/manual-sync",
    "  --merged-evidence <path>     optional: regression merged-evidence.json for top-N promotion",
    "  --promotion-top-n <n>        default: 120 (0 disables merged-evidence promotion)",
    "  --path-surface-only          export only module path/surface overrides (no symbol renames/promotion)",
    "  --top-hot-limit <n>          limit export scope to top-N manual hot files (default: 0 = all)",
    "  --top-hot-report <path>      default: shared/manual-sync/manual-hot-rescue-last-report.json",
    "",
    "Example:",
    "  node dist/manual-sync/export-from-manual.js --manual-project \"C:\\\\Codex-Windows\\\\manual-project\" --promotion-top-n 180",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let generatedProjectPath = path.join(projectRoot, "output", "regression-latest", "project");
  let manualProjectPath = "";
  let manualSyncRootPath = defaultManualSyncRootPath(projectRoot);
  let mergedEvidencePath: string | undefined;
  let promotionTopN = 120;
  let pathSurfaceOnly = false;
  let topHotLimit = 0;
  let topHotReportPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-hot-rescue-last-report.json");
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--generated-project": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --generated-project");
        }
        generatedProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--manual-project": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --manual-project");
        }
        manualProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--manual-sync-root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --manual-sync-root");
        }
        manualSyncRootPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--merged-evidence": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --merged-evidence");
        }
        mergedEvidencePath = path.resolve(value);
        index += 1;
        break;
      }
      case "--promotion-top-n": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --promotion-top-n");
        }
        const parsed = Number.parseInt(value, 10);
        if (Number.isNaN(parsed) || parsed < 0) {
          throw new Error(`Invalid --promotion-top-n value: ${value}`);
        }
        promotionTopN = parsed;
        index += 1;
        break;
      }
      case "--path-surface-only": {
        pathSurfaceOnly = true;
        break;
      }
      case "--top-hot-limit": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --top-hot-limit");
        }
        const parsed = Number.parseInt(value, 10);
        if (Number.isNaN(parsed) || parsed < 0) {
          throw new Error(`Invalid --top-hot-limit value: ${value}`);
        }
        topHotLimit = parsed;
        index += 1;
        break;
      }
      case "--top-hot-report": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --top-hot-report");
        }
        topHotReportPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--help":
      case "-h": {
        printUsage();
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }
  if (manualProjectPath.length < 1) {
    throw new Error("Missing required --manual-project");
  }
  return {
    generatedProjectPath,
    manualProjectPath,
    manualSyncRootPath,
    mergedEvidencePath,
    promotionTopN,
    pathSurfaceOnly,
    topHotLimit,
    topHotReportPath,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function readGeneratedIndex(generatedProjectPath: string): Promise<ManualSyncGeneratedIndex> {
  const indexPath = path.join(generatedProjectPath, "runtime", "manual-sync-index.json");
  if (!(await fileExists(indexPath))) {
    throw new Error(`manual-sync export: missing generated index ${indexPath}`);
  }
  const raw = await fs.readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as ManualSyncGeneratedIndex;
  if (!parsed || !Array.isArray(parsed.modules)) {
    throw new Error(`manual-sync export: invalid generated index ${indexPath}`);
  }
  return parsed;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) {
    return false;
  }
  for (const modifier of modifiers) {
    if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
      return true;
    }
  }
  return false;
}

function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectBindingNames(element.name, out);
  }
}

function collectTopLevelExports(source: ts.SourceFile): string[] {
  const exports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      exports.push("default");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue;
      }
      for (const element of statement.exportClause.elements) {
        exports.push(element.name.text);
      }
      continue;
    }
    if (!hasExportModifier(statement)) {
      continue;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      exports.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, exports);
      }
    }
  }
  return exports;
}

async function collectManualExportsByRelativeFile(
  manualProjectPath: string,
): Promise<Map<string, string[]>> {
  const byFilePath = new Map<string, string[]>();
  const pending: string[] = [manualProjectPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    const stat = await fs.stat(current);
    if (stat.isDirectory()) {
      const name = path.basename(current).toLowerCase();
      if (name === "node_modules" || name === "dist" || name === ".git") {
        continue;
      }
      const children = await fs.readdir(current, { withFileTypes: true });
      for (const child of children) {
        pending.push(path.join(current, child.name));
      }
      continue;
    }
    if (!/\.[cm]?tsx?$/i.test(current)) {
      continue;
    }
    const relativePath = path.relative(manualProjectPath, current).replace(/\\/g, "/");
    const sourceText = await fs.readFile(current, "utf8");
    const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    byFilePath.set(relativePath, collectTopLevelExports(sourceFile));
  }
  return byFilePath;
}

function mergeSymbolOverrides(
  existing: ManualSyncSymbolNameOverridesModel | undefined,
  updates: ReadonlyMap<string, ManualSyncSymbolNameOverride>,
): { model: ManualSyncSymbolNameOverridesModel; created: number; updated: number } {
  const bySymbolKey = new Map<string, ManualSyncSymbolNameOverride>();
  if (existing) {
    for (const entry of existing.overrides) {
      bySymbolKey.set(entry.symbolKey, entry);
    }
  }
  let created = 0;
  let updated = 0;
  for (const [symbolKey, entry] of updates) {
    const current = bySymbolKey.get(symbolKey);
    if (!current) {
      bySymbolKey.set(symbolKey, entry);
      created += 1;
      continue;
    }
    const currentFingerprint = current.symbolFingerprint ? JSON.stringify(current.symbolFingerprint) : "";
    const nextFingerprint = entry.symbolFingerprint ? JSON.stringify(entry.symbolFingerprint) : "";
    if (
      current.preferredName !== entry.preferredName ||
      current.evidence !== entry.evidence ||
      current.provenance !== entry.provenance ||
      current.confidence !== entry.confidence ||
      currentFingerprint !== nextFingerprint
    ) {
      bySymbolKey.set(symbolKey, {
        ...current,
        ...entry,
      });
      updated += 1;
    }
  }
  return {
    model: {
      contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
      migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
      generatedAtIso: new Date().toISOString(),
      overrides: [...bySymbolKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    },
    created,
    updated,
  };
}

function mergePathOverrides(
  existing: ManualSyncModulePathOverridesModel | undefined,
  updates: ReadonlyMap<string, ManualSyncModulePathOverride>,
): { model: ManualSyncModulePathOverridesModel; created: number; updated: number } {
  const bySymbolKey = new Map<string, ManualSyncModulePathOverride>();
  if (existing) {
    for (const entry of existing.overrides) {
      bySymbolKey.set(entry.symbolKey, entry);
    }
  }
  let created = 0;
  let updated = 0;
  for (const [symbolKey, entry] of updates) {
    const current = bySymbolKey.get(symbolKey);
    if (!current) {
      bySymbolKey.set(symbolKey, entry);
      created += 1;
      continue;
    }
    const currentFingerprint = current.symbolFingerprint ? JSON.stringify(current.symbolFingerprint) : "";
    const nextFingerprint = entry.symbolFingerprint ? JSON.stringify(entry.symbolFingerprint) : "";
    if (
      current.filePath !== entry.filePath ||
      current.topic !== entry.topic ||
      current.layer !== entry.layer ||
      current.archetype !== entry.archetype ||
      current.provenance !== entry.provenance ||
      current.confidence !== entry.confidence ||
      currentFingerprint !== nextFingerprint
    ) {
      bySymbolKey.set(symbolKey, {
        ...current,
        ...entry,
      });
      updated += 1;
    }
  }
  return {
    model: {
      contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
      migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
      generatedAtIso: new Date().toISOString(),
      overrides: [...bySymbolKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    },
    created,
    updated,
  };
}

function mergeSurfaceOverrides(
  existing: ManualSyncModuleSurfaceOverridesModel | undefined,
  updates: ReadonlyMap<string, ManualSyncModuleSurfaceOverride>,
): { model: ManualSyncModuleSurfaceOverridesModel; created: number; updated: number } {
  const byModuleFilePath = new Map<string, ManualSyncModuleSurfaceOverride>();
  if (existing) {
    for (const entry of existing.overrides) {
      byModuleFilePath.set(entry.moduleFilePath, entry);
    }
  }
  let created = 0;
  let updated = 0;
  for (const [moduleFilePath, entry] of updates) {
    const current = byModuleFilePath.get(moduleFilePath);
    if (!current) {
      byModuleFilePath.set(moduleFilePath, entry);
      created += 1;
      continue;
    }
    const currentExports = JSON.stringify(current.exportSurface);
    const nextExports = JSON.stringify(entry.exportSurface);
    const currentSymbolKeys = JSON.stringify(current.symbolKeys);
    const nextSymbolKeys = JSON.stringify(entry.symbolKeys);
    if (
      current.ownerLayer !== entry.ownerLayer ||
      current.archetype !== entry.archetype ||
      currentExports !== nextExports ||
      currentSymbolKeys !== nextSymbolKeys ||
      current.provenance !== entry.provenance ||
      current.confidence !== entry.confidence
    ) {
      byModuleFilePath.set(moduleFilePath, {
        ...current,
        ...entry,
      });
      updated += 1;
    }
  }
  return {
    model: {
      contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
      migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
      generatedAtIso: new Date().toISOString(),
      overrides: [...byModuleFilePath.values()].sort((left, right) => left.moduleFilePath.localeCompare(right.moduleFilePath)),
    },
    created,
    updated,
  };
}

function collectGeneratedSymbolKeys(generatedIndex: ManualSyncGeneratedIndex): Set<string> {
  const symbolKeys = new Set<string>();
  for (const moduleEntry of generatedIndex.modules) {
    for (const symbolExport of moduleEntry.symbolExports) {
      symbolKeys.add(symbolExport.symbolKey);
    }
  }
  return symbolKeys;
}

function collectGeneratedModuleFilePaths(generatedIndex: ManualSyncGeneratedIndex): Set<string> {
  const modulePaths = new Set<string>();
  for (const moduleEntry of generatedIndex.modules) {
    modulePaths.add(normalizeModuleFilePath(moduleEntry.filePath));
  }
  return modulePaths;
}

function collectGeneratedExportNames(generatedIndex: ManualSyncGeneratedIndex): Map<string, string[]> {
  const byExportName = new Map<string, Set<string>>();
  for (const moduleEntry of generatedIndex.modules) {
    for (const symbolExport of moduleEntry.symbolExports) {
      const bucket = byExportName.get(symbolExport.exportName) ?? new Set<string>();
      bucket.add(symbolExport.symbolKey);
      byExportName.set(symbolExport.exportName, bucket);
    }
  }
  const materialized = new Map<string, string[]>();
  for (const [exportName, symbolKeys] of byExportName) {
    materialized.set(exportName, [...symbolKeys].sort((left, right) => left.localeCompare(right)));
  }
  return materialized;
}

function collectGeneratedFingerprints(generatedIndex: ManualSyncGeneratedIndex): Map<string, ManualSyncSymbolFingerprint> {
  const bySymbolKey = new Map<string, ManualSyncSymbolFingerprint>();
  for (const moduleEntry of generatedIndex.modules) {
    for (const symbolExport of moduleEntry.symbolExports) {
      bySymbolKey.set(symbolExport.symbolKey, symbolExport.symbolFingerprint);
    }
  }
  return bySymbolKey;
}

function resolveCurrentNameBySymbolKey(
  generatedIndex: ManualSyncGeneratedIndex,
  existingSymbolOverrides: ManualSyncSymbolNameOverridesModel | undefined,
): Map<string, string> {
  const currentNameBySymbolKey = new Map<string, string>();
  for (const moduleEntry of generatedIndex.modules) {
    for (const symbolExport of moduleEntry.symbolExports) {
      currentNameBySymbolKey.set(symbolExport.symbolKey, symbolExport.exportName);
    }
  }
  if (existingSymbolOverrides) {
    for (const entry of existingSymbolOverrides.overrides) {
      if (entry.enabled === false) {
        continue;
      }
      currentNameBySymbolKey.set(entry.symbolKey, entry.preferredName);
    }
  }
  return currentNameBySymbolKey;
}

async function readMergedEvidence(
  mergedEvidencePath: string | undefined,
): Promise<MergedEvidenceReport | undefined> {
  if (!mergedEvidencePath || mergedEvidencePath.trim().length < 1) {
    return undefined;
  }
  const exists = await fileExists(mergedEvidencePath);
  if (!exists) {
    throw new Error(`manual-sync export: merged evidence file not found: ${mergedEvidencePath}`);
  }
  const raw = await fs.readFile(mergedEvidencePath, "utf8");
  const parsed = JSON.parse(raw) as MergedEvidenceReport;
  if (!parsed || !Array.isArray(parsed.symbolWinners)) {
    throw new Error(`manual-sync export: invalid merged evidence model at ${mergedEvidencePath}`);
  }
  return parsed;
}

async function readTopHotManualFilePaths(
  reportPath: string,
  topHotLimit: number,
): Promise<Set<string>> {
  if (topHotLimit < 1) {
    return new Set<string>();
  }
  if (!(await fileExists(reportPath))) {
    throw new Error(`manual-sync export: top-hot report not found: ${reportPath}`);
  }
  const raw = await fs.readFile(reportPath, "utf8");
  const parsed = JSON.parse(raw) as ManualHotRescueReport;
  const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
  const selected = targets
    .filter((entry) => entry && entry.exists === true && typeof entry.manualFilePath === "string")
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, topHotLimit)
    .map((entry) => normalizeModuleFilePath(entry.manualFilePath));
  return new Set<string>(selected);
}

function applyMergedEvidencePromotion(
  mergedEvidence: MergedEvidenceReport | undefined,
  promotionTopN: number,
  symbolUpdates: Map<string, ManualSyncSymbolNameOverride>,
  currentNameBySymbolKey: ReadonlyMap<string, string>,
): number {
  if (!mergedEvidence || promotionTopN < 1) {
    return 0;
  }
  const ranked = [...mergedEvidence.symbolWinners].sort((left, right) => {
    if (left.mergedScore !== right.mergedScore) {
      return right.mergedScore - left.mergedScore;
    }
    if (left.quality !== right.quality) {
      return right.quality - left.quality;
    }
    if (left.confidence !== right.confidence) {
      return right.confidence - left.confidence;
    }
    return left.symbolKey.localeCompare(right.symbolKey);
  });

  let promoted = 0;
  for (const winner of ranked.slice(0, promotionTopN)) {
    const candidateName = winner.symbolName.trim();
    if (!isIdentifierName(candidateName)) {
      continue;
    }
    const quality = typeof winner.quality === "number" && Number.isFinite(winner.quality)
      ? winner.quality
      : scoreNameQuality(candidateName);
    if (quality < 0.62) {
      continue;
    }
    const currentName = currentNameBySymbolKey.get(winner.symbolKey) ?? "";
    if (candidateName === currentName) {
      continue;
    }
    const currentQuality = currentName.length > 0 ? scoreNameQuality(currentName) : 0;
    const nonGenericUpgrade = currentName.length > 0 && isGenericName(currentName) && !isGenericName(candidateName);
    if (currentName.length > 0 && !nonGenericUpgrade && quality <= currentQuality + 0.0005) {
      continue;
    }
    if (currentName.length > 0 && isGenericName(candidateName) && !isGenericName(currentName)) {
      continue;
    }
    const confidence = Math.max(0.72, Math.min(0.97, Number(winner.confidence.toFixed(4))));
    symbolUpdates.set(winner.symbolKey, {
      symbolKey: winner.symbolKey,
      preferredName: candidateName,
      confidence,
      evidence: `merged-evidence-top-n:${winner.mergedScore.toFixed(4)}`,
      provenance: "merged-evidence:top-n",
      updatedAtIso: new Date().toISOString(),
      enabled: true,
    });
    promoted += 1;
  }
  return promoted;
}

function cleanupSymbolOverridesModel(
  model: ManualSyncSymbolNameOverridesModel,
  generatedSymbolKeys: ReadonlySet<string>,
  generatedFingerprintsBySymbolKey: ReadonlyMap<string, ManualSyncSymbolFingerprint>,
): { model: ManualSyncSymbolNameOverridesModel; removed: number; rekeyed: number } {
  const claimedKeys = new Set<string>();
  const cleaned: ManualSyncSymbolNameOverride[] = [];
  let removed = 0;
  let rekeyed = 0;
  for (const entry of model.overrides) {
    let resolvedSymbolKey = entry.symbolKey;
    let wasRekeyed = false;
    if (!generatedSymbolKeys.has(resolvedSymbolKey)) {
      if (!entry.symbolFingerprint) {
        removed += 1;
        continue;
      }
      const resolved = resolveSymbolByManualFingerprint(
        entry.symbolFingerprint,
        generatedFingerprintsBySymbolKey,
        claimedKeys,
        0.82,
        0.04,
      );
      if (!resolved) {
        removed += 1;
        continue;
      }
      resolvedSymbolKey = resolved.symbolKey;
      rekeyed += 1;
      wasRekeyed = true;
    }
    if (claimedKeys.has(resolvedSymbolKey)) {
      removed += 1;
      continue;
    }
    claimedKeys.add(resolvedSymbolKey);
    cleaned.push({
      ...entry,
      symbolKey: resolvedSymbolKey,
      updatedAtIso: wasRekeyed ? new Date().toISOString() : entry.updatedAtIso,
    });
  }
  return {
    model: {
      ...model,
      generatedAtIso: new Date().toISOString(),
      overrides: cleaned.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    },
    removed,
    rekeyed,
  };
}

function cleanupPathOverridesModel(
  model: ManualSyncModulePathOverridesModel,
  generatedSymbolKeys: ReadonlySet<string>,
  generatedFingerprintsBySymbolKey: ReadonlyMap<string, ManualSyncSymbolFingerprint>,
): { model: ManualSyncModulePathOverridesModel; removed: number; rekeyed: number } {
  const claimedKeys = new Set<string>();
  const cleaned: ManualSyncModulePathOverride[] = [];
  let removed = 0;
  let rekeyed = 0;
  for (const entry of model.overrides) {
    let resolvedSymbolKey = entry.symbolKey;
    let wasRekeyed = false;
    if (!generatedSymbolKeys.has(resolvedSymbolKey)) {
      if (!entry.symbolFingerprint) {
        removed += 1;
        continue;
      }
      const resolved = resolveSymbolByManualFingerprint(
        entry.symbolFingerprint,
        generatedFingerprintsBySymbolKey,
        claimedKeys,
        0.82,
        0.04,
      );
      if (!resolved) {
        removed += 1;
        continue;
      }
      resolvedSymbolKey = resolved.symbolKey;
      rekeyed += 1;
      wasRekeyed = true;
    }
    if (claimedKeys.has(resolvedSymbolKey)) {
      removed += 1;
      continue;
    }
    claimedKeys.add(resolvedSymbolKey);
    cleaned.push({
      ...entry,
      symbolKey: resolvedSymbolKey,
      updatedAtIso: wasRekeyed ? new Date().toISOString() : entry.updatedAtIso,
    });
  }
  return {
    model: {
      ...model,
      generatedAtIso: new Date().toISOString(),
      overrides: cleaned.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    },
    removed,
    rekeyed,
  };
}

function cleanupSurfaceOverridesModel(
  model: ManualSyncModuleSurfaceOverridesModel,
  generatedModulePaths: ReadonlySet<string>,
  generatedSymbolKeys: ReadonlySet<string>,
): { model: ManualSyncModuleSurfaceOverridesModel; removed: number } {
  const byModulePath = new Map<string, ManualSyncModuleSurfaceOverride>();
  let removed = 0;
  for (const entry of model.overrides) {
    const normalizedPath = normalizeModuleFilePath(entry.moduleFilePath);
    const normalizedSymbols = entry.symbolKeys
      .filter((symbolKey) => generatedSymbolKeys.has(symbolKey))
      .sort((left, right) => left.localeCompare(right));
    const normalizedExports = [...new Set(entry.exportSurface.map((name) => name.trim()).filter((name) => name.length > 0))]
      .sort((left, right) => left.localeCompare(right));
    if (normalizedExports.length < 1) {
      removed += 1;
      continue;
    }
    if (!generatedModulePaths.has(normalizedPath) && normalizedSymbols.length < 1) {
      removed += 1;
      continue;
    }
    const inferredLayer = inferLayerFromModuleFilePath(normalizedPath);
    if (!inferredLayer) {
      removed += 1;
      continue;
    }
    const inferredArchetype = inferArchetypeFromModuleFilePath(normalizedPath);
    byModulePath.set(normalizedPath, {
      ...entry,
      moduleFilePath: normalizedPath,
      ownerLayer: inferredLayer,
      archetype: inferredArchetype ?? entry.archetype,
      exportSurface: normalizedExports,
      symbolKeys: normalizedSymbols,
    });
  }
  return {
    model: {
      ...model,
      generatedAtIso: new Date().toISOString(),
      overrides: [...byModulePath.values()].sort((left, right) => left.moduleFilePath.localeCompare(right.moduleFilePath)),
    },
    removed,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const manualSyncPaths: ManualSyncPaths = resolveManualSyncPaths(projectRoot, cli.manualSyncRootPath);
  const generatedIndex = await readGeneratedIndex(cli.generatedProjectPath);
  const generatedSymbolKeys = collectGeneratedSymbolKeys(generatedIndex);
  const generatedModulePaths = collectGeneratedModuleFilePaths(generatedIndex);
  const generatedFingerprintsBySymbolKey = collectGeneratedFingerprints(generatedIndex);
  const generatedSymbolKeysByExportName = collectGeneratedExportNames(generatedIndex);
  const manualExportsByRelativeFile = await collectManualExportsByRelativeFile(cli.manualProjectPath);
  const topHotFilePathSet = await readTopHotManualFilePaths(cli.topHotReportPath, cli.topHotLimit);
  const inTopHotScope = (moduleFilePath: string): boolean =>
    topHotFilePathSet.size < 1 || topHotFilePathSet.has(normalizeModuleFilePath(moduleFilePath));
  const filesByExportName = new Map<string, Set<string>>();
  for (const [filePath, exportNames] of manualExportsByRelativeFile) {
    for (const exportName of exportNames) {
      if (exportName === "default") {
        continue;
      }
      const bucket = filesByExportName.get(exportName) ?? new Set<string>();
      bucket.add(filePath);
      filesByExportName.set(exportName, bucket);
    }
  }

  const symbolUpdates = new Map<string, ManualSyncSymbolNameOverride>();
  const pathUpdates = new Map<string, ManualSyncModulePathOverride>();
  const surfaceUpdates = new Map<string, ManualSyncModuleSurfaceOverride>();
  const missingModuleFiles: string[] = [];
  const lengthMismatches: Array<{ filePath: string; generatedExports: number; manualExports: number }> = [];

  for (const moduleEntry of generatedIndex.modules) {
    const normalizedFilePath = normalizeModuleFilePath(moduleEntry.filePath);
    if (!inTopHotScope(normalizedFilePath)) {
      continue;
    }
    const manualExports = manualExportsByRelativeFile.get(normalizedFilePath);
    if (!manualExports) {
      missingModuleFiles.push(normalizedFilePath);
      for (const symbolExport of moduleEntry.symbolExports) {
        const candidateFiles = [...(filesByExportName.get(symbolExport.exportName) ?? new Set<string>())];
        if (candidateFiles.length !== 1) {
          continue;
        }
        const candidateRawFilePath = candidateFiles[0] ?? "";
        if (!candidateRawFilePath.endsWith(".ts")) {
          continue;
        }
        const candidateFilePath = normalizeModuleFilePath(candidateRawFilePath);
        if (candidateFilePath === normalizedFilePath) {
          continue;
        }
        pathUpdates.set(symbolExport.symbolKey, {
          symbolKey: symbolExport.symbolKey,
          filePath: candidateFilePath,
          symbolFingerprint: symbolExport.symbolFingerprint,
          confidence: 0.84,
          evidence: `manual-sync-relocated:${symbolExport.exportName}`,
          provenance: "manual-export-unique-file",
          updatedAtIso: new Date().toISOString(),
          enabled: true,
        });
      }
      continue;
    }
    if (manualExports.length !== moduleEntry.symbolExports.length) {
      lengthMismatches.push({
        filePath: normalizedFilePath,
        generatedExports: moduleEntry.symbolExports.length,
        manualExports: manualExports.length,
      });
    }
    if (!cli.pathSurfaceOnly) {
      const compareCount = Math.min(moduleEntry.symbolExports.length, manualExports.length);
      for (let index = 0; index < compareCount; index += 1) {
        const generatedSymbol = moduleEntry.symbolExports[index];
        const manualName = manualExports[index];
        if (!generatedSymbol || !manualName || manualName === "default") {
          continue;
        }
        if (!isIdentifierName(manualName)) {
          continue;
        }
        if (manualName === generatedSymbol.exportName) {
          continue;
        }
        if (scoreNameQuality(manualName) < 0.56) {
          continue;
        }
        symbolUpdates.set(generatedSymbol.symbolKey, {
          symbolKey: generatedSymbol.symbolKey,
          preferredName: manualName,
          symbolFingerprint: generatedSymbol.symbolFingerprint,
          confidence: 0.96,
          evidence: `manual-export-rename:${normalizedFilePath}:${index + 1}`,
          provenance: "manual-project-export-order",
          updatedAtIso: new Date().toISOString(),
          enabled: true,
        });
      }
    }
  }

  for (const [manualRelativePath, exportNames] of manualExportsByRelativeFile) {
    let normalizedFilePath = "";
    try {
      normalizedFilePath = normalizeModuleFilePath(manualRelativePath);
    } catch {
      continue;
    }
    if (!inTopHotScope(normalizedFilePath)) {
      continue;
    }
    const ownerLayer = inferLayerFromModuleFilePath(normalizedFilePath);
    if (!ownerLayer) {
      continue;
    }
    const archetype = inferArchetypeFromModuleFilePath(normalizedFilePath);
    const exportSurface = [...new Set(
      exportNames
        .filter((name) => name !== "default")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    )].sort((left, right) => left.localeCompare(right));
    if (exportSurface.length < 1) {
      continue;
    }
    const symbolKeys = [...new Set(
      exportSurface.flatMap((exportName) => generatedSymbolKeysByExportName.get(exportName) ?? []),
    )].sort((left, right) => left.localeCompare(right));
    surfaceUpdates.set(normalizedFilePath, {
      moduleFilePath: normalizedFilePath,
      ownerLayer,
      archetype,
      exportSurface,
      symbolKeys,
      confidence: symbolKeys.length > 0 ? 0.92 : 0.74,
      evidence: `manual-export-surface:${normalizedFilePath}`,
      provenance: "manual-project-export-surface",
      updatedAtIso: new Date().toISOString(),
      enabled: true,
    });
  }

  await fs.mkdir(manualSyncPaths.rootPath, { recursive: true });
  const existingSymbolOverrides = await readManualSyncSymbolNameOverrides(manualSyncPaths.symbolNameOverridesPath);
  const existingPathOverrides = await readManualSyncModulePathOverrides(manualSyncPaths.modulePathOverridesPath);
  const existingSurfaceOverrides = await readManualSyncModuleSurfaceOverrides(manualSyncPaths.moduleSurfaceOverridesPath);
  const currentNameBySymbolKey = resolveCurrentNameBySymbolKey(generatedIndex, existingSymbolOverrides);
  const mergedEvidence = !cli.pathSurfaceOnly ? await readMergedEvidence(cli.mergedEvidencePath) : undefined;
  const promotedFromMergedEvidenceCount = !cli.pathSurfaceOnly
    ? applyMergedEvidencePromotion(
      mergedEvidence,
      cli.promotionTopN,
      symbolUpdates,
      currentNameBySymbolKey,
    )
    : 0;

  const mergedSymbolRaw = !cli.pathSurfaceOnly
    ? mergeSymbolOverrides(existingSymbolOverrides, symbolUpdates)
    : {
      model: existingSymbolOverrides ?? {
        contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
        migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
        generatedAtIso: new Date().toISOString(),
        overrides: [],
      },
      created: 0,
      updated: 0,
    };
  const mergedPathRaw = mergePathOverrides(existingPathOverrides, pathUpdates);
  const mergedSurfaceRaw = mergeSurfaceOverrides(existingSurfaceOverrides, surfaceUpdates);
  const cleanedSymbol = !cli.pathSurfaceOnly
    ? cleanupSymbolOverridesModel(
      mergedSymbolRaw.model,
      generatedSymbolKeys,
      generatedFingerprintsBySymbolKey,
    )
    : {
      model: mergedSymbolRaw.model,
      removed: 0,
      rekeyed: 0,
    };
  const cleanedPath = cleanupPathOverridesModel(
    mergedPathRaw.model,
    generatedSymbolKeys,
    generatedFingerprintsBySymbolKey,
  );
  const cleanedSurface = cleanupSurfaceOverridesModel(
    mergedSurfaceRaw.model,
    generatedModulePaths,
    generatedSymbolKeys,
  );

  if (
    !cli.pathSurfaceOnly &&
    (
      !existingSymbolOverrides ||
      mergedSymbolRaw.created > 0 ||
      mergedSymbolRaw.updated > 0 ||
      cleanedSymbol.removed > 0 ||
      cleanedSymbol.rekeyed > 0
    )
  ) {
    await writeJsonFile(manualSyncPaths.symbolNameOverridesPath, cleanedSymbol.model);
  }
  if (
    !existingPathOverrides ||
    mergedPathRaw.created > 0 ||
    mergedPathRaw.updated > 0 ||
    cleanedPath.removed > 0 ||
    cleanedPath.rekeyed > 0
  ) {
    await writeJsonFile(manualSyncPaths.modulePathOverridesPath, cleanedPath.model);
  }
  if (
    !existingSurfaceOverrides ||
    mergedSurfaceRaw.created > 0 ||
    mergedSurfaceRaw.updated > 0 ||
    cleanedSurface.removed > 0
  ) {
    await writeJsonFile(manualSyncPaths.moduleSurfaceOverridesPath, cleanedSurface.model);
  }
  const changelogEntries: ManualSyncChangelogEntry[] = [
    {
      actor: "manual-sync:export",
      reason: cli.pathSurfaceOnly
        ? "path-surface-only mode: symbol rename overrides are intentionally skipped"
        : "auto-import symbol rename overrides from manual project",
      scope: "symbol-name-overrides" as const,
      created: cli.pathSurfaceOnly ? 0 : mergedSymbolRaw.created,
      updated: cli.pathSurfaceOnly ? 0 : mergedSymbolRaw.updated + cleanedSymbol.rekeyed,
    },
    {
      actor: "manual-sync:export",
      reason: "auto-import module relocation overrides from manual project",
      scope: "module-path-overrides" as const,
      created: mergedPathRaw.created,
      updated: mergedPathRaw.updated + cleanedPath.rekeyed,
    },
    {
      actor: "manual-sync:export",
      reason: "auto-import module export surface and owner-layer from manual project",
      scope: "module-surface-overrides" as const,
      created: mergedSurfaceRaw.created,
      updated: mergedSurfaceRaw.updated,
    },
    {
      actor: "manual-sync:export",
      reason: `stale-cleanup removed symbol/path/surface overrides: ${cleanedSymbol.removed}/${cleanedPath.removed}/${cleanedSurface.removed}`,
      scope: "system" as const,
      created: cleanedSymbol.removed + cleanedPath.removed + cleanedSurface.removed,
      updated: 0,
    },
  ].filter((entry) => entry.created > 0 || entry.updated > 0);
  await appendManualSyncChangelog(manualSyncPaths, changelogEntries);

  const report: ExportReport = {
    generatedAtIso: new Date().toISOString(),
    generatedProjectPath: cli.generatedProjectPath,
    manualProjectPath: cli.manualProjectPath,
    mergedEvidencePath: cli.mergedEvidencePath,
    staleCleanupMandatory: true,
    staleCleanupExecuted: {
      symbolRemoved: cleanedSymbol.removed,
      pathRemoved: cleanedPath.removed,
      surfaceRemoved: cleanedSurface.removed,
    },
    symbolNameCreated: mergedSymbolRaw.created,
    symbolNameUpdated: mergedSymbolRaw.updated,
    symbolNameRemoved: cleanedSymbol.removed,
    symbolNameRekeyed: cleanedSymbol.rekeyed,
    symbolNamePromotedFromMergedEvidence: promotedFromMergedEvidenceCount,
    pathCreated: mergedPathRaw.created,
    pathUpdated: mergedPathRaw.updated,
    pathRemoved: cleanedPath.removed,
    pathRekeyed: cleanedPath.rekeyed,
    surfaceCreated: mergedSurfaceRaw.created,
    surfaceUpdated: mergedSurfaceRaw.updated,
    surfaceRemoved: cleanedSurface.removed,
    missingModuleFiles: [...new Set(missingModuleFiles)].sort((left, right) => left.localeCompare(right)),
    lengthMismatches: lengthMismatches.sort((left, right) => left.filePath.localeCompare(right.filePath)),
    mode: cli.pathSurfaceOnly ? "path-surface-only" : "full",
    topHotLimit: cli.topHotLimit,
    topHotSelectedCount: topHotFilePathSet.size,
  };
  await writeJsonFile(manualSyncPaths.exportReportPath, report);
  process.stdout.write(
    `${JSON.stringify(
      {
        symbolUpdatesScanned: symbolUpdates.size,
        pathUpdatesScanned: pathUpdates.size,
        surfaceUpdatesScanned: surfaceUpdates.size,
        symbolNameCreated: mergedSymbolRaw.created,
        symbolNameUpdated: mergedSymbolRaw.updated,
        symbolNameRemoved: cleanedSymbol.removed,
        symbolNameRekeyed: cleanedSymbol.rekeyed,
        symbolNamePromotedFromMergedEvidence: promotedFromMergedEvidenceCount,
        pathCreated: mergedPathRaw.created,
        pathUpdated: mergedPathRaw.updated,
        pathRemoved: cleanedPath.removed,
        pathRekeyed: cleanedPath.rekeyed,
        surfaceCreated: mergedSurfaceRaw.created,
        surfaceUpdated: mergedSurfaceRaw.updated,
        surfaceRemoved: cleanedSurface.removed,
        reportPath: manualSyncPaths.exportReportPath,
      },
      null,
      2,
    )}\n`,
  );
}

run().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack ?? error.message : error)}\n`);
  process.exitCode = 1;
});
