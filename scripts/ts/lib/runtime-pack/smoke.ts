import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists, removePath, writeError, writeHeader, writeSuccess, writeWarn } from "../exec";

export type SmokeLaneName = "no-mods" | "minimal" | "with-mods" | "isolated-home";

export type SmokeLaneSummary = {
  lane: string;
  stdout_bytes: number;
  chromium_bytes: number;
  cli_initialized: number;
  ready_message: number;
  statsig_ready: number;
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

function cleanupLaneState(outputDir: string, lane: SmokeLaneName): void {
  const suffix =
    lane === "isolated-home"
      ? "-isolated-home"
      : lane === "with-mods"
        ? "-with-mods"
        : lane === "no-mods"
          ? "-no-mods"
          : "-minimal";
  removePath(path.join(outputDir, `userdata${suffix}`));
  removePath(path.join(outputDir, `cache${suffix}`));
  if (lane === "isolated-home") {
    removePath(path.join(outputDir, "codex-home-isolated"));
  }
}

async function runSmokeLane(outputDir: string, lane: SmokeLaneName, holdSeconds: number): Promise<void> {
  cleanupLaneState(outputDir, lane);
  const launcherPath = resolveLaneLauncherPath(outputDir, lane);
  writeHeader(`Smoke lane: ${lane}`);
  const child = spawn("cmd.exe", ["/c", launcherPath], {
    cwd: outputDir,
    detached: false,
    stdio: "ignore",
    windowsHide: true,
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
  if (!Array.isArray(parsed)) {
    throw new Error(`Runtime lane summary must be an array: ${summaryJsonPath}`);
  }
  return parsed as SmokeLaneSummary[];
}

function evaluateLaneSummary(summary: SmokeLaneSummary): string[] {
  const failures: string[] = [];
  if (summary.cli_initialized < 1) failures.push("cli_initialized=0");
  if (summary.ready_message < 1) failures.push("ready_message=0");
  if (summary.dom_ready < 1) failures.push("dom_ready=0");
  if (summary.did_finish_load < 1) failures.push("did_finish_load=0");
  if (summary.ready_to_show < 1) failures.push("ready_to_show=0");
  if (summary.window_show < 1) failures.push("window_show=0");
  if (summary.thread_list < 1) failures.push("thread_list=0");
  if (summary.app_list < 1) failures.push("app_list=0");
  if (summary.syntax_error > 0) failures.push(`syntax_error=${summary.syntax_error}`);
  if (summary.renderer_mod_failed > 0) failures.push(`renderer_mod_failed=${summary.renderer_mod_failed}`);
  if (summary.preload_error > 0) failures.push(`preload_error=${summary.preload_error}`);
  if (summary.update_required > 0) failures.push(`update_required=${summary.update_required}`);
  if (summary.did_fail_load > 0) failures.push(`did_fail_load=${summary.did_fail_load}`);
  if (summary.render_process_gone > 0) failures.push(`render_process_gone=${summary.render_process_gone}`);
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

export async function runPortableSmoke(outputDir: string, smokeSeconds: number, rawLanes?: string): Promise<PortableSmokeResult> {
  if (!fileExists(outputDir)) {
    throw new Error(`Portable output missing for smoke: ${outputDir}`);
  }

  const lanes = parseSmokeLanes(rawLanes);
  removePath(path.join(outputDir, "runtime-logs"));

  for (const lane of lanes) {
    await runSmokeLane(outputDir, lane, smokeSeconds);
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
    for (const failure of evaluateLaneSummary(summary)) {
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
