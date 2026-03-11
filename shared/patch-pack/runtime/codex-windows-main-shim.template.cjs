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
    const windowsPathContract = require(path.join(__dirname, "codex-windows-path-contract.cjs"));
    const normalizeWindowsOpenPathContract = windowsPathContract.normalizeWindowsOpenPathContract;
    const normalizeThreadPathContract = windowsPathContract.normalizeThreadPathContract;
    const normalizeWindowsPathTextContract = windowsPathContract.normalizeWindowsPathTextContract;
    const normalizeWindowsPathPayloadContract = windowsPathContract.normalizeWindowsPathPayloadContract;
    const buildThreadPathNormalizeExpression = windowsPathContract.buildThreadPathNormalizeExpression;
    let rendererPathNormalizationBootstrapSource = "";

    function normalizePathString(value) {
      return typeof value === "string" ? value.trim().replace(/^\"+|\"+$/g, "") : "";
    }

    function mergePathEntries(entries) {
      const out = [];
      const seen = new Set();
      for (const entry of entries) {
        const normalized = normalizePathString(entry);
        if (!normalized || !fs.existsSync(normalized)) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
      }
      return out;
    }

    function ensureBundledRuntimeToolsOnPath() {
      const winRoot = normalizePathString(process.env.SystemRoot || "C:\\Windows");
      const execPath = normalizePathString(process.execPath || "");
      const existing = String(process.env.PATH || process.env.Path || "").split(";");
      const merged = mergePathEntries([
        path.join(resourcesRoot, "path"),
        resourcesRoot,
        execPath ? path.dirname(execPath) : "",
        path.join(winRoot, "System32"),
        winRoot,
        path.join(winRoot, "System32", "Wbem"),
        path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
        path.join(winRoot, "System32", "OpenSSH"),
        normalizePathString(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "PowerShell", "7") : ""),
        normalizePathString(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : ""),
        normalizePathString(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "cmd") : ""),
        normalizePathString(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin") : ""),
        normalizePathString(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "usr", "bin") : ""),
        normalizePathString(process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : ""),
        normalizePathString(process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "cmd") : ""),
        normalizePathString(process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin") : ""),
        normalizePathString(process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin") : ""),
        normalizePathString(process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : ""),
        ...existing,
      ]);
      const nextPath = merged.join(";");
      if (nextPath) {
        process.env.PATH = nextPath;
        process.env.Path = nextPath;
      }
    }

    function resolveCodexHomeDir() {
      const configured = normalizePathString(process.env.CODEX_HOME || "");
      if (configured) return path.resolve(configured);
      const profileDir = normalizePathString(process.env.USERPROFILE || process.env.HOME || "");
      if (!profileDir) return "";
      return path.join(profileDir, ".codex");
    }

    function normalizeConfigTomlProjectHeaders(codexHomeDir) {
      if (!codexHomeDir) return { updated: false, path: "" };
      const configPath = path.join(codexHomeDir, "config.toml");
      if (!fs.existsSync(configPath)) return { updated: false, path: configPath };
      let raw = "";
      try {
        raw = fs.readFileSync(configPath, "utf8");
      } catch {
        return { updated: false, path: configPath };
      }
      const next = raw.replace(/^\[projects\.(["'])(.+?)\1\]$/gm, (_full, quote, projectKey) => {
        const normalizedKey = windowsPathContract.normalizeWindowsPathContract(projectKey, {
          stripLeadingDriveSlash: true,
          slashStyle: "backward",
        });
        return normalizedKey && normalizedKey !== projectKey
          ? `[projects.${quote}${normalizedKey}${quote}]`
          : _full;
      });
      if (next === raw) {
        return { updated: false, path: configPath };
      }
      try {
        fs.writeFileSync(configPath, next, "utf8");
        return { updated: true, path: configPath };
      } catch {
        return { updated: false, path: configPath };
      }
    }

    function listRecentSessionJsonlPaths(codexHomeDir) {
      const sessionsRoot = codexHomeDir ? path.join(codexHomeDir, "sessions") : "";
      if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return [];

      const out = [];
      function visit(dirPath, depth) {
        if (depth > 4 || out.length >= 64) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (!entry) continue;
          const nextPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            visit(nextPath, depth + 1);
            continue;
          }
          if (!entry.isFile() || !/\.jsonl$/i.test(entry.name || "")) continue;
          out.push(nextPath);
          if (out.length >= 64) break;
        }
      }

      visit(sessionsRoot, 0);
      out.sort((left, right) => {
        try {
          return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
        } catch {
          return 0;
        }
      });
      return out.slice(0, 32);
    }

    function normalizeRecentSessionLogs(codexHomeDir) {
      const report = { scannedFiles: 0, updatedFiles: 0 };
      for (const sessionPath of listRecentSessionJsonlPaths(codexHomeDir)) {
        report.scannedFiles += 1;
        let raw = "";
        try {
          const stat = fs.statSync(sessionPath);
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
          raw = fs.readFileSync(sessionPath, "utf8");
        } catch {
          continue;
        }
        const next = normalizeWindowsPathTextContract(raw);
        if (!next || next === raw) continue;
        try {
          fs.writeFileSync(sessionPath, next, "utf8");
          report.updatedFiles += 1;
        } catch {
          // ignore
        }
      }
      return report;
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
              const normalizedPath = normalizeThreadPathContract(currentPath);
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

    function buildRendererPathNormalizationBootstrapSource() {
      if (rendererPathNormalizationBootstrapSource) return rendererPathNormalizationBootstrapSource;
      const bootstrap = [
        "(() => {",
        "if (globalThis.__CODEX_WINDOWS_RENDERER_PATH_CONTRACT_V1__) return;",
        "globalThis.__CODEX_WINDOWS_RENDERER_PATH_CONTRACT_V1__ = true;",
        windowsPathContract.normalizePathString.toString(),
        windowsPathContract.normalizeFileUrlToPath.toString(),
        windowsPathContract.isWindowsDrivePath.toString(),
        windowsPathContract.isUncPath.toString(),
        windowsPathContract.stripDiffPrefix.toString(),
        windowsPathContract.stripExtendedWindowsPrefix.toString(),
        windowsPathContract.stripLeadingDriveSlash.toString(),
        windowsPathContract.applySlashStyle.toString(),
        windowsPathContract.normalizeWindowsPathContract.toString(),
        windowsPathContract.normalizeWindowsPathDisplayContract.toString(),
        windowsPathContract.containsMalformedWindowsPathText.toString(),
        windowsPathContract.normalizeWindowsPathTextContract.toString(),
        windowsPathContract.normalizeWindowsPathPayloadContract.toString(),
        `function patchResponsePrototype(){`,
        `if(typeof Response==="undefined"||!Response.prototype||Response.prototype.__codexWindowsPathContractPatched)return;`,
        `Object.defineProperty(Response.prototype,"__codexWindowsPathContractPatched",{value:!0,configurable:!0});`,
        `const originalJson=typeof Response.prototype.json==="function"?Response.prototype.json:null;`,
        `if(originalJson){Response.prototype.json=async function codexWindowsNormalizedResponseJson(){const payload=await originalJson.apply(this,arguments);return normalizeWindowsPathPayloadContract(payload)}}`,
        `const originalText=typeof Response.prototype.text==="function"?Response.prototype.text:null;`,
        `if(originalText){Response.prototype.text=async function codexWindowsNormalizedResponseText(){const payload=await originalText.apply(this,arguments);return normalizeWindowsPathTextContract(payload)}}`,
        `}`,
        `function patchJsonParse(){`,
        `if(typeof JSON!=="object"||typeof JSON.parse!=="function"||JSON.parse.__codexWindowsPathContractPatched)return;`,
        `const originalParse=JSON.parse.bind(JSON);`,
        `const wrappedParse=function codexWindowsNormalizedJsonParse(text,reviver){const parsed=originalParse(text,reviver);return typeof text==="string"&&containsMalformedWindowsPathText(text)?normalizeWindowsPathPayloadContract(parsed):parsed};`,
        `Object.defineProperty(wrappedParse,"__codexWindowsPathContractPatched",{value:!0,configurable:!0});`,
        `JSON.parse=wrappedParse;`,
        `}`,
        `function normalizeElementAttributes(element){`,
        `if(!element||element.nodeType!==Node.ELEMENT_NODE)return 0;`,
        `let changed=0;`,
        `for(const attrName of ["href","title","data-path","data-file-path"]){`,
        `if(!element.hasAttribute||!element.hasAttribute(attrName))continue;`,
        `const currentValue=element.getAttribute(attrName);`,
        `if(typeof currentValue!=="string"||!containsMalformedWindowsPathText(currentValue))continue;`,
        `const nextValue=attrName==="href"?normalizeWindowsPathDisplayContract(currentValue):normalizeWindowsPathTextContract(currentValue);`,
        `if(nextValue&&nextValue!==currentValue){element.setAttribute(attrName,nextValue);changed+=1;}`,
        `}`,
        `return changed;`,
        `}`,
        `function normalizeTextNode(node){`,
        `if(!node||node.nodeType!==Node.TEXT_NODE)return 0;`,
        `const currentValue=typeof node.data==="string"?node.data:"";`,
        `if(!containsMalformedWindowsPathText(currentValue))return 0;`,
        `const nextValue=normalizeWindowsPathTextContract(currentValue);`,
        `if(!nextValue||nextValue===currentValue)return 0;`,
        `node.data=nextValue;`,
        `return 1;`,
        `}`,
        `function normalizeSubtree(root){`,
        `if(!root)return 0;`,
        `if(root.nodeType===Node.TEXT_NODE)return normalizeTextNode(root);`,
        `let changed=0;`,
        `if(root.nodeType===Node.ELEMENT_NODE)changed+=normalizeElementAttributes(root);`,
        `if(typeof document!=="object"||!document.createTreeWalker)return changed;`,
        `const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);`,
        `let currentNode=walker.currentNode;`,
        `while(currentNode){`,
        `if(currentNode!==root){`,
        `if(currentNode.nodeType===Node.TEXT_NODE)changed+=normalizeTextNode(currentNode);`,
        `else if(currentNode.nodeType===Node.ELEMENT_NODE)changed+=normalizeElementAttributes(currentNode);`,
        `}`,
        `currentNode=walker.nextNode();`,
        `}`,
        `return changed;`,
        `}`,
        `function startDomObserver(){`,
        `const targetRoot=document.body||document.documentElement;`,
        `if(!targetRoot||globalThis.__CODEX_WINDOWS_RENDERER_PATH_OBSERVER_V1__)return;`,
        `globalThis.__CODEX_WINDOWS_RENDERER_PATH_OBSERVER_V1__=new MutationObserver(records=>{`,
        `for(const record of records){`,
        `if(record.type==="characterData"){normalizeTextNode(record.target);continue;}`,
        `if(record.type==="attributes"){normalizeSubtree(record.target);continue;}`,
        `for(const addedNode of record.addedNodes||[]){normalizeSubtree(addedNode);}`,
        `}`,
        `});`,
        `normalizeSubtree(targetRoot);`,
        `globalThis.__CODEX_WINDOWS_RENDERER_PATH_OBSERVER_V1__.observe(targetRoot,{subtree:!0,childList:!0,characterData:!0,attributes:!0,attributeFilter:["href","title","data-path","data-file-path"]});`,
        `}`,
        `patchResponsePrototype();`,
        `patchJsonParse();`,
        `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",startDomObserver,{once:!0});}else{startDomObserver();}`,
        "})();",
      ].join("");
      rendererPathNormalizationBootstrapSource = bootstrap;
      return rendererPathNormalizationBootstrapSource;
    }

    function installRendererPathNormalization(contents, browserWindowId) {
      if (!contents || typeof contents.on !== "function" || typeof contents.executeJavaScript !== "function") return;
      const injectBootstrap = () => {
        Promise.resolve(contents.executeJavaScript(buildRendererPathNormalizationBootstrapSource(), true)).catch((error) => {
          const message = error && error.message ? error.message : String(error || "");
          console.warn(
            `[codex-windows-runtime] renderer path bootstrap failed browserWindowId=${browserWindowId || 0} webContentsId=${typeof contents.id === "number" ? contents.id : 0} error=${normalizePathString(message)}`,
          );
        });
      };
      contents.on("dom-ready", injectBootstrap);
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
        installRendererPathNormalization(contents, browserWindowId);
        const webContentsId = typeof contents.id === "number" ? contents.id : 0;
        const getRendererMetricSnapshot = () => {
          try {
            const rendererPid = typeof contents.getOSProcessId === "function" ? contents.getOSProcessId() : 0;
            const appMetrics =
              electron && electron.app && typeof electron.app.getAppMetrics === "function"
                ? electron.app.getAppMetrics()
                : [];
            const rendererMetric = Array.isArray(appMetrics)
              ? appMetrics.find((metric) => metric && metric.pid === rendererPid)
              : null;
            const memoryUsage = process.memoryUsage();
            const rendererMemory = rendererMetric && rendererMetric.memory ? rendererMetric.memory : null;
            return {
              rendererPid,
              mainRssBytes: Number(memoryUsage && memoryUsage.rss ? memoryUsage.rss : 0),
              mainHeapUsedBytes: Number(memoryUsage && memoryUsage.heapUsed ? memoryUsage.heapUsed : 0),
              rendererWorkingSetKb: rendererMemory && Number.isFinite(rendererMemory.workingSetSize) ? rendererMemory.workingSetSize : 0,
              rendererPeakWorkingSetKb: rendererMemory && Number.isFinite(rendererMemory.peakWorkingSetSize) ? rendererMemory.peakWorkingSetSize : 0,
              rendererPrivateBytesKb: rendererMemory && Number.isFinite(rendererMemory.privateBytes) ? rendererMemory.privateBytes : 0,
            };
          } catch {
            return {
              rendererPid: 0,
              mainRssBytes: 0,
              mainHeapUsedBytes: 0,
              rendererWorkingSetKb: 0,
              rendererPeakWorkingSetKb: 0,
              rendererPrivateBytesKb: 0,
            };
          }
        };
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
          const metrics = getRendererMetricSnapshot();
          console.error(
            `[codex-windows-startup] webcontents.render-process-gone browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId} reason=${reason} exitCode=${exitCode}`,
          );
          console.error(
            `[codex-windows-startup] webcontents.render-process-gone-metrics browserWindowId=${browserWindowId || 0} webContentsId=${webContentsId} rendererPid=${metrics.rendererPid} mainRssBytes=${metrics.mainRssBytes} mainHeapUsedBytes=${metrics.mainHeapUsedBytes} rendererWorkingSetKb=${metrics.rendererWorkingSetKb} rendererPeakWorkingSetKb=${metrics.rendererPeakWorkingSetKb} rendererPrivateBytesKb=${metrics.rendererPrivateBytesKb}`,
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
        const rgPath = normalizePathString(path.join(resourcesRoot, "rg.exe"));
        const sshPath = normalizePathString(process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "OpenSSH", "ssh.exe") : "");
        const resourcesPath = normalizePathString(process.resourcesPath || "");
        const runtimeModsEnabled = normalizePathString(process.env.CODEX_ENABLE_RUNTIME_MODS || "") === "1";
        console.log(
          `[codex-windows-runtime] executable=${executablePath} userData=${userDataDir} codexHome=${codexHomeDir} cli=${cliPath} rg=${rgPath} ssh=${sshPath} mods=${modsRootPath} resources=${resourcesPath} appVersion=${appVersion} runtimeMods=${runtimeModsEnabled ? "1" : "0"} minimal=${IS_MINIMAL_PLATFORM ? "1" : "0"}`,
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
    if (!process.env.CODEX_ENABLE_RUNTIME_MODS) process.env.CODEX_ENABLE_RUNTIME_MODS = "0";
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
    if (!process.env.PWD) process.env.PWD = process.cwd();
    ensureBundledRuntimeToolsOnPath();

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
    const configTomlProjectHeaderNormalization = normalizeConfigTomlProjectHeaders(codexHomeDir);
    const sessionLogNormalization = normalizeRecentSessionLogs(codexHomeDir);
    if (!IS_MINIMAL_PLATFORM) {
      migrateThreadCwdPrefixInSqlite(codexHomeDir);
    }
    logRuntimeContract(codexHomeDir, modsRootPath, appVersion);
    if (configTomlProjectHeaderNormalization.updated) {
      console.log(`[codex-windows-runtime] normalized config.toml project paths path=${configTomlProjectHeaderNormalization.path}`);
    }
    if (sessionLogNormalization.updatedFiles > 0) {
      console.log(
        `[codex-windows-runtime] normalized recent session logs scanned=${sessionLogNormalization.scannedFiles} updated=${sessionLogNormalization.updatedFiles}`,
      );
    }

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
          electron.shell.openPath = (targetPath) => originalOpenPath(normalizeWindowsOpenPathContract(targetPath));
        }
        if (originalShowItemInFolder) {
          electron.shell.showItemInFolder = (targetPath) => originalShowItemInFolder(normalizeWindowsOpenPathContract(targetPath));
        }
      }

      const runtimeModsEnabled = normalizePathString(process.env.CODEX_ENABLE_RUNTIME_MODS || "") === "1";
      if (runtimeModsEnabled) {
        const buildHint = parseBuildNumberHint(process.env.CODEX_BUILD_NUMBER || BUILD_NUMBER);
        const activateRuntimeMods = loadRuntimeModLoader();
        activateRuntimeMods({ electron, buildHint, appVersion, resourcesRoot, minimalPlatform: IS_MINIMAL_PLATFORM });
      }
    } catch (error) {
      console.error("[codex-windows-main-shim] electron patch failed", error);
    }
  } catch (error) {
    console.error("[codex-windows-main-shim] init failed", error);
  }
})();
