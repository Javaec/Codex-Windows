import { formatDomainReportMarkdown, type ComponentBoundariesReport, type DomainDefinition, type DomainReport } from "./domain-boundaries";
import type { IpcContractMapReport } from "./ipc-contract-map";
import type { DeobfuscationTableReport } from "./match-v2";
import type { QualityGateReport } from "./quality-gates";
import type { ReferenceParityGapsReport } from "./reference-parity";
import type { ReferenceSignalProfile } from "./reference-model";
import type { RpcSchemaReport } from "./rpc-schema";
import type { RouteBoundaryGraphReport, SessionFlowReport } from "./session-route-flow";
import type { RuntimeProbeResult } from "./runtime-probe";

export interface BinaryExtractionResult {
  binaryPath: string | null;
  rawMatches: string[];
  rpcLikeMethods: string[];
}

interface TopCountRow {
  value: string;
  count: number;
}

interface FileSizeRow {
  relPath: string;
  sizeBytes: number;
}

export interface BuildArchitectureMarkdownInput {
  top: number;
  appDir: string;
  outDir: string;
  packageMain: string | null;
  webviewScripts: string[];
  webviewStyles: string[];
  files: FileSizeRow[];
  jsFiles: FileSizeRow[];
  cssFiles: Array<{ relPath: string }>;
  parseFailures: Array<{ file: string; reason: string }>;
  prettyStats: { prettyOk: number; copiedRaw: number; skippedLarge: number };
  importsGraph: Record<string, string[]>;
  ipcRows: TopCountRow[];
  methodRows: TopCountRow[];
  routeRows: TopCountRow[];
  messageTypeRows: TopCountRow[];
  statusRows: TopCountRow[];
  stateKeyRows: TopCountRow[];
  cssVars: string[];
  cssClasses: string[];
  cssColors: string[];
  domainReport: DomainReport;
  domainDefinitions: Record<string, DomainDefinition>;
  componentBoundaries: ComponentBoundariesReport;
  ipcContractMap: IpcContractMapReport;
  rpcSchema: RpcSchemaReport;
  deobfuscationTable: DeobfuscationTableReport;
  qualityGates: QualityGateReport;
  sessionFlow: SessionFlowReport;
  routeBoundaryGraph: RouteBoundaryGraphReport;
  referenceParityGaps: ReferenceParityGapsReport;
  referenceProfile: ReferenceSignalProfile;
  runtimeProbe: RuntimeProbeResult;
  binary: BinaryExtractionResult | null;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function formatTopRows(rows: TopCountRow[], top: number): string {
  if (rows.length === 0) return "_none_";
  return rows
    .slice(0, top)
    .map((row) => `- \`${row.value}\` (${row.count})`)
    .join("\n");
}

export function buildArchitectureMarkdown(input: BuildArchitectureMarkdownInput): string {
  const totalBytes = input.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const topSizeRows = [...input.jsFiles]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, input.top)
    .map((item) => ({ value: item.relPath, count: item.sizeBytes }));
  const graphOutRows = Object.entries(input.importsGraph)
    .map(([file, deps]) => ({ value: file, count: deps.length }))
    .sort((a, b) => b.count - a.count);

  return `# Codex App Reverse Report

## Scope
- Input app dir: \`${toPosixPath(input.appDir)}\`
- Output dir: \`${toPosixPath(input.outDir)}\`
- Files indexed: ${input.files.length}
- JS files: ${input.jsFiles.length}
- CSS files: ${input.cssFiles.length}
- Total indexed bytes: ${totalBytes}

## Entrypoints
- package.main: \`${input.packageMain ?? "<missing>"}\`
- webview scripts:
${input.webviewScripts.length > 0 ? input.webviewScripts.map((item) => `- \`${item}\``).join("\n") : "- _none_"}
- webview styles:
${input.webviewStyles.length > 0 ? input.webviewStyles.map((item) => `- \`${item}\``).join("\n") : "- _none_"}

## Decompile Pass
- pretty rendered: ${input.prettyStats.prettyOk}
- copied as raw: ${input.prettyStats.copiedRaw}
- skipped by size limit: ${input.prettyStats.skippedLarge}
- parse failures: ${input.parseFailures.length}
${input.parseFailures.length > 0 ? input.parseFailures.slice(0, input.top).map((failure) => `- \`${failure.file}\` :: ${failure.reason}`).join("\n") : ""}

## Reference Priors (1code + CodexMonitor)
- source map path: \`${input.referenceProfile.sourcePath}\`
- source map loaded: ${input.referenceProfile.loaded}
- source map copy: \`${input.referenceProfile.copiedPath || "<none>"}\`
- source bytes: ${input.referenceProfile.bytes}
- route priors: ${input.referenceProfile.keywordGroups.routes.length}
- method priors: ${input.referenceProfile.keywordGroups.methods.length}
- state priors: ${input.referenceProfile.keywordGroups.stateKeys.length}
- readiness priors: ${input.referenceProfile.keywordGroups.readiness.length}
- event priors: ${input.referenceProfile.keywordGroups.events.length}
- ipc priors: ${input.referenceProfile.keywordGroups.ipc.length}
- ui priors: ${input.referenceProfile.keywordGroups.ui.length}
- warnings:
${input.referenceProfile.warnings.length > 0 ? input.referenceProfile.warnings.map((item) => `- ${item}`).join("\n") : "- _none_"}
- excerpt:
${input.referenceProfile.excerpt.length > 0 ? input.referenceProfile.excerpt.map((item) => `- ${item}`).join("\n") : "- _none_"}

## IPC Channels
${formatTopRows(input.ipcRows, input.top)}

## RPC Methods
${formatTopRows(input.methodRows, input.top)}

## Message Types
${formatTopRows(input.messageTypeRows, input.top)}

## Status Values
${formatTopRows(input.statusRows, input.top)}

## Route Candidates
${formatTopRows(input.routeRows, input.top)}

## State Keys
${formatTopRows(input.stateKeyRows, input.top)}

## Domain Focus (UI & Logic)
${formatDomainReportMarkdown(input.domainReport, input.top, input.domainDefinitions)}

## Component Boundaries
- boundary files: ${input.componentBoundaries.coverage.boundaryFiles}
- candidate files: ${input.componentBoundaries.coverage.candidateFiles}
- avg UI likelihood: ${input.componentBoundaries.coverage.avgUiLikelihood}
- max ownership score: ${input.componentBoundaries.coverage.maxOwnershipScore}
- Top ownership files:
${input.componentBoundaries.boundaries.slice(0, Math.min(input.top, 20)).map((row) => `- \`${row.ownerFile}\` (score=${row.ownershipScore}, ui=${row.uiLikelihood}, refHits=${row.referenceSignalHits}, chunk=\`${row.chunkId}\`)`).join("\n") || "- _none_"}

## IPC Contract Map
- channels: ${input.ipcContractMap.coverage.channels}
- channels with main handlers: ${input.ipcContractMap.coverage.withMainHandlers}
- channels with renderer invokes: ${input.ipcContractMap.coverage.withRendererInvokes}
- channels with renderer subscriptions: ${input.ipcContractMap.coverage.withRendererSubscriptions}
- channels with main emits: ${input.ipcContractMap.coverage.withMainEmits}
- wrapper files: ${input.ipcContractMap.wrappers.filesWithWrappers}
- wrappers discovered: ${input.ipcContractMap.wrappers.wrappersDiscovered}
- global wrappers discovered: ${input.ipcContractMap.wrappers.globalWrappersDiscovered}
- wrapper invocations resolved: ${input.ipcContractMap.wrappers.wrapperInvocationsResolved}
- missing main handlers:
${input.ipcContractMap.orphanSignals.missingMainHandlers.slice(0, Math.min(input.top, 20)).map((row) => `- \`${row}\``).join("\n") || "- _none_"}
- missing renderer subscriptions:
${input.ipcContractMap.orphanSignals.missingRendererSubscriptions.slice(0, Math.min(input.top, 20)).map((row) => `- \`${row}\``).join("\n") || "- _none_"}

## RPC Schema (Unified Source of Truth)
- methods: ${input.rpcSchema.coverage.methods}
- from bundle: ${input.rpcSchema.coverage.fromBundle}
- from binary: ${input.rpcSchema.coverage.fromBinary}
- from runtime: ${input.rpcSchema.coverage.fromRuntime}
- with payload keys: ${input.rpcSchema.coverage.withPayloadKeys}
- with renderer callsites: ${input.rpcSchema.coverage.withRendererCallsites}
- envelope request methods: ${input.rpcSchema.envelopes.request}
- envelope response methods: ${input.rpcSchema.envelopes.response}
- envelope event methods: ${input.rpcSchema.envelopes.event}
- runtime noise mode: ${input.rpcSchema.runtimeProbe.noiseMode}
- soft-recovered runtime methods: ${input.rpcSchema.runtimeProbe.softRecoveredMethods}
- runtime lines scanned for schema: ${input.rpcSchema.runtimeProbe.linesScanned}
- top rpc schema methods:
${input.rpcSchema.methods.slice(0, Math.min(input.top, 16)).map((row) => `- \`${row.method}\` (confidence=${row.confidence}, payload=${row.payloadKeys.length}, envelopes=${row.envelopes.join("|") || "none"})`).join("\n") || "- _none_"}

## Deobfuscation Table
- mapped symbols: ${input.deobfuscationTable.coverage.mappedSymbols}
- mapped files: ${input.deobfuscationTable.coverage.mappedFiles}
- obfuscated symbol candidates: ${input.deobfuscationTable.coverage.obfuscatedSymbolCandidates}
- obfuscated file candidates: ${input.deobfuscationTable.coverage.obfuscatedFileCandidates}
- symbol maps loaded: ${input.deobfuscationTable.referenceInputs.loaded}
- top file relocations:
${input.deobfuscationTable.filePlans.slice(0, Math.min(input.top, 12)).map((row) => `- \`${row.sourceFile}\` -> \`${row.proposedModulePath}\` (confidence=${row.confidence})`).join("\n") || "- _none_"}
- top symbol renames:
${input.deobfuscationTable.entries.filter((row) => row.kind !== "file").slice(0, Math.min(input.top, 12)).map((row) => `- \`${row.sourceFile}\` :: \`${row.obfuscated}\` -> \`${row.deobfuscated}\` (confidence=${row.confidence}, ref=${row.reference.source})`).join("\n") || "- _none_"}

## Quality Gates
- pass: ${input.qualityGates.passed}
- mappedFiles gate: ${input.qualityGates.targets.mappedFilesMin}-${input.qualityGates.targets.mappedFilesMax}
- mappedFiles current: ${input.qualityGates.metrics.mappedFiles}
- mappedSymbols current: ${input.qualityGates.metrics.mappedSymbols}
- mappedSymbols previous: ${input.qualityGates.metrics.previousMappedSymbols}
- generic-path noise rows: ${input.qualityGates.metrics.genericNoisePaths.length}
- chunk artifacts: rows=${input.qualityGates.metrics.chunkArtifactRows}, uniqueSource=${input.qualityGates.metrics.chunkArtifactUniqueSource}, uniqueArtifact=${input.qualityGates.metrics.chunkArtifactUniqueArtifact}
- project checks: install=${input.qualityGates.metrics.installSuccess}, tscErrors=${input.qualityGates.metrics.tscErrors}, eslintErrors=${input.qualityGates.metrics.eslintErrors}, eslintWarnings=${input.qualityGates.metrics.eslintWarnings}
- failures:
${input.qualityGates.failures.length > 0 ? input.qualityGates.failures.map((item) => `- ${item}`).join("\n") : "- _none_"}

## Session Flow
- focus routes: ${input.sessionFlow.focusRouteCount}
- total route candidates: ${input.sessionFlow.totalRouteCandidates}
- core owners:
${input.sessionFlow.coreFlowOwners.slice(0, Math.min(input.top, 12)).map((row) => `- \`${row.file}\` (${row.score})`).join("\n") || "- _none_"}

## Runtime Probe Classification
- attempted: ${input.runtimeProbe.attempted}
- success: ${input.runtimeProbe.success}
- forced stop: ${input.runtimeProbe.forcedStop}
- duration ms: ${input.runtimeProbe.durationMs}
- warnings total: ${input.runtimeProbe.warnings.length}
  system: ${input.runtimeProbe.warningClassification.system.length}, logic: ${input.runtimeProbe.warningClassification.logic.length}, unknown: ${input.runtimeProbe.warningClassification.unknown.length}
- errors total: ${input.runtimeProbe.errors.length}
  system: ${input.runtimeProbe.errorClassification.system.length}, logic: ${input.runtimeProbe.errorClassification.logic.length}, unknown: ${input.runtimeProbe.errorClassification.unknown.length}
- top warning lines:
${input.runtimeProbe.warnings.slice(0, Math.min(input.top, 10)).map((line) => `- ${line}`).join("\n") || "- _none_"}
- top error lines:
${input.runtimeProbe.errors.slice(0, Math.min(input.top, 10)).map((line) => `- ${line}`).join("\n") || "- _none_"}

## Route -> Boundary -> IPC/RPC Graph
- route nodes: ${input.routeBoundaryGraph.coverage.routes}
- boundary nodes: ${input.routeBoundaryGraph.coverage.boundaries}
- ipc nodes: ${input.routeBoundaryGraph.coverage.ipcChannels}
- envelope nodes: ${input.routeBoundaryGraph.coverage.envelopes}
- rpc nodes: ${input.routeBoundaryGraph.coverage.rpcMethods}
- route->boundary edges: ${input.routeBoundaryGraph.coverage.routeToBoundaryEdges}
- boundary->ipc edges: ${input.routeBoundaryGraph.coverage.boundaryToIpcEdges}
- boundary->envelope edges: ${input.routeBoundaryGraph.coverage.boundaryToEnvelopeEdges}
- envelope->rpc edges: ${input.routeBoundaryGraph.coverage.envelopeToRpcEdges}
- boundary->rpc edges: ${input.routeBoundaryGraph.coverage.boundaryToRpcEdges}

## Reference Parity Gaps (1code + CodexMonitor)
- weighted coverage: ${input.referenceParityGaps.coverage.weightedCoveragePercent}%
- weighted gap score: ${input.referenceParityGaps.coverage.weightedGapScore}
- domains scored: ${input.referenceParityGaps.coverage.domains}
- top prioritized gaps:
${input.referenceParityGaps.topGaps.map((row) => `- #${row.priorityRank} ${row.label} [${row.domain}] tier=${row.confidenceTier} impact=${row.impactScore} coverage=${row.coveragePercent}% gap=${row.gapScore} missing=${row.missingKeywords.slice(0, 8).join(", ") || "none"}`).join("\n") || "- _none_"}

## Chunk Dependency Graph (out-degree)
${formatTopRows(graphOutRows, input.top)}

## Largest JS Files
${formatTopRows(topSizeRows, input.top)}

## Design System Signals
- CSS vars: ${input.cssVars.length}
- CSS classes: ${input.cssClasses.length}
- Color tokens: ${input.cssColors.length}
- Top CSS vars:
${input.cssVars.slice(0, input.top).map((item) => `- \`${item}\``).join("\n") || "- _none_"}

## Bundled Binary Signals
- Binary source: \`${input.binary?.binaryPath ? toPosixPath(input.binary.binaryPath) : "<none>"}\`
- Binary raw protocol strings: ${input.binary?.rawMatches.length ?? 0}
- Binary rpc-like methods: ${input.binary?.rpcLikeMethods.length ?? 0}
- Top binary rpc-like methods:
${input.binary && input.binary.rpcLikeMethods.length > 0 ? input.binary.rpcLikeMethods.slice(0, input.top).map((item) => `- \`${item}\``).join("\n") : "- _none_"}
`;
}
