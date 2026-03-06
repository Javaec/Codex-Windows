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
exports.runVerify = runVerify;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const cli_1 = require("../cli");
const env_1 = require("../env");
const exec_1 = require("../exec");
const patch_pack_1 = require("../platform-patches/patch-pack");
const extract_1 = require("../source-bundle/extract");
const context_1 = require("./context");
function addVerifyItem(items, name, status, details) {
    items.push({ name, status, details });
}
function writeVerifySummary(items) {
    const counts = { OK: 0, WARN: 0, FAIL: 0 };
    for (const item of items) {
        counts[item.status] += 1;
        const line = `[verify] ${item.status.padEnd(4, " ")} ${item.name} :: ${item.details}`;
        if (item.status === "OK")
            (0, exec_1.writeSuccess)(line);
        else if (item.status === "WARN")
            (0, exec_1.writeWarn)(line);
        else
            (0, exec_1.writeError)(line);
    }
    (0, exec_1.writeHeader)("Verify summary");
    (0, exec_1.writeSuccess)(`OK=${counts.OK} WARN=${counts.WARN} FAIL=${counts.FAIL}`);
}
function resolveNativeSupportCandidates() {
    return (0, exec_1.uniqueExistingDirs)([
        path.join(context_1.REPO_ROOT, "dist", "Codex-win32-x64", "resources", "app"),
        path.join(context_1.REPO_ROOT, "dist", "Codex-win32-arm64", "resources", "app"),
        path.join(context_1.REPO_ROOT, "scripts", "native-seeds", "win32-x64", "app"),
        path.join(context_1.REPO_ROOT, "scripts", "native-seeds", "win32-arm64", "app"),
    ]);
}
function takeLastLine(text) {
    const lines = String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : "";
}
function summarizePatchPackPreflight(output) {
    try {
        const parsed = JSON.parse(output);
        const profileId = parsed.selected?.profileId || "unknown";
        const modCount = Number(parsed.selected?.modCount ?? 0);
        const stepCount = Number(parsed.selected?.stepCount ?? 0);
        const runtimeModCount = Number(parsed.runtimeModpack?.modCount ?? 0);
        return `profile=${profileId} selectedMods=${modCount} patchSteps=${stepCount} runtimeMods=${runtimeModCount}`;
    }
    catch {
        return takeLastLine(output) || "patch-pack is valid";
    }
}
async function runVerify(options) {
    (0, context_1.sanitizeRunnerEnvironment)();
    (0, env_1.ensureWindowsEnvironment)();
    (0, exec_1.mustResolveCommand)("node.exe");
    const workDir = path.resolve(options.workDir || path.join(context_1.REPO_ROOT, "work"));
    const distDir = path.resolve(options.distDir || path.join(context_1.REPO_ROOT, "dist"));
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    const items = [];
    (0, exec_1.writeHeader)("Verify environment");
    const ripgrep = await (0, env_1.ensureRipgrepInPath)(workDir);
    addVerifyItem(items, "ripgrep", "OK", `${ripgrep.path} (source=${ripgrep.source})`);
    const environmentResult = (0, env_1.invokeEnvironmentContractChecks)();
    for (const check of environmentResult.checks) {
        addVerifyItem(items, `env:${check.name}`, check.passed ? "OK" : "FAIL", check.details);
    }
    let resolvedDmgPath = "";
    try {
        resolvedDmgPath = (0, extract_1.resolveDmgPath)(options.dmgPath, context_1.REPO_ROOT);
        addVerifyItem(items, "dmg", "OK", resolvedDmgPath);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addVerifyItem(items, "dmg", "FAIL", message);
    }
    const snapshotLabel = resolvedDmgPath ? path.basename(resolvedDmgPath) : "";
    try {
        const resolvedProfile = (0, patch_pack_1.resolvePatchProfile)({
            snapshotLabel,
            buildNumber: "",
            appVersion: "",
            forcedProfileId: options.patchProfile || "",
        });
        addVerifyItem(items, "patch-profile", "OK", `${resolvedProfile.profile.profileId} (${resolvedProfile.source})`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addVerifyItem(items, "patch-profile", "FAIL", message);
    }
    const preflightArgs = [path.join(context_1.REPO_ROOT, "shared", "patch-pack", "preflight.mjs")];
    if (snapshotLabel)
        preflightArgs.push("--snapshot-label", snapshotLabel);
    const preflight = (0, exec_1.runCommand)(process.execPath, preflightArgs, {
        cwd: context_1.REPO_ROOT,
        capture: true,
        allowNonZero: true,
    });
    addVerifyItem(items, "patch-pack-preflight", preflight.status === 0 ? "OK" : "FAIL", preflight.status === 0
        ? summarizePatchPackPreflight(preflight.stdout)
        : takeLastLine(preflight.stderr || preflight.stdout) || `exit=${preflight.status}`);
    const preferredCodexCliPath = (0, context_1.resolvePreferredCodexCliPath)(options.codexCliPath);
    try {
        const cliResolution = (0, cli_1.resolveCodexCliPathContract)(preferredCodexCliPath, false);
        if (!cliResolution.found || !cliResolution.path) {
            addVerifyItem(items, "codex-cli", "FAIL", takeLastLine(cliResolution.trace.join("\n")) || "codex.exe not found");
        }
        else {
            const probe = (0, cli_1.probeResolvedCodexCli)(cliResolution);
            addVerifyItem(items, "codex-cli", probe.ok ? "OK" : "FAIL", `${cliResolution.path} (source=${cliResolution.source}; ${probe.details})`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addVerifyItem(items, "codex-cli", "FAIL", message);
    }
    const nativeCandidates = resolveNativeSupportCandidates();
    addVerifyItem(items, "native-support", nativeCandidates.length > 0 ? "OK" : "FAIL", nativeCandidates.length > 0
        ? `${nativeCandidates.length} donor/seed path(s) available`
        : "no donor/seed app directories found under dist/ or scripts/native-seeds/");
    writeVerifySummary(items);
    return items.some((item) => item.status === "FAIL") ? 1 : 0;
}
