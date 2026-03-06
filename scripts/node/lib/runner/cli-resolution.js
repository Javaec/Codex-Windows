"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAndProbeCodexCli = resolveAndProbeCodexCli;
const cli_1 = require("../cli");
const exec_1 = require("../exec");
function resolveAndProbeCodexCli(codexCliPath, requireFound, tracePath, probeFailurePrefix, missingWarnMessage) {
    const resolution = (0, cli_1.resolveCodexCliPathContract)(codexCliPath, requireFound);
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
