import { runReversePipelineCli } from "./reverse/pipeline-stage-machine";
import { writeError } from "./lib/exec";

runReversePipelineCli()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`[ERROR] ${message}`);
    process.exit(1);
  });
