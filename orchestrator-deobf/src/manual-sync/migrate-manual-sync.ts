import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MANUAL_SYNC_CONTRACT_VERSION,
  MANUAL_SYNC_MIGRATION_VERSION,
  ManualSyncModuleSurfaceOverride,
  ManualSyncModuleSurfaceOverridesModel,
  ManualSyncModulePathOverride,
  ManualSyncModulePathOverridesModel,
  ManualSyncSymbolFingerprint,
  ManualSyncPaths,
  ManualSyncSymbolNameOverride,
  ManualSyncSymbolNameOverridesModel,
  defaultManualSyncRootPath,
  inferArchetypeFromModuleFilePath,
  inferLayerFromModuleFilePath,
  normalizeModuleFilePath,
  resolveManualSyncPaths,
} from "./contracts";
import { appendManualSyncChangelog } from "./changelog";
import { writeJsonFile } from "../utils/fs-json";

interface CliOptions {
  manualSyncRootPath: string;
  actor: string;
  reason: string;
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/manual-sync/migrate-manual-sync.js [options]",
    "",
    "Options:",
    "  --manual-sync-root <path>   default: shared/manual-sync",
    "  --actor <name>              default: manual-sync:migrate",
    "  --reason <text>             default: migrate contract to v2",
    "",
    "Example:",
    "  node dist/manual-sync/migrate-manual-sync.js --actor codex --reason \"initial strict migration\"",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let manualSyncRootPath = defaultManualSyncRootPath(projectRoot);
  let actor = "manual-sync:migrate";
  let reason = "migrate contract to v2";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--manual-sync-root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --manual-sync-root");
        }
        manualSyncRootPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--actor": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --actor");
        }
        actor = value.trim();
        index += 1;
        break;
      }
      case "--reason": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --reason");
        }
        reason = value.trim();
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
  if (actor.length < 1) {
    throw new Error("Empty --actor is not allowed");
  }
  if (reason.length < 1) {
    throw new Error("Empty --reason is not allowed");
  }
  return {
    manualSyncRootPath,
    actor,
    reason,
  };
}

async function readRawJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  const raw = await fs
    .readFile(filePath, "utf8")
    .catch(() => "");
  if (raw.trim().length < 1) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return parsed;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function parseFingerprint(rawValue: unknown): ManualSyncSymbolFingerprint | undefined {
  if (!rawValue || typeof rawValue !== "object") {
    return undefined;
  }
  const record = rawValue as Record<string, unknown>;
  const version = typeof record.version === "number" && Number.isFinite(record.version) ? record.version : 1;
  const role = typeof record.role === "string" ? record.role.trim() : "";
  const apiShape = typeof record.apiShape === "string" ? record.apiShape.trim() : "";
  const mutationProfile = typeof record.mutationProfile === "string" ? record.mutationProfile.trim() : "";
  const parameterCount = typeof record.parameterCount === "number" && Number.isFinite(record.parameterCount)
    ? Math.max(0, Math.trunc(record.parameterCount))
    : 0;
  const incomingBucket = typeof record.incomingBucket === "number" && Number.isFinite(record.incomingBucket)
    ? Math.max(0, Math.trunc(record.incomingBucket))
    : 0;
  const outgoingBucket = typeof record.outgoingBucket === "number" && Number.isFinite(record.outgoingBucket)
    ? Math.max(0, Math.trunc(record.outgoingBucket))
    : 0;
  const stateTokens = Array.isArray(record.stateTokens)
    ? record.stateTokens.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const callTokens = Array.isArray(record.callTokens)
    ? record.callTokens.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  if (role.length < 1 || apiShape.length < 1 || mutationProfile.length < 1) {
    return undefined;
  }
  return {
    version,
    role,
    apiShape,
    mutationProfile,
    parameterCount,
    incomingBucket,
    outgoingBucket,
    stateTokens,
    callTokens,
  };
}

function migrateSymbolOverrides(rawModel: Record<string, unknown> | undefined): ManualSyncSymbolNameOverridesModel {
  const nowIso = toIsoNow();
  const rawOverrides = rawModel && Array.isArray(rawModel.overrides)
    ? (rawModel.overrides as Array<Record<string, unknown>>)
    : [];
  const overrides: ManualSyncSymbolNameOverride[] = [];
  for (const rawEntry of rawOverrides) {
    const symbolKey = typeof rawEntry.symbolKey === "string" ? rawEntry.symbolKey.trim() : "";
    const preferredName = typeof rawEntry.preferredName === "string" ? rawEntry.preferredName.trim() : "";
    if (symbolKey.length < 1 || preferredName.length < 1) {
      throw new Error("migrate-symbol-overrides: every entry must contain symbolKey and preferredName");
    }
    const confidence = typeof rawEntry.confidence === "number" && Number.isFinite(rawEntry.confidence)
      ? Math.max(0, Math.min(1, rawEntry.confidence))
      : 0.9;
    const evidence = typeof rawEntry.evidence === "string" && rawEntry.evidence.trim().length > 0
      ? rawEntry.evidence.trim()
      : "manual-sync-migration";
    const provenance = typeof rawEntry.provenance === "string" && rawEntry.provenance.trim().length > 0
      ? rawEntry.provenance.trim()
      : "manual-sync:migration";
    const updatedAtIso = typeof rawEntry.updatedAtIso === "string" && rawEntry.updatedAtIso.trim().length > 0
      ? rawEntry.updatedAtIso.trim()
      : nowIso;
    const enabled = typeof rawEntry.enabled === "boolean" ? rawEntry.enabled : true;
    overrides.push({
      symbolKey,
      preferredName,
      confidence,
      evidence,
      provenance,
      updatedAtIso,
      symbolFingerprint: parseFingerprint(rawEntry.symbolFingerprint),
      enabled,
    });
  }
  return {
    contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
    migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
    generatedAtIso: nowIso,
    overrides: overrides.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
  };
}

function migratePathOverrides(rawModel: Record<string, unknown> | undefined): ManualSyncModulePathOverridesModel {
  const nowIso = toIsoNow();
  const rawOverrides = rawModel && Array.isArray(rawModel.overrides)
    ? (rawModel.overrides as Array<Record<string, unknown>>)
    : [];
  const overrides: ManualSyncModulePathOverride[] = [];
  for (const rawEntry of rawOverrides) {
    const symbolKey = typeof rawEntry.symbolKey === "string" ? rawEntry.symbolKey.trim() : "";
    const rawFilePath = typeof rawEntry.filePath === "string" ? rawEntry.filePath.trim() : "";
    if (symbolKey.length < 1 || rawFilePath.length < 1) {
      throw new Error("migrate-module-path-overrides: every entry must contain symbolKey and filePath");
    }
    const filePath = normalizeModuleFilePath(rawFilePath);
    const confidence = typeof rawEntry.confidence === "number" && Number.isFinite(rawEntry.confidence)
      ? Math.max(0, Math.min(1, rawEntry.confidence))
      : 0.84;
    const evidence = typeof rawEntry.evidence === "string" && rawEntry.evidence.trim().length > 0
      ? rawEntry.evidence.trim()
      : "manual-sync-migration";
    const provenance = typeof rawEntry.provenance === "string" && rawEntry.provenance.trim().length > 0
      ? rawEntry.provenance.trim()
      : "manual-sync:migration";
    const updatedAtIso = typeof rawEntry.updatedAtIso === "string" && rawEntry.updatedAtIso.trim().length > 0
      ? rawEntry.updatedAtIso.trim()
      : nowIso;
    const enabled = typeof rawEntry.enabled === "boolean" ? rawEntry.enabled : true;
    const layer = rawEntry.layer as ManualSyncModulePathOverride["layer"];
    const archetype = rawEntry.archetype as ManualSyncModulePathOverride["archetype"];
    const topic = typeof rawEntry.topic === "string" && rawEntry.topic.trim().length > 0 ? rawEntry.topic.trim() : undefined;
    overrides.push({
      symbolKey,
      filePath,
      layer,
      archetype,
      topic,
      confidence,
      evidence,
      provenance,
      updatedAtIso,
      symbolFingerprint: parseFingerprint(rawEntry.symbolFingerprint),
      enabled,
    });
  }
  return {
    contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
    migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
    generatedAtIso: nowIso,
    overrides: overrides.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
  };
}

function migrateModuleSurfaceOverrides(rawModel: Record<string, unknown> | undefined): ManualSyncModuleSurfaceOverridesModel {
  const nowIso = toIsoNow();
  const rawOverrides = rawModel && Array.isArray(rawModel.overrides)
    ? (rawModel.overrides as Array<Record<string, unknown>>)
    : [];
  const overrides: ManualSyncModuleSurfaceOverride[] = [];
  for (const rawEntry of rawOverrides) {
    const rawModuleFilePath = typeof rawEntry.moduleFilePath === "string" ? rawEntry.moduleFilePath.trim() : "";
    if (rawModuleFilePath.length < 1) {
      throw new Error("migrate-module-surface-overrides: every entry must contain moduleFilePath");
    }
    const moduleFilePath = normalizeModuleFilePath(rawModuleFilePath);
    const inferredLayer = inferLayerFromModuleFilePath(moduleFilePath);
    const inferredArchetype = inferArchetypeFromModuleFilePath(moduleFilePath);
    const ownerLayer = typeof rawEntry.ownerLayer === "string" && rawEntry.ownerLayer.trim().length > 0
      ? (rawEntry.ownerLayer.trim() as ManualSyncModuleSurfaceOverride["ownerLayer"])
      : inferredLayer;
    if (!ownerLayer) {
      throw new Error(
        `migrate-module-surface-overrides: unable to infer ownerLayer for ${moduleFilePath}; provide ownerLayer explicitly`,
      );
    }
    const archetype = typeof rawEntry.archetype === "string" && rawEntry.archetype.trim().length > 0
      ? (rawEntry.archetype.trim() as ManualSyncModuleSurfaceOverride["archetype"])
      : inferredArchetype;
    const exportSurfaceRaw = Array.isArray(rawEntry.exportSurface) ? rawEntry.exportSurface : [];
    const exportSurface = exportSurfaceRaw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (exportSurface.length < 1) {
      throw new Error(
        `migrate-module-surface-overrides: exportSurface must contain at least one export for ${moduleFilePath}`,
      );
    }
    const symbolKeys = Array.isArray(rawEntry.symbolKeys)
      ? rawEntry.symbolKeys
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      : [];
    const confidence = typeof rawEntry.confidence === "number" && Number.isFinite(rawEntry.confidence)
      ? Math.max(0, Math.min(1, rawEntry.confidence))
      : 0.88;
    const evidence = typeof rawEntry.evidence === "string" && rawEntry.evidence.trim().length > 0
      ? rawEntry.evidence.trim()
      : "manual-sync-migration";
    const provenance = typeof rawEntry.provenance === "string" && rawEntry.provenance.trim().length > 0
      ? rawEntry.provenance.trim()
      : "manual-sync:migration";
    const updatedAtIso = typeof rawEntry.updatedAtIso === "string" && rawEntry.updatedAtIso.trim().length > 0
      ? rawEntry.updatedAtIso.trim()
      : nowIso;
    const enabled = typeof rawEntry.enabled === "boolean" ? rawEntry.enabled : true;
    overrides.push({
      moduleFilePath,
      ownerLayer,
      archetype,
      exportSurface: [...new Set(exportSurface)].sort((left, right) => left.localeCompare(right)),
      symbolKeys: [...new Set(symbolKeys)].sort((left, right) => left.localeCompare(right)),
      confidence,
      evidence,
      provenance,
      updatedAtIso,
      enabled,
    });
  }
  return {
    contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
    migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
    generatedAtIso: nowIso,
    overrides: overrides.sort((left, right) => left.moduleFilePath.localeCompare(right.moduleFilePath)),
  };
}

async function ensureContractTemplates(paths: ManualSyncPaths): Promise<void> {
  const defaultSymbolModel: ManualSyncSymbolNameOverridesModel = {
    contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
    migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
    generatedAtIso: toIsoNow(),
    overrides: [],
  };
  const defaultPathModel: ManualSyncModulePathOverridesModel = {
    contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
    migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
    generatedAtIso: toIsoNow(),
    overrides: [],
  };
  const defaultSurfaceModel: ManualSyncModuleSurfaceOverridesModel = {
    contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
    migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
    generatedAtIso: toIsoNow(),
    overrides: [],
  };
  const symbolExists = await fs
    .stat(paths.symbolNameOverridesPath)
    .then(() => true)
    .catch(() => false);
  if (!symbolExists) {
    await writeJsonFile(paths.symbolNameOverridesPath, defaultSymbolModel);
  }
  const pathExists = await fs
    .stat(paths.modulePathOverridesPath)
    .then(() => true)
    .catch(() => false);
  if (!pathExists) {
    await writeJsonFile(paths.modulePathOverridesPath, defaultPathModel);
  }
  const surfaceExists = await fs
    .stat(paths.moduleSurfaceOverridesPath)
    .then(() => true)
    .catch(() => false);
  if (!surfaceExists) {
    await writeJsonFile(paths.moduleSurfaceOverridesPath, defaultSurfaceModel);
  }
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const paths = resolveManualSyncPaths(projectRoot, cli.manualSyncRootPath);
  await fs.mkdir(paths.rootPath, { recursive: true });

  const rawSymbolModel = await readRawJson(paths.symbolNameOverridesPath);
  const rawPathModel = await readRawJson(paths.modulePathOverridesPath);
  const rawSurfaceModel = await readRawJson(paths.moduleSurfaceOverridesPath);
  const migratedSymbolModel = migrateSymbolOverrides(rawSymbolModel);
  const migratedPathModel = migratePathOverrides(rawPathModel);
  const migratedSurfaceModel = migrateModuleSurfaceOverrides(rawSurfaceModel);
  await writeJsonFile(paths.symbolNameOverridesPath, migratedSymbolModel);
  await writeJsonFile(paths.modulePathOverridesPath, migratedPathModel);
  await writeJsonFile(paths.moduleSurfaceOverridesPath, migratedSurfaceModel);
  await ensureContractTemplates(paths);

  await appendManualSyncChangelog(paths, [
    {
      actor: cli.actor,
      reason: cli.reason,
      scope: "migration",
      created:
        migratedSymbolModel.overrides.length +
        migratedPathModel.overrides.length +
        migratedSurfaceModel.overrides.length,
      updated: 0,
    },
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        rootPath: paths.rootPath,
        symbolOverrides: migratedSymbolModel.overrides.length,
        modulePathOverrides: migratedPathModel.overrides.length,
        moduleSurfaceOverrides: migratedSurfaceModel.overrides.length,
        contractVersion: MANUAL_SYNC_CONTRACT_VERSION,
        migrationVersion: MANUAL_SYNC_MIGRATION_VERSION,
      },
      null,
      2,
    )}\n`,
  );
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
