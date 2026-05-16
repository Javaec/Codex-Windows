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
const exec_1 = require("../exec");
const asar_1 = require("../asar");
const manifest_1 = require("../manifest");
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
    if (process.env.USERPROFILE) {
        const scoop = path.join(process.env.USERPROFILE, "scoop", "shims", "7z.exe");
        if ((0, exec_1.fileExists)(scoop))
            return scoop;
    }
    if (process.env.LOCALAPPDATA) {
        const winget = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "7z.exe");
        if ((0, exec_1.fileExists)(winget))
            return winget;
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
    const extractCurrent = (0, manifest_1.testManifestStepCurrent)(manifest, "extract", extractSignature);
    const canReuse = reuse && (0, exec_1.fileExists)(appPackage) && (extractCurrent || allowFallbackReuse);
    if (canReuse) {
        if (extractCurrent)
            (0, exec_1.writeSuccess)("Extraction cache hit: DMG signature unchanged. Reusing app payload.");
        else
            (0, exec_1.writeInfo)("Extraction reuse fallback applied from legacy manifest state.");
        return { sevenZip, extractedDir, electronDir, appDir, performed: false };
    }
    (0, exec_1.writeHeader)("Extracting DMG");
    for (const dir of [extractedDir, electronDir, appDir]) {
        (0, exec_1.removePath)(dir);
        (0, exec_1.ensureDir)(dir);
    }
    const dmgExtract = (0, exec_1.runCommand)(sevenZip, ["x", "-y", dmgPath, `-o${extractedDir}`], {
        capture: true,
        allowNonZero: true,
    });
    (0, exec_1.writeHeader)("Extracting app.asar");
    const diskImage = [path.join(extractedDir, "4.hfs"), path.join(extractedDir, "4.apfs")].find(exec_1.fileExists);
    const appResourceRoots = [
        path.join("Codex Installer", "Codex.app", "Contents", "Resources"),
        path.join("Codex.app", "Contents", "Resources"),
    ];
    const directResourceRoot = appResourceRoots.find((root) => (0, exec_1.fileExists)(path.join(extractedDir, root, "app.asar")));
    const directApp = directResourceRoot ? path.join(extractedDir, directResourceRoot, "app.asar") : "";
    if (!diskImage && !directApp) {
        throw new Error(`DMG extraction did not produce expected payload (4.hfs/4.apfs/app.asar). 7z exit=${dmgExtract.status}\n${dmgExtract.stderr || dmgExtract.stdout}`);
    }
    if (dmgExtract.status !== 0) {
        (0, exec_1.writeInfo)(`7z returned exit=${dmgExtract.status} while extracting DMG; required files are present, continuing.`);
    }
    if (diskImage) {
        const archiveResourceRoot = appResourceRoots.find((root) => {
            const probe = (0, exec_1.runCommand)(sevenZip, ["l", diskImage, path.join(root, "app.asar")], {
                capture: true,
                allowNonZero: true,
            });
            return probe.status === 0 && probe.stdout.includes("app.asar");
        });
        if (!archiveResourceRoot) {
            throw new Error(`Failed to locate app.asar inside extracted disk image: ${diskImage}`);
        }
        const imageExtract = (0, exec_1.runCommand)(sevenZip, [
            "x",
            "-y",
            diskImage,
            path.join(archiveResourceRoot, "app.asar"),
            path.join(archiveResourceRoot, "app.asar.unpacked"),
            `-o${electronDir}`,
        ], { capture: true, allowNonZero: true });
        const extractedAsar = path.join(electronDir, archiveResourceRoot, "app.asar");
        if (!(0, exec_1.fileExists)(extractedAsar)) {
            throw new Error(`Failed to extract app.asar from disk image (7z exit=${imageExtract.status}).\n${imageExtract.stderr || imageExtract.stdout}`);
        }
        if (imageExtract.status !== 0) {
            (0, exec_1.writeInfo)(`7z returned exit=${imageExtract.status} on disk image extraction; app.asar was extracted, continuing.`);
        }
    }
    else {
        if (!(0, exec_1.fileExists)(directApp))
            throw new Error("app.asar not found.");
        const directUnpacked = path.join(extractedDir, directResourceRoot, "app.asar.unpacked");
        const destBase = path.join(electronDir, directResourceRoot);
        (0, exec_1.ensureDir)(destBase);
        (0, exec_1.copyFileSafe)(directApp, path.join(destBase, "app.asar"));
        if ((0, exec_1.fileExists)(directUnpacked)) {
            (0, exec_1.copyDirectory)(directUnpacked, path.join(destBase, "app.asar.unpacked"));
        }
    }
    (0, exec_1.writeHeader)("Unpacking app.asar");
    const extractedResourceRoot = appResourceRoots.find((root) => (0, exec_1.fileExists)(path.join(electronDir, root, "app.asar")));
    if (!extractedResourceRoot)
        throw new Error("Extracted app.asar not found.");
    const resourcesDir = path.join(electronDir, extractedResourceRoot);
    const asarSource = path.join(resourcesDir, "app.asar");
    if (!(0, exec_1.fileExists)(asarSource))
        throw new Error("app.asar not found.");
    let asar = asarSource;
    const resourcesAlias = path.join(workDir, "_resources");
    try {
        (0, exec_1.removePath)(resourcesAlias);
        fs.symlinkSync(resourcesDir, resourcesAlias, "junction");
        asar = path.join(resourcesAlias, "app.asar");
    }
    catch {
        // Fallback for environments where junction creation is blocked.
        asar = path.join(workDir, "input-app.asar");
        (0, exec_1.copyFileSafe)(asarSource, asar);
        const unpackedSource = path.join(resourcesDir, "app.asar.unpacked");
        if ((0, exec_1.fileExists)(unpackedSource)) {
            (0, exec_1.copyDirectory)(unpackedSource, `${asar}.unpacked`);
        }
    }
    (0, asar_1.extractAsarArchive)(asar, appDir);
    (0, exec_1.writeSuccess)("app.asar unpacked via native Node extractor.");
    (0, exec_1.writeHeader)("Syncing app.asar.unpacked");
    const unpacked = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar.unpacked");
    if ((0, exec_1.fileExists)(unpacked)) {
        (0, exec_1.copyDirectory)(unpacked, appDir);
    }
    (0, manifest_1.setManifestStepState)(manifest, "extract", extractSignature, "ok", { dmgPath });
    (0, manifest_1.writeStateManifest)(manifestPath, manifest);
    return { sevenZip, extractedDir, electronDir, appDir, performed: true };
}
