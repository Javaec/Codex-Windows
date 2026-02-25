import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MonolithCensusStageInput, MonolithCensusStageOutput } from "../contracts";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

interface RenameOccurrence {
  start: number;
  end: number;
  originalName: string;
  replacementName: string;
  kind: "class" | "function" | "callable-variable";
}

interface CensusSeedEntry {
  symbolKey: string;
  owner: string;
  anchor: string;
  kind: "class" | "function" | "callable-variable";
  originalName: string;
  censusName: string;
}

interface VariableCoverageEntry {
  variableKey: string;
  originalName: string;
  censusName: string;
}

interface MonolithCensusMapping {
  version: number;
  generatedAtIso: string;
  sourceJsPath: string;
  lineageId: string;
  seedEntries: CensusSeedEntry[];
  variableCoverage: VariableCoverageEntry[];
}

const CLASS_REGEX = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
const FUNCTION_REGEX = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
const CALLABLE_VARIABLE_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/g;
const VARIABLE_COVERAGE_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

function pad(value: number): string {
  return String(value).padStart(6, "0");
}

function collectRenames(source: string): RenameOccurrence[] {
  const classes = [...source.matchAll(CLASS_REGEX)].map((match, index) => {
    const originalName = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("collectRenames: invalid class match");
    }
    const localIndex = fullMatch.indexOf(originalName);
    if (localIndex < 0) {
      throw new Error("collectRenames: class name offset missing");
    }
    const start = matchIndex + localIndex;
    return {
      start,
      end: start + originalName.length,
      originalName,
      replacementName: `classUnit${pad(index + 1)}`,
      kind: "class" as const,
    };
  });

  const functions = [...source.matchAll(FUNCTION_REGEX)].map((match, index) => {
    const originalName = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("collectRenames: invalid function match");
    }
    const localIndex = fullMatch.indexOf(originalName);
    if (localIndex < 0) {
      throw new Error("collectRenames: function name offset missing");
    }
    const start = matchIndex + localIndex;
    return {
      start,
      end: start + originalName.length,
      originalName,
      replacementName: `functionUnit${pad(index + 1)}`,
      kind: "function" as const,
    };
  });

  const callableVariables = [...source.matchAll(CALLABLE_VARIABLE_REGEX)].map((match, index) => {
    const originalName = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("collectRenames: invalid callable variable match");
    }
    const localIndex = fullMatch.indexOf(originalName);
    if (localIndex < 0) {
      throw new Error("collectRenames: callable variable name offset missing");
    }
    const start = matchIndex + localIndex;
    return {
      start,
      end: start + originalName.length,
      originalName,
      replacementName: `callableUnit${pad(index + 1)}`,
      kind: "callable-variable" as const,
    };
  });

  return [...classes, ...functions, ...callableVariables].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.end - right.end;
  });
}

function assertNoOverlaps(renames: RenameOccurrence[]): void {
  for (let index = 1; index < renames.length; index += 1) {
    const previous = renames[index - 1];
    const current = renames[index];
    if (!previous || !current) {
      continue;
    }
    if (current.start < previous.end) {
      throw new Error(`collectRenames: overlap detected between ${previous.kind} and ${current.kind}`);
    }
  }
}

function applyRenames(source: string, renames: RenameOccurrence[]): string {
  const sorted = [...renames].sort((left, right) => right.start - left.start);
  let output = source;
  for (const rename of sorted) {
    output = `${output.slice(0, rename.start)}${rename.replacementName}${output.slice(rename.end)}`;
  }
  return output;
}

function buildSeedEntries(lineageId: string, renames: RenameOccurrence[]): CensusSeedEntry[] {
  const classes = renames.filter((entry) => entry.kind === "class");
  const functions = renames.filter((entry) => entry.kind === "function");
  const callableVariables = renames.filter((entry) => entry.kind === "callable-variable");
  const ordered = [...classes, ...functions, ...callableVariables];
  return ordered.map((entry, index) => {
    const anchor = `symbol:${index}`;
    return {
      symbolKey: `${lineageId}:${anchor}`,
      owner: lineageId,
      anchor,
      kind: entry.kind,
      originalName: entry.originalName,
      censusName: entry.replacementName,
    };
  });
}

function buildVariableCoverage(source: string): VariableCoverageEntry[] {
  return [...source.matchAll(VARIABLE_COVERAGE_REGEX)].map((match, index) => {
    const originalName = match[1];
    if (!originalName) {
      throw new Error("buildVariableCoverage: invalid variable match");
    }
    return {
      variableKey: `var:${index}`,
      originalName,
      censusName: `valueUnit${pad(index + 1)}`,
    };
  });
}

async function executeMonolithCensus(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<MonolithCensusStageInput>(request.inputPath);
  const source = await fs.readFile(input.sourceJsPath, "utf8");
  const renames = collectRenames(source);
  assertNoOverlaps(renames);
  const censusSource = applyRenames(source, renames);

  const seedEntries = buildSeedEntries(input.lineageId, renames);
  const variableCoverage = buildVariableCoverage(source);

  const mapping: MonolithCensusMapping = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    sourceJsPath: input.sourceJsPath,
    lineageId: input.lineageId,
    seedEntries,
    variableCoverage,
  };

  await ensureDirectory(input.outputDirectory);
  const censusJsPath = path.join(input.outputDirectory, "monolith-census.js");
  const mappingPath = path.join(input.outputDirectory, "census-mapping.json");
  await fs.writeFile(censusJsPath, censusSource, "utf8");
  await writeJsonFile(mappingPath, mapping);

  const output: MonolithCensusStageOutput = {
    outputDirectory: input.outputDirectory,
    censusJsPath,
    mappingPath,
    sourceJsPath: input.sourceJsPath,
    lineageId: input.lineageId,
    classCount: renames.filter((entry) => entry.kind === "class").length,
    functionCount: renames.filter((entry) => entry.kind === "function").length,
    callableVariableCount: renames.filter((entry) => entry.kind === "callable-variable").length,
    variableCoverageCount: variableCoverage.length,
    renamedDeclarationCount: renames.length,
  };
  await writeJsonFile(request.outputPath, output);
}

export const monolithCensusStage: PipelineStage = {
  id: "monolith-census",
  execute: executeMonolithCensus,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as MonolithCensusStageInput;
      const digest = await hashFileSha256(input.sourceJsPath);
      return JSON.stringify({
        sourceSha256: digest.sha256,
        sourceBytes: digest.bytes,
        lineageId: input.lineageId,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as MonolithCensusStageInput;
      return [{ kind: "directory", path: input.outputDirectory }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<MonolithCensusStageOutput> => {
      const input = inputUnknown as MonolithCensusStageInput;
      const mappingPath = path.join(input.outputDirectory, "census-mapping.json");
      const censusJsPath = path.join(input.outputDirectory, "monolith-census.js");
      const mapping = await readJsonFile<MonolithCensusMapping>(mappingPath);
      const classCount = mapping.seedEntries.filter((entry) => entry.kind === "class").length;
      const functionCount = mapping.seedEntries.filter((entry) => entry.kind === "function").length;
      const callableVariableCount = mapping.seedEntries.filter((entry) => entry.kind === "callable-variable").length;
      return {
        outputDirectory: input.outputDirectory,
        censusJsPath,
        mappingPath,
        sourceJsPath: input.sourceJsPath,
        lineageId: input.lineageId,
        classCount,
        functionCount,
        callableVariableCount,
        variableCoverageCount: mapping.variableCoverage.length,
        renamedDeclarationCount: mapping.seedEntries.length,
      };
    },
  } as StageCachePlan<unknown>,
};
