"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROFILE_NAME = void 0;
exports.parseArgs = parseArgs;
exports.printUsage = printUsage;
exports.normalizeProfileName = normalizeProfileName;
exports.isLiteProfileName = isLiteProfileName;
exports.isForgeProfileName = isForgeProfileName;
exports.isCanonicalProfileName = isCanonicalProfileName;
exports.DEFAULT_PROFILE_NAME = "lite";
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
    process.stdout.write("Usage:\n");
    process.stdout.write("  node scripts/node/run.js run [options]\n");
    process.stdout.write("  node scripts/node/run.js build [options]\n");
    process.stdout.write("  node scripts/node/run.js verify [options]\n");
    process.stdout.write("  node scripts/node/run.js smoke [options]\n");
    process.stdout.write("  node scripts/node/run.js audit [options]\n");
    process.stdout.write("  node scripts/node/run.js contention [options]\n");
    process.stdout.write("\n");
    process.stdout.write("Examples:\n");
    process.stdout.write("  node scripts/node/run.js run -DmgPath .\\Codex.dmg -Reuse\n");
    process.stdout.write("  node scripts/node/run.js build -DmgPath .\\Codex.dmg -Reuse -NoLaunch\n");
    process.stdout.write("  node scripts/node/run.js verify -DmgPath .\\Codex.dmg\n");
    process.stdout.write("  node scripts/node/run.js smoke -DmgPath .\\Codex.dmg -Reuse -SmokeSeconds 25\n");
    process.stdout.write("  node scripts/node/run.js smoke -DmgPath .\\Codex.dmg -Reuse -SmokeAuthStage -SmokeUserDataSeed .\\dist\\Codex-win32-x64\\userdata -SmokeCodexHomeSeed %USERPROFILE%\\.codex\n");
    process.stdout.write("  node scripts/node/run.js audit -CodexHomePath C:\\Users\\<user>\\.codex\n");
    process.stdout.write("  node scripts/node/run.js contention -CodexHomePath C:\\Users\\<user>\\.codex -RuntimeLogsDir .\\dist\\Codex-win32-x64\\runtime-logs\n");
    process.stdout.write("\n");
    process.stdout.write("Options:\n");
    process.stdout.write("  -DmgPath <path>\n");
    process.stdout.write("  -WorkDir <path>\n");
    process.stdout.write("  -DistDir <path>\n");
    process.stdout.write("  -CodexCliPath <path>\n");
    process.stdout.write("  -CodexHomePath <path>\n");
    process.stdout.write("  -RuntimeLogsDir <path>\n");
    process.stdout.write("  -PatchProfile <codex-106x|codex-10711|codex-11012|codex-11413|codex-11414|generic>\n");
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
