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
exports.invokeSingleExeBuild = invokeSingleExeBuild;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const extract_1 = require("./extract");
function resolveSfxModule(sevenZipExe) {
    const candidates = [];
    const exeDir = path.dirname(sevenZipExe);
    candidates.push(path.join(exeDir, "7z.sfx"));
    candidates.push(path.join(exeDir, "7zCon.sfx"));
    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, "7-Zip", "7z.sfx"));
        candidates.push(path.join(process.env.ProgramFiles, "7-Zip", "7zCon.sfx"));
    }
    if (process.env["ProgramFiles(x86)"]) {
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "7-Zip", "7z.sfx"));
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "7-Zip", "7zCon.sfx"));
    }
    const scoopMarker = `${path.sep}scoop${path.sep}shims${path.sep}`;
    const normalizedExe = path.normalize(sevenZipExe).toLowerCase();
    const scoopIndex = normalizedExe.indexOf(scoopMarker);
    if (scoopIndex >= 0) {
        const root = sevenZipExe.slice(0, scoopIndex);
        candidates.push(path.join(root, "scoop", "apps", "7zip", "current", "7z.sfx"));
        candidates.push(path.join(root, "scoop", "apps", "7zip", "current", "7zCon.sfx"));
    }
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate))
            return path.resolve(candidate);
    }
    return null;
}
function buildSfxConfigFile(tempDir) {
    const configPath = path.join(tempDir, "sfx-config.txt");
    const config = [
        ";!@Install@!UTF-8!",
        'Title="Codex Windows Portable"',
        'RunProgram="Launch-Codex.cmd"',
        'GUIMode="2"',
        ";!@InstallEnd@!",
        "",
    ].join("\n");
    fs.writeFileSync(configPath, config, "utf8");
    return configPath;
}
function invokeSingleExeBuild(portableDir, distDir, workDir) {
    const sevenZipExe = (0, extract_1.resolve7z)(workDir);
    const sfxModule = resolveSfxModule(sevenZipExe);
    if (!sfxModule) {
        throw new Error(`7z SFX module was not found near [${sevenZipExe}]. Install full 7-Zip distribution with 7z.sfx to build single EXE.`);
    }
    const outputBaseName = path.basename(portableDir);
    const outputExe = path.join(distDir, `${outputBaseName}-single.exe`);
    const tempDir = path.join(workDir, "sfx-build", outputBaseName);
    const archivePath = path.join(tempDir, "payload.7z");
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    (0, exec_1.writeInfo)("Compressing portable payload for SFX...");
    const archiveResult = (0, exec_1.runCommand)(sevenZipExe, ["a", "-t7z", "-mx=9", "-mmt=on", archivePath, "*"], { cwd: portableDir, allowNonZero: true, capture: true });
    if (archiveResult.status !== 0 || !fs.existsSync(archivePath)) {
        throw new Error(`7z archive creation failed (exit=${archiveResult.status}).\n${archiveResult.stderr || archiveResult.stdout}`);
    }
    const configPath = buildSfxConfigFile(tempDir);
    const sfxData = fs.readFileSync(sfxModule);
    const configData = fs.readFileSync(configPath);
    const archiveData = fs.readFileSync(archivePath);
    fs.writeFileSync(outputExe, Buffer.concat([sfxData, configData, archiveData]));
    if (!fs.existsSync(outputExe)) {
        throw new Error(`Failed to create single EXE at [${outputExe}]`);
    }
    return { outputExe };
}
