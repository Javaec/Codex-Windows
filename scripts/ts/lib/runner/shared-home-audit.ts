import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { ensureWindowsEnvironment } from "../env";
import { copyDirectory, removePath, resolveCommand, writeHeader, writeSuccess } from "../exec";
import { getWindowsRuntimeDonorBetterSqlite3Path } from "../runtime-donor/windows-apps";
import { REPO_ROOT, sanitizeRunnerEnvironment } from "./context";

type FileAudit = {
  path: string;
  exists: boolean;
  sizeBytes: number;
  modifiedAtIso: string;
};

type ProcessAudit = {
  processId: number;
  name: string;
  commandLine: string;
};

type SqliteAudit =
  | {
      ok: true;
      sourcePath: string;
      journalMode: string;
      lockingMode: string;
      userVersion: number;
      tableCount: number;
      threadCount: number;
      malformedCwdPrefixCount: number;
      malformedRolloutPrefixCount: number;
    }
  | {
      ok: false;
      sourcePath: string;
      error: string;
    };

type SharedHomeAuditReport = {
  generatedAtIso: string;
  codexHomePath: string;
  files: Record<string, FileAudit>;
  globalState: {
    workspaceRootCount: number;
    threadTitleCount: number;
    rawKeyCount: number;
  };
  processes: ProcessAudit[];
  sqlite: SqliteAudit | null;
  contentionHints: string[];
};

function resolveCodexHomePath(explicit: string | undefined): string {
  if (explicit && explicit.trim()) return path.resolve(explicit);
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  if (!userProfile) {
    throw new Error("Unable to resolve USERPROFILE/HOME for shared-home audit");
  }
  return path.join(userProfile, ".codex");
}

function readFileAudit(filePath: string): FileAudit {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      sizeBytes: 0,
      modifiedAtIso: "",
    };
  }
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    sizeBytes: stat.size,
    modifiedAtIso: stat.mtime.toISOString(),
  };
}

function readGlobalStateSummary(codexHomePath: string): SharedHomeAuditReport["globalState"] {
  const globalStatePath = path.join(codexHomePath, ".codex-global-state.json");
  if (!fs.existsSync(globalStatePath)) {
    return {
      workspaceRootCount: 0,
      threadTitleCount: 0,
      rawKeyCount: 0,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
  const roots = Array.isArray(parsed["electron-saved-workspace-roots"]) ? parsed["electron-saved-workspace-roots"] : [];
  const threadTitles = parsed["thread-titles"] && typeof parsed["thread-titles"] === "object" ? parsed["thread-titles"] : {};
  return {
    workspaceRootCount: roots.length,
    threadTitleCount: Object.keys(threadTitles).length,
    rawKeyCount: parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0,
  };
}

function runPowerShellJson(command: string): unknown {
  const shellPath =
    resolveCommand("pwsh.exe") ||
    resolveCommand("pwsh") ||
    resolveCommand("powershell.exe") ||
    resolveCommand("powershell");
  if (!shellPath) {
    throw new Error("PowerShell is not available for shared-home audit");
  }
  const tempScriptPath = path.join(os.tmpdir(), `codex-windows-audit-${process.pid}-${Date.now()}.ps1`);
  const scriptBody = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n${command}\n`;
  fs.writeFileSync(tempScriptPath, scriptBody, "utf8");
  try {
    const result = spawnSync(shellPath, ["-NoProfile", "-File", tempScriptPath], {
      encoding: "utf8",
      windowsHide: true,
    }) as { status: number | null; stdout?: string; stderr?: string; error?: Error };
    if (result.error) {
      throw result.error;
    }
    const status = typeof result.status === "number" ? result.status : 1;
    if (status !== 0) {
      throw new Error((result.stderr || result.stdout || `PowerShell exited with ${status}`).trim());
    }
    return JSON.parse(String(result.stdout || "null").trim() || "null");
  } finally {
    removePath(tempScriptPath);
  }
}

function readCodexProcesses(): ProcessAudit[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -match 'Codex|codex|electron|node' -or ($_.CommandLine -as [string]) -match 'codex'",
    "} | Select-Object ProcessId, Name, CommandLine",
    "$items | ConvertTo-Json -Depth 4",
  ].join("; ");
  const parsed = runPowerShellJson(script);
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return list.map((item) => ({
    processId: Number(item.ProcessId || 0),
    name: String(item.Name || ""),
    commandLine: String(item.CommandLine || ""),
  }));
}

function materializeBetterSqlite3AuditAdapter(outputDir: string): string {
  const betterSqlite3Path = getWindowsRuntimeDonorBetterSqlite3Path();
  if (!betterSqlite3Path) {
    throw new Error("Windows runtime donor does not expose better-sqlite3");
  }
  const sourceDir = fs.statSync(betterSqlite3Path).isDirectory()
    ? betterSqlite3Path
    : path.dirname(path.dirname(betterSqlite3Path));
  const vendorRoot = path.join(outputDir, "vendor");
  const targetDir = path.join(vendorRoot, "better-sqlite3");
  removePath(targetDir);
  copyDirectory(sourceDir, targetDir);
  const entryPath = path.join(targetDir, "lib", "database.js");
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Local better-sqlite3 adapter entry missing: ${entryPath}`);
  }
  return entryPath;
}

function resolveHostCompatibleBetterSqlite3Binding(): string {
  const candidates = [
    path.join(REPO_ROOT, "work", "native-builds", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    path.join(REPO_ROOT, "work", "smoke-mode", "native-builds", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    path.join(REPO_ROOT, "work", "startup-instrument-smoke", "native-builds", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Host-compatible better-sqlite3 native binding is missing under work/native-builds");
}

function readSqliteAudit(codexHomePath: string, outputDir: string): SqliteAudit | null {
  const sqlitePath = path.join(codexHomePath, "state_5.sqlite");
  if (!fs.existsSync(sqlitePath)) return null;

  try {
    const betterSqlite3EntryPath = materializeBetterSqlite3AuditAdapter(outputDir);
    const Database = require(betterSqlite3EntryPath) as new (
      file: string,
      options: { readonly: boolean; fileMustExist: boolean; nativeBinding: string },
    ) => {
      pragma(sql: string, options?: { simple?: boolean }): unknown;
      prepare(sql: string): { get(): { c: number } };
      close(): void;
    };

    const nativeBindingPath = resolveHostCompatibleBetterSqlite3Binding();
    const db = new Database(sqlitePath, {
      readonly: true,
      fileMustExist: true,
      nativeBinding: nativeBindingPath,
    });
    try {
      return {
        ok: true,
        sourcePath: sqlitePath,
        journalMode: String(db.pragma("journal_mode", { simple: true }) || ""),
        lockingMode: String(db.pragma("locking_mode", { simple: true }) || ""),
        userVersion: Number(db.pragma("user_version", { simple: true }) || 0),
        tableCount: Number(db.prepare("select count(*) as c from sqlite_master where type='table'").get().c || 0),
        threadCount: Number(db.prepare("select count(*) as c from threads").get().c || 0),
        malformedCwdPrefixCount: Number(
          db
            .prepare("select count(*) as c from threads where typeof(cwd)='text' and substr(hex(cwd),1,8)='5C5C3F5C'")
            .get().c || 0,
        ),
        malformedRolloutPrefixCount: Number(
          db
            .prepare("select count(*) as c from threads where typeof(rollout_path)='text' and substr(hex(rollout_path),1,8)='5C5C3F5C'")
            .get().c || 0,
        ),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      sourcePath: sqlitePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildContentionHints(report: Omit<SharedHomeAuditReport, "generatedAtIso" | "contentionHints">): string[] {
  const hints: string[] = [];
  const wal = report.files.stateWal;
  const shm = report.files.stateShm;
  if (wal.exists && wal.sizeBytes > 0) {
    hints.push(`state_5.sqlite-wal present (${wal.sizeBytes} bytes)`);
  }
  if (shm.exists && shm.sizeBytes > 0) {
    hints.push(`state_5.sqlite-shm present (${shm.sizeBytes} bytes)`);
  }
  const codexProcesses = report.processes.filter((process) => /codex/i.test(process.name) || /codex/i.test(process.commandLine));
  if (codexProcesses.length > 1) {
    hints.push(`multiple codex-related processes detected (${codexProcesses.length})`);
  }
  if (report.sqlite && report.sqlite.ok && report.sqlite.threadCount > 1000) {
    hints.push(`large thread table (${report.sqlite.threadCount} rows)`);
  }
  if (report.globalState.workspaceRootCount > 10) {
    hints.push(`many saved workspace roots (${report.globalState.workspaceRootCount})`);
  }
  if (report.globalState.threadTitleCount > 100) {
    hints.push(`large thread-title cache (${report.globalState.threadTitleCount})`);
  }
  return hints;
}

export async function runSharedHomeAudit(options: PipelineOptions): Promise<number> {
  sanitizeRunnerEnvironment();
  ensureWindowsEnvironment();

  const codexHomePath = resolveCodexHomePath(options.codexHomePath);
  const outputDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work", "shared-home-audit"));
  fs.mkdirSync(outputDir, { recursive: true });

  writeHeader("Shared-home audit");

  const reportBase = {
    codexHomePath,
    files: {
      globalState: readFileAudit(path.join(codexHomePath, ".codex-global-state.json")),
      stateDb: readFileAudit(path.join(codexHomePath, "state_5.sqlite")),
      stateWal: readFileAudit(path.join(codexHomePath, "state_5.sqlite-wal")),
      stateShm: readFileAudit(path.join(codexHomePath, "state_5.sqlite-shm")),
    },
    globalState: readGlobalStateSummary(codexHomePath),
    processes: readCodexProcesses(),
    sqlite: readSqliteAudit(codexHomePath, outputDir),
  };

  const report: SharedHomeAuditReport = {
    generatedAtIso: new Date().toISOString(),
    ...reportBase,
    contentionHints: buildContentionHints(reportBase),
  };

  const reportPath = path.join(outputDir, "shared-home-audit.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  writeSuccess(`Audit report: ${reportPath}`);
  writeSuccess(`Codex home: ${report.codexHomePath}`);
  writeSuccess(`SQLite: ${report.files.stateDb.sizeBytes} bytes`);
  writeSuccess(`WAL: ${report.files.stateWal.sizeBytes} bytes`);
  writeSuccess(`Processes: ${report.processes.length}`);
  if (report.sqlite && report.sqlite.ok) {
    writeSuccess(`Threads: ${report.sqlite.threadCount}`);
    writeSuccess(`Journal mode: ${report.sqlite.journalMode}`);
  } else if (report.sqlite && !report.sqlite.ok) {
    writeSuccess(`SQLite audit error: ${report.sqlite.error}`);
  }
  if (report.contentionHints.length > 0) {
    for (const hint of report.contentionHints) {
      writeSuccess(`Hint: ${hint}`);
    }
  }
  return 0;
}
