import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashFileSha256 } from "./utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "./utils/fs-json";
import {
  AsarExtractStageInput,
  AsarExtractStageOutput,
  ChunkArtifactModelStageInput,
  ChunkArtifactModelStageOutput,
  DecisionDashboardStageInput,
  DecisionDashboardStageOutput,
  EvidenceSourceFile,
  EvidenceStoreStageInput,
  EvidenceStoreStageOutput,
  GreenGateStageInput,
  GreenGateStageOutput,
  JavascriptDeobfuscatorStageInput,
  JavascriptDeobfuscatorStageOutput,
  MonolithCensusStageInput,
  MonolithCensusStageOutput,
  NamingMemoryStageInput,
  NamingMemoryStageOutput,
  OutputProfile,
  OwnershipResolverStageInput,
  OwnershipResolverStageOutput,
  QualityGatesStageInput,
  QualityGatesStageOutput,
  RunManifest,
  RunSummary,
  SemanticIrSweepProfile,
  SemanticIrStageInput,
  SemanticIrStageOutput,
  SynchronyStageInput,
  SynchronyStageOutput,
  TemplateEmitterStageInput,
  TemplateEmitterStageOutput,
  ToolWeights,
  UnwebpackSourcemapStageInput,
  UnwebpackSourcemapStageOutput,
  WakaruStageInput,
  WakaruStageOutput,
  WebcrackStageInput,
  WebcrackStageOutput,
} from "./contracts";
import { SemanticIrModel } from "./ir/semantic-ir";
import { OwnershipModel } from "./ir/ownership-model";
import { scoreNameQuality } from "./ir/name-quality";
import { resolveToolVersions } from "./adapters/tool-versions";
import { buildRunMetrics } from "./quality/run-metrics";
import { runStage } from "./stages/stage-runner";
import { asarExtractStage } from "./stages/asar-extract-stage";
import { webcrackStage } from "./stages/webcrack-stage";
import { monolithCensusStage } from "./stages/monolith-census-stage";
import { wakaruStage } from "./stages/wakaru-stage";
import { javascriptDeobfuscatorStage } from "./stages/javascript-deobfuscator-stage";
import { synchronyStage } from "./stages/synchrony-stage";
import { unwebpackSourcemapStage } from "./stages/unwebpack-sourcemap-stage";
import { evidenceStoreStage } from "./stages/evidence-store-stage";
import { semanticIrStage } from "./stages/semantic-ir-stage";
import { namingMemoryStage } from "./stages/naming-memory-stage";
import { ownershipResolverStage } from "./stages/ownership-resolver-stage";
import { chunkArtifactModelStage } from "./stages/chunk-artifact-model-stage";
import { templateEmitterStage } from "./stages/template-emitter-stage";
import { qualityGatesStage } from "./stages/quality-gates-stage";
import { greenGatesStage } from "./stages/green-gates-stage";
import { decisionDashboardStage } from "./stages/decision-dashboard-stage";

interface CliOptions {
  snapshotAsarPath: string;
  runId: string;
  seed: number;
  forceOverwriteOutputs: boolean;
  wakaruConcurrency: number;
  promotionBudget: number;
  enableJavascriptDeobfuscator: boolean;
  enableSynchrony: boolean;
  enableUnwebpackSourcemap: boolean;
  javascriptDeobfuscatorParseAsModule: boolean;
  synchronyRename: boolean;
  synchronyLoose: boolean;
  unwebpackSourcemapMaxMaps: number;
  pythonExecutable: string;
  stageCacheEnabled: boolean;
  outputProfile: OutputProfile;
  statementBudget: number;
  weightsConfigPath: string;
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/index.js --snapshot <path-to-app.asar> [options]",
    "",
    "Options:",
    "  --run-id <id>",
    "  --seed <n>",
    "  --wakaru-concurrency <n>",
    "  --promotion-budget <n>",
    "  --enable-javascript-deobfuscator",
    "  --enable-synchrony",
    "  --enable-unwebpack-sourcemap",
    "  --disable-javascript-deobfuscator",
    "  --disable-synchrony",
    "  --disable-unwebpack-sourcemap",
    "  --javascript-deobfuscator-module",
    "  --synchrony-rename",
    "  --synchrony-loose",
    "  --unwebpack-sourcemap-max-maps <n>",
    "  --no-stage-cache",
    "  --python <python-executable>",
    "  --profile <latest|regression-latest>",
    "  --statement-budget <n>",
    "  --weights-config <path>",
    "  --no-force-overwrite",
    "",
    "Example:",
    "  node dist/index.js --snapshot \"C:\\\\Codex-Windows\\\\work\\\\electron\\\\Codex Installer\\\\Codex.app\\\\Contents\\\\Resources\\\\app.asar\" --enable-synchrony --profile latest",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function buildDefaultRunId(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `run-${y}${m}${d}-${hh}${mm}${ss}`;
}

function parseIntegerOption(token: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${token} value: ${value}`);
  }
  return parsed;
}

function parseOutputProfile(value: string): OutputProfile {
  if (value === "latest") {
    return "latest";
  }
  if (value === "regression-latest") {
    return "regression-latest";
  }
  throw new Error(`Invalid --profile value: ${value}`);
}

function parseCli(argv: string[]): CliOptions {
  let snapshotAsarPath = "";
  let runId = buildDefaultRunId();
  let seed = 424242;
  let forceOverwriteOutputs = true;
  let wakaruConcurrency = 1;
  let promotionBudget = 100;
  let enableJavascriptDeobfuscator = true;
  let enableSynchrony = true;
  let enableUnwebpackSourcemap = true;
  let javascriptDeobfuscatorParseAsModule = false;
  let synchronyRename = false;
  let synchronyLoose = false;
  let unwebpackSourcemapMaxMaps = 20;
  let pythonExecutable = "python";
  let stageCacheEnabled = true;
  let outputProfile: OutputProfile = "latest";
  let statementBudget = 32;
  let weightsConfigPath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--snapshot": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --snapshot");
        }
        snapshotAsarPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--run-id": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --run-id");
        }
        runId = value;
        index += 1;
        break;
      }
      case "--seed": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --seed");
        }
        seed = parseIntegerOption("--seed", value);
        index += 1;
        break;
      }
      case "--wakaru-concurrency": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --wakaru-concurrency");
        }
        wakaruConcurrency = parseIntegerOption("--wakaru-concurrency", value);
        if (wakaruConcurrency < 1) {
          throw new Error("--wakaru-concurrency must be >= 1");
        }
        index += 1;
        break;
      }
      case "--promotion-budget": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --promotion-budget");
        }
        promotionBudget = parseIntegerOption("--promotion-budget", value);
        if (promotionBudget < 1) {
          throw new Error("--promotion-budget must be >= 1");
        }
        index += 1;
        break;
      }
      case "--enable-javascript-deobfuscator": {
        enableJavascriptDeobfuscator = true;
        break;
      }
      case "--disable-javascript-deobfuscator": {
        enableJavascriptDeobfuscator = false;
        break;
      }
      case "--enable-synchrony": {
        enableSynchrony = true;
        break;
      }
      case "--disable-synchrony": {
        enableSynchrony = false;
        break;
      }
      case "--enable-unwebpack-sourcemap": {
        enableUnwebpackSourcemap = true;
        break;
      }
      case "--disable-unwebpack-sourcemap": {
        enableUnwebpackSourcemap = false;
        break;
      }
      case "--javascript-deobfuscator-module": {
        javascriptDeobfuscatorParseAsModule = true;
        break;
      }
      case "--synchrony-rename": {
        synchronyRename = true;
        break;
      }
      case "--synchrony-loose": {
        synchronyLoose = true;
        break;
      }
      case "--unwebpack-sourcemap-max-maps": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --unwebpack-sourcemap-max-maps");
        }
        unwebpackSourcemapMaxMaps = parseIntegerOption("--unwebpack-sourcemap-max-maps", value);
        if (unwebpackSourcemapMaxMaps < 1) {
          throw new Error("--unwebpack-sourcemap-max-maps must be >= 1");
        }
        index += 1;
        break;
      }
      case "--python": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --python");
        }
        pythonExecutable = value;
        index += 1;
        break;
      }
      case "--profile": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --profile");
        }
        outputProfile = parseOutputProfile(value);
        index += 1;
        break;
      }
      case "--statement-budget": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --statement-budget");
        }
        statementBudget = parseIntegerOption("--statement-budget", value);
        if (statementBudget < 1) {
          throw new Error("--statement-budget must be >= 1");
        }
        index += 1;
        break;
      }
      case "--weights-config": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --weights-config");
        }
        weightsConfigPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--no-force-overwrite": {
        forceOverwriteOutputs = false;
        break;
      }
      case "--no-stage-cache": {
        stageCacheEnabled = false;
        break;
      }
      case "--help": {
        printUsage();
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (snapshotAsarPath.length === 0) {
    throw new Error("Argument --snapshot is required");
  }

  return {
    snapshotAsarPath,
    runId,
    seed,
    forceOverwriteOutputs,
    wakaruConcurrency,
    promotionBudget,
    enableJavascriptDeobfuscator,
    enableSynchrony,
    enableUnwebpackSourcemap,
    javascriptDeobfuscatorParseAsModule,
    synchronyRename,
    synchronyLoose,
    unwebpackSourcemapMaxMaps,
    pythonExecutable,
    stageCacheEnabled,
    outputProfile,
    statementBudget,
    weightsConfigPath,
  };
}

function pushEvidenceSource(sink: EvidenceSourceFile[], source: EvidenceSourceFile): void {
  sink.push(source);
}

function inferSourceKind(filePath: string): "javascript" | "sourcemap" | "text" {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) {
    return "javascript";
  }
  if (normalized.endsWith(".map")) {
    return "sourcemap";
  }
  return "text";
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

function shouldUseAsarJavascriptForArtifacts(extractedRootDirectory: string, filePath: string): boolean {
  const relativePath = normalizePath(path.relative(extractedRootDirectory, filePath)).toLowerCase();
  if (relativePath.startsWith(".vite/build/")) {
    return true;
  }
  if (relativePath.startsWith("webview/assets/")) {
    return true;
  }
  return false;
}

async function listWakaruOutputs(outputDirectory: string, outputFiles: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const relativeOutput of outputFiles) {
    const filePath = path.join(outputDirectory, relativeOutput);
    const exists = await fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      resolved.push(filePath);
    }
  }
  return resolved.sort((left, right) => left.localeCompare(right));
}

const COVERAGE_OWNER_SUFFIX = "-census";

function buildCoverageOwnerLineageId(snapshotKey: string): string {
  return `main-entry-${snapshotKey}${COVERAGE_OWNER_SUFFIX}`;
}

function isCoverageOwnerLineageId(lineageId: string): boolean {
  return lineageId.endsWith(COVERAGE_OWNER_SUFFIX);
}

async function resolveNamingMemoryProfilePath(
  projectRoot: string,
  snapshotKey: string,
): Promise<{ profilePath: string; legacyPath: string }> {
  const legacyPath = path.join(projectRoot, "naming-memory.json");
  const profilesDirectory = path.join(projectRoot, "naming-memory-store", "snapshots");
  await ensureDirectory(profilesDirectory);
  const profilePath = path.join(profilesDirectory, `snapshot-${snapshotKey}.json`);
  const hasProfile = await fileExists(profilePath);
  if (!hasProfile) {
    const hasLegacy = await fileExists(legacyPath);
    if (hasLegacy) {
      await fs.copyFile(legacyPath, profilePath);
    } else {
      const entries = await fs.readdir(profilesDirectory, { withFileTypes: true });
      const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.startsWith("snapshot-") || !entry.name.endsWith(".json")) {
          continue;
        }
        const candidatePath = path.join(profilesDirectory, entry.name);
        if (candidatePath === profilePath) {
          continue;
        }
        const stat = await fs.stat(candidatePath);
        candidates.push({
          filePath: candidatePath,
          mtimeMs: stat.mtimeMs,
        });
      }
      candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
      const latestSnapshotProfile = candidates[0];
      if (latestSnapshotProfile) {
        await fs.copyFile(latestSnapshotProfile.filePath, profilePath);
      }
    }
  }
  return {
    profilePath,
    legacyPath,
  };
}

function normalizeWeight(token: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid tool weight "${token}"`);
  }
  if (value <= 0) {
    throw new Error(`Tool weight must be > 0 for "${token}"`);
  }
  return Number(value.toFixed(4));
}

async function loadToolWeights(projectRoot: string, cliWeightsPath: string): Promise<{ path: string; weights: ToolWeights }> {
  const defaultPath = path.join(projectRoot, "config", "tool-weights.json");
  const resolvedPath = cliWeightsPath.length > 0 ? cliWeightsPath : defaultPath;
  const raw = await readJsonFile<Record<string, unknown>>(resolvedPath);
  const weights: ToolWeights = {
    asar: normalizeWeight("asar", raw["asar"]),
    webcrack: normalizeWeight("webcrack", raw["webcrack"]),
    wakaru: normalizeWeight("wakaru", raw["wakaru"]),
    javascriptDeobfuscator: normalizeWeight("javascriptDeobfuscator", raw["javascriptDeobfuscator"]),
    synchrony: normalizeWeight("synchrony", raw["synchrony"]),
    unwebpackSourcemap: normalizeWeight("unwebpackSourcemap", raw["unwebpackSourcemap"]),
  };
  return {
    path: resolvedPath,
    weights,
  };
}

function applyWeightScale(base: ToolWeights, factors: Partial<ToolWeights>): ToolWeights {
  return {
    asar: Number((base.asar * (factors.asar ?? 1)).toFixed(4)),
    webcrack: Number((base.webcrack * (factors.webcrack ?? 1)).toFixed(4)),
    wakaru: Number((base.wakaru * (factors.wakaru ?? 1)).toFixed(4)),
    javascriptDeobfuscator: Number((base.javascriptDeobfuscator * (factors.javascriptDeobfuscator ?? 1)).toFixed(4)),
    synchrony: Number((base.synchrony * (factors.synchrony ?? 1)).toFixed(4)),
    unwebpackSourcemap: Number((base.unwebpackSourcemap * (factors.unwebpackSourcemap ?? 1)).toFixed(4)),
  };
}

function buildSemanticSweepProfiles(base: ToolWeights): SemanticIrSweepProfile[] {
  const baseProfiles: SemanticIrSweepProfile[] = [
    {
      profileId: "base",
      toolWeights: base,
    },
    {
      profileId: "structure-heavy",
      toolWeights: applyWeightScale(base, {
        webcrack: 1.28,
        wakaru: 1.24,
        javascriptDeobfuscator: 0.92,
        synchrony: 0.92,
      }),
    },
    {
      profileId: "deobf-heavy",
      toolWeights: applyWeightScale(base, {
        javascriptDeobfuscator: 1.4,
        synchrony: 1.35,
        webcrack: 0.94,
        wakaru: 0.98,
      }),
    },
    {
      profileId: "sourcemap-heavy",
      toolWeights: applyWeightScale(base, {
        asar: 1.18,
        unwebpackSourcemap: 1.6,
        webcrack: 0.95,
        wakaru: 0.95,
      }),
    },
  ];

  const isolateProfiles: SemanticIrSweepProfile[] = [
    {
      profileId: "isolate-webcrack",
      toolWeights: applyWeightScale(base, {
        webcrack: 2.2,
        wakaru: 0.55,
        javascriptDeobfuscator: 0.45,
        synchrony: 0.45,
        unwebpackSourcemap: 0.5,
        asar: 0.7,
      }),
    },
    {
      profileId: "isolate-wakaru",
      toolWeights: applyWeightScale(base, {
        webcrack: 0.65,
        wakaru: 2.2,
        javascriptDeobfuscator: 0.5,
        synchrony: 0.5,
        unwebpackSourcemap: 0.55,
        asar: 0.7,
      }),
    },
    {
      profileId: "isolate-javascript-deobfuscator",
      toolWeights: applyWeightScale(base, {
        webcrack: 0.6,
        wakaru: 0.6,
        javascriptDeobfuscator: 2.3,
        synchrony: 0.55,
        unwebpackSourcemap: 0.5,
        asar: 0.65,
      }),
    },
    {
      profileId: "isolate-synchrony",
      toolWeights: applyWeightScale(base, {
        webcrack: 0.6,
        wakaru: 0.6,
        javascriptDeobfuscator: 0.55,
        synchrony: 2.3,
        unwebpackSourcemap: 0.5,
        asar: 0.65,
      }),
    },
    {
      profileId: "isolate-unwebpack-sourcemap",
      toolWeights: applyWeightScale(base, {
        webcrack: 0.55,
        wakaru: 0.55,
        javascriptDeobfuscator: 0.5,
        synchrony: 0.5,
        unwebpackSourcemap: 2.4,
        asar: 0.75,
      }),
    },
    {
      profileId: "isolate-asar",
      toolWeights: applyWeightScale(base, {
        webcrack: 0.55,
        wakaru: 0.55,
        javascriptDeobfuscator: 0.5,
        synchrony: 0.5,
        unwebpackSourcemap: 0.55,
        asar: 2.15,
      }),
    },
  ];

  return [...baseProfiles, ...isolateProfiles];
}

async function run(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const projectRoot = path.resolve(__dirname, "..");
  const runsRoot = path.join(projectRoot, "runs");
  const runDirectory = path.join(runsRoot, cli.runId);
  const artifactsDirectory = path.join(runDirectory, "artifacts");
  const toolWeightsConfig = await loadToolWeights(projectRoot, cli.weightsConfigPath);
  const semanticSweepProfiles = buildSemanticSweepProfiles(toolWeightsConfig.weights);
  await ensureDirectory(runsRoot);
  await ensureDirectory(runDirectory);
  await ensureDirectory(artifactsDirectory);

  const inputArtifact = await hashFileSha256(cli.snapshotAsarPath);
  const snapshotKey = inputArtifact.sha256.slice(0, 12);
  const coverageLineageId = buildCoverageOwnerLineageId(snapshotKey);
  const namingMemoryProfile = await resolveNamingMemoryProfilePath(projectRoot, snapshotKey);
  const tools = await resolveToolVersions(projectRoot);
  const manifest: RunManifest = {
    manifestVersion: 8,
    runId: cli.runId,
    createdAtIso: new Date().toISOString(),
    seed: cli.seed,
    pipeline: [
      "asar-extract",
      "webcrack",
      "monolith-census",
      "wakaru",
      "javascript-deobfuscator",
      "synchrony",
      "unwebpack-sourcemap",
      "evidence-store",
      "semantic-ir",
      "naming-memory",
      "ownership-resolver",
      "chunk-artifact-model",
      "template-emitter",
      "quality-gates",
      "green-gates",
      "decision-dashboard",
    ],
    tools,
    flags: {
      forceOverwriteOutputs: cli.forceOverwriteOutputs,
      wakaruConcurrency: cli.wakaruConcurrency,
      promotionBudget: cli.promotionBudget,
      coverageLineageId,
      namingMemoryProfilePath: namingMemoryProfile.profilePath,
      enableJavascriptDeobfuscator: cli.enableJavascriptDeobfuscator,
      enableSynchrony: cli.enableSynchrony,
      enableUnwebpackSourcemap: cli.enableUnwebpackSourcemap,
      stageCacheEnabled: cli.stageCacheEnabled,
      javascriptDeobfuscatorParseAsModule: cli.javascriptDeobfuscatorParseAsModule,
      synchronyRename: cli.synchronyRename,
      synchronyLoose: cli.synchronyLoose,
      unwebpackSourcemapMaxMaps: cli.unwebpackSourcemapMaxMaps,
      semanticSweepProfileCount: semanticSweepProfiles.length,
      outputProfile: cli.outputProfile,
      statementBudget: cli.statementBudget,
      weightsConfigPath: toolWeightsConfig.path,
    },
    inputs: {
      snapshotAsarPath: cli.snapshotAsarPath,
      snapshotAsarSha256: inputArtifact.sha256,
      snapshotAsarBytes: inputArtifact.bytes,
      snapshotKey,
    },
  };
  const manifestPath = path.join(runDirectory, "run-manifest.json");
  await writeJsonFile(manifestPath, manifest);
  await writeJsonFile(path.join(runDirectory, "snapshot-profile.json"), {
    version: 1,
    snapshotKey,
    snapshotAsarSha256: inputArtifact.sha256,
    coverageLineageId,
    namingMemoryProfilePath: namingMemoryProfile.profilePath,
    namingMemoryLegacyPath: namingMemoryProfile.legacyPath,
  });

  const asarInput: AsarExtractStageInput = {
    snapshotAsarPath: cli.snapshotAsarPath,
    extractDirectory: path.join(artifactsDirectory, "asar-extract"),
    entryFileHints: [
      ".vite/build/main-*.js",
      ".vite/build/main.js",
      ".vite/build/preload.js",
      "main.js",
      "preload.js",
      "webview/assets/index-*.js",
    ],
  };
  const asarOutput = await runStage<AsarExtractStageInput, AsarExtractStageOutput>(asarExtractStage, asarInput, runDirectory, {
    cacheEnabled: cli.stageCacheEnabled,
  });

  const webcrackInput: WebcrackStageInput = {
    entryJsPath: asarOutput.selectedEntryJsPath,
    outputDirectory: path.join(artifactsDirectory, "webcrack"),
    forceOverwriteOutputDirectory: cli.forceOverwriteOutputs,
  };
  const webcrackOutput = await runStage<WebcrackStageInput, WebcrackStageOutput>(webcrackStage, webcrackInput, runDirectory, {
    cacheEnabled: cli.stageCacheEnabled,
  });

  const monolithCensusInput: MonolithCensusStageInput = {
    sourceJsPath: webcrackOutput.primaryOutputJsPath,
    outputDirectory: path.join(artifactsDirectory, "monolith-census"),
    lineageId: coverageLineageId,
  };
  const monolithCensusOutput = await runStage<MonolithCensusStageInput, MonolithCensusStageOutput>(
    monolithCensusStage,
    monolithCensusInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const wakaruInput: WakaruStageInput = {
    sourceJsPath: webcrackOutput.primaryOutputJsPath,
    outputDirectory: path.join(artifactsDirectory, "wakaru"),
    forceOverwriteOutputDirectory: cli.forceOverwriteOutputs,
    concurrency: cli.wakaruConcurrency,
  };
  const wakaruOutput = await runStage<WakaruStageInput, WakaruStageOutput>(wakaruStage, wakaruInput, runDirectory, {
    cacheEnabled: cli.stageCacheEnabled,
  });

  const javascriptDeobfuscatorInput: JavascriptDeobfuscatorStageInput = {
    enabled: cli.enableJavascriptDeobfuscator,
    sourceJsPath: webcrackOutput.primaryOutputJsPath,
    outputFilePath: path.join(artifactsDirectory, "javascript-deobfuscator", "entry.deobfuscated.js"),
    parseAsModule: cli.javascriptDeobfuscatorParseAsModule,
  };
  const javascriptDeobfuscatorOutput = await runStage<JavascriptDeobfuscatorStageInput, JavascriptDeobfuscatorStageOutput>(
    javascriptDeobfuscatorStage,
    javascriptDeobfuscatorInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const synchronyInput: SynchronyStageInput = {
    enabled: cli.enableSynchrony,
    sourceJsPath: webcrackOutput.primaryOutputJsPath,
    outputFilePath: path.join(artifactsDirectory, "synchrony", "entry.cleaned.js"),
    rename: cli.synchronyRename,
    loose: cli.synchronyLoose,
  };
  const synchronyOutput = await runStage<SynchronyStageInput, SynchronyStageOutput>(synchronyStage, synchronyInput, runDirectory, {
    cacheEnabled: cli.stageCacheEnabled,
  });

  const unwebpackSourcemapInput: UnwebpackSourcemapStageInput = {
    enabled: cli.enableUnwebpackSourcemap,
    pythonExecutable: cli.pythonExecutable,
    referenceScriptPath: path.join(projectRoot, "..", "reference", "decompile", "unwebpack-sourcemap", "unwebpack_sourcemap.py"),
    mapFilePaths: asarOutput.discoveredMapFiles,
    outputDirectory: path.join(artifactsDirectory, "unwebpack-sourcemap"),
    maxMaps: cli.unwebpackSourcemapMaxMaps,
  };
  const unwebpackSourcemapOutput = await runStage<UnwebpackSourcemapStageInput, UnwebpackSourcemapStageOutput>(
    unwebpackSourcemapStage,
    unwebpackSourcemapInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const evidenceSources: EvidenceSourceFile[] = [];
  pushEvidenceSource(evidenceSources, {
    tool: "asar",
    stageId: "asar-extract",
    lineageId: `main-entry-asar:${snapshotKey}`,
    filePath: asarOutput.selectedEntryJsPath,
    sourceKind: "javascript",
    baseConfidence: 0.62,
  });
  pushEvidenceSource(evidenceSources, {
    tool: "webcrack",
    stageId: "webcrack",
    lineageId: "main-entry",
    filePath: webcrackOutput.primaryOutputJsPath,
    sourceKind: "javascript",
    baseConfidence: 0.93,
  });
  pushEvidenceSource(evidenceSources, {
    tool: "webcrack",
    stageId: "monolith-census",
    lineageId: monolithCensusOutput.lineageId,
    filePath: monolithCensusOutput.symbolTablePath,
    sourceKind: "text",
    baseConfidence: 0.46,
  });
  pushEvidenceSource(evidenceSources, {
    tool: "webcrack",
    stageId: "monolith-census",
    lineageId: monolithCensusOutput.lineageId,
    filePath: monolithCensusOutput.typingHintsPath,
    sourceKind: "text",
    baseConfidence: 0.33,
  });

  const wakaruFiles = await listWakaruOutputs(wakaruOutput.outputDirectory, wakaruOutput.outputFiles);
  for (const wakaruFile of wakaruFiles) {
    pushEvidenceSource(evidenceSources, {
      tool: "wakaru",
      stageId: "wakaru",
      lineageId: "main-entry",
      filePath: wakaruFile,
      sourceKind: inferSourceKind(wakaruFile),
      baseConfidence: 0.9,
    });
  }

  if (javascriptDeobfuscatorOutput.status === "executed") {
    pushEvidenceSource(evidenceSources, {
      tool: "javascript-deobfuscator",
      stageId: "javascript-deobfuscator",
      lineageId: "main-entry",
      filePath: javascriptDeobfuscatorOutput.outputFilePath,
      sourceKind: "javascript",
      baseConfidence: 0.86,
    });
  }

  if (synchronyOutput.status === "executed") {
    pushEvidenceSource(evidenceSources, {
      tool: "synchrony",
      stageId: "synchrony",
      lineageId: "main-entry",
      filePath: synchronyOutput.outputFilePath,
      sourceKind: "javascript",
      baseConfidence: 0.84,
    });
  }

  for (const mapFile of asarOutput.discoveredMapFiles) {
    pushEvidenceSource(evidenceSources, {
      tool: "asar",
      stageId: "asar-extract",
      lineageId: `sourcemap:${path.basename(mapFile)}`,
      filePath: mapFile,
      sourceKind: "sourcemap",
      baseConfidence: 0.74,
    });
  }

  if (unwebpackSourcemapOutput.status === "executed") {
    if (await fileExists(unwebpackSourcemapOutput.summaryFilePath)) {
      pushEvidenceSource(evidenceSources, {
        tool: "unwebpack-sourcemap",
        stageId: "unwebpack-sourcemap",
        lineageId: "sourcemap-summary:unwebpack",
        filePath: unwebpackSourcemapOutput.summaryFilePath,
        sourceKind: "text",
        baseConfidence: 0.48,
      });
    }
    for (const extractedSource of unwebpackSourcemapOutput.extractedSourceFiles) {
      pushEvidenceSource(evidenceSources, {
        tool: "unwebpack-sourcemap",
        stageId: "unwebpack-sourcemap",
        lineageId: `sourcemap-extract:${path.basename(extractedSource)}`,
        filePath: extractedSource,
        sourceKind: inferSourceKind(extractedSource),
        baseConfidence: 0.88,
      });
    }
  }

  const evidenceStoreInput: EvidenceStoreStageInput = {
    sourceFiles: evidenceSources,
    outputFilePath: path.join(artifactsDirectory, "evidence-store.json"),
    maxRecords: 8000,
  };
  const evidenceStoreOutput = await runStage<EvidenceStoreStageInput, EvidenceStoreStageOutput>(
    evidenceStoreStage,
    evidenceStoreInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const semanticIrInput: SemanticIrStageInput = {
    evidenceStorePath: evidenceStoreOutput.outputFilePath,
    outputFilePath: path.join(artifactsDirectory, "semantic-ir.json"),
    toolWeights: toolWeightsConfig.weights,
    sweepProfiles: semanticSweepProfiles,
  };
  const semanticIrOutput = await runStage<SemanticIrStageInput, SemanticIrStageOutput>(semanticIrStage, semanticIrInput, runDirectory, {
    cacheEnabled: cli.stageCacheEnabled,
  });

  const namingMemoryInput: NamingMemoryStageInput = {
    semanticIrPath: semanticIrOutput.outputFilePath,
    namingMemoryPath: namingMemoryProfile.profilePath,
    snapshotPath: path.join(runDirectory, "naming-memory.snapshot.json"),
    namedSemanticIrPath: path.join(artifactsDirectory, "semantic-ir.named.json"),
    runId: cli.runId,
    monolithSymbolTablePath: monolithCensusOutput.symbolTablePath,
    promotionBudget: cli.promotionBudget,
  };
  const namingMemoryOutput = await runStage<NamingMemoryStageInput, NamingMemoryStageOutput>(
    namingMemoryStage,
    namingMemoryInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );
  if (namingMemoryProfile.profilePath !== namingMemoryProfile.legacyPath) {
    await fs.copyFile(namingMemoryProfile.profilePath, namingMemoryProfile.legacyPath);
  }

  const ownershipResolverInput: OwnershipResolverStageInput = {
    namedSemanticIrPath: namingMemoryOutput.namedSemanticIrPath,
    outputFilePath: path.join(artifactsDirectory, "ownership-model.json"),
  };
  const ownershipResolverOutput = await runStage<OwnershipResolverStageInput, OwnershipResolverStageOutput>(
    ownershipResolverStage,
    ownershipResolverInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const fullOwnershipModel = await readJsonFile<OwnershipModel>(ownershipResolverOutput.outputFilePath);
  const qualityOwnershipModel: OwnershipModel = {
    ...fullOwnershipModel,
    generatedAtIso: new Date().toISOString(),
    symbols: fullOwnershipModel.symbols.filter((symbol) => {
      if (isCoverageOwnerLineageId(symbol.ownerLineageId)) {
        return false;
      }
      const quality = scoreNameQuality(symbol.symbolName);
      return quality >= 0.56 && symbol.confidence >= 0.2;
    }),
  };
  const qualityOwnershipModelPath = path.join(artifactsDirectory, "ownership-model.quality.json");
  await writeJsonFile(qualityOwnershipModelPath, qualityOwnershipModel);

  const chunkArtifactSources: EvidenceSourceFile[] = evidenceSources.filter((source) => source.stageId !== "monolith-census");
  for (const extractedJsFile of asarOutput.discoveredJsFiles) {
    if (!shouldUseAsarJavascriptForArtifacts(asarOutput.extractedRootDirectory, extractedJsFile)) {
      continue;
    }
    const relativePath = path
      .relative(asarOutput.extractedRootDirectory, extractedJsFile)
      .split(path.sep)
      .join("/");
    pushEvidenceSource(chunkArtifactSources, {
      tool: "asar",
      stageId: "asar-extract",
      lineageId: `asar-js:${relativePath}`,
      filePath: extractedJsFile,
      sourceKind: "javascript",
      baseConfidence: 0.58,
    });
  }

  const chunkArtifactModelInput: ChunkArtifactModelStageInput = {
    sourceFiles: chunkArtifactSources,
    ownershipModelPath: qualityOwnershipModelPath,
    outputFilePath: path.join(artifactsDirectory, "chunk-artifacts.json"),
  };
  const chunkArtifactModelOutput = await runStage<ChunkArtifactModelStageInput, ChunkArtifactModelStageOutput>(
    chunkArtifactModelStage,
    chunkArtifactModelInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const templateEmitterInput: TemplateEmitterStageInput = {
    ownershipModelPath: qualityOwnershipModelPath,
    chunkArtifactsPath: chunkArtifactModelOutput.outputFilePath,
    outputProjectDirectory: path.join(artifactsDirectory, "project"),
    statementBudget: cli.statementBudget,
    emittedFilesIndexPath: path.join(artifactsDirectory, "emitted-files.json"),
  };
  const templateEmitterOutput = await runStage<TemplateEmitterStageInput, TemplateEmitterStageOutput>(
    templateEmitterStage,
    templateEmitterInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const qualityGatesInput: QualityGatesStageInput = {
    chunkArtifactsPath: chunkArtifactModelOutput.outputFilePath,
    emittedFilesIndexPath: templateEmitterOutput.emittedFilesIndexPath,
    outputProjectDirectory: templateEmitterOutput.outputProjectDirectory,
    stableOutputRoot: path.join(projectRoot, "output"),
    stableOutputProfile: cli.outputProfile,
    qualityReportPath: path.join(runDirectory, "quality-gates.json"),
  };
  const qualityGatesOutput = await runStage<QualityGatesStageInput, QualityGatesStageOutput>(
    qualityGatesStage,
    qualityGatesInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const greenGatesInput: GreenGateStageInput = {
    projectDirectory: qualityGatesOutput.stableProjectDirectory,
    logDirectory: path.join(runDirectory, "green-gates-logs"),
    outputReportPath: path.join(runDirectory, "green-gates.json"),
  };
  const greenGatesOutput = await runStage<GreenGateStageInput, GreenGateStageOutput>(
    greenGatesStage,
    greenGatesInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const namedSemanticIr = await readJsonFile<SemanticIrModel>(namingMemoryOutput.namedSemanticIrPath);
  const runMetrics = buildRunMetrics(
    namedSemanticIr,
    fullOwnershipModel,
    qualityOwnershipModel,
    qualityGatesOutput,
    greenGatesOutput,
  );
  const runMetricsPath = path.join(runDirectory, "run-metrics.json");
  await writeJsonFile(runMetricsPath, runMetrics);

  const decisionDashboardInput: DecisionDashboardStageInput = {
    runId: cli.runId,
    ownershipModelPath: qualityOwnershipModelPath,
    metricsPath: runMetricsPath,
    outputJsonPath: path.join(runDirectory, "decision-dashboard.json"),
    outputMarkdownPath: path.join(runDirectory, "decision-dashboard.md"),
    javascriptDeobfuscator: {
      status: javascriptDeobfuscatorOutput.status,
      reason: javascriptDeobfuscatorOutput.reason,
    },
    synchrony: {
      status: synchronyOutput.status,
      reason: synchronyOutput.reason,
    },
    unwebpackSourcemap: {
      status: unwebpackSourcemapOutput.status,
      reason: unwebpackSourcemapOutput.reason,
    },
  };
  const decisionDashboardOutput = await runStage<DecisionDashboardStageInput, DecisionDashboardStageOutput>(
    decisionDashboardStage,
    decisionDashboardInput,
    runDirectory,
    {
      cacheEnabled: cli.stageCacheEnabled,
    },
  );

  const summary: RunSummary = {
    manifestPath,
    runDirectory,
    runMetricsPath,
    decisionDashboardPath: decisionDashboardOutput.outputJsonPath,
    stageOutputs: {
      asarExtract: asarOutput,
      webcrack: webcrackOutput,
      monolithCensus: monolithCensusOutput,
      wakaru: wakaruOutput,
      javascriptDeobfuscator: javascriptDeobfuscatorOutput,
      synchrony: synchronyOutput,
      unwebpackSourcemap: unwebpackSourcemapOutput,
      evidenceStore: evidenceStoreOutput,
      semanticIr: semanticIrOutput,
      namingMemory: namingMemoryOutput,
      ownershipResolver: ownershipResolverOutput,
      chunkArtifactModel: chunkArtifactModelOutput,
      templateEmitter: templateEmitterOutput,
      qualityGates: qualityGatesOutput,
      greenGates: greenGatesOutput,
      decisionDashboard: decisionDashboardOutput,
    },
  };
  const summaryPath = path.join(runDirectory, "summary.json");
  await writeJsonFile(summaryPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
