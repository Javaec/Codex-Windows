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
exports.resolveDmgPath = resolveDmgPath;
exports.resolve7z = resolve7z;
exports.invokeExtractionStage = invokeExtractionStage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const npm_1 = require("./npm");
const manifest_1 = require("./manifest");
function resolveDmgPath(explicit, repoRoot) {
    if (explicit) {
        const resolved = path.resolve(explicit);
        if (!(0, exec_1.fileExists)(resolved))
            throw new Error(`DMG not found: ${resolved}`);
        return resolved;
    }
    const defaultDmg = path.join(repoRoot, "Codex.dmg");
    if ((0, exec_1.fileExists)(defaultDmg))
        return defaultDmg;
    const candidate = fs.readdirSync(repoRoot).find((entry) => entry.toLowerCase().endsWith(".dmg"));
    if (candidate)
        return path.join(repoRoot, candidate);
    throw new Error(`No DMG found in [${repoRoot}].`);
}
function resolve7z(workDir) {
    const fromPath = (0, exec_1.resolveCommand)("7z.exe") ?? (0, exec_1.resolveCommand)("7z");
    if (fromPath)
        return fromPath;
    if (process.env.ProgramFiles) {
        const p1 = path.join(process.env.ProgramFiles, "7-Zip", "7z.exe");
        if ((0, exec_1.fileExists)(p1))
            return p1;
    }
    if (process.env["ProgramFiles(x86)"]) {
        const p2 = path.join(process.env["ProgramFiles(x86)"], "7-Zip", "7z.exe");
        if ((0, exec_1.fileExists)(p2))
            return p2;
    }
    const winget = (0, exec_1.resolveCommand)("winget.exe") ?? (0, exec_1.resolveCommand)("winget");
    if (winget) {
        (0, exec_1.runCommand)(winget, [
            "install",
            "--id",
            "7zip.7zip",
            "-e",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--silent",
        ], { allowNonZero: true, capture: true });
        const afterInstall = (0, exec_1.resolveCommand)("7z.exe") ?? (0, exec_1.resolveCommand)("7z");
        if (afterInstall)
            return afterInstall;
    }
    const portable = path.join(workDir, "tools", "7zip", "7z.exe");
    if ((0, exec_1.fileExists)(portable))
        return portable;
    throw new Error("7z not found.");
}
function invokeExtractionStage(dmgPath, workDir, reuse, allowFallbackReuse, manifest, manifestPath, extractSignature) {
    const sevenZip = resolve7z(workDir);
    const extractedDir = path.join(workDir, "extracted");
    const electronDir = path.join(workDir, "electron");
    const appDir = path.join(workDir, "app");
    const appPackage = path.join(appDir, "package.json");
    const canReuse = reuse && (0, exec_1.fileExists)(appPackage);
    if (canReuse) {
        (0, exec_1.writeSuccess)("Extraction cache hit: DMG signature unchanged. Reusing app payload.");
        return { sevenZip, extractedDir, electronDir, appDir, performed: false };
    }
    (0, exec_1.writeHeader)("Extracting DMG");
    for (const dir of [extractedDir, electronDir, appDir]) {
        fs.rmSync(dir, { recursive: true, force: true });
        (0, exec_1.ensureDir)(dir);
    }
    const dmgExtract = (0, exec_1.runCommand)(sevenZip, ["x", "-y", dmgPath, `-o${extractedDir}`], {
        capture: true,
        allowNonZero: true,
    });
    (0, exec_1.writeHeader)("Extracting app.asar");
    const hfs = path.join(extractedDir, "4.hfs");
    const directApp = path.join(extractedDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar");
    if (!(0, exec_1.fileExists)(hfs) && !(0, exec_1.fileExists)(directApp)) {
        throw new Error(`DMG extraction did not produce expected payload (4.hfs/app.asar). 7z exit=${dmgExtract.status}\n${dmgExtract.stderr || dmgExtract.stdout}`);
    }
    if (dmgExtract.status !== 0) {
        (0, exec_1.writeWarn)(`7z returned exit=${dmgExtract.status} while extracting DMG; continuing because required files are present.`);
    }
    if ((0, exec_1.fileExists)(hfs)) {
        const hfsExtract = (0, exec_1.runCommand)(sevenZip, [
            "x",
            "-y",
            hfs,
            "Codex Installer/Codex.app/Contents/Resources/app.asar",
            "Codex Installer/Codex.app/Contents/Resources/app.asar.unpacked",
            `-o${electronDir}`,
        ], { capture: true, allowNonZero: true });
        const extractedAsar = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar");
        if (!(0, exec_1.fileExists)(extractedAsar)) {
            throw new Error(`Failed to extract app.asar from HFS (7z exit=${hfsExtract.status}).\n${hfsExtract.stderr || hfsExtract.stdout}`);
        }
        if (hfsExtract.status !== 0) {
            (0, exec_1.writeWarn)(`7z returned exit=${hfsExtract.status} on HFS extraction; continuing.`);
        }
    }
    else {
        if (!(0, exec_1.fileExists)(directApp))
            throw new Error("app.asar not found.");
        const directUnpacked = path.join(extractedDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar.unpacked");
        const destBase = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources");
        (0, exec_1.ensureDir)(destBase);
        fs.copyFileSync(directApp, path.join(destBase, "app.asar"));
        if ((0, exec_1.fileExists)(directUnpacked)) {
            (0, exec_1.runRobocopy)(directUnpacked, path.join(destBase, "app.asar.unpacked"));
        }
    }
    (0, exec_1.writeHeader)("Unpacking app.asar");
    const resourcesDir = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources");
    const asarSource = path.join(resourcesDir, "app.asar");
    if (!(0, exec_1.fileExists)(asarSource))
        throw new Error("app.asar not found.");
    let asar = asarSource;
    const resourcesAlias = path.join(workDir, "_resources");
    try {
        fs.rmSync(resourcesAlias, { recursive: true, force: true });
        fs.symlinkSync(resourcesDir, resourcesAlias, "junction");
        asar = path.join(resourcesAlias, "app.asar");
    }
    catch {
        // Fallback for environments where junction creation is blocked.
        asar = path.join(workDir, "input-app.asar");
        fs.copyFileSync(asarSource, asar);
        const unpackedSource = path.join(resourcesDir, "app.asar.unpacked");
        if ((0, exec_1.fileExists)(unpackedSource)) {
            (0, exec_1.runRobocopy)(unpackedSource, `${asar}.unpacked`);
        }
    }
    const npmResult = (0, npm_1.invokeNpmWithResult)(["exec", "--yes", "--package", "@electron/asar", "--", "asar", "extract", asar, appDir], undefined, false);
    if (npmResult.status !== 0) {
        (0, exec_1.writeWarn)(`npm exec failed (exit=${npmResult.status}). Retrying with npx...`);
        const npxResult = (0, npm_1.invokeNpxWithResult)(["-y", "@electron/asar", "extract", asar, appDir], undefined, false);
        if (npxResult.status !== 0) {
            const globalAsar = (0, exec_1.resolveCommand)("asar.cmd") ?? (0, exec_1.resolveCommand)("asar");
            if (globalAsar) {
                (0, exec_1.writeWarn)(`npx failed (exit=${npxResult.status}). Retrying with global asar...`);
                const asarResult = (0, exec_1.runCommand)(globalAsar, ["extract", asar, appDir], {
                    capture: true,
                    allowNonZero: true,
                });
                if (asarResult.status === 0) {
                    (0, exec_1.writeSuccess)("app.asar unpacked via global asar command.");
                }
                else {
                    const npmDiag = (npmResult.stderr || npmResult.stdout || "").trim();
                    const npxDiag = (npxResult.stderr || npxResult.stdout || "").trim();
                    const asarDiag = (asarResult.stderr || asarResult.stdout || "").trim();
                    throw new Error(`app.asar extraction failed via npm exec (exit=${npmResult.status}), npx (exit=${npxResult.status}), and global asar (exit=${asarResult.status}).` +
                        (npmDiag ? `\n[npm] ${npmDiag}` : "") +
                        (npxDiag ? `\n[npx] ${npxDiag}` : "") +
                        (asarDiag ? `\n[asar] ${asarDiag}` : ""));
                }
            }
            else {
                const npmDiag = (npmResult.stderr || npmResult.stdout || "").trim();
                const npxDiag = (npxResult.stderr || npxResult.stdout || "").trim();
                throw new Error(`app.asar extraction failed via npm exec (exit=${npmResult.status}) and npx (exit=${npxResult.status}).` +
                    (npmDiag ? `\n[npm] ${npmDiag}` : "") +
                    (npxDiag ? `\n[npx] ${npxDiag}` : ""));
            }
        }
        else {
            (0, exec_1.writeSuccess)("app.asar unpacked via npx fallback.");
        }
    }
    (0, exec_1.writeHeader)("Syncing app.asar.unpacked");
    const unpacked = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar.unpacked");
    if ((0, exec_1.fileExists)(unpacked)) {
        (0, exec_1.runRobocopy)(unpacked, appDir);
    }
    (0, manifest_1.setManifestStepState)(manifest, "extract", extractSignature, "ok", { dmgPath });
    (0, manifest_1.writeStateManifest)(manifestPath, manifest);
    return { sevenZip, extractedDir, electronDir, appDir, performed: true };
}
