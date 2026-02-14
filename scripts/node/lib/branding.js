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
exports.ensureRcedit = ensureRcedit;
exports.resolveDefaultCodexIconPath = resolveDefaultCodexIconPath;
exports.applyExecutableBranding = applyExecutableBranding;
exports.copyCodexIconToOutput = copyCodexIconToOutput;
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
async function downloadFile(url, outputPath) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed (${response.status}) for ${url}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    await Promise.resolve().then(() => __importStar(require("node:fs/promises"))).then((fsp) => fsp.writeFile(outputPath, data));
}
function normalizeVersion(value) {
    const input = (value || "").trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(input))
        return input;
    if (/^\d+\.\d+\.\d+$/.test(input))
        return `${input}.0`;
    if (/^\d+\.\d+$/.test(input))
        return `${input}.0.0`;
    if (/^\d+$/.test(input))
        return `${input}.0.0.0`;
    return "1.0.0.0";
}
function resolveBundledRcedit(workDir) {
    const rceditDir = (0, exec_1.ensureDir)(path.join(workDir, "tools", "rcedit"));
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return path.join(rceditDir, `rcedit-${arch}.exe`);
}
async function ensureRcedit(workDir) {
    const envOverride = process.env.CODEX_RCEDIT_PATH;
    if (envOverride && (0, exec_1.fileExists)(envOverride))
        return path.resolve(envOverride);
    const pathResolved = (0, exec_1.resolveCommand)("rcedit.exe") ?? (0, exec_1.resolveCommand)("rcedit");
    if (pathResolved)
        return pathResolved;
    const bundled = resolveBundledRcedit(workDir);
    if ((0, exec_1.fileExists)(bundled))
        return bundled;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const url = `https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-${arch}.exe`;
    await downloadFile(url, bundled);
    if (!(0, exec_1.fileExists)(bundled)) {
        throw new Error(`rcedit download failed: ${bundled}`);
    }
    return bundled;
}
function resolveDefaultCodexIconPath() {
    if (process.env.CODEX_ICON_PATH && (0, exec_1.fileExists)(process.env.CODEX_ICON_PATH)) {
        return path.resolve(process.env.CODEX_ICON_PATH);
    }
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const candidates = [
        path.join(repoRoot, "icons", "codex.ico"),
        path.join(repoRoot, "reference", "Codex-Windows-main-3", "icons", "codex.ico"),
        path.join(repoRoot, "reference", "Codex-Windows-main-2", "codexd-launcher", "codex.ico"),
    ];
    for (const candidate of candidates) {
        if ((0, exec_1.fileExists)(candidate))
            return candidate;
    }
    return "";
}
async function applyExecutableBranding(executablePath, options) {
    if (!(0, exec_1.fileExists)(executablePath))
        return false;
    const iconPath = options.iconPath && (0, exec_1.fileExists)(options.iconPath) ? options.iconPath : "";
    const appVersion = normalizeVersion(options.appVersion);
    const rcedit = await ensureRcedit(options.workDir);
    const fileName = path.basename(executablePath);
    const args = [
        executablePath,
        "--set-version-string",
        "ProductName",
        options.productName,
        "--set-version-string",
        "FileDescription",
        options.fileDescription,
        "--set-version-string",
        "InternalName",
        options.productName,
        "--set-version-string",
        "OriginalFilename",
        fileName,
        "--set-version-string",
        "CompanyName",
        "OpenAI",
        "--set-file-version",
        appVersion,
        "--set-product-version",
        appVersion,
    ];
    if (iconPath) {
        args.push("--set-icon", iconPath);
    }
    const result = (0, exec_1.runCommand)(rcedit, args, {
        allowNonZero: true,
        capture: true,
    });
    if (result.status !== 0) {
        const output = (result.stderr || result.stdout || "").trim();
        (0, exec_1.writeWarn)(`rcedit branding failed (exit=${result.status}) for ${executablePath}${output ? ` :: ${output}` : ""}`);
        return false;
    }
    return true;
}
function copyCodexIconToOutput(iconPath, outputDir) {
    if (!iconPath || !(0, exec_1.fileExists)(iconPath))
        return "";
    const destination = path.join(outputDir, "codex.ico");
    (0, exec_1.copyFileSafe)(iconPath, destination);
    return destination;
}
