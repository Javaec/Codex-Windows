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
exports.resolveCodexCliPathContract = resolveCodexCliPathContract;
exports.writeCliResolutionTrace = writeCliResolutionTrace;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const npm_1 = require("./npm");
function newCliResolveResult(preferredArch) {
    return {
        found: false,
        path: null,
        source: null,
        preferredArch,
        trace: [],
    };
}
function addCliTrace(result, message) {
    result.trace.push(message);
}
function getNpmGlobalRoots() {
    const roots = [];
    try {
        const npmRoot = (0, npm_1.invokeNpmCapture)(["root", "-g"]).trim();
        if (npmRoot)
            roots.push(npmRoot);
    }
    catch {
        // ignore
    }
    try {
        const prefix = (0, npm_1.invokeNpmCapture)(["prefix", "-g"]).trim();
        if (prefix)
            roots.push(path.join(prefix, "node_modules"));
    }
    catch {
        // ignore
    }
    if (process.env.APPDATA)
        roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
    return (0, exec_1.uniqueExistingDirs)(roots);
}
function findCodexVendorExeInRoot(root, preferredArch) {
    const candidates = [
        path.join(root, "@openai", "codex", "vendor", preferredArch, "codex", "codex.exe"),
        path.join(root, "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"),
        path.join(root, "@openai", "codex", "vendor", "aarch64-pc-windows-msvc", "codex", "codex.exe"),
    ];
    for (const candidate of candidates) {
        if ((0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return null;
}
function resolveNpmShimToVendorExe(shimPath, preferredArch, result) {
    if (!shimPath || !(0, exec_1.fileExists)(shimPath))
        return null;
    const shimDir = path.dirname(shimPath);
    const roots = (0, exec_1.uniqueExistingDirs)([path.join(shimDir, "node_modules"), ...getNpmGlobalRoots()]);
    for (const root of roots) {
        const resolved = findCodexVendorExeInRoot(root, preferredArch);
        if (resolved) {
            addCliTrace(result, `Resolved shim [${shimPath}] via root [${root}] -> [${resolved}]`);
            return resolved;
        }
    }
    addCliTrace(result, `Shim [${shimPath}] did not resolve to vendor codex.exe`);
    return null;
}
function resolveCodexCliPathContract(explicit, throwOnFailure) {
    const preferredArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const result = newCliResolveResult(preferredArch);
    const resolveCandidate = (candidate, source) => {
        if (!candidate)
            return null;
        const resolvedCandidate = path.resolve(candidate);
        if (!(0, exec_1.fileExists)(resolvedCandidate)) {
            addCliTrace(result, `Candidate missing [${source}] -> [${resolvedCandidate}]`);
            return null;
        }
        const ext = path.extname(resolvedCandidate).toLowerCase();
        if (ext === ".exe") {
            addCliTrace(result, `Accepted executable [${source}] -> [${resolvedCandidate}]`);
            return resolvedCandidate;
        }
        if (ext === ".cmd" || ext === ".ps1" || !ext) {
            addCliTrace(result, `Candidate is shim/non-exe [${source}] -> [${resolvedCandidate}]`);
            return resolveNpmShimToVendorExe(resolvedCandidate, preferredArch, result);
        }
        addCliTrace(result, `Rejected unsupported extension [${source}] -> [${resolvedCandidate}]`);
        return null;
    };
    if (explicit) {
        const resolvedExplicit = resolveCandidate(explicit, "explicit");
        if (resolvedExplicit) {
            result.found = true;
            result.path = resolvedExplicit;
            result.source = "explicit";
            return result;
        }
        if (throwOnFailure) {
            throw new Error(`Codex CLI not found from explicit path [${explicit}]. Trace: ${result.trace.join(" | ")}`);
        }
        return result;
    }
    if (process.env.CODEX_CLI_PATH) {
        const resolvedEnv = resolveCandidate(process.env.CODEX_CLI_PATH, "env:CODEX_CLI_PATH");
        if (resolvedEnv) {
            result.found = true;
            result.path = resolvedEnv;
            result.source = "env:CODEX_CLI_PATH";
            return result;
        }
    }
    for (const root of getNpmGlobalRoots()) {
        const vendorExe = findCodexVendorExeInRoot(root, preferredArch);
        if (vendorExe) {
            addCliTrace(result, `Detected vendor exe in npm root [${root}] -> [${vendorExe}]`);
            result.found = true;
            result.path = vendorExe;
            result.source = "npm-vendor";
            return result;
        }
        addCliTrace(result, `No vendor exe in npm root [${root}]`);
    }
    const whereCandidates = (0, exec_1.uniqueExistingDirs)([(0, exec_1.resolveCommand)("codex.exe"), (0, exec_1.resolveCommand)("codex.cmd"), (0, exec_1.resolveCommand)("codex")].filter(Boolean));
    for (const candidate of whereCandidates) {
        const resolved = resolveCandidate(candidate, "where");
        if (resolved) {
            result.found = true;
            result.path = resolved;
            result.source = "where";
            return result;
        }
    }
    if (throwOnFailure) {
        throw new Error(`codex.exe not found. Trace: ${result.trace.join(" | ")}`);
    }
    return result;
}
function writeCliResolutionTrace(resolution, tracePath) {
    (0, exec_1.ensureDir)(path.dirname(tracePath));
    const lines = [];
    lines.push(`timestampUtc=${new Date().toISOString()}`);
    lines.push(`found=${resolution.found}`);
    lines.push(`path=${resolution.path ?? ""}`);
    lines.push(`source=${resolution.source ?? ""}`);
    lines.push(`preferredArch=${resolution.preferredArch}`);
    for (const entry of resolution.trace)
        lines.push(`trace=${entry}`);
    fs.writeFileSync(tracePath, `${lines.join("\n")}\n`, "utf8");
}
