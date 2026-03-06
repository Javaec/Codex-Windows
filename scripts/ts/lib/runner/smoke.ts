import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { writeHeader, writeSuccess } from "../exec";
import { runPortableSmoke } from "../runtime-pack/smoke";
import { REPO_ROOT } from "./context";
import { runPipelineDetailed } from "./pipeline";

export async function runSmoke(options: PipelineOptions): Promise<number> {
  writeHeader("Smoke build");
  const smokeWorkDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work", "runner-smoke"));
  const smokeDistDir = path.resolve(options.distDir || path.join(smokeWorkDir, "dist"));

  const pipelineResult = await runPipelineDetailed({
    ...options,
    workDir: smokeWorkDir,
    distDir: smokeDistDir,
    buildPortable: true,
    noLaunch: true,
    buildSingleExe: false,
  });
  if (pipelineResult.exitCode !== 0) {
    return pipelineResult.exitCode;
  }
  if (!pipelineResult.portableOutputDir) {
    throw new Error("Smoke mode requires a portable output directory");
  }

  writeSuccess(`Smoke portable output: ${pipelineResult.portableOutputDir}`);
  const smokeResult = await runPortableSmoke(
    pipelineResult.portableOutputDir,
    options.smokeSeconds,
    options.smokeLanes,
  );
  return smokeResult.success ? 0 : 1;
}
