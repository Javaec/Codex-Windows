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
exports.resolveNpmCommand = resolveNpmCommand;
exports.resolveNpxCommand = resolveNpxCommand;
exports.invokeNpmWithResult = invokeNpmWithResult;
exports.invokeNpxWithResult = invokeNpxWithResult;
exports.invokeNpm = invokeNpm;
exports.invokeNpx = invokeNpx;
exports.invokeNpmCapture = invokeNpmCapture;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
function resolveNodeCommand() {
    const node = (0, exec_1.resolveCommand)("node.exe") ?? (0, exec_1.resolveCommand)("node");
    if (!node)
        throw new Error("node not found.");
    return node;
}
function resolveNpmCliScript() {
    const npm = resolveNpmCommand();
    if (npm.toLowerCase().endsWith(".js")) {
        if (!fs.existsSync(npm))
            throw new Error(`npm CLI script does not exist: ${npm}`);
        return npm;
    }
    const npmDir = path.dirname(npm);
    const npmCli = path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (!fs.existsSync(npmCli)) {
        throw new Error(`npm-cli.js not found next to npm command: ${npmCli}`);
    }
    return npmCli;
}
function runViaNodeNpm(args, cwd, capture) {
    const npmCli = resolveNpmCliScript();
    const node = resolveNodeCommand();
    return (0, exec_1.runCommand)(node, [npmCli, ...args], {
        cwd,
        capture,
        allowNonZero: true,
    });
}
function translateNpxArgsToNpmExec(args) {
    if (!args.length)
        return ["exec"];
    let index = 0;
    let yes = false;
    if (args[index] === "-y" || args[index] === "--yes") {
        yes = true;
        index += 1;
    }
    const pkg = args[index];
    if (!pkg)
        return ["exec", ...args];
    index += 1;
    const commandArgs = args.slice(index);
    const npmArgs = ["exec"];
    if (yes)
        npmArgs.push("--yes");
    npmArgs.push("--package", pkg);
    if (commandArgs.length)
        npmArgs.push("--", ...commandArgs);
    return npmArgs;
}
function resolveNpmCommand() {
    const npm = (0, exec_1.resolveCommand)("npm.cmd") ?? (0, exec_1.resolveCommand)("npm");
    if (!npm)
        throw new Error("npm not found.");
    return npm;
}
function resolveNpxCommand() {
    const npx = (0, exec_1.resolveCommand)("npx.cmd") ?? (0, exec_1.resolveCommand)("npx");
    if (!npx)
        throw new Error("npx not found.");
    return npx;
}
function invokeNpmWithResult(args, cwd, passThruOutput = false) {
    return runViaNodeNpm(args, cwd, !passThruOutput);
}
function invokeNpxWithResult(args, cwd, passThruOutput = false) {
    return runViaNodeNpm(translateNpxArgsToNpmExec(args), cwd, !passThruOutput);
}
function invokeNpm(args, cwd, passThruOutput = false) {
    return invokeNpmWithResult(args, cwd, passThruOutput).status;
}
function invokeNpx(args, cwd, passThruOutput = false) {
    return invokeNpxWithResult(args, cwd, passThruOutput).status;
}
function invokeNpmCapture(args, cwd) {
    const result = runViaNodeNpm(args, cwd, true);
    return result.stdout || "";
}
