import * as path from "node:path";
import { isCanonicalProfileName, normalizeProfileName } from "../args";
import { ensureDir, fileExists, runCommand } from "../exec";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WINDOWS_PATH_CONTRACT = require(path.join(REPO_ROOT, "shared", "windows-path-contract", "index.cjs")) as {
  normalizeWindowsPathContract: (
    input: string,
    options?: { slashStyle?: "forward" | "backward" | "preserve"; stripDiffPrefix?: boolean; stripLeadingDriveSlash?: boolean },
  ) => string;
};

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
  const normalizedAppDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.resolve(appDir));
  const normalizedUserDataDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.resolve(userDataDir));
  const normalizedCacheDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.resolve(cacheDir));
  const normalizedCliPath = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.resolve(codexCliPath));
  const rendererPath = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.join(normalizedAppDir, "webview", "index.html"), {
    slashStyle: "forward",
  });
  const rendererUrl = `file:///${rendererPath}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_RENDERER_URL = rendererUrl;
  env.ELECTRON_FORCE_IS_PACKAGED = "1";
  env.CODEX_BUILD_NUMBER = buildNumber;
  env.CODEX_BUILD_FLAVOR = buildFlavor;
  env.BUILD_FLAVOR = buildFlavor;
  env.NODE_ENV = "production";
  env.CODEX_CLI_PATH = normalizedCliPath;
  env.CODEX_ENABLE_RUNTIME_MODS = env.CODEX_ENABLE_RUNTIME_MODS === "1" ? "1" : "0";
  env.PWD = normalizedAppDir;
  if (gitCapabilityCachePath) env.CODEX_GIT_CAPABILITY_CACHE = gitCapabilityCachePath;

  if (env.CODEX_ENABLE_RUNTIME_MODS === "1") {
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
  } else {
    delete env.CODEX_MODS_DIR;
    delete env.CODEX_MOD_API_DIR;
    delete env.CODEX_MOD_LOADER_DIR;
  }

  ensureDir(normalizedUserDataDir);
  ensureDir(normalizedCacheDir);

  const result = runCommand(
    electronExe,
    [normalizedAppDir, "--enable-logging", `--user-data-dir=${normalizedUserDataDir}`, `--disk-cache-dir=${normalizedCacheDir}`],
    { cwd: normalizedAppDir, env, capture: false, allowNonZero: true },
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
  include(path.join(winRoot, "System32", "OpenSSH"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "PowerShell", "7"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "nodejs"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "Git", "cmd"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "Git", "bin"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "Git", "usr", "bin"));
  if (process.env["ProgramFiles(x86)"]) include(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
  if (process.env["ProgramFiles(x86)"]) include(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd"));
  if (process.env["ProgramFiles(x86)"]) include(path.join(process.env["ProgramFiles(x86)"], "Git", "bin"));
  if (process.env["ProgramFiles(x86)"]) include(path.join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin"));
  if (process.env.APPDATA) include(path.join(process.env.APPDATA, "npm"));
  return entries.join(";");
}

export function startPortableDirectLaunch(outputDir: string, profileName: string): number {
  const profile = normalizeProfileName(profileName);
  const isDefault = isCanonicalProfileName(profile);
  const normalizedOutputDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.resolve(outputDir));
  const userDataDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(
    path.join(normalizedOutputDir, isDefault ? "userdata" : `userdata-${profile}`),
  );
  const cacheDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(
    path.join(normalizedOutputDir, isDefault ? "cache" : `cache-${profile}`),
  );
  const exePath = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.join(normalizedOutputDir, "Codex.exe"));
  if (!fileExists(exePath)) throw new Error(`Portable executable not found: ${exePath}`);

  ensureDir(userDataDir);
  ensureDir(cacheDir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const normalizedPath = composePortablePath(process.env.PATH || process.env.Path || "", normalizedOutputDir);
  env.PATH = normalizedPath;
  env.Path = normalizedPath;
  env.PATHEXT = env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  env.CODEX_WINDOWS_PROFILE = profile;
  env.CODEX_GIT_CAPABILITY_CACHE = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(
    path.join(normalizedOutputDir, "resources", "git-capability-cache.json"),
  );
  env.ELECTRON_FORCE_IS_PACKAGED = "1";
  env.NODE_ENV = "production";
  env.CODEX_ENABLE_RUNTIME_MODS = env.CODEX_ENABLE_RUNTIME_MODS === "1" ? "1" : "0";
  delete env.ELECTRON_RENDERER_URL;

  const codexCliPath = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.join(normalizedOutputDir, "resources", "codex.exe"));
  if (!fileExists(codexCliPath)) throw new Error(`Portable Codex CLI is missing: ${codexCliPath}`);
  env.CODEX_CLI_PATH = codexCliPath;
  if (env.CODEX_ENABLE_RUNTIME_MODS === "1") {
    const modsDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.join(normalizedOutputDir, "resources", "mods"));
    if (!fileExists(modsDir)) throw new Error(`Portable modpack is missing: ${modsDir}`);
    const modApiDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.join(normalizedOutputDir, "resources", "mod-api"));
    if (!fileExists(modApiDir)) throw new Error(`Portable mod API is missing: ${modApiDir}`);
    const modLoaderDir = WINDOWS_PATH_CONTRACT.normalizeWindowsPathContract(path.join(normalizedOutputDir, "resources", "mod-loader"));
    if (!fileExists(modLoaderDir)) throw new Error(`Portable mod loader is missing: ${modLoaderDir}`);
    env.CODEX_MODS_DIR = modsDir;
    env.CODEX_MOD_API_DIR = modApiDir;
    env.CODEX_MOD_LOADER_DIR = modLoaderDir;
  } else {
    delete env.CODEX_MODS_DIR;
    delete env.CODEX_MOD_API_DIR;
    delete env.CODEX_MOD_LOADER_DIR;
  }

  const cliProbe = runCommand(codexCliPath, ["--version"], { capture: true, allowNonZero: true });
  if (cliProbe.status !== 0) {
    throw new Error(
      `Portable Codex CLI failed preflight (exit=${cliProbe.status}): ${(cliProbe.stdout || cliProbe.stderr || "").trim()}`,
    );
  }

  return runCommand(
    exePath,
    ["--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`],
    { cwd: normalizedOutputDir, env, capture: false, allowNonZero: true },
  ).status;
}
