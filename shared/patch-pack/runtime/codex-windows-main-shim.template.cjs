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

    function sanitizeExistingPathList(values) {
      if (!Array.isArray(values)) return { nextValues: values, removedCount: 0, changed: false };

      const nextValues = [];
      const seen = new Set();
      let removedCount = 0;
      for (const rawValue of values) {
        if (typeof rawValue !== "string") {
          removedCount += 1;
          continue;
        }
        const normalizedPath = normalizeWindowsOpenPath(rawValue);
        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
          removedCount += 1;
          continue;
        }
        const key = normalizedPath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        nextValues.push(normalizedPath);
      }

      const changed = removedCount > 0 || JSON.stringify(nextValues) !== JSON.stringify(values);
      return { nextValues, removedCount, changed };
    }

    function sanitizeExistingPathMap(values) {
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        return { nextValues: values, removedCount: 0, changed: false };
      }

      const nextValues = {};
      const seen = new Set();
      let removedCount = 0;
      let changed = false;

      for (const [rawKey, rawValue] of Object.entries(values)) {
        const normalizedKey = normalizeWindowsOpenPath(rawKey);
        if (!normalizedKey || !fs.existsSync(normalizedKey)) {
          removedCount += 1;
          changed = true;
          continue;
        }
        const key = normalizedKey.toLowerCase();
        if (seen.has(key)) {
          changed = true;
          continue;
        }
        seen.add(key);
        if (normalizedKey !== rawKey) changed = true;
        nextValues[normalizedKey] = rawValue;
      }

      return { nextValues, removedCount, changed };
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

    function loadKnownThreadIds(codexHomeDir) {
      const databasePaths = listStateDatabasePaths(codexHomeDir);
      if (databasePaths.length === 0) return null;

      let DatabaseCtor;
      try {
        DatabaseCtor = require("better-sqlite3");
      } catch {
        return null;
      }
      if (typeof DatabaseCtor !== "function") return null;

      const knownThreadIds = new Set();
      for (const databasePath of databasePaths) {
        let db;
        try {
          db = new DatabaseCtor(databasePath, { fileMustExist: true, readonly: true });
          const hasThreadsTable = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads' LIMIT 1")
            .get();
          if (!hasThreadsTable) continue;
          const rows = db.prepare("SELECT id FROM threads").all();
          for (const row of rows) {
            const id = row && typeof row.id === "string" ? row.id : "";
            if (id) knownThreadIds.add(id);
          }
        } catch {
          // ignore unreadable databases
        } finally {
          try {
            if (db && typeof db.close === "function") db.close();
          } catch {
            // ignore close errors
          }
        }
      }

      return knownThreadIds;
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

    function sanitizeCodexGlobalState(codexHomeDir) {
      const globalStatePath = codexHomeDir ? path.join(codexHomeDir, ".codex-global-state.json") : "";
      if (!globalStatePath || !fs.existsSync(globalStatePath)) {
        return { changed: false, workspaceRootsRemoved: 0, threadTitlesRemoved: 0 };
      }

      let rawState = "";
      try {
        rawState = fs.readFileSync(globalStatePath, "utf8").replace(/^\uFEFF/, "");
      } catch {
        return { changed: false, workspaceRootsRemoved: 0, threadTitlesRemoved: 0 };
      }
      if (!rawState.trim()) {
        return { changed: false, workspaceRootsRemoved: 0, threadTitlesRemoved: 0 };
      }

      let parsedState;
      try {
        parsedState = JSON.parse(rawState);
      } catch {
        return { changed: false, workspaceRootsRemoved: 0, threadTitlesRemoved: 0 };
      }
      if (!parsedState || typeof parsedState !== "object" || Array.isArray(parsedState)) {
        return { changed: false, workspaceRootsRemoved: 0, threadTitlesRemoved: 0 };
      }

      let changed = false;
      let workspaceRootsRemoved = 0;
      let threadTitlesRemoved = 0;

      for (const key of ["electron-saved-workspace-roots", "active-workspace-roots"]) {
        const result = sanitizeExistingPathList(parsedState[key]);
        if (!result.changed) continue;
        parsedState[key] = result.nextValues;
        workspaceRootsRemoved += result.removedCount;
        changed = true;
      }

      const workspaceLabels = sanitizeExistingPathMap(parsedState["electron-workspace-root-labels"]);
      if (workspaceLabels.changed) {
        parsedState["electron-workspace-root-labels"] = workspaceLabels.nextValues;
        workspaceRootsRemoved += workspaceLabels.removedCount;
        changed = true;
      }

      const openInTarget = parsedState["open-in-target-preferences"];
      if (openInTarget && typeof openInTarget === "object" && !Array.isArray(openInTarget)) {
        const perPathResult = sanitizeExistingPathMap(openInTarget.perPath);
        if (perPathResult.changed) {
          openInTarget.perPath = perPathResult.nextValues;
          workspaceRootsRemoved += perPathResult.removedCount;
          changed = true;
        }
      }

      const knownThreadIds = loadKnownThreadIds(codexHomeDir);
      const threadTitlesRoot = parsedState["thread-titles"];
      if (threadTitlesRoot && typeof threadTitlesRoot === "object" && !Array.isArray(threadTitlesRoot)) {
        const currentTitles = threadTitlesRoot.titles && typeof threadTitlesRoot.titles === "object" && !Array.isArray(threadTitlesRoot.titles)
          ? threadTitlesRoot.titles
          : {};
        const currentOrder = Array.isArray(threadTitlesRoot.order) ? threadTitlesRoot.order : Object.keys(currentTitles);
        const nextTitles = {};
        const nextOrder = [];
        const seen = new Set();

        for (const rawId of currentOrder) {
          if (typeof rawId !== "string" || !rawId) continue;
          if (seen.has(rawId)) continue;
          if (knownThreadIds && !knownThreadIds.has(rawId)) {
            threadTitlesRemoved += 1;
            changed = true;
            continue;
          }
          const title = typeof currentTitles[rawId] === "string" ? currentTitles[rawId].trim() : "";
          if (!title) {
            threadTitlesRemoved += 1;
            changed = true;
            continue;
          }
          seen.add(rawId);
          nextTitles[rawId] = title;
          nextOrder.push(rawId);
          if (nextOrder.length >= 80) break;
        }

        if (nextOrder.length === 0) {
          if (parsedState["thread-titles"]) {
            delete parsedState["thread-titles"];
            changed = true;
          }
        } else {
          if (
            JSON.stringify(nextOrder) !== JSON.stringify(currentOrder) ||
            JSON.stringify(nextTitles) !== JSON.stringify(currentTitles)
          ) {
            parsedState["thread-titles"] = { titles: nextTitles, order: nextOrder };
            changed = true;
          }
        }
      }

      if (!changed) {
        return { changed: false, workspaceRootsRemoved: 0, threadTitlesRemoved: 0 };
      }

      fs.writeFileSync(globalStatePath, `${JSON.stringify(parsedState, null, 2)}\n`, "utf8");
      return { changed: true, workspaceRootsRemoved, threadTitlesRemoved };
    }

    function parseBuildNumberHint(value) {
      const parsed = Number.parseInt(String(value || ""), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function shouldSuppressConsoleMessage(messageText) {
      const text = String(messageText || "");
      if (!text) return false;
      if (text.includes("[wsl] error retrieving eligible distro")) return true;
      if (text.includes("[git-origin-and-roots] Failed to resolve origin for workspace errorMessage=\"ENOENT: path does not exist:")) return true;
      if (text.includes("[electron-fetch-handler] [git-origins] failed to list worktrees for dir=")) return true;
      if (text.includes("Failed to backfill app thread title errorMessage=\"thread not found:")) return true;
      if (text.includes("[git] git.command.complete") && text.includes("remote.upstream.url") && text.includes("exitCode=1")) return true;
      return false;
    }

    function installNoiseGuards() {
      if (globalThis.__CODEX_WINDOWS_NOISE_GUARDS_V1__) return;
      globalThis.__CODEX_WINDOWS_NOISE_GUARDS_V1__ = true;

      function patchConsoleMethod(methodName) {
        const original = console && typeof console[methodName] === "function" ? console[methodName].bind(console) : null;
        if (!original) return;
        console[methodName] = (...args) => {
          let text = "";
          try {
            text = args
              .map((value) => {
                if (typeof value === "string") return value;
                if (value && typeof value.stack === "string") return value.stack;
                if (value && typeof value.message === "string") return value.message;
                return String(value);
              })
              .join(" ");
          } catch {
            text = "";
          }
          if (shouldSuppressConsoleMessage(text)) return;
          return original(...args);
        };
      }

      patchConsoleMethod("warn");
      patchConsoleMethod("error");
      patchConsoleMethod("log");

      const originalEmitWarning = typeof process.emitWarning === "function" ? process.emitWarning.bind(process) : null;
      if (originalEmitWarning) {
        process.emitWarning = (warning, ...args) => {
          const text = typeof warning === "string"
            ? warning
            : String(warning && warning.message ? warning.message : warning || "");
          const firstArg = args.length > 0 ? args[0] : "";
          const code = typeof firstArg === "string"
            ? firstArg
            : String(firstArg && firstArg.code ? firstArg.code : (warning && warning.code ? warning.code : ""));
          if (code === "DEP0169") return;
          if (text.includes("url.parse() behavior is not standardized")) return;
          return originalEmitWarning(warning, ...args);
        };
      }
    }

    function resolveModsRootPath() {
      const configured = normalizePathString(process.env.CODEX_MODS_DIR || "");
      if (configured) return path.resolve(configured);

      const resourcesPath = normalizePathString(process.resourcesPath || "");
      if (resourcesPath) return path.join(resourcesPath, "mods");

      // Fallback for unpacked execution (rare): shim lives under `resources/app/.vite/build`.
      return path.resolve(resourcesRoot, "..", "mods");
    }

    function loadRuntimeMods(modsRoot, buildHint) {
      if (!modsRoot || !fs.existsSync(modsRoot)) return [];
      if (normalizePathString(process.env.CODEX_MODS_DISABLED || "") === "1") return [];

      const mods = [];
      const entries = fs.readdirSync(modsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry || !entry.isDirectory()) continue;
        const modDir = path.join(modsRoot, entry.name);
        const manifestPath = path.join(modDir, "mod.json");
        if (!fs.existsSync(manifestPath)) continue;

        const rawManifest = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
        let manifest;
        try {
          manifest = JSON.parse(rawManifest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`codex-mod-loader: failed to parse ${manifestPath}: ${message}`);
        }

        const id = normalizePathString(manifest && manifest.id ? manifest.id : "");
        if (!id) throw new Error(`codex-mod-loader: missing id in ${manifestPath}`);
        if (id !== entry.name) {
          throw new Error(`codex-mod-loader: id mismatch for ${manifestPath} (${id} != ${entry.name})`);
        }

        if (manifest && manifest.enabled === false) continue;

        const priority = Number(manifest && manifest.priority !== undefined ? manifest.priority : 0);
        if (!Number.isFinite(priority)) {
          throw new Error(`codex-mod-loader: invalid priority for ${id} (${manifest && manifest.priority})`);
        }

        const compat = manifest && manifest.compatibility && typeof manifest.compatibility === "object" ? manifest.compatibility : {};
        const minBuild = Number(compat.minBuild !== undefined ? compat.minBuild : 0);
        const maxBuild = Number(compat.maxBuild !== undefined ? compat.maxBuild : 0);
        if (!Number.isFinite(minBuild) || minBuild < 0) throw new Error(`codex-mod-loader: invalid minBuild for ${id}`);
        if (!Number.isFinite(maxBuild) || maxBuild < 0) throw new Error(`codex-mod-loader: invalid maxBuild for ${id}`);
        if (maxBuild > 0 && minBuild > 0 && maxBuild < minBuild) {
          throw new Error(`codex-mod-loader: invalid build range for ${id} (maxBuild < minBuild)`);
        }
        if (buildHint > 0 && minBuild > 0 && buildHint < minBuild) continue;
        if (buildHint > 0 && maxBuild > 0 && buildHint > maxBuild) continue;

        const entrypoints = manifest && manifest.entrypoints && typeof manifest.entrypoints === "object" ? manifest.entrypoints : {};
        const rendererEntry = normalizePathString(entrypoints.renderer || "");
        const mainEntry = normalizePathString(entrypoints.main || "");
        if (!rendererEntry && !mainEntry) {
          throw new Error(`codex-mod-loader: mod has no entrypoints: ${id}`);
        }

        let rendererScript = "";
        if (rendererEntry) {
          const rendererEntryPath = path.join(modDir, rendererEntry);
          if (!fs.existsSync(rendererEntryPath)) {
            throw new Error(`codex-mod-loader: missing renderer entry for ${id}: ${rendererEntryPath}`);
          }
          const script = fs.readFileSync(rendererEntryPath, "utf8").replace(/^\uFEFF/, "");
          if (script.trim().length < 16) {
            throw new Error(`codex-mod-loader: renderer entry is empty for ${id}: ${rendererEntryPath}`);
          }
          rendererScript = script;
        }

        let mainEntryPath = "";
        if (mainEntry) {
          const candidate = path.join(modDir, mainEntry);
          if (!fs.existsSync(candidate)) {
            throw new Error(`codex-mod-loader: missing main entry for ${id}: ${candidate}`);
          }
          mainEntryPath = candidate;
        }

        const conflicts = Array.isArray(manifest && manifest.conflicts) ? manifest.conflicts : [];
        const normalizedConflicts = conflicts
          .map((value) => normalizePathString(value))
          .filter((value) => value.length > 0);

        mods.push({ id, priority, rendererScript, mainEntryPath, conflicts: normalizedConflicts });
      }

      mods.sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        return String(left.id).localeCompare(String(right.id));
      });

      const selected = new Set();
      for (const mod of mods) {
        if (selected.has(mod.id)) throw new Error(`codex-mod-loader: duplicate mod id selected: ${mod.id}`);
        selected.add(mod.id);
      }

      for (const mod of mods) {
        for (const conflictId of mod.conflicts) {
          if (!selected.has(conflictId)) continue;
          throw new Error(`codex-mod-loader: conflicting mods selected: ${mod.id} x ${conflictId}`);
        }
      }

      return mods;
    }

    function applyMainMods(electron, loadedMods, buildHint) {
      if (!electron || !loadedMods || loadedMods.length === 0) return;
      if (globalThis.__CODEX_MOD_LOADER_MAIN_V1__) return;
      globalThis.__CODEX_MOD_LOADER_MAIN_V1__ = true;

      for (const mod of loadedMods) {
        if (!mod.mainEntryPath) continue;
        const exported = require(mod.mainEntryPath);
        const apply =
          typeof exported === "function"
            ? exported
            : (exported && typeof exported.activate === "function" ? exported.activate : null);
        if (typeof apply !== "function") {
          throw new Error(`codex-mod-loader: main entry for ${mod.id} must export a function (or {activate})`);
        }
        apply({ electron, buildHint, modId: mod.id });
      }
    }

    function installRendererMods(electron, rendererMods) {
      if (!electron || !rendererMods || rendererMods.length === 0) return;
      if (globalThis.__CODEX_MOD_LOADER_RENDERER_V1__) return;
      globalThis.__CODEX_MOD_LOADER_RENDERER_V1__ = true;

      const injectedByWebContents = new WeakMap();
      const getInjected = (contents) => {
        let injected = injectedByWebContents.get(contents);
        if (!injected) {
          injected = new Set();
          injectedByWebContents.set(contents, injected);
        }
        return injected;
      };

      electron.app.on("web-contents-created", (_event, contents) => {
        if (!contents || typeof contents.executeJavaScript !== "function") return;
        const inject = () => {
          const currentUrl = typeof contents.getURL === "function" ? String(contents.getURL() || "") : "";
          if (currentUrl.startsWith("devtools://")) return;

          const injected = getInjected(contents);
          for (const mod of rendererMods) {
            if (injected.has(mod.id)) continue;
            injected.add(mod.id);
            const wrapped = `/* CODEX-MOD:${mod.id} */
${mod.script}
`;
            Promise.resolve(contents.executeJavaScript(wrapped, true)).catch((error) => {
              console.error(`[codex-mod-loader] renderer mod failed (${mod.id})`, error);
            });
          }
        };

        contents.on("dom-ready", () => {
          try {
            inject();
          } catch (error) {
            console.error("[codex-mod-loader] inject failed", error);
          }
        });
      });
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
    installNoiseGuards();
    migrateThreadCwdPrefixInSqlite(codexHomeDir);
    sanitizeCodexGlobalState(codexHomeDir);

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

      const buildHint = parseBuildNumberHint(process.env.CODEX_BUILD_NUMBER || BUILD_NUMBER);
      const loadedMods = loadRuntimeMods(resolveModsRootPath(), buildHint);
      applyMainMods(electron, loadedMods, buildHint);
      const rendererMods = loadedMods.filter((mod) => mod.rendererScript).map((mod) => ({ id: mod.id, script: mod.rendererScript }));
      installRendererMods(electron, rendererMods);
    } catch (error) {
      console.error("[codex-windows-main-shim] electron patch failed", error);
    }
  } catch (error) {
    console.error("[codex-windows-main-shim] init failed", error);
  }
})();
