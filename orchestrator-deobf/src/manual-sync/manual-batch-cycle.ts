import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
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

interface ManualFirstWorkflowConfig {
  version: number;
  manualProjectPath: string;
  snapshotAsarPath: string;
  domainSourceRoots: string[];
  lightGateCommands: string[];
  fullGateCommands: string[];
  fullGateEveryBatches: number;
  promotionTopN: number;
  generatorSync: GeneratorSyncConfig;
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

function normalizePathSlashes(input: string): string {
  return input.replace(/\\/g, "/");
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
  const freezePath = path.join(projectRoot, MANUAL_GENERATOR_FREEZE_RELATIVE_PATH);
  const freezeExists = await fileExists(freezePath);
  if (freezeExists && !cli.allowAfterFreeze) {
    throw new Error(`manual generator freeze is active at ${freezePath}; pass --allow-after-freeze to continue`);
  }

  await verifyManualDomainStructure(manualProjectPath, workflow.domainSourceRoots);

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
    await runCommand(
      `npm run regression:cycles -- --snapshot "${snapshotAsarPath}" --max-cycles 1 --allow-after-freeze --suite-run-prefix "${workflow.generatorSync.suiteRunPrefix}" --fast-profile-id "${fastProfileId}" --fast-focus-count ${fastFocusCount} --promotion-budget-per-cycle ${promotionBudgetPerCycle}`,
      projectRoot,
    );
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
  await runCommand(
    `npm run manual-sync:roundtrip -- --snapshot "${snapshotAsarPath}" --manual-project "${manualProjectPath}"`,
    projectRoot,
  );

  const roundtripReportPath = path.join(projectRoot, MANUAL_ROUNDTRIP_REPORT_RELATIVE_PATH);
  const roundtripReport = await readJsonFile<Record<string, unknown>>(roundtripReportPath);
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
  const cycleQualityDelta = afterMetrics.nameQuality - beforeMetrics.nameQuality;
  if (generatorSyncExecuted && cycleQualityDelta <= 0) {
    await restoreManualSyncContractSnapshot(projectRoot, contractSnapshot);
    generatorSyncRolledBack = true;
    generatorSyncSkippedReason = "rolled_back_no_kpi_gain";
  }
  const effectiveAfterMetrics = generatorSyncRolledBack ? beforeMetrics : afterMetrics;
  const qualityDelta = effectiveAfterMetrics.nameQuality - previousState.lastNameQuality;
  const noGrowthStreak = qualityDelta > 0 ? 0 : previousState.noGrowthStreak + 1;
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
      reason: "manual-batch stop-rule reached: no quality growth",
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
