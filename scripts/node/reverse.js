"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pipeline_stage_machine_1 = require("./reverse/pipeline-stage-machine");
const exec_1 = require("./lib/exec");
(0, pipeline_stage_machine_1.runReversePipelineCli)()
    .then((code) => {
    process.exit(code);
})
    .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
