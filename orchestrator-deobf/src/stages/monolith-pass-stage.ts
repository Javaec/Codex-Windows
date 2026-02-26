import { MonolithPassStageInput, MonolithPassStageOutput } from "../contracts";
import { MonolithLayoutHintEntry, MonolithLayoutHintsModel, MonolithSemanticBucket } from "../ir/monolith-layout";
import { hashFileSha256 } from "../utils/hash";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageCachePlan, StageExecutionRequest } from "./stage-runner";

interface SymbolTableEntry {
  symbolKey: string;
  finalName: string;
  semanticBucket: MonolithSemanticBucket;
  signalScore: number;
  promoteToQuality: boolean;
}

interface SymbolTableModel {
  sourceJsPath: string;
  entries: SymbolTableEntry[];
}

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function canonicalToken(value: string): string {
  return value.toLowerCase();
}

function splitNameTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
}

function bucketFallbackToken(bucket: MonolithSemanticBucket): string {
  if (bucket === "parse") {
    return "parser";
  }
  if (bucket === "sum") {
    return "math";
  }
  if (bucket === "state") {
    return "state";
  }
  return "flow";
}

function sanitizeTopicToken(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (normalized.length < 3) {
    return fallback;
  }
  return normalized;
}

function deriveTopicTokens(finalName: string, bucket: MonolithSemanticBucket): string[] {
  const rawTokens = splitNameTokens(finalName);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of rawTokens) {
    const canonical = canonicalToken(token);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    deduped.push(token);
    if (deduped.length >= 2) {
      break;
    }
  }
  if (deduped.length > 0) {
    return deduped.map((token) => sanitizeTopicToken(token, bucketFallbackToken(bucket)));
  }
  return [bucketFallbackToken(bucket)];
}

function buildLayoutEntries(entries: SymbolTableEntry[]): MonolithLayoutHintEntry[] {
  return [...entries]
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey))
    .map((entry) => {
      const topicTokens = deriveTopicTokens(entry.finalName, entry.semanticBucket);
      const topic = sanitizeTopicToken(topicTokens.join("-"), bucketFallbackToken(entry.semanticBucket));
      return {
        symbolKey: entry.symbolKey,
        finalName: entry.finalName,
        semanticBucket: entry.semanticBucket,
        signalScore: clamp(entry.signalScore),
        promoteToQuality: entry.promoteToQuality,
        topic,
        topicTokens,
      };
    });
}

async function executeMonolithPass(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<MonolithPassStageInput>(request.inputPath);
  const symbolTable = await readJsonFile<SymbolTableModel>(input.symbolTablePath);
  const entries = buildLayoutEntries(symbolTable.entries);
  const layoutHints: MonolithLayoutHintsModel = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    lineageId: input.lineageId,
    sourceJsPath: input.sourceJsPath,
    pass2MonolithPath: input.pass2MonolithPath,
    entries,
  };
  await writeJsonFile(input.outputFilePath, layoutHints);

  let parseCount = 0;
  let sumCount = 0;
  let stateCount = 0;
  let orchestrateCount = 0;
  for (const entry of entries) {
    if (entry.semanticBucket === "parse") {
      parseCount += 1;
      continue;
    }
    if (entry.semanticBucket === "sum") {
      sumCount += 1;
      continue;
    }
    if (entry.semanticBucket === "state") {
      stateCount += 1;
      continue;
    }
    orchestrateCount += 1;
  }

  const output: MonolithPassStageOutput = {
    outputFilePath: input.outputFilePath,
    entryCount: entries.length,
    parseCount,
    sumCount,
    stateCount,
    orchestrateCount,
  };
  await writeJsonFile(request.outputPath, output);
}

export const monolithPassStage: PipelineStage = {
  id: "monolith-pass",
  execute: executeMonolithPass,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as MonolithPassStageInput;
      const digest = await hashFileSha256(input.symbolTablePath);
      return JSON.stringify({
        symbolTableSha256: digest.sha256,
        symbolTableBytes: digest.bytes,
        lineageId: input.lineageId,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as MonolithPassStageInput;
      return [{ kind: "file", path: input.outputFilePath }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<MonolithPassStageOutput> => {
      const input = inputUnknown as MonolithPassStageInput;
      const layoutHints = await readJsonFile<MonolithLayoutHintsModel>(input.outputFilePath);
      let parseCount = 0;
      let sumCount = 0;
      let stateCount = 0;
      let orchestrateCount = 0;
      for (const entry of layoutHints.entries) {
        if (entry.semanticBucket === "parse") {
          parseCount += 1;
          continue;
        }
        if (entry.semanticBucket === "sum") {
          sumCount += 1;
          continue;
        }
        if (entry.semanticBucket === "state") {
          stateCount += 1;
          continue;
        }
        orchestrateCount += 1;
      }
      return {
        outputFilePath: input.outputFilePath,
        entryCount: layoutHints.entries.length,
        parseCount,
        sumCount,
        stateCount,
        orchestrateCount,
      };
    },
  } as StageCachePlan<unknown>,
};

