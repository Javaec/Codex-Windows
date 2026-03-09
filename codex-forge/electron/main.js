"use strict";

const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { resolveForgePaths, ensureForgeWorkspace } = require("../../scripts/node/lib/forge/paths.js");
const { startForgeLauncherServer } = require("../../scripts/node/lib/forge/server.js");

function parseElectronForgeCli(argv) {
  const options = {
    port: 4327,
    devtools: false,
    smoke: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "").toLowerCase();
    switch (token) {
      case "--port": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --port");
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`Invalid port: ${value}`);
        }
        options.port = parsed;
        index += 1;
        break;
      }
      case "--devtools":
        options.devtools = true;
        break;
      case "--smoke":
        options.smoke = true;
        break;
      default:
        throw new Error(`Unknown Codex Forge Electron option: ${argv[index]}`);
    }
  }

  return options;
}

function createApplicationMenu(mainWindow, paths) {
  return Menu.buildFromTemplate([
    {
      label: "Codex Forge",
      submenu: [
        {
          label: "Open Forge Root",
          click: () => {
            shell.openPath(paths.forgeRoot);
          },
        },
        {
          label: "Open Logs",
          click: () => {
            shell.openPath(paths.logsDir);
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    {
      label: "Window",
      submenu: [
        {
          label: "Focus Launcher",
          click: () => {
            if (!mainWindow) return;
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          },
        },
      ],
    },
  ]);
}

async function closeServer(launcherServer) {
  if (!launcherServer || !launcherServer.server) return;
  await new Promise((resolve) => {
    launcherServer.server.close(() => resolve());
  });
}

async function createMainWindow(launcherUrl, options, paths) {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#0f1317",
    title: "Codex Forge",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(launcherUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (options.devtools) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  });

  await mainWindow.loadURL(launcherUrl);
  Menu.setApplicationMenu(createApplicationMenu(mainWindow, paths));
  return mainWindow;
}

async function main() {
  const options = parseElectronForgeCli(process.argv.slice(2));
  const paths = resolveForgePaths();
  app.setName("Codex Forge");
  app.setAppUserModelId("CodexForge.Desktop");
  app.setPath("userData", path.join(paths.cacheDir, "electron-userdata"));
  app.setPath("sessionData", path.join(paths.cacheDir, "electron-session"));
  app.setPath("logs", path.join(paths.logsDir, "electron"));
  app.setPath("crashDumps", path.join(paths.logsDir, "crash-dumps"));

  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }

  let mainWindow = null;
  let launcherServer = null;
  let isQuitting = false;

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  ipcMain.handle("codex-forge:open-path", async (_event, targetPath) => {
    return shell.openPath(String(targetPath || ""));
  });

  ipcMain.handle("codex-forge:pick-directory", async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow() || mainWindow || null;
    const result = await dialog.showOpenDialog(focusedWindow, {
      title: "Import Codex Runtime Folder",
      properties: ["openDirectory", "dontAddToRecent"],
    });
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length < 1) {
      return "";
    }
    return String(result.filePaths[0] || "");
  });

  await app.whenReady();

  const config = ensureForgeWorkspace(paths);
  launcherServer = await startForgeLauncherServer({
    port: options.port,
    openBrowser: false,
    paths,
    config,
  });

  if (options.smoke) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      url: launcherServer.url,
      userDataPath: app.getPath("userData"),
      logsPath: app.getPath("logs"),
    }, null, 2)}\n`);
    await closeServer(launcherServer);
    app.quit();
    return;
  }

  mainWindow = await createMainWindow(launcherServer.url, options, paths);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length < 1) {
      mainWindow = await createMainWindow(launcherServer.url, options, paths);
    }
  });

  app.on("will-quit", async (event) => {
    if (!launcherServer) return;
    event.preventDefault();
    const currentServer = launcherServer;
    launcherServer = null;
    await closeServer(currentServer);
    app.exit(0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[Codex Forge Electron] ${message}\n`);
  app.exit(1);
});

module.exports = {
  parseElectronForgeCli,
};
