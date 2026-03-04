import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";

interface ManualRefactorCandidateEntry {
  filePath: string;
  averageScore: number;
  moduleIds?: string[];
}

interface ManualRefactorCandidatesModel {
  candidates?: ManualRefactorCandidateEntry[];
}

export interface ManualHotRescueOptions {
  manualProjectPath: string;
  candidatesPath: string;
  topN: number;
  namespaceImportCap: number;
  longFunctionLineThreshold: number;
  outputPath: string;
}

interface FunctionBodyCandidate {
  name: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

interface ManualHotFileMetrics {
  lineCount: number;
  namespaceImportCount: number;
  runtimeVendorImportCount: number;
  importCount: number;
  longFunctionCandidates: FunctionBodyCandidate[];
  boundaryTokenCounts: Record<string, number>;
}

interface ManualHotRescueTarget {
  rank: number;
  sourceFilePath: string;
  manualFilePath: string;
  mappedBy: "exact" | "normalized" | "fallback";
  averageScore: number;
  moduleIds: string[];
  exists: boolean;
  metrics?: ManualHotFileMetrics;
  recommendedActions: string[];
  violations: string[];
}

export interface ManualHotRescueReport {
  generatedAtIso: string;
  manualProjectPath: string;
  candidatesPath: string;
  topN: number;
  namespaceImportCap: number;
  longFunctionLineThreshold: number;
  targetCount: number;
  unresolvedCount: number;
  violationCount: number;
  targets: ManualHotRescueTarget[];
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function buildPathCandidates(relativePath: string): Array<{ path: string; mappedBy: "exact" | "normalized" | "fallback" }> {
  const normalized = normalizeRelativePath(relativePath);
  const candidates: Array<{ path: string; mappedBy: "exact" | "normalized" | "fallback" }> = [
    { path: normalized, mappedBy: "exact" },
  ];
  const qualityStripped = normalized.replace(/-quality-\d+(?=\.ts$)/i, "");
  if (qualityStripped !== normalized) {
    candidates.push({ path: qualityStripped, mappedBy: "normalized" });
  }
  for (const suffix of ["01", "02", "03", "04"]) {
    const qualityVariant = normalized.replace(/-quality-\d+(?=\.ts$)/i, `-quality-${suffix}`);
    if (qualityVariant !== normalized) {
      candidates.push({ path: qualityVariant, mappedBy: "normalized" });
    }
  }
  if (/^src\/renderer\/features\/store\/store-state-quality-\d+\.ts$/i.test(normalized)) {
    candidates.push({ path: "src/renderer/features/store/store-state.ts", mappedBy: "fallback" });
  }
  if (/^src\/renderer\/features\/hooks\/hook-(?:hooks|render)-quality-\d+\.ts$/i.test(normalized)) {
    candidates.push({ path: "src/renderer/features/hooks/hook-hooks-render.ts", mappedBy: "fallback" });
  }
  if (/^src\/renderer\/features\/ui\/ui-components(?:-render)?-quality-\d+\.ts$/i.test(normalized)) {
    candidates.push({ path: "src/renderer/features/ui/ui-components.ts", mappedBy: "fallback" });
  }
  if (/^src\/main\/lib\/transport\/transport-bridge-quality-\d+\.ts$/i.test(normalized)) {
    candidates.push({ path: "src/main/lib/transport/transport-bridge.ts", mappedBy: "fallback" });
  }
  const deduped = new Map<string, { path: string; mappedBy: "exact" | "normalized" | "fallback" }>();
  for (const candidate of candidates) {
    if (!deduped.has(candidate.path)) {
      deduped.set(candidate.path, candidate);
    }
  }
  return [...deduped.values()];
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function collectBoundaryTokenCounts(text: string): Record<string, number> {
  const tokenPatterns: Record<string, RegExp> = {
    state: /\bstate\b/gi,
    event: /\bevent\b/gi,
    route: /\broute\b/gi,
    session: /\bsession\b/gi,
    workspace: /\bworkspace\b/gi,
    ipc: /\bipc\b/gi,
    transport: /\btransport\b/gi,
  };
  const counts: Record<string, number> = {};
  for (const [token, pattern] of Object.entries(tokenPatterns)) {
    counts[token] = countMatches(text, pattern);
  }
  return counts;
}

function collectLongFunctionCandidates(content: string, threshold: number): FunctionBodyCandidate[] {
  const sourceFile = ts.createSourceFile("manual-hot-rescue.ts", content, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const entries: FunctionBodyCandidate[] = [];
  const pushCandidate = (name: string, body: ts.Node): void => {
    const start = sourceFile.getLineAndCharacterOfPosition(body.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(body.getEnd()).line + 1;
    const lineCount = Math.max(1, end - start + 1);
    if (lineCount < threshold) {
      return;
    }
    entries.push({
      name,
      startLine: start,
      endLine: end,
      lineCount,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const functionName = node.name?.text ?? "anonymousFunction";
      pushCandidate(functionName, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const initializer = node.initializer;
      const body = initializer.body;
      if (ts.isBlock(body)) {
        pushCandidate(node.name.text, body);
      }
    } else if (ts.isMethodDeclaration(node) && node.body) {
      const methodName =
        node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : node.name && ts.isStringLiteralLike(node.name)
            ? node.name.text
            : "anonymousMethod";
      pushCandidate(methodName, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries.sort((left, right) => right.lineCount - left.lineCount).slice(0, 20);
}

function collectManualFileMetrics(content: string, longFunctionLineThreshold: number): ManualHotFileMetrics {
  const lineCount = content.split(/\r?\n/).length;
  const namespaceImportCount = countMatches(content, /^\s*import\s+\*\s+as\s+/gm);
  const importCount = countMatches(content, /^\s*import\s+/gm);
  const runtimeVendorImportCount = content
    .split(/\r?\n/)
    .filter((line) => /^\s*import\s+/.test(line))
    .filter((line) => /(?:\/runtime\/|\/vendor\/|\/artifacts\/)/i.test(line)).length;
  return {
    lineCount,
    namespaceImportCount,
    runtimeVendorImportCount,
    importCount,
    longFunctionCandidates: collectLongFunctionCandidates(content, longFunctionLineThreshold),
    boundaryTokenCounts: collectBoundaryTokenCounts(content),
  };
}

function buildRecommendedActions(metrics: ManualHotFileMetrics): string[] {
  const actions = new Set<string>();
  if (metrics.longFunctionCandidates.length > 0) {
    actions.add("dependency-closure extraction inside long functions");
  }
  const boundaryStrength = (metrics.boundaryTokenCounts.state ?? 0) + (metrics.boundaryTokenCounts.event ?? 0);
  if (metrics.lineCount >= 800 || boundaryStrength >= 20) {
    actions.add("behavior split by state/event boundaries");
  }
  if (metrics.runtimeVendorImportCount > 0) {
    actions.add("runtime/vendor quarantine into dedicated runtime-vendor layer");
  }
  if (actions.size < 1) {
    actions.add("maintain current structure; no rescue action required");
  }
  return [...actions];
}

function hasRealRefactorAction(target: ManualHotRescueTarget): boolean {
  return target.recommendedActions.some((action) => !/^maintain current structure;/iu.test(action));
}

function isNoOpPath(target: ManualHotRescueTarget): boolean {
  return /store-path|transport-bridge/iu.test(target.manualFilePath);
}

function computeRefactorabilityRank(target: ManualHotRescueTarget): number {
  if (!target.exists || !target.metrics) {
    return -10;
  }
  const hasAction = hasRealRefactorAction(target);
  const boundaryStrength = (target.metrics.boundaryTokenCounts.state ?? 0) + (target.metrics.boundaryTokenCounts.event ?? 0);
  let rank = 0;
  if (hasAction) {
    rank += 4;
  }
  if (target.metrics.lineCount >= 400) {
    rank += 2;
  }
  if (target.metrics.longFunctionCandidates.length > 0) {
    rank += 2;
  }
  if (boundaryStrength >= 8) {
    rank += 1;
  }
  if (isNoOpPath(target)) {
    rank -= 4;
  }
  return rank;
}

async function resolveManualTarget(
  manualProjectPath: string,
  sourceRelativePath: string,
): Promise<{ manualFilePath: string; mappedBy: "exact" | "normalized" | "fallback"; exists: boolean }> {
  for (const candidate of buildPathCandidates(sourceRelativePath)) {
    const absolutePath = path.join(manualProjectPath, candidate.path);
    try {
      await fs.access(absolutePath);
      return {
        manualFilePath: candidate.path,
        mappedBy: candidate.mappedBy,
        exists: true,
      };
    } catch {
      continue;
    }
  }
  return {
    manualFilePath: normalizeRelativePath(sourceRelativePath),
    mappedBy: "exact",
    exists: false,
  };
}

export async function runManualHotRescue(options: ManualHotRescueOptions): Promise<ManualHotRescueReport> {
  const manualProjectPath = path.resolve(options.manualProjectPath);
  const candidatesPath = path.resolve(options.candidatesPath);
  const topN = Math.max(1, Math.trunc(options.topN));
  const namespaceImportCap = Math.max(1, Math.trunc(options.namespaceImportCap));
  const longFunctionLineThreshold = Math.max(20, Math.trunc(options.longFunctionLineThreshold));
  const model = await readJsonFile<ManualRefactorCandidatesModel>(candidatesPath);
  const sourceCandidates = Array.isArray(model.candidates) ? model.candidates : [];
  const candidatePool = [...sourceCandidates]
    .sort((left, right) => (left.averageScore ?? 0) - (right.averageScore ?? 0))
    .slice(0, Math.max(topN * 4, topN));
  const targets: ManualHotRescueTarget[] = [];
  for (let index = 0; index < candidatePool.length; index += 1) {
    const candidate = candidatePool[index];
    if (!candidate) {
      continue;
    }
    const sourceFilePath = normalizeRelativePath(candidate.filePath);
    const resolved = await resolveManualTarget(manualProjectPath, sourceFilePath);
    const target: ManualHotRescueTarget = {
      rank: index + 1,
      sourceFilePath,
      manualFilePath: resolved.manualFilePath,
      mappedBy: resolved.mappedBy,
      averageScore: typeof candidate.averageScore === "number" ? candidate.averageScore : 0,
      moduleIds: Array.isArray(candidate.moduleIds) ? candidate.moduleIds : [],
      exists: resolved.exists,
      recommendedActions: [],
      violations: [],
    };
    if (!resolved.exists) {
      target.violations.push("missing-manual-file-mapping");
      target.recommendedActions = ["map this hot file to a manual domain module before next cycle"];
      targets.push(target);
      continue;
    }
    const absoluteManualPath = path.join(manualProjectPath, resolved.manualFilePath);
    const content = await fs.readFile(absoluteManualPath, "utf8");
    const metrics = collectManualFileMetrics(content, longFunctionLineThreshold);
    target.metrics = metrics;
    target.recommendedActions = buildRecommendedActions(metrics);
    if (metrics.namespaceImportCount > namespaceImportCap) {
      target.violations.push(
        `namespace-import-cap-exceeded:${metrics.namespaceImportCount}>${namespaceImportCap}`,
      );
    }
    targets.push(target);
  }
  const selectedTargets = [...targets]
    .sort((left, right) => {
      const refactorabilityDelta = computeRefactorabilityRank(right) - computeRefactorabilityRank(left);
      if (refactorabilityDelta !== 0) {
        return refactorabilityDelta;
      }
      return (left.averageScore ?? 0) - (right.averageScore ?? 0);
    })
    .slice(0, topN)
    .map((target, index) => ({ ...target, rank: index + 1 }));
  const report: ManualHotRescueReport = {
    generatedAtIso: new Date().toISOString(),
    manualProjectPath,
    candidatesPath,
    topN,
    namespaceImportCap,
    longFunctionLineThreshold,
    targetCount: selectedTargets.length,
    unresolvedCount: selectedTargets.filter((target) => !target.exists).length,
    violationCount: selectedTargets.reduce((sum, target) => sum + target.violations.length, 0),
    targets: selectedTargets,
  };
  await writeJsonFile(path.resolve(options.outputPath), report);
  return report;
}
