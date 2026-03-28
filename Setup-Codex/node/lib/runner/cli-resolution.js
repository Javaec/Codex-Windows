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
exports.resolveAndProbeCodexCli = resolveAndProbeCodexCli;
const path = __importStar(require("node:path"));
const cli_1 = require("../cli");
const github_cli_1 = require("../github-cli");
const exec_1 = require("../exec");
async function resolveAndProbeCodexCli(codexCliPath, requireFound, tracePath, probeFailurePrefix, missingWarnMessage, options) {
    let effectiveCliPath = codexCliPath;
    let sourceOverride = "";
    if (!effectiveCliPath && (0, github_cli_1.isGitHubAlphaCliChannel)(options?.codexCliChannel)) {
        const downloaded = await (0, github_cli_1.downloadLatestGitHubAlphaCodexCli)(options?.workDir || path.dirname(tracePath));
        effectiveCliPath = downloaded.path;
        sourceOverride = downloaded.source;
        (0, exec_1.writeSuccess)(`Using latest GitHub alpha Codex CLI: ${downloaded.tag} (${downloaded.path})`);
    }
    const resolution = (0, cli_1.resolveCodexCliPathContract)(effectiveCliPath, requireFound);
    if (sourceOverride && resolution.found) {
        resolution.source = sourceOverride;
        resolution.trace.unshift(`Resolved GitHub alpha CLI -> [${effectiveCliPath}]`);
    }
    (0, cli_1.writeCliResolutionTrace)(resolution, tracePath);
    if (!resolution.found) {
        if (missingWarnMessage)
            (0, exec_1.writeWarn)(missingWarnMessage);
        return resolution;
    }
    (0, exec_1.writeSuccess)(`Using Codex CLI: ${resolution.path} (source=${resolution.source})`);
    const probe = (0, cli_1.probeResolvedCodexCli)(resolution);
    if (!probe.ok)
        throw new Error(`${probeFailurePrefix}: ${probe.details}`);
    return resolution;
}
