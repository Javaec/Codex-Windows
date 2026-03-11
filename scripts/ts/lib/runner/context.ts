import * as path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const RUNNER_ENV_KEYS = [
  "CODEX_CLI_PATH",
  "CODEX_MODS_DIR",
  "CODEX_MOD_API_DIR",
  "CODEX_MOD_LOADER_DIR",
  "CODEX_ENABLE_RUNTIME_MODS",
  "CODEX_MODS_DISABLED",
  "CODEX_MODS_ONLY",
  "CODEX_WINDOWS_PROFILE",
  "CODEX_GIT_CAPABILITY_CACHE",
  "CODEX_BUILD_NUMBER",
  "CODEX_BUILD_FLAVOR",
  "BUILD_FLAVOR",
  "ELECTRON_RENDERER_URL",
  "ELECTRON_FORCE_IS_PACKAGED",
];

export function resolvePreferredCodexCliPath(explicit: string | undefined): string | undefined {
  return explicit || undefined;
}

export function sanitizeRunnerEnvironment(): void {
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
}

export function sanitizeNpmBuildEnvironment(): void {
  for (const key of [
    "npm_config_runtime",
    "npm_config_target",
    "npm_config_disturl",
    "npm_config_arch",
    "npm_config_build_from_source",
  ]) {
    delete process.env[key];
  }
}
