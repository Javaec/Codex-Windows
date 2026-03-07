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
    const IS_MINIMAL_PLATFORM = normalizePathString(process.env.CODEX_WINDOWS_MINIMAL || "") === "1";

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

    function resolveAppVersion() {
      const candidatePaths = [
        path.join(__dirname, "..", "..", "package.json"),
        path.join(resourcesRoot, "app", "package.json"),
      ];
      for (const candidatePath of candidatePaths) {
        try {
          if (!fs.existsSync(candidatePath)) continue;
          const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
          const version = normalizePathString(parsed && parsed.version ? parsed.version : "");
          if (version) return version;
        } catch {
          // ignore
        }
      }
      return "";
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

    function parseBuildNumberHint(value) {
      const parsed = Number.parseInt(String(value || ""), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function resolveRuntimeSubdir(leafDir, envKey) {
      const resourcesPath = normalizePathString(process.resourcesPath || "");
      if (resourcesPath) {
        const bundled = path.join(resourcesPath, leafDir);
        if (fs.existsSync(bundled)) return bundled;
      }

      const configured = normalizePathString(process.env[envKey] || "");
      if (configured) return path.resolve(configured);

      return path.resolve(resourcesRoot, "..", leafDir);
    }

    function loadRuntimeModLoader() {
      const modLoaderRootPath = resolveRuntimeSubdir("mod-loader", "CODEX_MOD_LOADER_DIR");
      const loaderPath = path.join(modLoaderRootPath, "main-loader.cjs");
      if (!fs.existsSync(loaderPath)) {
        throw new Error(`codex-mod-loader: runtime loader missing: ${loaderPath}`);
      }
      const exported = require(loaderPath);
      const activateRuntimeMods =
        typeof exported === "function"
          ? exported
          : (exported && typeof exported.activateRuntimeMods === "function" ? exported.activateRuntimeMods : null);
      if (typeof activateRuntimeMods !== "function") {
        throw new Error(`codex-mod-loader: runtime loader must export activateRuntimeMods(): ${loaderPath}`);
      }
      return activateRuntimeMods;
    }

    function installStartupInstrumentation(electron) {
      if (!electron || typeof electron !== "object" || !electron.app) return;
      if (globalThis.__CODEX_WINDOWS_STARTUP_INSTRUMENTATION_V1__) return;
      globalThis.__CODEX_WINDOWS_STARTUP_INSTRUMENTATION_V1__ = true;

      const instrumentedWebContents = new WeakSet();

      function getUrl(contents) {
        if (!contents || typeof contents.getURL !== "function") return "";
        try {
          return normalizePathString(contents.getURL() || "");
        } catch {
          return "";
        }
      }

      function instrumentWebContents(contents, browserWindowId) {
        if (!contents || typeof contents.on !== "function" || instrumentedWebContents.has(contents)) return;
        instrumentedWebContents.add(contents);
        const webContentsId = typeof contents.id === "number" ? contents.id : 0;
        console.log(`[codex-windows-startup] webcontents-created browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId}`);
        contents.on("dom-ready", () => {
          console.log(`[codex-windows-startup] renderer.dom-ready browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId} url=${getUrl(contents)}`);
        });
        contents.on("did-finish-load", () => {
          console.log(`[codex-windows-startup] webcontents.did-finish-load browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId} url=${getUrl(contents)}`);
        });
        contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          console.error(
            `[codex-windows-startup] webcontents.did-fail-load browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId} errorCode=${errorCode} isMainFrame=${isMainFrame ? "1" : "0"} validatedURL=${normalizePathString(validatedURL || "")} error=${normalizePathString(errorDescription || "")}`,
          );
        });
        contents.on("render-process-gone", (_event, details) => {
          const reason = details && typeof details.reason === "string" ? details.reason : "";
          const exitCode = details && typeof details.exitCode === "number" ? details.exitCode : 0;
          console.error(
            `[codex-windows-startup] webcontents.render-process-gone browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId} reason=${reason} exitCode=${exitCode}`,
          );
        });
      }

      electron.app.on("browser-window-created", (_event, browserWindow) => {
        if (!browserWindow || typeof browserWindow.on !== "function") return;
        const browserWindowId = typeof browserWindow.id === "number" ? browserWindow.id : 0;
        console.log(`[codex-windows-startup] browser-window-created browserWindowId=${browserWindowId}`);
        browserWindow.once("ready-to-show", () => {
          console.log(`[codex-windows-startup] browser-window.ready-to-show browserWindowId=${browserWindowId}`);
        });
        browserWindow.once("show", () => {
          console.log(`[codex-windows-startup] browser-window.show browserWindowId=${browserWindowId}`);
        });
        browserWindow.on("unresponsive", () => {
          console.error(`[codex-windows-startup] browser-window.unresponsive browserWindowId=${browserWindowId}`);
        });
        if (browserWindow.webContents) {
          instrumentWebContents(browserWindow.webContents, browserWindowId);
        }
      });

      electron.app.on("web-contents-created", (_event, contents) => {
        instrumentWebContents(contents, 0);
      });
    }

    function logRuntimeContract(codexHomeDir, modsRootPath, appVersion) {
      if (globalThis.__CODEX_WINDOWS_RUNTIME_CONTRACT_V1__) return;
      globalThis.__CODEX_WINDOWS_RUNTIME_CONTRACT_V1__ = true;
      try {
        const electron = require("electron");
        const userDataDir =
          electron && electron.app && typeof electron.app.getPath === "function"
            ? normalizePathString(electron.app.getPath("userData"))
            : "";
        const executablePath = normalizePathString(process.execPath || "");
        const cliPath = normalizePathString(process.env.CODEX_CLI_PATH || "");
        const resourcesPath = normalizePathString(process.resourcesPath || "");
        console.log(
          `[codex-windows-runtime] executable=${executablePath} userData=${userDataDir} codexHome=${codexHomeDir} cli=${cliPath} mods=${modsRootPath} resources=${resourcesPath} appVersion=${appVersion} minimal=${IS_MINIMAL_PLATFORM ? "1" : "0"}`,
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error || "");
        console.warn(`[codex-windows-runtime] runtime contract logging failed: ${message}`);
      }
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
    const codexHomeDir = resolveCodexHomeDir();
    const modsRootPath = resolveRuntimeSubdir("mods", "CODEX_MODS_DIR");
    const appVersion = resolveAppVersion();
    if (!IS_MINIMAL_PLATFORM) {
      migrateThreadCwdPrefixInSqlite(codexHomeDir);
    }
    logRuntimeContract(codexHomeDir, modsRootPath, appVersion);

    // Fix Windows path opening.
    try {
      const electron = require("electron");
      installStartupInstrumentation(electron);
      if (!IS_MINIMAL_PLATFORM && electron && electron.shell && !globalThis.__CODEX_WINDOWS_SHELL_OPEN_PATH_PATCHED__) {
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

      const buildHint = parseBuildNumberHint(process.env.CODEX_BUILD_NUMBER || BUILD_NUMBER);
      const activateRuntimeMods = loadRuntimeModLoader();
      activateRuntimeMods({ electron, buildHint, appVersion, resourcesRoot, minimalPlatform: IS_MINIMAL_PLATFORM });
    } catch (error) {
      console.error("[codex-windows-main-shim] electron patch failed", error);
    }
  } catch (error) {
    console.error("[codex-windows-main-shim] init failed", error);
  }
})();
