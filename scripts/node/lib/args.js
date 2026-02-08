"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
exports.printUsage = printUsage;
exports.normalizeProfileName = normalizeProfileName;
function parseArgs(argv) {
    const defaults = {
        reuse: false,
        noLaunch: false,
        buildPortable: false,
        buildSingleExe: false,
        devProfile: false,
        profileName: "default",
        persistRipgrepPath: false,
        strictContract: false,
    };
    if (argv.length === 0) {
        return { mode: "run", showHelp: true, options: defaults };
    }
    let mode = "run";
    let index = 0;
    const first = argv[0].toLowerCase();
    if (!first.startsWith("-")) {
        if (first === "run" || first === "build") {
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
            case "persistripgreppath":
                options.persistRipgrepPath = true;
                break;
            case "strictcontract":
                options.strictContract = true;
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
    process.stdout.write("\n");
    process.stdout.write("Examples:\n");
    process.stdout.write("  node scripts/node/run.js run -DmgPath .\\Codex.dmg -Reuse\n");
    process.stdout.write("  node scripts/node/run.js build -DmgPath .\\Codex.dmg -Reuse -NoLaunch\n");
    process.stdout.write("\n");
    process.stdout.write("Options:\n");
    process.stdout.write("  -DmgPath <path>\n");
    process.stdout.write("  -WorkDir <path>\n");
    process.stdout.write("  -DistDir <path>\n");
    process.stdout.write("  -CodexCliPath <path>\n");
    process.stdout.write("  -Reuse  -NoLaunch  -BuildPortable  -SingleExe  -DevProfile\n");
    process.stdout.write("  -ProfileName <name>  -PersistRipgrepPath  -StrictContract\n");
}
function normalizeProfileName(profileName) {
    const raw = (profileName || "").trim().toLowerCase();
    if (!raw)
        return "default";
    const sanitized = raw.replace(/[^a-z0-9._-]/g, "-").replace(/^[-._]+|[-._]+$/g, "");
    return sanitized || "default";
}
