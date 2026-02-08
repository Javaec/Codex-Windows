"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNpmCommand = resolveNpmCommand;
exports.resolveNpxCommand = resolveNpxCommand;
exports.invokeNpmWithResult = invokeNpmWithResult;
exports.invokeNpxWithResult = invokeNpxWithResult;
exports.invokeNpm = invokeNpm;
exports.invokeNpx = invokeNpx;
exports.invokeNpmCapture = invokeNpmCapture;
const env_1 = require("./env");
const exec_1 = require("./exec");
function runViaCmd(scriptPath, args, cwd, capture) {
    const cmd = (0, env_1.resolveCmdPath)() ?? "cmd.exe";
    // Pass tokens separately to avoid fragile string re-quoting under localized cmd.exe.
    const result = (0, exec_1.runCommand)(cmd, ["/d", "/c", "call", scriptPath, ...args], {
        cwd,
        capture,
        allowNonZero: true,
    });
    return result;
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
    return runViaCmd(resolveNpmCommand(), args, cwd, !passThruOutput);
}
function invokeNpxWithResult(args, cwd, passThruOutput = false) {
    return runViaCmd(resolveNpxCommand(), args, cwd, !passThruOutput);
}
function invokeNpm(args, cwd, passThruOutput = false) {
    return invokeNpmWithResult(args, cwd, passThruOutput).status;
}
function invokeNpx(args, cwd, passThruOutput = false) {
    return invokeNpxWithResult(args, cwd, passThruOutput).status;
}
function invokeNpmCapture(args, cwd) {
    const cmd = (0, env_1.resolveCmdPath)() ?? "cmd.exe";
    const npm = resolveNpmCommand();
    const result = (0, exec_1.runCommand)(cmd, ["/d", "/c", "call", npm, ...args], {
        cwd,
        capture: true,
        allowNonZero: true,
    });
    return result.stdout || "";
}
