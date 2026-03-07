import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { ensureWindowsEnvironment } from "../env";
import { fileExists, writeHeader, writeSuccess } from "../exec";
import {
  readCodexProcesses,
  readFileAudit,
  readGlobalStateSummary,
  resolveCodexHomePath,
} from "./shared-home-audit";
import { REPO_ROOT, sanitizeRunnerEnvironment } from "./context";

type RuntimeLaneContention = {
  lane: string;
  stdoutBytes: number;
  chromiumBytes: number;
  authUnset: number;
  stateDbLocked: number;
  sqliteBusy: number;
  gitOriginFailed: number;
  threadBackfillFailed: number;
  noPromise: number;
  readyMessage: number;
  domReady: number;
  windowShow: number;
};

type SharedHomeContentionReport = {
  generatedAtIso: string;
  codexHomePath: string;
  runtimeLogsDir: string;
  files: {
    globalState: ReturnType<typeof readFileAudit>;
    stateDb: ReturnType<typeof readFileAudit>;
    stateWal: ReturnType<typeof readFileAudit>;
    stateShm: ReturnType<typeof readFileAudit>;
  };
  globalState: ReturnType<typeof readGlobalStateSummary>;
  processes: ReturnType<typeof readCodexProcesses>;
  lanes: RuntimeLaneContention[];
  contentionHints: string[];
};

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

function readLaneContention(runtimeLogsDir: string): RuntimeLaneContention[] {
  if (!fileExists(runtimeLogsDir)) return [];
  const rows: RuntimeLaneContention[] = [];
  for (const entry of fs.readdirSync(runtimeLogsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const laneDir = path.join(runtimeLogsDir, entry.name);
    const stdoutPath = path.join(laneDir, "stdout-latest.log");
    const chromiumPath = path.join(laneDir, "chromium.log");
    const launchEnvPath = path.join(laneDir, "launch.env.txt");
    const content = [stdoutPath, chromiumPath, launchEnvPath]
      .filter((filePath) => fileExists(filePath))
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    if (!content.trim()) continue;

    rows.push({
      lane: entry.name,
      stdoutBytes: fileExists(stdoutPath) ? fs.statSync(stdoutPath).size : 0,
      chromiumBytes: fileExists(chromiumPath) ? fs.statSync(chromiumPath).size : 0,
      authUnset: countMatches(content, /authMethod=unset/gi),
      stateDbLocked: countMatches(content, /state db locked|database is locked/gi),
      sqliteBusy: countMatches(content, /SQLITE_BUSY|SQLITE_LOCKED/gi),
      gitOriginFailed: countMatches(content, /git-origin-and-roots/gi),
      threadBackfillFailed: countMatches(content, /Failed to backfill app thread title/gi),
      noPromise: countMatches(content, /No promise for request ID/gi),
      readyMessage: countMatches(content, /Handled 'ready' message/gi),
      domReady: countMatches(content, /renderer\.dom-ready|dom-ready/gi),
      windowShow: countMatches(content, /browser-window\.show|show-window/gi),
    });
  }
  rows.sort((left, right) => left.lane.localeCompare(right.lane));
  return rows;
}

function buildContentionHints(report: Omit<SharedHomeContentionReport, "generatedAtIso" | "contentionHints">): string[] {
  const hints: string[] = [];
  if (report.files.stateWal.exists && report.files.stateWal.sizeBytes > 0) {
    hints.push(`state_5.sqlite-wal present (${report.files.stateWal.sizeBytes} bytes)`);
  }
  if (report.files.stateShm.exists && report.files.stateShm.sizeBytes > 0) {
    hints.push(`state_5.sqlite-shm present (${report.files.stateShm.sizeBytes} bytes)`);
  }
  const codexProcesses = report.processes.filter((process) => /codex/i.test(process.name) || /codex/i.test(process.commandLine));
  if (codexProcesses.length > 1) {
    hints.push(`multiple codex-related processes detected (${codexProcesses.length})`);
  }
  for (const lane of report.lanes) {
    if (lane.stateDbLocked > 0 || lane.sqliteBusy > 0) {
      hints.push(`${lane.lane}: sqlite lock markers detected`);
    }
    if (lane.authUnset > 0) {
      hints.push(`${lane.lane}: auth surface is unset`);
    }
    if (lane.gitOriginFailed > 0) {
      hints.push(`${lane.lane}: git-origin failures detected (${lane.gitOriginFailed})`);
    }
    if (lane.threadBackfillFailed > 0) {
      hints.push(`${lane.lane}: thread title backfill failures detected (${lane.threadBackfillFailed})`);
    }
  }
  return Array.from(new Set(hints));
}

export async function runSharedHomeContentionReport(options: PipelineOptions): Promise<number> {
  sanitizeRunnerEnvironment();
  ensureWindowsEnvironment();

  const codexHomePath = resolveCodexHomePath(options.codexHomePath);
  const workDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work", "shared-home-contention"));
  const runtimeLogsDir = path.resolve(options.runtimeLogsDir || path.join(REPO_ROOT, "dist", "Codex-win32-x64", "runtime-logs"));
  fs.mkdirSync(workDir, { recursive: true });

  writeHeader("Shared-home contention report");

  const reportBase = {
    codexHomePath,
    runtimeLogsDir,
    files: {
      globalState: readFileAudit(path.join(codexHomePath, ".codex-global-state.json")),
      stateDb: readFileAudit(path.join(codexHomePath, "state_5.sqlite")),
      stateWal: readFileAudit(path.join(codexHomePath, "state_5.sqlite-wal")),
      stateShm: readFileAudit(path.join(codexHomePath, "state_5.sqlite-shm")),
    },
    globalState: readGlobalStateSummary(codexHomePath),
    processes: readCodexProcesses(),
    lanes: readLaneContention(runtimeLogsDir),
  };

  const report: SharedHomeContentionReport = {
    generatedAtIso: new Date().toISOString(),
    ...reportBase,
    contentionHints: buildContentionHints(reportBase),
  };

  const reportPath = path.join(workDir, "shared-home-contention.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  writeSuccess(`Contention report: ${reportPath}`);
  writeSuccess(`Codex home: ${report.codexHomePath}`);
  writeSuccess(`Runtime logs: ${report.runtimeLogsDir}`);
  writeSuccess(`Processes: ${report.processes.length}`);
  writeSuccess(`Lane rows: ${report.lanes.length}`);
  for (const hint of report.contentionHints) {
    writeSuccess(`Hint: ${hint}`);
  }
  return 0;
}
