/* CODEX-WINDOWS-MAIN-SHIM-TEMPLATE-V1 */
"use strict";

(function codexWindowsMainShimV1() {
  if (globalThis.__CODEX_WINDOWS_MAIN_SHIM_V1__) return;
  globalThis.__CODEX_WINDOWS_MAIN_SHIM_V1__ = true;

  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const url = require("node:url");

    const BUILD_NUMBER = "__BUILD_NUMBER__";
    const BUILD_FLAVOR = "__BUILD_FLAVOR__";

    const resourcesRoot = process.resourcesPath || path.join(__dirname, "..", "..", "..");

    function normalizePathString(value) {
      return typeof value === "string" ? value.trim().replace(/^\"+|\"+$/g, "") : "";
    }

    function normalizeWindowsOpenPath(input) {
      let value = normalizePathString(input);
      if (!value) return value;
      if (/^file:\/\//i.test(value)) {
        try {
          value = url.fileURLToPath(value);
        } catch {
          // keep original
        }
      }

      // Strip accidental diff prefixes (`a/`, `b/`) and malformed drive prefixes (`\\C:\\...`, `/C:/...`).
      value = value.replace(/^([ab])[\\/](?=[^\\/])/, "");
      const isUncPath = /^[/\\]{2}[^/\\]/.test(value) && !/^[/\\]{2}[?.][\\/]/.test(value);
      if (!isUncPath) {
        value = value.replace(/^[/\\]+(?=[A-Za-z]:[\\/])/, "");
      }
      return value;
    }

    function resolveCodexHomeDir() {
      const configured = normalizePathString(process.env.CODEX_HOME || "");
      if (configured) return path.resolve(configured);
      const profileDir = normalizePathString(process.env.USERPROFILE || process.env.HOME || "");
      if (!profileDir) return "";
      return path.join(profileDir, ".codex");
    }

    function listStateDatabasePaths(codexHomeDir) {
      if (!codexHomeDir || !fs.existsSync(codexHomeDir)) return [];
      let entries = [];
      try {
        entries = fs.readdirSync(codexHomeDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const out = [];
      for (const entry of entries) {
        if (!entry || !entry.isFile()) continue;
        if (!/^state(?:_\\d+)?\\.sqlite$/i.test(String(entry.name || ""))) continue;
        out.push(path.join(codexHomeDir, entry.name));
      }
      out.sort((a, b) => String(a).localeCompare(String(b)));
      return out;
    }

    function normalizeThreadPathPrefix(rawValue) {
      if (typeof rawValue !== "string") return "";
      let value = rawValue.trim().replace(/^\"+|\"+$/g, "");
      if (!value) return value;
      if (value.startsWith("\\\\?\\\\")) value = value.slice(4);
      else if (value.startsWith("//?/")) value = value.slice(4);
      else if (value.startsWith("/??/")) value = value.slice(4);
      if (/^[/\\\\][A-Za-z]:[\\\\/]/.test(value)) value = value.slice(1);
      return value;
    }

    function buildThreadPathNormalizeExpression(column) {
      return (
        "CASE " +
        "WHEN typeof(" + column + ")='text' AND length(" + column + ") > 4 AND substr(hex(" + column + "), 1, 8)='5C5C3F5C' THEN substr(" + column + ", 5) " +
        "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '//?/%' THEN substr(" + column + ", 5) " +
        "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '/??/%' THEN substr(" + column + ", 5) " +
        "WHEN typeof(" + column + ")='text' AND " + column + " GLOB '/[A-Za-z]:/*' THEN substr(" + column + ", 2) " +
        "WHEN typeof(" + column + ")='text' AND substr(" + column + ", 1, 1)='\\\\' AND substr(" + column + ", 2, 2) GLOB '[A-Za-z]:' THEN substr(" + column + ", 2) " +
        "ELSE " + column + " END"
      );
    }

    function ensureThreadPathNormalizationTriggers(db, migrationTargets, availableColumns) {
      for (const column of migrationTargets) {
        if (!availableColumns.includes(column)) continue;
        const normalizeExpr = buildThreadPathNormalizeExpression(column);
        const triggerPrefix = "codex_windows_threads_" + column + "_normalize";
        const createInsertTrigger =
          "CREATE TRIGGER IF NOT EXISTS " + triggerPrefix + "_insert " +
          "AFTER INSERT ON threads " +
          "FOR EACH ROW BEGIN " +
          "UPDATE threads SET " + column + " = " + normalizeExpr + " WHERE id = NEW.id; " +
          "END;";
        const createUpdateTrigger =
          "CREATE TRIGGER IF NOT EXISTS " + triggerPrefix + "_update " +
          "AFTER UPDATE OF " + column + " ON threads " +
          "FOR EACH ROW BEGIN " +
          "UPDATE threads SET " + column + " = " + normalizeExpr + " WHERE id = NEW.id; " +
          "END;";
        db.exec(createInsertTrigger);
        db.exec(createUpdateTrigger);
      }
    }

    function migrateThreadCwdPrefixInSqlite(codexHomeDir) {
      const report = {
        codexHomeDir: codexHomeDir || "",
        scannedDatabases: 0,
        updatedDatabases: 0,
        updatedRows: 0,
      };

      const databasePaths = listStateDatabasePaths(codexHomeDir);
      if (databasePaths.length === 0) return report;

      let DatabaseCtor;
      try {
        DatabaseCtor = require("better-sqlite3");
      } catch {
        return report;
      }
      if (typeof DatabaseCtor !== "function") return report;

      const migrationTargets = ["cwd", "rollout_path"];
      const hasThreadsTableQuery = "SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads' LIMIT 1";

      for (const databasePath of databasePaths) {
        let db;
        try {
          db = new DatabaseCtor(databasePath, { fileMustExist: true });
          report.scannedDatabases += 1;

          const hasThreadsTable = db.prepare(hasThreadsTableQuery).get();
          if (!hasThreadsTable) continue;

          let availableColumns = [];
          try {
            availableColumns = db.prepare("PRAGMA table_info(threads)").all().map((row) => String(row && row.name ? row.name : ""));
          } catch {
            availableColumns = [];
          }

          ensureThreadPathNormalizationTriggers(db, migrationTargets, availableColumns);

          let changedRows = 0;
          for (const column of migrationTargets) {
            if (!availableColumns.includes(column)) continue;
            const rows = db
              .prepare("SELECT id, " + column + " AS pathValue FROM threads WHERE typeof(" + column + ")='text'")
              .all();
            if (!Array.isArray(rows) || rows.length === 0) continue;
            const updateStatement = db.prepare("UPDATE threads SET " + column + " = ? WHERE id = ?");
            for (const row of rows) {
              const threadId = row && typeof row.id === "string" ? row.id : "";
              const currentPath = row && typeof row.pathValue === "string" ? row.pathValue : "";
              if (!threadId || !currentPath) continue;
              const normalizedPath = normalizeThreadPathPrefix(currentPath);
              if (!normalizedPath || normalizedPath === currentPath) continue;
              const updateResult = updateStatement.run(normalizedPath, threadId);
              changedRows += Number(updateResult && updateResult.changes ? updateResult.changes : 0);
            }
          }

          if (changedRows > 0) {
            report.updatedDatabases += 1;
            report.updatedRows += changedRows;
          }
        } catch {
          // ignore
        } finally {
          try {
            if (db && typeof db.close === "function") db.close();
          } catch {
            // ignore
          }
        }
      }

      return report;
    }

    // Minimal environment contract.
    if (!process.env.ELECTRON_FORCE_IS_PACKAGED) process.env.ELECTRON_FORCE_IS_PACKAGED = "1";
    if (!process.env.CODEX_BUILD_NUMBER) process.env.CODEX_BUILD_NUMBER = BUILD_NUMBER;
    if (!process.env.CODEX_BUILD_FLAVOR) process.env.CODEX_BUILD_FLAVOR = BUILD_FLAVOR;
    if (!process.env.BUILD_FLAVOR) process.env.BUILD_FLAVOR = BUILD_FLAVOR;
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
    if (!process.env.PWD) process.env.PWD = process.cwd();

    // Prefer repacked/bundled CLI to avoid app-server drift.
    if (!process.env.CODEX_CLI_PATH) {
      const bundledCli = path.join(resourcesRoot, "codex.exe");
      const bundledAppCli = path.join(resourcesRoot, "app", "codex.exe");
      if (fs.existsSync(bundledCli)) process.env.CODEX_CLI_PATH = bundledCli;
      else if (fs.existsSync(bundledAppCli)) process.env.CODEX_CLI_PATH = bundledAppCli;
    }

    // Ensure renderer URL is stable when repacked.
    if (!process.env.ELECTRON_RENDERER_URL) {
      const unpacked = path.join(__dirname, "..", "..", "webview", "index.html");
      const packaged = path.join(resourcesRoot, "app", "webview", "index.html");
      const chosen = fs.existsSync(unpacked) ? unpacked : (fs.existsSync(packaged) ? packaged : "");
      if (chosen) process.env.ELECTRON_RENDERER_URL = url.pathToFileURL(chosen).toString();
    }

    // Apply SQLite normalization early (before UI loads threads).
    migrateThreadCwdPrefixInSqlite(resolveCodexHomeDir());

    // Fix Windows path opening.
    try {
      const electron = require("electron");
      if (electron && electron.shell && !globalThis.__CODEX_WINDOWS_SHELL_OPEN_PATH_PATCHED__) {
        globalThis.__CODEX_WINDOWS_SHELL_OPEN_PATH_PATCHED__ = true;
        const originalOpenPath = typeof electron.shell.openPath === "function" ? electron.shell.openPath.bind(electron.shell) : null;
        const originalShowItemInFolder = typeof electron.shell.showItemInFolder === "function"
          ? electron.shell.showItemInFolder.bind(electron.shell)
          : null;
        if (originalOpenPath) {
          electron.shell.openPath = (targetPath) => originalOpenPath(normalizeWindowsOpenPath(targetPath));
        }
        if (originalShowItemInFolder) {
          electron.shell.showItemInFolder = (targetPath) => originalShowItemInFolder(normalizeWindowsOpenPath(targetPath));
        }
      }
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
})();

