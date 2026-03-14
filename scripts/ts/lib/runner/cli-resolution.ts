import * as path from "node:path";
import { probeResolvedCodexCli, resolveCodexCliPathContract, writeCliResolutionTrace } from "../cli";
import { downloadLatestGitHubAlphaCodexCli, isGitHubAlphaCliChannel } from "../github-cli";
import { writeSuccess, writeWarn } from "../exec";

export async function resolveAndProbeCodexCli(
  codexCliPath: string | undefined,
  requireFound: boolean,
  tracePath: string,
  probeFailurePrefix: string,
  missingWarnMessage?: string,
  options?: { workDir?: string; codexCliChannel?: string },
) {
  let effectiveCliPath = codexCliPath;
  let sourceOverride = "";
  if (!effectiveCliPath && isGitHubAlphaCliChannel(options?.codexCliChannel)) {
    const downloaded = await downloadLatestGitHubAlphaCodexCli(options?.workDir || path.dirname(tracePath));
    effectiveCliPath = downloaded.path;
    sourceOverride = downloaded.source;
    writeSuccess(`Using latest GitHub alpha Codex CLI: ${downloaded.tag} (${downloaded.path})`);
  }
  const resolution = resolveCodexCliPathContract(effectiveCliPath, requireFound);
  if (sourceOverride && resolution.found) {
    resolution.source = sourceOverride;
    resolution.trace.unshift(`Resolved GitHub alpha CLI -> [${effectiveCliPath}]`);
  }
  writeCliResolutionTrace(resolution, tracePath);
  if (!resolution.found) {
    if (missingWarnMessage) writeWarn(missingWarnMessage);
    return resolution;
  }
  writeSuccess(`Using Codex CLI: ${resolution.path} (source=${resolution.source})`);
  const probe = probeResolvedCodexCli(resolution);
  if (!probe.ok) throw new Error(`${probeFailurePrefix}: ${probe.details}`);
  return resolution;
}
