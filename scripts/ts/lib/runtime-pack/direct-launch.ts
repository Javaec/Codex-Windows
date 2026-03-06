import * as path from "node:path";
import { normalizeProfileName } from "../args";
import { ensureDir, fileExists, runCommand } from "../exec";

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
  gitCapabilityCachePath?: string,
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
  if (gitCapabilityCachePath) env.CODEX_GIT_CAPABILITY_CACHE = gitCapabilityCachePath;

  if (!env.CODEX_MODS_DIR) {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const modsDir = path.join(repoRoot, "shared", "codex-mod-loader", "mods");
    if (!fileExists(modsDir)) {
      throw new Error(`Codex mods directory missing: ${modsDir}`);
    }
    env.CODEX_MODS_DIR = modsDir;
  }
  if (!env.CODEX_MOD_API_DIR) {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const modApiDir = path.join(repoRoot, "shared", "codex-mod-loader", "api");
    if (!fileExists(modApiDir)) {
      throw new Error(`Codex mod API directory missing: ${modApiDir}`);
    }
    env.CODEX_MOD_API_DIR = modApiDir;
  }
  if (!env.CODEX_MOD_LOADER_DIR) {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const modLoaderDir = path.join(repoRoot, "shared", "codex-mod-loader", "loader");
    if (!fileExists(modLoaderDir)) {
      throw new Error(`Codex mod loader directory missing: ${modLoaderDir}`);
    }
    env.CODEX_MOD_LOADER_DIR = modLoaderDir;
  }

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

function composePortablePath(basePath: string, outputDir: string): string {
  const entries = basePath.split(";").filter(Boolean);
  const seen = new Set<string>();
  const include = (value: string): void => {
    const normalized = value.trim().replace(/^"+|"+$/g, "");
    if (!normalized) return;
    if (!fileExists(normalized)) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.unshift(normalized);
  };

  const winRoot = process.env.SystemRoot || "C:\\Windows";
  include(path.join(outputDir, "resources", "path"));
  include(path.join(outputDir, "resources"));
  include(outputDir);
  include(path.join(winRoot, "System32"));
  include(winRoot);
  include(path.join(winRoot, "System32", "Wbem"));
  include(path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "PowerShell", "7"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "nodejs"));
  if (process.env["ProgramFiles(x86)"]) include(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
  if (process.env.APPDATA) include(path.join(process.env.APPDATA, "npm"));
  return entries.join(";");
}

export function startPortableDirectLaunch(outputDir: string, profileName: string): number {
  const profile = normalizeProfileName(profileName);
  const isDefault = profile === "default";
  const userDataDir = path.join(outputDir, isDefault ? "userdata" : `userdata-${profile}`);
  const cacheDir = path.join(outputDir, isDefault ? "cache" : `cache-${profile}`);
  const exePath = path.join(outputDir, "Codex.exe");
  if (!fileExists(exePath)) throw new Error(`Portable executable not found: ${exePath}`);

  ensureDir(userDataDir);
  ensureDir(cacheDir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const normalizedPath = composePortablePath(process.env.PATH || process.env.Path || "", outputDir);
  env.PATH = normalizedPath;
  env.Path = normalizedPath;
  env.PATHEXT = env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  env.CODEX_WINDOWS_PROFILE = profile;
  env.CODEX_GIT_CAPABILITY_CACHE = path.join(outputDir, "resources", "git-capability-cache.json");
  env.ELECTRON_FORCE_IS_PACKAGED = "1";
  env.NODE_ENV = "production";
  delete env.ELECTRON_RENDERER_URL;

  const codexCliPath = path.join(outputDir, "resources", "codex.exe");
  if (!fileExists(codexCliPath)) throw new Error(`Portable Codex CLI is missing: ${codexCliPath}`);
  const modsDir = path.join(outputDir, "resources", "mods");
  if (!fileExists(modsDir)) throw new Error(`Portable modpack is missing: ${modsDir}`);
  const modApiDir = path.join(outputDir, "resources", "mod-api");
  if (!fileExists(modApiDir)) throw new Error(`Portable mod API is missing: ${modApiDir}`);
  const modLoaderDir = path.join(outputDir, "resources", "mod-loader");
  if (!fileExists(modLoaderDir)) throw new Error(`Portable mod loader is missing: ${modLoaderDir}`);
  env.CODEX_CLI_PATH = codexCliPath;
  env.CODEX_MODS_DIR = modsDir;
  env.CODEX_MOD_API_DIR = modApiDir;
  env.CODEX_MOD_LOADER_DIR = modLoaderDir;

  const cliProbe = runCommand(codexCliPath, ["--version"], { capture: true, allowNonZero: true });
  if (cliProbe.status !== 0) {
    throw new Error(
      `Portable Codex CLI failed preflight (exit=${cliProbe.status}): ${(cliProbe.stdout || cliProbe.stderr || "").trim()}`,
    );
  }

  return runCommand(
    exePath,
    ["--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`],
    { cwd: outputDir, env, capture: false, allowNonZero: true },
  ).status;
}
