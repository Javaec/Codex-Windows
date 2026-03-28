"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const args_1 = require("./lib/args");
const exec_1 = require("./lib/exec");
const shared_home_audit_1 = require("./lib/runner/shared-home-audit");
const shared_home_contention_1 = require("./lib/runner/shared-home-contention");
const pipeline_1 = require("./lib/runner/pipeline");
const smoke_1 = require("./lib/runner/smoke");
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
    if (parsed.mode === "smoke") {
        return (0, smoke_1.runSmoke)(parsed.options);
    }
    if (parsed.mode === "audit") {
        return (0, shared_home_audit_1.runSharedHomeAudit)(parsed.options);
    }
    if (parsed.mode === "contention") {
        return (0, shared_home_contention_1.runSharedHomeContentionReport)(parsed.options);
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
