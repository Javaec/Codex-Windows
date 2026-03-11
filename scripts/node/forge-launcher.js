"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const exec_1 = require("./lib/exec");
const paths_1 = require("./lib/forge/paths");
const state_1 = require("./lib/forge/state");
function parseCli(argv) {
    const options = {
        printState: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        switch (token.toLowerCase()) {
            case "--print-state":
                options.printState = true;
                break;
            default:
                throw new Error(`Unknown Codex Forge option: ${token}`);
        }
    }
    return options;
}
async function main() {
    const options = parseCli(process.argv.slice(2));
    const paths = (0, paths_1.resolveForgePaths)();
    const config = (0, paths_1.ensureForgeWorkspace)(paths);
    if (!options.printState) {
        throw new Error("Codex Forge browser launcher was removed. Use codex-forge\\tools\\Launch-Codex-Forge.cmd or npm run forge:electron.");
    }
    process.stdout.write(`${JSON.stringify((0, state_1.getForgeState)(paths, config), null, 2)}\n`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
