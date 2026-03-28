"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPO_ROOT = void 0;
exports.resolvePreferredCodexCliPath = resolvePreferredCodexCliPath;
exports.sanitizeRunnerEnvironment = sanitizeRunnerEnvironment;
exports.sanitizeNpmBuildEnvironment = sanitizeNpmBuildEnvironment;
const path = __importStar(require("node:path"));
exports.REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
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
function resolvePreferredCodexCliPath(explicit) {
    return explicit || undefined;
}
function sanitizeRunnerEnvironment() {
    for (const key of RUNNER_ENV_KEYS)
        delete process.env[key];
}
function sanitizeNpmBuildEnvironment() {
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
