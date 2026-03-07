import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, ensureDir, fileExists, removePath, writeError, writeHeader, writeSuccess, writeWarn } from "../exec";

export type SmokeLaneName = "no-mods" | "minimal" | "with-mods" | "isolated-home";

export type SmokeLaneSummary = {
  lane: string;
  stdout_bytes: number;
  chromium_bytes: number;
  cli_initialized: number;
  ready_message: number;
  statsig_ready: number;
  auth_unset: number;
  dom_ready: number;
  did_finish_load: number;
  window_show: number;
  ready_to_show: number;
  did_fail_load: number;
  render_process_gone: number;
  syntax_error: number;
  renderer_mod_failed: number;
  preload_error: number;
  update_required: number;
  account_read: number;
  thread_list: number;
  app_list: number;
  skills_list: number;
  usability_sidebar_present: number;
  usability_settings_present: number;
  usability_project_list_present: number;
  usability_surface_ready: number;
  usability_blocking_spinner: number;
  git_origin_failed: number;
  thread_backfill_failed: number;
};

export type PortableSmokeResult = {
  success: boolean;
  outputDir: string;
  lanes: SmokeLaneSummary[];
  failures: string[];
  summaryPath: string;
  summaryJsonPath: string;
};

const DEFAULT_SMOKE_LANES: SmokeLaneName[] = ["no-mods", "minimal", "with-mods", "isolated-home"];
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
  const fileName =
    lane === "isolated-home"
      ? "Launch-Codex-isolated-home.cmd"
      : lane === "with-mods"
        ? "Launch-Codex-with-mods.cmd"
        : lane === "no-mods"
          ? "Launch-Codex-no-mods.cmd"
          : "Launch-Codex-minimal.cmd";
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
    if (!DEFAULT_SMOKE_LANES.includes(lane)) {
      throw new Error(`Unsupported smoke lane: ${lane}`);
    }
  }
  return Array.from(new Set(lanes));
}

function getLaneSuffix(lane: SmokeLaneName): string {
  return lane === "isolated-home"
    ? "-isolated-home"
    : lane === "with-mods"
      ? "-with-mods"
      : lane === "no-mods"
        ? "-no-mods"
        : "-minimal";
}

function resolveLaneUserDataDir(outputDir: string, lane: SmokeLaneName): string {
  return path.join(outputDir, `userdata${getLaneSuffix(lane)}`);
}

function resolveLaneCacheDir(outputDir: string, lane: SmokeLaneName): string {
  return path.join(outputDir, `cache${getLaneSuffix(lane)}`);
}

function resolveSeededCodexHomeDir(outputDir: string, lane: SmokeLaneName): string {
  return path.join(outputDir, `codex-home-seeded${getLaneSuffix(lane)}`);
}

function cleanupLaneState(outputDir: string, lane: SmokeLaneName, codexHomeSeedPath?: string): void {
  const suffix = getLaneSuffix(lane);
  removePath(path.join(outputDir, `userdata${suffix}`));
  removePath(path.join(outputDir, `cache${suffix}`));
  if (lane === "isolated-home") {
    removePath(path.join(outputDir, "codex-home-isolated"));
  }
  if (codexHomeSeedPath && lane !== "isolated-home") {
    removePath(resolveSeededCodexHomeDir(outputDir, lane));
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
  const laneUserDataDir = resolveLaneUserDataDir(outputDir, lane);
  const laneCacheDir = resolveLaneCacheDir(outputDir, lane);
  copySeedSnapshot(options.userDataSeedPath, laneUserDataDir, "userData");

  const seededCodexHomeDir =
    options.codexHomeSeedPath && lane !== "isolated-home"
      ? resolveSeededCodexHomeDir(outputDir, lane)
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

function refreshLaneSummary(outputDir: string): void {
  const compareLauncherPath = path.join(outputDir, "Compare-Runtime-Lanes.cmd");
  if (!fileExists(compareLauncherPath)) {
    throw new Error(`Runtime compare launcher missing: ${compareLauncherPath}`);
  }
  const result = spawnSync("cmd.exe", ["/c", compareLauncherPath], {
    cwd: outputDir,
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Compare-Runtime-Lanes failed with exit=${result.status}`);
  }
}

function readLaneSummary(outputDir: string): SmokeLaneSummary[] {
  const summaryJsonPath = path.join(outputDir, "runtime-logs", "lane-summary.json");
  if (!fileExists(summaryJsonPath)) {
    throw new Error(`Runtime lane summary missing: ${summaryJsonPath}`);
  }
  const rawValue = fs.readFileSync(summaryJsonPath, "utf8").trim();
  const parsed = JSON.parse(rawValue);
  if (Array.isArray(parsed)) {
    return parsed as SmokeLaneSummary[];
  }
  if (parsed && typeof parsed === "object") {
    return [parsed as SmokeLaneSummary];
  }
  throw new Error(`Runtime lane summary must be an object or array: ${summaryJsonPath}`);
}

function evaluateLaneSummary(summary: SmokeLaneSummary, options: PortableSmokeOptions): string[] {
  const failures: string[] = [];
  const seededAuthenticatedSmoke = Boolean(options.userDataSeedPath && options.codexHomeSeedPath);
  const requireAuthenticatedSurface =
    summary.lane !== "isolated-home" &&
    (seededAuthenticatedSmoke || summary.auth_unset < 1);
  if (summary.cli_initialized < 1) failures.push("cli_initialized=0");
  if (summary.ready_message < 1) failures.push("ready_message=0");
  if (summary.dom_ready < 1) failures.push("dom_ready=0");
  if (summary.did_finish_load < 1) failures.push("did_finish_load=0");
  if (summary.ready_to_show < 1) failures.push("ready_to_show=0");
  if (summary.window_show < 1) failures.push("window_show=0");
  if (seededAuthenticatedSmoke && summary.lane !== "isolated-home" && summary.auth_unset > 0) failures.push(`auth_unset=${summary.auth_unset}`);
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

  refreshLaneSummary(outputDir);
  const summaries = readLaneSummary(outputDir);
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
