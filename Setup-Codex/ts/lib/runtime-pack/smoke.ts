import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, ensureDir, fileExists, removePath, writeError, writeHeader, writeSuccess, writeWarn } from "../exec";
import { RuntimeLaneSummary, summarizeRuntimeLanes } from "./runtime-compare";

export type SmokeLaneName = "default" | "with-mods";

export type SmokeLaneSummary = RuntimeLaneSummary;

export type PortableSmokeResult = {
  success: boolean;
  outputDir: string;
  lanes: SmokeLaneSummary[];
  failures: string[];
  summaryPath: string;
  summaryJsonPath: string;
};

const DEFAULT_SMOKE_LANES: SmokeLaneName[] = ["default"];
const SUPPORTED_SMOKE_LANES: SmokeLaneName[] = ["default", "with-mods"];
const CODEX_HOME_SEED_FILES = [
  ".codex-global-state.json",
  ".personality_migration",
  "auth.json",
  "cap_sid",
  "config.toml",
  "history.jsonl",
  "models_cache.json",
  "session_index.jsonl",
  "version.json",
];
const CODEX_HOME_SEED_DIRS = [
  ".sandbox",
  ".sandbox-bin",
  ".sandbox-secrets",
  "automations",
  "memories",
  "prompts",
  "rules",
  "skills",
  "sqlite",
  "vendor_imports",
];
const USER_DATA_SEED_FILES = [
  "Local State",
  "Preferences",
  "DIPS",
  "DIPS-wal",
  "SharedStorage",
  "SharedStorage-wal",
];
const USER_DATA_SEED_DIRS = [
  "blob_storage",
  "Local Storage",
  "Session Storage",
  "Network",
];

export type PortableSmokeOptions = {
  outputDir: string;
  smokeSeconds: number;
  rawLanes?: string;
  userDataSeedPath?: string;
  codexHomeSeedPath?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLaneLauncherPath(outputDir: string, lane: SmokeLaneName): string {
  const fileName = lane === "with-mods" ? "Launch-Codex-with-mods.cmd" : "Launch-Codex.cmd";
  const launcherPath = path.join(outputDir, fileName);
  if (!fileExists(launcherPath)) {
    throw new Error(`Smoke launcher missing: ${launcherPath}`);
  }
  return launcherPath;
}

function parseSmokeLanes(rawValue: string | undefined): SmokeLaneName[] {
  if (!rawValue) return [...DEFAULT_SMOKE_LANES];
  const lanes = rawValue
    .split(",")
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean) as SmokeLaneName[];
  if (lanes.length === 0) return [...DEFAULT_SMOKE_LANES];
  for (const lane of lanes) {
    if (!SUPPORTED_SMOKE_LANES.includes(lane)) {
      throw new Error(`Unsupported smoke lane: ${lane}`);
    }
  }
  return Array.from(new Set(lanes));
}

function getLaneSuffix(lane: SmokeLaneName): string {
  return lane === "with-mods" ? "-with-mods" : "";
}

function getRunStateSuffix(lane: SmokeLaneName, seededRun: boolean): string {
  const laneSuffix = getLaneSuffix(lane);
  return seededRun ? `-auth${laneSuffix}` : laneSuffix;
}

function resolveLaneUserDataDir(outputDir: string, lane: SmokeLaneName, seededRun: boolean): string {
  return path.join(outputDir, `userdata${getRunStateSuffix(lane, seededRun)}`);
}

function resolveLaneCacheDir(outputDir: string, lane: SmokeLaneName, seededRun: boolean): string {
  return path.join(outputDir, `cache${getRunStateSuffix(lane, seededRun)}`);
}

function resolveSeededCodexHomeDir(outputDir: string, lane: SmokeLaneName, seededRun: boolean): string {
  return path.join(outputDir, `codex-home-seeded${getRunStateSuffix(lane, seededRun)}`);
}

function cleanupLaneState(outputDir: string, lane: SmokeLaneName, codexHomeSeedPath?: string): void {
  const seededRun = Boolean(codexHomeSeedPath);
  removePath(resolveLaneUserDataDir(outputDir, lane, seededRun));
  removePath(resolveLaneCacheDir(outputDir, lane, seededRun));
  if (codexHomeSeedPath) {
    removePath(resolveSeededCodexHomeDir(outputDir, lane, true));
  }
}

function copySeedSnapshot(sourceDir: string | undefined, targetDir: string, label: string): void {
  if (!sourceDir) return;
  const resolvedSource = path.resolve(sourceDir);
  if (!fileExists(resolvedSource)) {
    throw new Error(`Smoke ${label} seed missing: ${resolvedSource}`);
  }
  removePath(targetDir);
  copyDirectory(resolvedSource, targetDir);
}

function copyPathSnapshotBestEffort(sourcePath: string, targetPath: string): void {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    ensureDir(targetPath);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      copyPathSnapshotBestEffort(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
    }
    return;
  }
  try {
    copyFileSafe(sourcePath, targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeWarn(`UserData seed copy skipped: ${sourcePath} (${message})`);
  }
}

function copyUserDataSeedSnapshot(sourceDir: string | undefined, targetDir: string): void {
  if (!sourceDir) return;
  const resolvedSource = path.resolve(sourceDir);
  if (!fileExists(resolvedSource)) {
    throw new Error(`Smoke userData seed missing: ${resolvedSource}`);
  }

  removePath(targetDir);
  ensureDir(targetDir);

  for (const fileName of USER_DATA_SEED_FILES) {
    const sourcePath = path.join(resolvedSource, fileName);
    if (!fileExists(sourcePath)) continue;
    copyPathSnapshotBestEffort(sourcePath, path.join(targetDir, fileName));
  }

  for (const dirName of USER_DATA_SEED_DIRS) {
    const sourcePath = path.join(resolvedSource, dirName);
    if (!fileExists(sourcePath)) continue;
    copyPathSnapshotBestEffort(sourcePath, path.join(targetDir, dirName));
  }
}

function copyCodexHomeSeedSnapshot(sourceDir: string | undefined, targetDir: string): void {
  if (!sourceDir) return;
  const resolvedSource = path.resolve(sourceDir);
  if (!fileExists(resolvedSource)) {
    throw new Error(`Smoke CODEX_HOME seed missing: ${resolvedSource}`);
  }

  removePath(targetDir);
  ensureDir(targetDir);

  for (const fileName of CODEX_HOME_SEED_FILES) {
    const sourcePath = path.join(resolvedSource, fileName);
    if (!fileExists(sourcePath)) continue;
    copyFileSafe(sourcePath, path.join(targetDir, fileName));
  }

  for (const dirName of CODEX_HOME_SEED_DIRS) {
    const sourcePath = path.join(resolvedSource, dirName);
    if (!fileExists(sourcePath)) continue;
    copyDirectory(sourcePath, path.join(targetDir, dirName));
  }

  const backupCandidates = fs
    .readdirSync(resolvedSource, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^state_5\.sqlite\.bak/i.test(entry.name))
    .map((entry) => path.join(resolvedSource, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (backupCandidates.length > 0) {
    copyFileSafe(backupCandidates[0], path.join(targetDir, "state_5.sqlite"));
  }
}

async function runSmokeLane(outputDir: string, lane: SmokeLaneName, holdSeconds: number, options: PortableSmokeOptions): Promise<void> {
  cleanupLaneState(outputDir, lane, options.codexHomeSeedPath);
  const seededRun = Boolean(options.userDataSeedPath || options.codexHomeSeedPath);
  const laneUserDataDir = resolveLaneUserDataDir(outputDir, lane, seededRun);
  const laneCacheDir = resolveLaneCacheDir(outputDir, lane, seededRun);
  copyUserDataSeedSnapshot(options.userDataSeedPath, laneUserDataDir);

  const seededCodexHomeDir =
    options.codexHomeSeedPath
      ? resolveSeededCodexHomeDir(outputDir, lane, seededRun)
      : "";
  if (seededCodexHomeDir) {
    copyCodexHomeSeedSnapshot(options.codexHomeSeedPath, seededCodexHomeDir);
  }

  const launcherPath = resolveLaneLauncherPath(outputDir, lane);
  writeHeader(`Smoke lane: ${lane}`);
  const child = spawn("cmd.exe", ["/c", launcherPath], {
    cwd: outputDir,
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_WINDOWS_USABILITY_SMOKE: "1",
      ...(seededCodexHomeDir ? { CODEX_HOME: seededCodexHomeDir } : {}),
    },
  });
  await sleep(holdSeconds * 1000);
  spawnSync("cmd.exe", ["/c", "taskkill", "/PID", String(child.pid), "/T", "/F"], {
    cwd: outputDir,
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(3000);
}

function evaluateLaneSummary(summary: SmokeLaneSummary, options: PortableSmokeOptions): string[] {
  const failures: string[] = [];
  const seededAuthenticatedSmoke = Boolean(options.userDataSeedPath && options.codexHomeSeedPath);
  const requireAuthenticatedSurface = seededAuthenticatedSmoke || summary.auth_unset < 1;
  if (summary.cli_initialized < 1) failures.push("cli_initialized=0");
  if (summary.ready_message < 1) failures.push("ready_message=0");
  if (summary.dom_ready < 1) failures.push("dom_ready=0");
  if (summary.did_finish_load < 1) failures.push("did_finish_load=0");
  if (summary.ready_to_show < 1) failures.push("ready_to_show=0");
  if (summary.window_show < 1) failures.push("window_show=0");
  if (seededAuthenticatedSmoke && summary.auth_unset > 0) failures.push(`auth_unset=${summary.auth_unset}`);
  if (requireAuthenticatedSurface && summary.thread_list < 1) failures.push("thread_list=0");
  if (requireAuthenticatedSurface && summary.app_list < 1) failures.push("app_list=0");
  if (requireAuthenticatedSurface && summary.usability_sidebar_present < 1) failures.push("usability_sidebar_present=0");
  if (requireAuthenticatedSurface && summary.usability_settings_present < 1) failures.push("usability_settings_present=0");
  if (requireAuthenticatedSurface && summary.usability_surface_ready < 1) failures.push("usability_surface_ready=0");
  if (summary.syntax_error > 0) failures.push(`syntax_error=${summary.syntax_error}`);
  if (summary.renderer_mod_failed > 0) failures.push(`renderer_mod_failed=${summary.renderer_mod_failed}`);
  if (summary.preload_error > 0) failures.push(`preload_error=${summary.preload_error}`);
  if (summary.update_required > 0) failures.push(`update_required=${summary.update_required}`);
  if (summary.did_fail_load > 0) failures.push(`did_fail_load=${summary.did_fail_load}`);
  if (summary.render_process_gone > 0) failures.push(`render_process_gone=${summary.render_process_gone}`);
  if (summary.usability_blocking_spinner > 0) failures.push(`usability_blocking_spinner=${summary.usability_blocking_spinner}`);
  return failures;
}

function writeSmokeResult(result: PortableSmokeResult): void {
  writeHeader("Smoke summary");
  writeSuccess(`Summary: ${result.summaryPath}`);
  writeSuccess(`Summary JSON: ${result.summaryJsonPath}`);
  if (result.failures.length === 0) {
    writeSuccess(`All smoke lanes passed (${result.lanes.map((lane) => lane.lane).join(", ")})`);
    return;
  }
  for (const failure of result.failures) {
    writeError(`[smoke] FAIL ${failure}`);
  }
}

export async function runPortableSmoke(options: PortableSmokeOptions): Promise<PortableSmokeResult> {
  const outputDir = options.outputDir;
  if (!fileExists(outputDir)) {
    throw new Error(`Portable output missing for smoke: ${outputDir}`);
  }

  const lanes = parseSmokeLanes(options.rawLanes);
  removePath(path.join(outputDir, "runtime-logs"));

  for (const lane of lanes) {
    await runSmokeLane(outputDir, lane, options.smokeSeconds, options);
  }

  const summaries = summarizeRuntimeLanes(outputDir);
  const failures: string[] = [];
  for (const lane of lanes) {
    const summary = summaries.find((item) => item.lane === lane);
    if (!summary) {
      failures.push(`${lane}: missing summary row`);
      continue;
    }
    for (const failure of evaluateLaneSummary(summary, options)) {
      failures.push(`${lane}: ${failure}`);
    }
  }

  const result: PortableSmokeResult = {
    success: failures.length === 0,
    outputDir,
    lanes: summaries,
    failures,
    summaryPath: path.join(outputDir, "runtime-logs", "lane-summary.txt"),
    summaryJsonPath: path.join(outputDir, "runtime-logs", "lane-summary.json"),
  };
  writeSmokeResult(result);
  return result;
}
