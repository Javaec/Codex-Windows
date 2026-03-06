import { probeResolvedCodexCli, resolveCodexCliPathContract, writeCliResolutionTrace } from "../cli";
import { writeSuccess, writeWarn } from "../exec";

export function resolveAndProbeCodexCli(
  codexCliPath: string | undefined,
  requireFound: boolean,
  tracePath: string,
  probeFailurePrefix: string,
  missingWarnMessage?: string,
) {
  const resolution = resolveCodexCliPathContract(codexCliPath, requireFound);
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
