"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const exec_1 = require("./lib/exec");
const paths_1 = require("./lib/forge/paths");
const server_1 = require("./lib/forge/server");
const state_1 = require("./lib/forge/state");
function parseCli(argv) {
    const options = {
        openBrowser: true,
        printState: false,
        port: 4317,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        switch (token.toLowerCase()) {
            case "--no-open":
                options.openBrowser = false;
                break;
            case "--print-state":
                options.printState = true;
                options.openBrowser = false;
                break;
            case "--port": {
                const value = argv[index + 1];
                if (!value)
                    throw new Error("Missing value for --port");
                const port = Number.parseInt(value, 10);
                if (!Number.isFinite(port) || port < 0 || port > 65535) {
                    throw new Error(`Invalid port: ${value}`);
                }
                options.port = port;
                index += 1;
                break;
            }
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
    if (options.printState) {
        process.stdout.write(`${JSON.stringify((0, state_1.getForgeState)(paths, config), null, 2)}\n`);
        return;
    }
    const launcher = await (0, server_1.startForgeLauncherServer)({
        port: options.port,
        openBrowser: options.openBrowser,
        paths,
        config,
    });
    (0, exec_1.writeSuccess)(`Codex Forge launcher ready: ${launcher.url}`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
