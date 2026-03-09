"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const exec_1 = require("./lib/exec");
const paths_1 = require("./lib/forge/paths");
const runtime_registry_1 = require("./lib/forge/runtime-registry");
const runtime_sync_1 = require("./lib/forge/runtime-sync");
function usage() {
    throw new Error("Usage: forge-runtime <list|capture-current|activate <installId>>");
}
async function main() {
    const command = process.argv[2];
    if (!command)
        usage();
    const paths = (0, paths_1.resolveForgePaths)();
    const config = (0, paths_1.ensureForgeWorkspace)(paths);
    switch (String(command).toLowerCase()) {
        case "list": {
            const ensured = (0, runtime_registry_1.ensureForgeRuntimeRegistry)(paths, config);
            process.stdout.write(`${JSON.stringify(ensured.registry, null, 2)}\n`);
            return;
        }
        case "capture-current": {
            const result = (0, runtime_registry_1.captureActiveForgeRuntime)(paths, config);
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
        }
        case "activate": {
            const installId = process.argv[3];
            if (!installId)
                usage();
            const result = (0, runtime_registry_1.activateForgeRuntimeInstall)(paths, config, installId);
            const syncResult = (0, runtime_sync_1.syncForgeRuntimeLayer)(paths, result.config);
            process.stdout.write(`${JSON.stringify({ result, syncResult }, null, 2)}\n`);
            return;
        }
        default:
            usage();
    }
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
