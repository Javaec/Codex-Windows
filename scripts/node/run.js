"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const args_1 = require("./lib/args");
const exec_1 = require("./lib/exec");
const pipeline_1 = require("./lib/runner/pipeline");
const verify_1 = require("./lib/runner/verify");
async function main() {
    const parsed = (0, args_1.parseArgs)(process.argv.slice(2));
    if (parsed.showHelp) {
        (0, args_1.printUsage)();
        return 0;
    }
    if (parsed.mode === "verify") {
        return (0, verify_1.runVerify)(parsed.options);
    }
    return (0, pipeline_1.runPipeline)(parsed.options);
}
main()
    .then((code) => process.exit(code))
    .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
