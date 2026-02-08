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
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ADAPTER_SCRIPT = path.join(REPO_ROOT, "scripts", "adapters", "legacy-pipeline.ps1");
function printUsage() {
    console.log("Usage:");
    console.log("  node scripts/node/run.js run [options]");
    console.log("  node scripts/node/run.js build [options]");
    console.log("");
    console.log("Examples:");
    console.log("  node scripts/node/run.js run -DmgPath .\\Codex.dmg -Reuse");
    console.log("  node scripts/node/run.js build -DmgPath .\\Codex.dmg -Reuse -NoLaunch");
    console.log("");
    console.log("Options are passed through to the pipeline as-is.");
}
function resolvePowerShellExecutable() {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const winPs = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(winPs)) {
        return winPs;
    }
    return "powershell.exe";
}
function parseArgs(argv) {
    if (argv.length === 0) {
        return { mode: "run", showHelp: true, forwarded: [] };
    }
    let mode = "run";
    let index = 0;
    const first = argv[0].toLowerCase();
    if (!first.startsWith("-")) {
        if (first === "run" || first === "build") {
            mode = first;
            index = 1;
        }
        else if (first === "help") {
            return { mode: "run", showHelp: true, forwarded: [] };
        }
        else {
            throw new Error(`Unsupported mode: ${argv[0]}`);
        }
    }
    const rest = argv.slice(index);
    const showHelp = rest.some((arg) => arg === "-h" || arg === "--help");
    return {
        mode,
        showHelp,
        forwarded: showHelp ? [] : rest,
    };
}
function runPipeline(mode, forwarded) {
    if (!fs.existsSync(ADAPTER_SCRIPT)) {
        console.error(`[ERROR] Missing adapter script: ${ADAPTER_SCRIPT}`);
        return 1;
    }
    const psExe = resolvePowerShellExecutable();
    const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ADAPTER_SCRIPT,
        "-Mode",
        mode,
        ...forwarded,
    ];
    const result = (0, node_child_process_1.spawnSync)(psExe, args, {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: process.env,
        windowsHide: false,
    });
    if (result.error) {
        if (result.error.code === "ENOENT") {
            console.error(`[ERROR] PowerShell not found: ${psExe}`);
        }
        else {
            console.error(`[ERROR] Failed to execute adapter: ${result.error.message}`);
        }
        return 1;
    }
    if (typeof result.status === "number") {
        return result.status;
    }
    return 1;
}
function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.showHelp) {
        printUsage();
        return 0;
    }
    return runPipeline(parsed.mode, parsed.forwarded);
}
try {
    process.exit(main());
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${message}`);
    process.exit(1);
}
