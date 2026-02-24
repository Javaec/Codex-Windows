import * as fs from "node:fs/promises";
import {
  DashboardDecisionItem,
  DecisionDashboardStageInput,
  DecisionDashboardStageOutput,
  RunMetrics,
} from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { OwnershipModel } from "../ir/ownership-model";
import { scoreNameQuality } from "../ir/name-quality";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

interface DashboardPayload {
  runId: string;
  generatedAtIso: string;
  metrics: RunMetrics;
  orchestratorActions: DashboardDecisionItem[];
  externalToolPatches: DashboardDecisionItem[];
  postRenamePass: DashboardDecisionItem[];
}

function pushIf(condition: boolean, sink: DashboardDecisionItem[], item: DashboardDecisionItem): void {
  if (condition) {
    sink.push(item);
  }
}

function buildMarkdown(payload: DashboardPayload): string {
  const lines: string[] = [];
  lines.push(`# Decision Dashboard (${payload.runId})`);
  lines.push("");
  lines.push(`Generated: ${payload.generatedAtIso}`);
  lines.push("");
  lines.push("## Baseline Metrics");
  lines.push("");
  lines.push(`- mappedFiles: ${payload.metrics.mappedFiles}`);
  lines.push(`- mappedSymbols: ${payload.metrics.mappedSymbols}`);
  lines.push(`- nameQuality: ${payload.metrics.nameQuality}`);
  lines.push(`- buildHealth: ${payload.metrics.buildHealth}`);
  lines.push(`- devHealth: ${payload.metrics.devHealth}`);
  lines.push(`- genericPathNoiseCount: ${payload.metrics.genericPathNoiseCount}`);
  lines.push(`- lowQualitySymbolCount: ${payload.metrics.lowQualitySymbolCount}`);
  lines.push("");

  lines.push("## Orchestrator Actions");
  lines.push("");
  if (payload.orchestratorActions.length === 0) {
    lines.push("- none");
  } else {
    for (const item of payload.orchestratorActions) {
      lines.push(`- [${item.priority}] ${item.title}: ${item.reason}`);
    }
  }
  lines.push("");

  lines.push("## External Tool Patches");
  lines.push("");
  if (payload.externalToolPatches.length === 0) {
    lines.push("- none");
  } else {
    for (const item of payload.externalToolPatches) {
      lines.push(`- [${item.priority}] ${item.title}: ${item.reason}`);
    }
  }
  lines.push("");

  lines.push("## Post-Rename Pass");
  lines.push("");
  if (payload.postRenamePass.length === 0) {
    lines.push("- none");
  } else {
    for (const item of payload.postRenamePass) {
      lines.push(`- [${item.priority}] ${item.title}: ${item.reason}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function executeDecisionDashboard(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<DecisionDashboardStageInput>(request.inputPath);
  const metrics = await readJsonFile<RunMetrics>(input.metricsPath);
  const ownershipModel = await readJsonFile<OwnershipModel>(input.ownershipModelPath);

  const orchestratorActions: DashboardDecisionItem[] = [];
  const externalToolPatches: DashboardDecisionItem[] = [];
  const postRenamePass: DashboardDecisionItem[] = [];

  pushIf(metrics.mappedFiles < 4, orchestratorActions, {
    title: "Increase mappedFiles coverage",
    reason: "mappedFiles below target; improve file-hint extraction or ownership resolver heuristics",
    priority: "high",
  });
  pushIf(metrics.nameQuality < 0.62, orchestratorActions, {
    title: "Improve name quality baseline",
    reason: "nameQuality is below target; adjust semantic-ir merge weighting and naming-memory acceptance",
    priority: "high",
  });
  pushIf(!metrics.buildHealth || !metrics.devHealth, orchestratorActions, {
    title: "Fix green gate stability",
    reason: "build/dev health is not consistently green on generated project",
    priority: "high",
  });
  pushIf(metrics.genericPathNoiseCount > 0, orchestratorActions, {
    title: "Tighten path noise guard",
    reason: "generic-path noise detected in generated modules",
    priority: "medium",
  });

  pushIf(input.javascriptDeobfuscator.status === "skipped", externalToolPatches, {
    title: "Patch javascript-deobfuscator parser path",
    reason: `stage skipped: ${input.javascriptDeobfuscator.reason}; use fallback parser mode or pre-transform unsupported syntax`,
    priority: "medium",
  });
  pushIf(input.synchrony.status === "skipped", externalToolPatches, {
    title: "Enable synchrony profile in regression",
    reason: "synchrony is not executed in current run; keep one suite profile with synchrony enabled",
    priority: "low",
  });
  pushIf(input.unwebpackSourcemap.status === "skipped", externalToolPatches, {
    title: "Prepare sourcemap extraction path",
    reason: "unwebpack-sourcemap skipped; run it when source maps appear in extracted bundle",
    priority: "low",
  });

  const lowQualityCandidates = [...ownershipModel.symbols]
    .map((symbol) => ({
      symbol,
      quality: scoreNameQuality(symbol.symbolName),
    }))
    .filter((entry) => entry.quality < 0.56)
    .sort((left, right) => left.quality - right.quality)
    .slice(0, 12);
  for (const candidate of lowQualityCandidates) {
    postRenamePass.push({
      title: `Rename ${candidate.symbol.symbolName}`,
      reason: `low quality=${candidate.quality}; layer=${candidate.symbol.layer}, archetype=${candidate.symbol.archetype}`,
      priority: "medium",
    });
  }

  const payload: DashboardPayload = {
    runId: input.runId,
    generatedAtIso: new Date().toISOString(),
    metrics,
    orchestratorActions,
    externalToolPatches,
    postRenamePass,
  };
  await writeJsonFile(input.outputJsonPath, payload);
  const markdown = buildMarkdown(payload);
  await fs.writeFile(input.outputMarkdownPath, markdown, "utf8");

  const output: DecisionDashboardStageOutput = {
    outputJsonPath: input.outputJsonPath,
    outputMarkdownPath: input.outputMarkdownPath,
    orchestratorActionCount: orchestratorActions.length,
    externalToolActionCount: externalToolPatches.length,
    postRenameActionCount: postRenamePass.length,
  };
  await writeJsonFile(request.outputPath, output);
}

export const decisionDashboardStage: PipelineStage = {
  id: "decision-dashboard",
  execute: executeDecisionDashboard,
};
