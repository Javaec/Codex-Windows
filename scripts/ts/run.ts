import { parseArgs, printUsage } from "./lib/args";
import { writeError } from "./lib/exec";
import { runPipeline } from "./lib/runner/pipeline";
import { runSmoke } from "./lib/runner/smoke";
import { runVerify } from "./lib/runner/verify";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }
  if (parsed.mode === "verify") {
    return runVerify(parsed.options);
  }
  if (parsed.mode === "smoke") {
    return runSmoke(parsed.options);
  }
  return runPipeline(parsed.options);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`[ERROR] ${message}`);
    process.exit(1);
  });
