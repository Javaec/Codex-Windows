import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists, runCommand } from "./exec";

export function patchPreload(appDir: string): void {
  const preload = path.join(appDir, ".vite", "build", "preload.js");
  if (!fileExists(preload)) return;
  let raw = fs.readFileSync(preload, "utf8");
  const processExpose =
    'const P={env:process.env,platform:process.platform,versions:process.versions,arch:process.arch,cwd:()=>process.env.PWD,argv:process.argv,pid:process.pid};n.contextBridge.exposeInMainWorld("process",P);';
  if (!raw.includes(processExpose)) {
    const pattern =
      /n\.contextBridge\.exposeInMainWorld\("codexWindowType",[A-Za-z0-9_$]+\);n\.contextBridge\.exposeInMainWorld\("electronBridge",[A-Za-z0-9_$]+\);/;
    const match = raw.match(pattern);
    if (!match) throw new Error("preload patch point not found.");
    raw = raw.replace(match[0], `${processExpose}${match[0]}`);
    fs.writeFileSync(preload, raw, "utf8");
  }
}

function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function patchMainForWindowsEnvironment(appDir: string, buildNumber: string, buildFlavor: string): void {
  const mainJs = path.join(appDir, ".vite", "build", "main.js");
  if (!fileExists(mainJs)) return;
  let raw = fs.readFileSync(mainJs, "utf8");
  raw = raw.replace(/\/\* CODEX-WINDOWS-ENV-SHIM-V[234] \*\/[\s\S]*?\}\)\;\s*/, "");
  const marker = "/* CODEX-WINDOWS-ENV-SHIM-V4 */";
  if (raw.includes(marker)) {
    fs.writeFileSync(mainJs, raw, "utf8");
    return;
  }

  const safeBuildNumber = escapeJsString(buildNumber);
  const safeBuildFlavor = escapeJsString(buildFlavor);
  const shim = `/* CODEX-WINDOWS-ENV-SHIM-V4 */
(function () {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const url = require("node:url");
    const cp = require("node:child_process");
    const winRoot = process.env.SystemRoot || "C:\\\\Windows";

    function normalizePathEnv(baseEnv) {
      const env = Object.assign({}, process.env, baseEnv || {});
      const parts = [];
      const seen = new Set();
      const include = (candidate, prepend) => {
        if (!candidate || typeof candidate !== "string") return;
        const value = candidate.trim().replace(/^"+|"+$/g, "");
        if (!value) return;
        if (!fs.existsSync(value)) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (prepend) parts.unshift(value);
        else parts.push(value);
      };
      const includeList = (value, prepend) => {
        if (!value || typeof value !== "string") return;
        for (const p of value.split(";")) include(p, prepend);
      };
      includeList(env.PATH, false);
      includeList(env.Path, false);
      includeList(process.env.PATH, false);
      includeList(process.env.Path, false);
      const preferred = [
        path.join(winRoot, "System32"),
        path.join(winRoot, "System32", "Wbem"),
        path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
        path.join(winRoot, "System32", "OpenSSH"),
        winRoot,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "PowerShell", "7") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "cmd") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin") : "",
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : ""
      ];
      for (const p of preferred) include(p, true);
      env.PATH = parts.join(";");
      env.Path = env.PATH;
      if (!env.PATHEXT) env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
      if (!env.COMSPEC) {
        const cmd = path.join(winRoot, "System32", "cmd.exe");
        if (fs.existsSync(cmd)) env.COMSPEC = cmd;
      }
      return env;
    }
    const normalizedProcessEnv = normalizePathEnv(process.env);
    for (const [k, v] of Object.entries(normalizedProcessEnv)) {
      if (typeof v === "string") process.env[k] = v;
    }
    if (!globalThis.__CODEX_WINDOWS_CHILD_ENV_PATCHED__) {
      globalThis.__CODEX_WINDOWS_CHILD_ENV_PATCHED__ = true;
      const patchOptionsEnv = (options) => {
        if (!options || typeof options !== "object") options = {};
        options.env = normalizePathEnv(options.env || process.env);
        return options;
      };
      const origSpawn = cp.spawn;
      cp.spawn = function patchedSpawn(file, args, options) {
        if (!Array.isArray(args)) { options = args; args = []; }
        options = patchOptionsEnv(options);
        return origSpawn.call(this, file, args, options);
      };
      const origSpawnSync = cp.spawnSync;
      cp.spawnSync = function patchedSpawnSync(file, args, options) {
        if (!Array.isArray(args)) { options = args; args = []; }
        options = patchOptionsEnv(options);
        return origSpawnSync.call(this, file, args, options);
      };
    }
    if (!process.env.ELECTRON_RENDERER_URL) {
      const unpacked = path.join(__dirname, "..", "..", "webview", "index.html");
      const packaged = path.join(process.resourcesPath || path.join(__dirname, "..", "..", ".."), "app", "webview", "index.html");
      const chosen = fs.existsSync(unpacked) ? unpacked : (fs.existsSync(packaged) ? packaged : null);
      if (chosen) process.env.ELECTRON_RENDERER_URL = url.pathToFileURL(chosen).toString();
    }
    if (!process.env.ELECTRON_FORCE_IS_PACKAGED) process.env.ELECTRON_FORCE_IS_PACKAGED = "1";
    if (!process.env.CODEX_BUILD_NUMBER) process.env.CODEX_BUILD_NUMBER = "__BUILD_NUMBER__";
    if (!process.env.CODEX_BUILD_FLAVOR) process.env.CODEX_BUILD_FLAVOR = "__BUILD_FLAVOR__";
    if (!process.env.BUILD_FLAVOR) process.env.BUILD_FLAVOR = "__BUILD_FLAVOR__";
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
  } catch {
    // no-op
  }
})();
`
    .replace(/__BUILD_NUMBER__/g, safeBuildNumber)
    .replace(/__BUILD_FLAVOR__/g, safeBuildFlavor);

  fs.writeFileSync(mainJs, `${shim}\n${raw}`, "utf8");
}

export function ensureGitOnPath(): void {
  const candidates: string[] = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"));
    candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "git.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe"));
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "git.exe"));
  }
  const gitExe = candidates.find((candidate) => fileExists(candidate));
  if (!gitExe) return;
  const gitDir = path.dirname(gitExe);
  const current = (process.env.PATH || "").split(";").map((entry) => entry.trim().toLowerCase());
  if (!current.includes(gitDir.toLowerCase())) {
    process.env.PATH = `${gitDir};${process.env.PATH || ""}`;
    process.env.Path = process.env.PATH;
  }
}

export function startCodexDirectLaunch(
  electronExe: string,
  appDir: string,
  userDataDir: string,
  cacheDir: string,
  codexCliPath: string,
  buildNumber: string,
  buildFlavor: string,
): void {
  if (!fileExists(electronExe)) throw new Error(`electron.exe not found: ${electronExe}`);
  const rendererPath = path.join(appDir, "webview", "index.html");
  const rendererUrl = `file:///${rendererPath.replace(/\\/g, "/")}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_RENDERER_URL = rendererUrl;
  env.ELECTRON_FORCE_IS_PACKAGED = "1";
  env.CODEX_BUILD_NUMBER = buildNumber;
  env.CODEX_BUILD_FLAVOR = buildFlavor;
  env.BUILD_FLAVOR = buildFlavor;
  env.NODE_ENV = "production";
  env.CODEX_CLI_PATH = codexCliPath;
  env.PWD = appDir;

  ensureDir(userDataDir);
  ensureDir(cacheDir);

  const result = runCommand(
    electronExe,
    [appDir, "--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`],
    { cwd: appDir, env, capture: false, allowNonZero: true },
  );
  if (result.status !== 0) {
    throw new Error(`Codex process exited with code ${result.status}.`);
  }
}
