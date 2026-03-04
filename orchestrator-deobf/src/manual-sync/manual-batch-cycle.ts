import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as ts from "typescript";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { runManualHotRescue } from "./hot-rescue";

interface GeneratorSyncConfig {
  enabled: boolean;
  maxPassesPerBatch: number;
  stopAfterNoQualityGrowthBatches: number;
  suiteRunPrefix: string;
  fastFocusCount?: number;
  promotionBudgetPerCycle?: number;
  fastProfileId?: string;
}

interface HotRescueConfig {
  enabled: boolean;
  candidatesPath: string;
  topN: number;
  namespaceImportCap: number;
  longFunctionLineThreshold: number;
}

interface ReadabilityKpiConfig {
  enabled: boolean;
  targetFiles: string[];
}

interface PatchPackPreflightConfig {
  enabled: boolean;
  snapshotLabel: string;
  appVersion: string;
  buildNumber: string;
  patchProfile: string;
  runConflictFixture: boolean;
}

interface ManualFirstWorkflowConfig {
  version: number;
  manualProjectPath: string;
  snapshotAsarPath: string;
  patchPackPreflight: PatchPackPreflightConfig;
  domainSourceRoots: string[];
  lightGateCommands: string[];
  fullGateCommands: string[];
  fullGateEveryBatches: number;
  promotionTopN: number;
  generatorSync: GeneratorSyncConfig;
  readabilityKpi?: ReadabilityKpiConfig;
  hotRescue?: HotRescueConfig;
}

interface BatchState {
  version: number;
  batchIndex: number;
  noGrowthStreak: number;
  lastNameQuality: number;
  lastRunAtIso: string;
}

interface RoundtripMetrics {
  nameQuality: number;
  classCoverage: number;
  functionCoverage: number;
  functionClassCoverage: number;
  variableCoverage: number;
  proxyInQualityCount: number;
  buildHealth: boolean;
  devHealth: boolean;
}

interface ManualReadabilityFileMetrics {
  filePath: string;
  lineCount: number;
  functionCount: number;
  avgFunctionBodyLength: number;
  glueRatio: number;
  domainCallDensity: number;
}

interface ManualReadabilityKpiMetrics {
  targetFiles: string[];
  files: ManualReadabilityFileMetrics[];
  avgFunctionBodyLength: number;
  glueRatio: number;
  domainCallDensity: number;
}

interface ManualReadabilityDelta {
  avgFunctionBodyLength: number;
  glueRatio: number;
  domainCallDensity: number;
  improvedSignals: string[];
  grew: boolean;
}

interface ManualBatchReport {
  generatedAtIso: string;
  batchIndex: number;
  manualProjectPath: string;
  snapshotAsarPath: string;
  fullGateExecuted: boolean;
  generatorSyncExecuted: boolean;
  generatorSyncSkippedReason: string;
  mergedEvidencePath: string;
  exportReportPath: string;
  roundtripReportPath: string;
  hotRescueReportPath: string;
  hotRescueViolationCount: number;
  hotRescueTargetCount: number;
  beforeMetrics: RoundtripMetrics;
  afterMetrics: RoundtripMetrics;
  readabilityBefore: ManualReadabilityKpiMetrics;
  readabilityAfter: ManualReadabilityKpiMetrics;
  readabilityDelta: ManualReadabilityDelta;
  cycleSuccessful: boolean;
  noGrowthStreak: number;
  generatorSyncFrozen: boolean;
  generatorSyncRolledBack: boolean;
}

interface CliOptions {
  workflowConfigPath: string;
  allowAfterFreeze: boolean;
  skipGeneratorSync: boolean;
}

const MANUAL_BATCH_STATE_RELATIVE_PATH = path.join("shared", "manual-sync", "manual-batch-state.json");
const MANUAL_BATCH_REPORT_RELATIVE_PATH = path.join("shared", "manual-sync", "manual-batch-last-report.json");
const MANUAL_GENERATOR_FREEZE_RELATIVE_PATH = path.join("shared", "manual-sync", "manual-generator-freeze.json");
const MANUAL_EXPORT_REPORT_RELATIVE_PATH = path.join("shared", "manual-sync", "last-export-report.json");
const MANUAL_ROUNDTRIP_REPORT_RELATIVE_PATH = path.join("shared", "manual-sync", "last-roundtrip-report.json");
const MANUAL_HOT_RESCUE_REPORT_RELATIVE_PATH = path.join("shared", "manual-sync", "manual-hot-rescue-last-report.json");

interface ManualSyncContractSnapshot {
  symbolNameOverrides: string;
  modulePathOverrides: string;
  moduleSurfaceOverrides: string;
  contractChangelog: string;
}

async function readOptionalFileText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf8").catch(() => "");
}

async function createManualSyncContractSnapshot(projectRoot: string): Promise<ManualSyncContractSnapshot> {
  return {
    symbolNameOverrides: await readOptionalFileText(path.join(projectRoot, "shared", "manual-sync", "symbol-name-overrides.json")),
    modulePathOverrides: await readOptionalFileText(path.join(projectRoot, "shared", "manual-sync", "module-path-overrides.json")),
    moduleSurfaceOverrides: await readOptionalFileText(path.join(projectRoot, "shared", "manual-sync", "module-surface-overrides.json")),
    contractChangelog: await readOptionalFileText(path.join(projectRoot, "shared", "manual-sync", "contract-changelog.md")),
  };
}

async function restoreManualSyncContractSnapshot(
  projectRoot: string,
  snapshot: ManualSyncContractSnapshot,
): Promise<void> {
  await fs.writeFile(path.join(projectRoot, "shared", "manual-sync", "symbol-name-overrides.json"), snapshot.symbolNameOverrides, "utf8");
  await fs.writeFile(path.join(projectRoot, "shared", "manual-sync", "module-path-overrides.json"), snapshot.modulePathOverrides, "utf8");
  await fs.writeFile(path.join(projectRoot, "shared", "manual-sync", "module-surface-overrides.json"), snapshot.moduleSurfaceOverrides, "utf8");
  await fs.writeFile(path.join(projectRoot, "shared", "manual-sync", "contract-changelog.md"), snapshot.contractChangelog, "utf8");
}

function parseCli(argv: readonly string[], projectRoot: string): CliOptions {
  let workflowConfigPath = path.join(projectRoot, "config", "manual-first-workflow.json");
  let allowAfterFreeze = false;
  let skipGeneratorSync = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--workflow-config": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--workflow-config requires a value");
        }
        workflowConfigPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--allow-after-freeze": {
        allowAfterFreeze = true;
        break;
      }
      case "--skip-generator-sync": {
        skipGeneratorSync = true;
        break;
      }
      default: {
        throw new Error(`Unknown option: ${token}`);
      }
    }
  }
  return {
    workflowConfigPath,
    allowAfterFreeze,
    skipGeneratorSync,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function runCommand(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${command}`));
    });
  });
}

async function verifyManualDomainStructure(
  manualProjectPath: string,
  domainSourceRoots: readonly string[],
): Promise<void> {
  const srcRoot = path.join(manualProjectPath, "src");
  const srcEntries = await fs.readdir(srcRoot, { withFileTypes: true });
  const allowedRoots = new Set(
    domainSourceRoots
      .filter((entry) => entry.startsWith("src/"))
      .map((entry) => entry.replace(/^src\//, "").replace(/\/$/, "")),
  );
  allowedRoots.add("main.tsx");
  allowedRoots.add("App.tsx");
  allowedRoots.add("index.css");
  allowedRoots.add("types.ts");
  allowedRoots.add("vite-env.d.ts");
  allowedRoots.add("env.d.ts");
  for (const entry of srcEntries) {
    if (allowedRoots.has(entry.name)) {
      continue;
    }
    throw new Error(`manual structure gate failed: disallowed src entry ${entry.name}`);
  }
}

async function findLatestMergedEvidencePath(projectRoot: string): Promise<string> {
  const runsRoot = path.join(projectRoot, "regression", "runs");
  const runEntries = await fs.readdir(runsRoot, { withFileTypes: true });
  const candidates: Array<{ mergedEvidencePath: string; mtimeMs: number }> = [];
  for (const entry of runEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const mergedEvidencePath = path.join(runsRoot, entry.name, "merged-evidence.json");
    if (!(await fileExists(mergedEvidencePath))) {
      continue;
    }
    const stats = await fs.stat(mergedEvidencePath);
    candidates.push({
      mergedEvidencePath,
      mtimeMs: stats.mtimeMs,
    });
  }
  if (candidates.length < 1) {
    throw new Error("No merged-evidence.json found in regression/runs");
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latestCandidate = candidates[0];
  if (!latestCandidate) {
    throw new Error("No merged-evidence candidate resolved");
  }
  return latestCandidate.mergedEvidencePath;
}

function toRoundtripMetrics(raw: Record<string, unknown>): RoundtripMetrics {
  return {
    nameQuality: typeof raw.nameQuality === "number" ? raw.nameQuality : 0,
    classCoverage: typeof raw.classCoverage === "number" ? raw.classCoverage : 0,
    functionCoverage: typeof raw.functionCoverage === "number" ? raw.functionCoverage : 0,
    functionClassCoverage: typeof raw.functionClassCoverage === "number" ? raw.functionClassCoverage : 0,
    variableCoverage: typeof raw.variableCoverage === "number" ? raw.variableCoverage : 0,
    proxyInQualityCount: typeof raw.proxyInQualityCount === "number" ? raw.proxyInQualityCount : 0,
    buildHealth: raw.buildHealth === true,
    devHealth: raw.devHealth === true,
  };
}

function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1) {
    throw new Error(`manual batch config invalid: ${label} must be non-empty`);
  }
  return normalized;
}

function buildPatchPackPreflightCommand(config: PatchPackPreflightConfig): string {
  const snapshotLabel = requireNonEmpty(config.snapshotLabel, "patchPackPreflight.snapshotLabel");
  const appVersion = requireNonEmpty(config.appVersion, "patchPackPreflight.appVersion");
  const buildNumber = requireNonEmpty(config.buildNumber, "patchPackPreflight.buildNumber");
  const patchProfile = config.patchProfile.trim();
  const patchProfileArg = patchProfile.length > 0 ? ` --patch-profile "${patchProfile}"` : "";
  return (
    `npm run patch-pack:preflight -- --snapshot-label "${snapshotLabel}" ` +
    `--app-version "${appVersion}" --build-number "${buildNumber}"${patchProfileArg}`
  );
}

function buildRoundtripPatchPackArgs(config: PatchPackPreflightConfig): string {
  if (!config.enabled) {
    return "";
  }
  const snapshotLabel = requireNonEmpty(config.snapshotLabel, "patchPackPreflight.snapshotLabel");
  const patchProfile = config.patchProfile.trim();
  const patchProfileArg = patchProfile.length > 0 ? ` --patch-profile "${patchProfile}"` : "";
  return ` --snapshot-label "${snapshotLabel}"${patchProfileArg}`;
}

function resolveReadabilityConfig(workflow: ManualFirstWorkflowConfig): ReadabilityKpiConfig {
  const defaultTargetFiles = [
    "src/services/store/store-state-quality-01.ts",
    "src/services/store/store-state-g002-quality-01.ts",
    "src/services/store/store-state-quality-02.ts",
  ];
  const rawTargetFiles = workflow.readabilityKpi?.targetFiles ?? defaultTargetFiles;
  const normalizedTargetFiles = rawTargetFiles.map((entry) => normalizeRelativePath(entry));
  return {
    enabled: workflow.readabilityKpi?.enabled ?? true,
    targetFiles: normalizedTargetFiles,
  };
}

function extractCallName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) {
      return argument.text;
    }
  }
  return "";
}

async function collectReadabilityMetricsForFile(
  absolutePath: string,
  relativePath: string,
  domainCallPattern: RegExp,
): Promise<ManualReadabilityFileMetrics> {
  const content = await fs.readFile(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = content.split(/\r?\n/u);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0).length;
  const glueLines = lines.filter((line) => {
    return (
      /^\s*import\s+/u.test(line) ||
      /^\s*export\s+\{[^}]*\}\s+from\s+/u.test(line) ||
      /^\s*export\s+\*\s+from\s+/u.test(line) ||
      /^\s*export\s+type\s+/u.test(line)
    );
  }).length;
  let functionCount = 0;
  let totalFunctionBodyLines = 0;
  let totalCallCount = 0;
  let domainCallCount = 0;
  const pushFunctionBody = (bodyNode: ts.Block): void => {
    const startLine = sourceFile.getLineAndCharacterOfPosition(bodyNode.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(bodyNode.getEnd()).line + 1;
    const lineCount = Math.max(1, endLine - startLine + 1);
    functionCount += 1;
    totalFunctionBodyLines += lineCount;
  };
  const visitNode = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      pushFunctionBody(node.body);
    } else if (ts.isMethodDeclaration(node) && node.body) {
      pushFunctionBody(node.body);
    } else if (ts.isFunctionExpression(node) && node.body) {
      pushFunctionBody(node.body);
    } else if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
      pushFunctionBody(node.body);
    }
    if (ts.isCallExpression(node)) {
      totalCallCount += 1;
      const callName = extractCallName(node.expression);
      if (callName.length > 0 && domainCallPattern.test(callName)) {
        domainCallCount += 1;
      }
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(sourceFile);
  return {
    filePath: relativePath,
    lineCount: lines.length,
    functionCount,
    avgFunctionBodyLength: functionCount > 0 ? totalFunctionBodyLines / functionCount : 0,
    glueRatio: glueLines / Math.max(1, nonEmptyLines),
    domainCallDensity: domainCallCount / Math.max(1, totalCallCount),
  };
}

async function collectReadabilityKpi(
  manualProjectPath: string,
  config: ReadabilityKpiConfig,
): Promise<ManualReadabilityKpiMetrics> {
  const domainCallPattern = /(state|event|route|session|workspace|ipc|transport|store|service)/i;
  const files: ManualReadabilityFileMetrics[] = [];
  for (const targetFile of config.targetFiles) {
    const absolutePath = path.join(manualProjectPath, targetFile);
    if (!(await fileExists(absolutePath))) {
      throw new Error(`readability KPI target file not found: ${absolutePath}`);
    }
    const metrics = await collectReadabilityMetricsForFile(absolutePath, targetFile, domainCallPattern);
    files.push(metrics);
  }
  const targetCount = Math.max(1, files.length);
  const avgFunctionBodyLength = files.reduce((sum, file) => sum + file.avgFunctionBodyLength, 0) / targetCount;
  const glueRatio = files.reduce((sum, file) => sum + file.glueRatio, 0) / targetCount;
  const domainCallDensity = files.reduce((sum, file) => sum + file.domainCallDensity, 0) / targetCount;
  return {
    targetFiles: [...config.targetFiles],
    files,
    avgFunctionBodyLength,
    glueRatio,
    domainCallDensity,
  };
}

function compareReadabilityKpi(
  before: ManualReadabilityKpiMetrics,
  after: ManualReadabilityKpiMetrics,
): ManualReadabilityDelta {
  const avgFunctionBodyLengthDelta = after.avgFunctionBodyLength - before.avgFunctionBodyLength;
  const glueRatioDelta = after.glueRatio - before.glueRatio;
  const domainCallDensityDelta = after.domainCallDensity - before.domainCallDensity;
  const improvedSignals: string[] = [];
  if (avgFunctionBodyLengthDelta < -0.01) {
    improvedSignals.push("avgFunctionBodyLength");
  }
  if (glueRatioDelta < -0.0001) {
    improvedSignals.push("glueRatio");
  }
  if (domainCallDensityDelta > 0.0001) {
    improvedSignals.push("domainCallDensity");
  }
  return {
    avgFunctionBodyLength: avgFunctionBodyLengthDelta,
    glueRatio: glueRatioDelta,
    domainCallDensity: domainCallDensityDelta,
    improvedSignals,
    grew: improvedSignals.length > 0,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const workflow = await readJsonFile<ManualFirstWorkflowConfig>(cli.workflowConfigPath);
  const manualProjectPath = path.resolve(workflow.manualProjectPath);
  const snapshotAsarPath = path.resolve(workflow.snapshotAsarPath);
  if (!(await fileExists(manualProjectPath))) {
    throw new Error(`manual project not found: ${manualProjectPath}`);
  }
  if (!(await fileExists(snapshotAsarPath))) {
    throw new Error(`snapshot not found: ${snapshotAsarPath}`);
  }
  if (workflow.patchPackPreflight.enabled) {
    await runCommand(buildPatchPackPreflightCommand(workflow.patchPackPreflight), projectRoot);
    if (workflow.patchPackPreflight.runConflictFixture) {
      await runCommand("npm run patch-pack:test:mod-conflict", projectRoot);
    }
  }
  const freezePath = path.join(projectRoot, MANUAL_GENERATOR_FREEZE_RELATIVE_PATH);
  const freezeExists = await fileExists(freezePath);
  if (freezeExists && !cli.allowAfterFreeze) {
    throw new Error(`manual generator freeze is active at ${freezePath}; pass --allow-after-freeze to continue`);
  }

  await verifyManualDomainStructure(manualProjectPath, workflow.domainSourceRoots);
  const readabilityConfig = resolveReadabilityConfig(workflow);
  const readabilityBefore = readabilityConfig.enabled
    ? await collectReadabilityKpi(manualProjectPath, readabilityConfig)
    : {
      targetFiles: [],
      files: [],
      avgFunctionBodyLength: 0,
      glueRatio: 0,
      domainCallDensity: 0,
    };

  const statePath = path.join(projectRoot, MANUAL_BATCH_STATE_RELATIVE_PATH);
  await ensureDirectory(path.dirname(statePath));
  const previousState = (await fileExists(statePath))
    ? await readJsonFile<BatchState>(statePath)
    : {
      version: 1,
      batchIndex: 0,
      noGrowthStreak: 0,
      lastNameQuality: 0,
      lastRunAtIso: "",
    };
  const batchIndex = previousState.batchIndex + 1;
  const fullGateEvery = Math.max(1, Math.trunc(workflow.fullGateEveryBatches));
  const fullGateExecuted = batchIndex % fullGateEvery === 0;
  const gateCommands = fullGateExecuted ? workflow.fullGateCommands : workflow.lightGateCommands;
  for (const gateCommand of gateCommands) {
    await runCommand(gateCommand, manualProjectPath);
  }

  let generatorSyncExecuted = false;
  let generatorSyncRolledBack = false;
  let generatorSyncSkippedReason = "";
  const contractSnapshot = await createManualSyncContractSnapshot(projectRoot);
  if (!workflow.generatorSync.enabled || cli.skipGeneratorSync) {
    generatorSyncSkippedReason = workflow.generatorSync.enabled ? "skipped_by_cli" : "disabled_in_config";
  } else {
    const maxPasses = Math.max(1, Math.trunc(workflow.generatorSync.maxPassesPerBatch));
    if (maxPasses !== 1) {
      throw new Error("manual batch policy violation: maxPassesPerBatch must be 1");
    }
    generatorSyncExecuted = true;
    const fastFocusCount = Math.max(1, Math.trunc(workflow.generatorSync.fastFocusCount ?? 10));
    const promotionBudgetPerCycle = Math.max(1, Math.trunc(workflow.generatorSync.promotionBudgetPerCycle ?? 140));
    const fastProfileId = (workflow.generatorSync.fastProfileId ?? "core-no-binary").trim();
    if (fastProfileId.length < 1) {
      throw new Error("manual batch policy violation: fastProfileId must be non-empty");
    }
    try {
      await runCommand(
        `set "CODEX_ROUNDTRIP_RELAX_QUALITY_SHARD_FAILFAST=1" && npm run regression:cycles -- --snapshot "${snapshotAsarPath}" --max-cycles 1 --allow-after-freeze --suite-run-prefix "${workflow.generatorSync.suiteRunPrefix}" --fast-profile-id "${fastProfileId}" --fast-focus-count ${fastFocusCount} --promotion-budget-per-cycle ${promotionBudgetPerCycle}`,
        projectRoot,
      );
    } catch (error) {
      await restoreManualSyncContractSnapshot(projectRoot, contractSnapshot);
      generatorSyncExecuted = false;
      const reason = error instanceof Error ? (error.message || "unknown_error") : String(error);
      generatorSyncSkippedReason = `generator_sync_failed:${reason}`;
    }
  }

  const hotRescueConfig: HotRescueConfig = {
    enabled: workflow.hotRescue?.enabled ?? true,
    candidatesPath: path.resolve(
      workflow.hotRescue?.candidatesPath ??
      path.join(projectRoot, "regression", "manual-refactor-candidates.json"),
    ),
    topN: Math.max(1, Math.trunc(workflow.hotRescue?.topN ?? 10)),
    namespaceImportCap: Math.max(1, Math.trunc(workflow.hotRescue?.namespaceImportCap ?? 8)),
    longFunctionLineThreshold: Math.max(20, Math.trunc(workflow.hotRescue?.longFunctionLineThreshold ?? 120)),
  };
  const hotRescueReportPath = path.join(projectRoot, MANUAL_HOT_RESCUE_REPORT_RELATIVE_PATH);
  let hotRescueViolationCount = 0;
  let hotRescueTargetCount = 0;
  if (hotRescueConfig.enabled) {
    const hotRescueReport = await runManualHotRescue({
      manualProjectPath,
      candidatesPath: hotRescueConfig.candidatesPath,
      topN: hotRescueConfig.topN,
      namespaceImportCap: hotRescueConfig.namespaceImportCap,
      longFunctionLineThreshold: hotRescueConfig.longFunctionLineThreshold,
      outputPath: hotRescueReportPath,
    });
    hotRescueViolationCount = hotRescueReport.violationCount;
    hotRescueTargetCount = hotRescueReport.targetCount;
    if (hotRescueReport.violationCount > 0) {
      const violationSummary = hotRescueReport.targets
        .flatMap((target) =>
          target.violations.map((violation) => `${target.manualFilePath} [rank ${target.rank}] -> ${violation}`),
        )
        .join("\n");
      throw new Error(`manual hot rescue gate failed:\n${violationSummary}`);
    }
  }

  const mergedEvidencePath = await findLatestMergedEvidencePath(projectRoot);
  await runCommand(
    `npm run manual-sync:export -- --manual-project "${manualProjectPath}" --merged-evidence "${mergedEvidencePath}" --promotion-top-n ${Math.max(1, Math.trunc(workflow.promotionTopN))}`,
    projectRoot,
  );
  const roundtripPatchPackArgs = buildRoundtripPatchPackArgs(workflow.patchPackPreflight);
  let roundtripFailureReason = "";
  try {
    await runCommand(
      `npm run manual-sync:roundtrip -- --snapshot "${snapshotAsarPath}" --manual-project "${manualProjectPath}" --profile latest${roundtripPatchPackArgs}`,
      projectRoot,
    );
  } catch (error) {
    const reason = error instanceof Error ? (error.message || "unknown_error") : String(error);
    roundtripFailureReason = reason;
    generatorSyncSkippedReason = generatorSyncSkippedReason.length > 0
      ? `${generatorSyncSkippedReason};roundtrip_failed:${reason}`
      : `roundtrip_failed:${reason}`;
  }

  const roundtripReportPath = path.join(projectRoot, MANUAL_ROUNDTRIP_REPORT_RELATIVE_PATH);
  const roundtripReport = (await fileExists(roundtripReportPath))
    ? await readJsonFile<Record<string, unknown>>(roundtripReportPath)
    : {};
  if (roundtripFailureReason.length > 0 && !Object.prototype.hasOwnProperty.call(roundtripReport, "afterMetrics")) {
    roundtripReport.beforeMetrics = {};
    roundtripReport.afterMetrics = {};
  }
  const beforeMetrics = toRoundtripMetrics(
    (typeof roundtripReport.beforeMetrics === "object" && roundtripReport.beforeMetrics
      ? roundtripReport.beforeMetrics
      : {}) as Record<string, unknown>,
  );
  const afterMetrics = toRoundtripMetrics(
    (typeof roundtripReport.afterMetrics === "object" && roundtripReport.afterMetrics
      ? roundtripReport.afterMetrics
      : {}) as Record<string, unknown>,
  );
  const readabilityAfter = readabilityConfig.enabled
    ? await collectReadabilityKpi(manualProjectPath, readabilityConfig)
    : readabilityBefore;
  const readabilityDelta = compareReadabilityKpi(readabilityBefore, readabilityAfter);
  const cycleQualityDelta = afterMetrics.nameQuality - beforeMetrics.nameQuality;
  if (generatorSyncExecuted && cycleQualityDelta <= 0 && !readabilityDelta.grew) {
    await restoreManualSyncContractSnapshot(projectRoot, contractSnapshot);
    generatorSyncRolledBack = true;
    generatorSyncSkippedReason = "rolled_back_no_roundtrip_or_local_kpi_gain";
  }
  const effectiveAfterMetrics = generatorSyncRolledBack ? beforeMetrics : afterMetrics;
  const effectiveReadabilityAfter = generatorSyncRolledBack ? readabilityBefore : readabilityAfter;
  const effectiveReadabilityDelta = generatorSyncRolledBack
    ? compareReadabilityKpi(readabilityBefore, readabilityBefore)
    : readabilityDelta;
  const qualityDelta = effectiveAfterMetrics.nameQuality - previousState.lastNameQuality;
  const cycleSuccessful = qualityDelta > 0 && effectiveReadabilityDelta.grew;
  const noGrowthStreak = cycleSuccessful ? 0 : previousState.noGrowthStreak + 1;
  const stopAfterNoGrowth = Math.max(1, Math.trunc(workflow.generatorSync.stopAfterNoQualityGrowthBatches));
  const generatorSyncFrozen = noGrowthStreak >= stopAfterNoGrowth;

  const nextState: BatchState = {
    version: 1,
    batchIndex,
    noGrowthStreak,
    lastNameQuality: effectiveAfterMetrics.nameQuality,
    lastRunAtIso: new Date().toISOString(),
  };
  await writeJsonFile(statePath, nextState);
  if (generatorSyncFrozen) {
    await writeJsonFile(freezePath, {
      version: 1,
      generatedAtIso: new Date().toISOString(),
      reason: "manual-batch stop-rule reached: no global+local readability growth",
      batchIndex,
      noGrowthStreak,
      stopAfterNoGrowth,
      lastNameQuality: effectiveAfterMetrics.nameQuality,
    });
  }

  const report: ManualBatchReport = {
    generatedAtIso: new Date().toISOString(),
    batchIndex,
    manualProjectPath,
    snapshotAsarPath,
    fullGateExecuted,
    generatorSyncExecuted,
    generatorSyncSkippedReason,
    mergedEvidencePath,
    exportReportPath: path.join(projectRoot, MANUAL_EXPORT_REPORT_RELATIVE_PATH),
    roundtripReportPath,
    hotRescueReportPath,
    hotRescueViolationCount,
    hotRescueTargetCount,
    beforeMetrics,
    afterMetrics: effectiveAfterMetrics,
    readabilityBefore,
    readabilityAfter: effectiveReadabilityAfter,
    readabilityDelta: effectiveReadabilityDelta,
    cycleSuccessful,
    noGrowthStreak,
    generatorSyncFrozen,
    generatorSyncRolledBack,
  };
  const reportPath = path.join(projectRoot, MANUAL_BATCH_REPORT_RELATIVE_PATH);
  await ensureDirectory(path.dirname(reportPath));
  await writeJsonFile(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
