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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const node_test_1 = require("node:test");
const worklouder_portable_1 = require("./worklouder-portable");
(0, node_test_1.test)("portable archive contains only shareable launcher files", () => {
    const result = (0, worklouder_portable_1.buildPortablePackage)();
    strict_1.default.equal(fs.existsSync(result.archivePath), true);
    const listing = (0, node_child_process_1.spawnSync)("tar.exe", ["-tf", result.archivePath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    strict_1.default.equal(listing.status, 0, String(listing.stderr || "tar failed"));
    const files = String(listing.stdout || "")
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean)
        .sort();
    strict_1.default.deepEqual(files, [
        "Check-Persistent-Patch.cmd",
        "Launch-Codex-WorkLouder-Bypass.cmd",
        "Manage-Persistent-Patch.ps1",
        "README.md",
        "Restore-Persistent-Patch.cmd",
        "SHA256SUMS.txt",
        "build-metadata.json",
        "worklouder-bypass.js",
        "worklouder-persistent-patch.js",
    ]);
    strict_1.default.equal(files.some((file) => /Codex-Windows|node_modules|\.codex/i.test(file)), false);
    const launcher = fs.readFileSync(`${result.stagingDir}\\Launch-Codex-WorkLouder-Bypass.cmd`, "ascii");
    strict_1.default.doesNotMatch(launcher, /-Mode Install/);
    strict_1.default.match(launcher, /Persistent install is disabled/);
    strict_1.default.match(launcher, /node "%NODE_SCRIPT%" %\*/);
});
