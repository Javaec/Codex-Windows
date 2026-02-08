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
exports.writeHeader = writeHeader;
exports.writeInfo = writeInfo;
exports.writeSuccess = writeSuccess;
exports.writeWarn = writeWarn;
exports.writeError = writeError;
exports.fileExists = fileExists;
exports.ensureDir = ensureDir;
exports.resolveCommand = resolveCommand;
exports.mustResolveCommand = mustResolveCommand;
exports.runCommand = runCommand;
exports.runRobocopy = runRobocopy;
exports.uniqueExistingDirs = uniqueExistingDirs;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_CYAN = "\x1b[36m";
function colorize(text, color) {
    return `${color}${text}${ANSI_RESET}`;
}
function writeHeader(text) {
    process.stdout.write(`\n${colorize(`=== ${text} ===`, ANSI_CYAN)}\n`);
}
function writeInfo(text) {
    process.stdout.write(`${text}\n`);
}
function writeSuccess(text) {
    process.stdout.write(`${colorize(text, ANSI_GREEN)}\n`);
}
function writeWarn(text) {
    process.stdout.write(`${colorize(text, ANSI_YELLOW)}\n`);
}
function writeError(text) {
    process.stderr.write(`${colorize(text, ANSI_RED)}\n`);
}
function fileExists(filePath) {
    return fs.existsSync(filePath);
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}
function resolveCommand(name) {
    const where = (0, node_child_process_1.spawnSync)("where.exe", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
    });
    if (where.error || where.status !== 0)
        return null;
    const lines = (where.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        if (fileExists(line))
            return path.resolve(line);
    }
    return null;
}
function mustResolveCommand(name) {
    const resolved = resolveCommand(name);
    if (!resolved)
        throw new Error(`${name} not found.`);
    return resolved;
}
function runCommand(file, args, options) {
    const capture = Boolean(options?.capture);
    const result = (0, node_child_process_1.spawnSync)(file, args, {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        windowsHide: false,
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (result.error) {
        throw result.error;
    }
    const status = typeof result.status === "number" ? result.status : 1;
    const stdout = capture ? (result.stdout || "") : "";
    const stderr = capture ? (result.stderr || "") : "";
    if (!options?.allowNonZero && status !== 0) {
        const details = capture ? `\n${stdout}\n${stderr}` : "";
        throw new Error(`${path.basename(file)} exited with code ${status}.${details}`.trim());
    }
    return { status, stdout, stderr };
}
function runRobocopy(sourceDir, destinationDir, extraArgs = ["/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"]) {
    ensureDir(destinationDir);
    const robocopy = resolveCommand("robocopy.exe") ?? "robocopy";
    const result = runCommand(robocopy, [sourceDir, destinationDir, ...extraArgs], {
        capture: true,
        allowNonZero: true,
    });
    if (result.status >= 8) {
        throw new Error(`robocopy failed with code ${result.status}.\n${result.stdout}\n${result.stderr}`.trim());
    }
}
function uniqueExistingDirs(candidates) {
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (!candidate || !fileExists(candidate))
            continue;
        const resolved = path.resolve(candidate);
        const key = resolved.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(resolved);
    }
    return out;
}
