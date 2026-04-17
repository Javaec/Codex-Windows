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
exports.DEFAULT_PROFILE_NAME = void 0;
exports.parseArgs = parseArgs;
exports.printUsage = printUsage;
exports.normalizeProfileName = normalizeProfileName;
exports.isLiteProfileName = isLiteProfileName;
exports.isForgeProfileName = isForgeProfileName;
exports.isCanonicalProfileName = isCanonicalProfileName;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
exports.DEFAULT_PROFILE_NAME = "lite";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PATCH_PROFILES_DIR = path.join(REPO_ROOT, "shared", "patch-pack", "profiles");
function comparePatchProfileIds(left, right) {
    const rank = (profileId) => {
        if (profileId === "generic")
            return [2, Number.MAX_SAFE_INTEGER, profileId];
        const numericMatch = profileId.match(/\d+/);
        if (numericMatch)
            return [0, Number.parseInt(numericMatch[0], 10) || 0, profileId];
        return [1, Number.MAX_SAFE_INTEGER, profileId];
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank[0] !== rightRank[0])
        return leftRank[0] - rightRank[0];
    if (leftRank[1] !== rightRank[1])
        return leftRank[1] - rightRank[1];
    return leftRank[2].localeCompare(rightRank[2]);
}
function listPatchProfileIds() {
    if (!fs.existsSync(PATCH_PROFILES_DIR))
        return ["generic"];
    const profileIds = fs.readdirSync(PATCH_PROFILES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5))
        .filter((profileId) => profileId.length > 0);
    if (profileIds.length < 1)
        return ["generic"];
    return [...new Set(profileIds)].sort(comparePatchProfileIds);
}
function parseArgs(argv) {
    const defaults = {
        reuse: false,
        noLaunch: false,
        buildPortable: false,
        buildSingleExe: false,
        devProfile: false,
        profileName: exports.DEFAULT_PROFILE_NAME,
        strictContract: false,
        smokeSeconds: 25,
        smokeAuthStage: false,
    };
    if (argv.length === 0) {
        return { mode: "run", showHelp: true, options: defaults };
    }
    let mode = "run";
    let index = 0;
    const first = argv[0].toLowerCase();
    if (!first.startsWith("-")) {
        if (first === "run" || first === "build" || first === "verify" || first === "smoke" || first === "audit" || first === "contention") {
            mode = first;
            index = 1;
        }
        else if (first === "help") {
            return { mode: "run", showHelp: true, options: defaults };
        }
        else {
            throw new Error(`Unsupported mode: ${argv[0]}`);
        }
    }
    const options = { ...defaults };
    const remaining = argv.slice(index);
    for (let i = 0; i < remaining.length; i += 1) {
        const token = remaining[i];
        const lower = token.toLowerCase();
        if (lower === "-h" || lower === "--help") {
            return { mode, showHelp: true, options };
        }
        if (!lower.startsWith("-")) {
            throw new Error(`Unexpected argument: ${token}`);
        }
        const key = lower.replace(/^-+/, "");
        const readValue = () => {
            const next = remaining[i + 1];
            if (!next || next.startsWith("-")) {
                throw new Error(`Missing value for ${token}`);
            }
            i += 1;
            return next;
        };
        switch (key) {
            case "dmgpath":
                options.dmgPath = readValue();
                break;
            case "workdir":
                options.workDir = readValue();
                break;
            case "distdir":
                options.distDir = readValue();
                break;
            case "codexclipath":
                options.codexCliPath = readValue();
                break;
            case "codexclichannel":
                options.codexCliChannel = readValue();
                break;
            case "codexhomepath":
                options.codexHomePath = readValue();
                break;
            case "patchprofile":
                options.patchProfile = readValue();
                break;
            case "profilename":
                options.profileName = readValue();
                break;
            case "reuse":
                options.reuse = true;
                break;
            case "nolaunch":
                options.noLaunch = true;
                break;
            case "buildportable":
                options.buildPortable = true;
                break;
            case "singleexe":
                options.buildSingleExe = true;
                break;
            case "devprofile":
                options.devProfile = true;
                break;
            case "strictcontract":
                options.strictContract = true;
                break;
            case "smokeseconds":
                options.smokeSeconds = Number.parseInt(readValue(), 10);
                if (!Number.isFinite(options.smokeSeconds) || options.smokeSeconds <= 0) {
                    throw new Error(`Invalid smoke seconds: ${options.smokeSeconds}`);
                }
                break;
            case "smokelanes":
                options.smokeLanes = readValue();
                break;
            case "smokeauthstage":
                options.smokeAuthStage = true;
                break;
            case "smokeauthlanes":
                options.smokeAuthLanes = readValue();
                break;
            case "smokeuserdataseed":
                options.smokeUserDataSeedPath = readValue();
                break;
            case "smokecodexhomeseed":
                options.smokeCodexHomeSeedPath = readValue();
                break;
            case "runtimelogsdir":
                options.runtimeLogsDir = readValue();
                break;
            default:
                throw new Error(`Unknown option: ${token}`);
        }
    }
    if (mode === "build") {
        options.buildPortable = true;
    }
    return { mode, showHelp: false, options };
}
function printUsage() {
    const patchProfiles = listPatchProfileIds().join("|");
    process.stdout.write("Usage:\n");
    process.stdout.write("  node Setup-Codex/node/run.js run [options]\n");
    process.stdout.write("  node Setup-Codex/node/run.js build [options]\n");
    process.stdout.write("  node Setup-Codex/node/run.js verify [options]\n");
    process.stdout.write("  node Setup-Codex/node/run.js smoke [options]\n");
    process.stdout.write("  node Setup-Codex/node/run.js audit [options]\n");
    process.stdout.write("  node Setup-Codex/node/run.js contention [options]\n");
    process.stdout.write("\n");
    process.stdout.write("Examples:\n");
    process.stdout.write("  node Setup-Codex/node/run.js run -DmgPath .\\Codex.dmg -Reuse\n");
    process.stdout.write("  node Setup-Codex/node/run.js build -DmgPath .\\Codex.dmg -Reuse -NoLaunch\n");
    process.stdout.write("  node Setup-Codex/node/run.js verify -DmgPath .\\Codex.dmg\n");
    process.stdout.write("  node Setup-Codex/node/run.js smoke -DmgPath .\\Codex.dmg -Reuse -SmokeSeconds 25\n");
    process.stdout.write("  node Setup-Codex/node/run.js smoke -DmgPath .\\Codex.dmg -Reuse -SmokeAuthStage -SmokeUserDataSeed .\\dist\\Codex-win32-x64\\userdata -SmokeCodexHomeSeed %USERPROFILE%\\.codex\n");
    process.stdout.write("  node Setup-Codex/node/run.js audit -CodexHomePath C:\\Users\\<user>\\.codex\n");
    process.stdout.write("  node Setup-Codex/node/run.js contention -CodexHomePath C:\\Users\\<user>\\.codex -RuntimeLogsDir .\\dist\\Codex-win32-x64\\runtime-logs\n");
    process.stdout.write("\n");
    process.stdout.write("Options:\n");
    process.stdout.write("  -DmgPath <path>\n");
    process.stdout.write("  -WorkDir <path>\n");
    process.stdout.write("  -DistDir <path>\n");
    process.stdout.write("  -CodexCliPath <path>\n");
    process.stdout.write("  -CodexCliChannel <alpha>\n");
    process.stdout.write("  -CodexHomePath <path>\n");
    process.stdout.write("  -RuntimeLogsDir <path>\n");
    process.stdout.write(`  -PatchProfile <${patchProfiles}>\n`);
    process.stdout.write("  -Reuse  -NoLaunch  -BuildPortable  -SingleExe  -DevProfile\n");
    process.stdout.write("  -ProfileName <lite|forge|dev>  -StrictContract\n");
    process.stdout.write("  -SmokeSeconds <n>  -SmokeLanes <comma-separated>  -SmokeAuthStage\n");
    process.stdout.write("  -SmokeAuthLanes <comma-separated>\n");
    process.stdout.write("  -SmokeUserDataSeed <path>  -SmokeCodexHomeSeed <path>\n");
}
function normalizeProfileName(profileName) {
    const raw = (profileName || "").trim().toLowerCase();
    if (!raw)
        return exports.DEFAULT_PROFILE_NAME;
    const sanitized = raw.replace(/[^a-z0-9._-]/g, "-").replace(/^[-._]+|[-._]+$/g, "");
    if (!sanitized)
        return exports.DEFAULT_PROFILE_NAME;
    if (sanitized === "default" ||
        sanitized === "lite" ||
        sanitized === "repack" ||
        sanitized === "codex-lite" ||
        sanitized === "codex-repack" ||
        sanitized === "no-mods" ||
        sanitized === "nomods") {
        return "lite";
    }
    if (sanitized === "forge" || sanitized === "mods" || sanitized === "modded" || sanitized === "with-mods") {
        return "forge";
    }
    return sanitized;
}
function isLiteProfileName(profileName) {
    return normalizeProfileName(profileName) === "lite";
}
function isForgeProfileName(profileName) {
    return normalizeProfileName(profileName) === "forge";
}
function isCanonicalProfileName(profileName) {
    return isLiteProfileName(profileName);
}
