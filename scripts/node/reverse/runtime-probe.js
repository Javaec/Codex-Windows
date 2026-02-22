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
exports.findElectronExecutableCandidates = findElectronExecutableCandidates;
exports.classifyProbeLine = classifyProbeLine;
exports.runRuntimeProbe = runRuntimeProbe;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const exec_1 = require("../lib/exec");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function findElectronExecutableCandidates(appDir, explicitPath) {
    const repoRoot = path.resolve(appDir, "..", "..");
    const workRoot = path.resolve(appDir, "..");
    const candidates = [
        explicitPath,
        path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "electron.exe"),
        path.join(repoRoot, "work", "native-builds", "node_modules", "electron", "dist", "electron.exe"),
        path.join(process.cwd(), "node_modules", "electron", "dist", "electron.exe"),
    ];
    return Array.from(new Set(candidates
        .filter((item) => !!item)
        .map((item) => path.resolve(item))
        .filter((item) => fs.existsSync(item) && fs.statSync(item).isFile())));
}
function classifyProbeLine(line) {
    const lower = line.toLowerCase();
    if (lower.length === 0)
        return "unknown";
    const logicPatterns = [
        /\btypeerror\b/,
        /\breferenceerror\b/,
        /\brangeerror\b/,
        /\bsyntaxerror\b/,
        /\bipc\b/,
        /\brpc\b/,
        /\brouter?\b/,
        /\broute\b/,
        /\bstate\b/,
        /\bthread\b/,
        /\bsession\b/,
        /\bconversation\b/,
        /\bchat\b/,
        /\bturn\b/,
        /\bapproval\b/,
        /\bworkspace\b/,
        /\bworktree\b/,
        /\bsettings?\b/,
        /\bmodel\b/,
        /\bauth\b/,
        /\blogin\b/,
        /\bmcp\b/,
        /\bautomation\b/,
        /\bstatsig\b/,
        /\bgate\b/,
        /\bundefined\b/,
        /cannot read (?:properties|property)/,
        /\bunhandled(?:rejection)?\b/,
    ];
    if (logicPatterns.some((pattern) => pattern.test(lower))) {
        return "logic";
    }
    const systemPatterns = [
        /\bcache\b/,
        /\bprofile\b/,
        /\buser-data-dir\b/,
        /\bgpu\b/,
        /\bwebgl\b/,
        /\bvulkan\b/,
        /\bd3d\b/,
        /\bnvidia\b/,
        /\bdmabuf\b/,
        /\bcompositor\b/,
        /\bwebkit\b/,
        /\bchromium\b/,
        /\bnetwork\b/,
        /\bdns\b/,
        /\bsocket\b/,
        /\btls\b/,
        /\bssl\b/,
        /\bcertificate\b/,
        /\bproxy\b/,
        /\bfirewall\b/,
        /\bpermission denied\b/,
        /\baccess denied\b/,
        /\bepipe\b/,
        /\beconnrefused\b/,
        /\betimedout\b/,
        /\benotfound\b/,
        /\bcrashpad\b/,
        /\bsandbox\b/,
        /\bfilesystem\b/,
        /\bdisk\b/,
        /\benoent\b/,
        /\bpath does not exist\b/,
        /\bfirst[-_ ]party sets?\b/,
        /\bfirst_party_sets\b/,
    ];
    if (systemPatterns.some((pattern) => pattern.test(lower))) {
        return "system";
    }
    return "unknown";
}
function classifyProbeLines(lines, maxPerBucket) {
    const buckets = {
        system: [],
        logic: [],
        unknown: [],
    };
    for (const line of lines) {
        const kind = classifyProbeLine(line);
        if (buckets[kind].length >= maxPerBucket)
            continue;
        buckets[kind].push(line);
    }
    return buckets;
}
async function runRuntimeProbe(input) {
    const logPath = path.join(input.reportDir, "runtime-probe.log");
    const userDataDir = path.join(input.reportDir, "runtime-probe-profile");
    if (!input.electronExe) {
        const skipped = {
            attempted: false,
            success: false,
            forcedStop: false,
            skippedReason: "Electron executable not found.",
            electronExe: "",
            userDataDir: toPosixPath(userDataDir),
            durationMs: 0,
            exitCode: -1,
            signal: "",
            stdoutLines: 0,
            stderrLines: 0,
            warnings: [],
            errors: [],
            warningClassification: { system: [], logic: [], unknown: [] },
            errorClassification: { system: [], logic: [], unknown: [] },
            capturedLines: [],
            logPath: toPosixPath(logPath),
        };
        fs.writeFileSync(logPath, "Runtime probe skipped: Electron executable not found.\n", "utf8");
        return skipped;
    }
    const start = Date.now();
    (0, exec_1.removePath)(userDataDir);
    (0, exec_1.ensureDir)(userDataDir);
    const args = [
        input.appDir,
        "--enable-logging",
        "--v=1",
        "--log-level=0",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`,
    ];
    const env = {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "1",
        ELECTRON_ENABLE_STACK_DUMPING: "1",
        NODE_ENV: "production",
    };
    const child = (0, node_child_process_1.spawn)(input.electronExe, args, {
        cwd: path.dirname(input.appDir),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
    let exitCode = -1;
    let exitSignal = "";
    let spawnErrorMessage = "";
    let forcedStop = false;
    child.once("error", (error) => {
        spawnErrorMessage = error instanceof Error ? error.message : String(error);
    });
    const exitPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => {
            exitCode = typeof code === "number" ? code : -1;
            exitSignal = signal ?? "";
            resolve();
        });
    });
    await new Promise((resolve) => setTimeout(resolve, input.durationMs));
    if (child.exitCode === null && child.pid) {
        forcedStop = true;
        if (process.platform === "win32") {
            (0, node_child_process_1.spawnSync)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        }
        else {
            child.kill("SIGTERM");
        }
    }
    await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    const stdoutText = stdoutChunks.join("");
    const stderrText = stderrChunks.join("");
    const combined = `${stdoutText}\n${stderrText}`.trim();
    fs.writeFileSync(logPath, `${combined}\n`, "utf8");
    const lines = combined.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const warnings = lines
        .filter((line) => /\bwarn(?:ing)?\b/i.test(line))
        .slice(0, 120);
    const errors = lines
        .filter((line) => /\berror\b|\bexception\b|\bfailed\b|uncaught|unhandled/i.test(line))
        .slice(0, 120);
    if (spawnErrorMessage)
        errors.unshift(`spawn-error: ${spawnErrorMessage}`);
    const warningClassification = classifyProbeLines(warnings, 120);
    const errorClassification = classifyProbeLines(errors, 120);
    const capturedLines = lines.slice(0, 8000);
    const spawned = !!child.pid && !spawnErrorMessage;
    return {
        attempted: true,
        success: spawned && (forcedStop || exitCode === 0 || exitSignal.length > 0),
        forcedStop,
        skippedReason: spawnErrorMessage ? spawnErrorMessage : "",
        electronExe: toPosixPath(input.electronExe),
        userDataDir: toPosixPath(userDataDir),
        durationMs: Date.now() - start,
        exitCode,
        signal: exitSignal,
        stdoutLines: stdoutText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
        stderrLines: stderrText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
        warnings,
        errors,
        warningClassification,
        errorClassification,
        capturedLines,
        logPath: toPosixPath(logPath),
    };
}
