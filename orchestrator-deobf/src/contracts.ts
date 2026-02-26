export type StageId =
  | "asar-extract"
  | "webcrack"
  | "monolith-census"
  | "monolith-pass"
  | "wakaru"
  | "javascript-deobfuscator"
  | "synchrony"
  | "unwebpack-sourcemap"
  | "evidence-store"
  | "semantic-ir"
  | "naming-memory"
  | "ownership-resolver"
  | "chunk-artifact-model"
  | "template-emitter"
  | "quality-gates"
  | "green-gates"
  | "decision-dashboard";

export type ToolId =
  | "asar"
  | "webcrack"
  | "wakaru"
  | "javascript-deobfuscator"
  | "synchrony"
  | "unwebpack-sourcemap";

export type OptionalStageStatus = "executed" | "skipped";
export type LayerId = "main" | "renderer" | "services" | "tauri";
export type ArchetypeId = "hook" | "service" | "ui" | "transport" | "store";
export type OutputProfile = "latest" | "regression-latest";

export interface ToolVersionEntry {
  packageName: string;
  version: string;
  source: "npm" | "local-reference";
}

export interface ToolVersions {
  asar: ToolVersionEntry;
  webcrack: ToolVersionEntry;
  wakaru: ToolVersionEntry;
  javascriptDeobfuscator: ToolVersionEntry;
  synchrony: ToolVersionEntry;
  unwebpackSourcemap: ToolVersionEntry;
}

export interface InputArtifacts {
  snapshotAsarPath: string;
  snapshotAsarSha256: string;
  snapshotAsarBytes: number;
  snapshotKey: string;
}

export interface RunFlags {
  forceOverwriteOutputs: boolean;
  wakaruConcurrency: number;
  promotionBudget: number;
  coverageLineageId: string;
  namingMemoryProfilePath: string;
  enableJavascriptDeobfuscator: boolean;
  enableSynchrony: boolean;
  enableUnwebpackSourcemap: boolean;
  stageCacheEnabled: boolean;
  javascriptDeobfuscatorParseAsModule: boolean;
  synchronyRename: boolean;
  synchronyLoose: boolean;
  unwebpackSourcemapMaxMaps: number;
  snapshotBootstrapMode: boolean;
  semanticSweepProfileCount: number;
  outputProfile: OutputProfile;
  statementBudget: number;
  weightsConfigPath: string;
}

export interface RunManifest {
  manifestVersion: number;
  runId: string;
  createdAtIso: string;
  seed: number;
  pipeline: StageId[];
  tools: ToolVersions;
  flags: RunFlags;
  inputs: InputArtifacts;
}

export interface AsarExtractStageInput {
  snapshotAsarPath: string;
  extractDirectory: string;
  entryFileHints: string[];
}

export interface AsarExtractStageOutput {
  extractedRootDirectory: string;
  extractedFileCount: number;
  extractedJsFileCount: number;
  extractedMapFileCount: number;
  selectedEntryJsPath: string;
  selectedEntryJsRelativePath: string;
  discoveredJsFiles: string[];
  discoveredMapFiles: string[];
}

export interface WebcrackStageInput {
  entryJsPath: string;
  outputDirectory: string;
  forceOverwriteOutputDirectory: boolean;
}

export interface WebcrackStageOutput {
  outputDirectory: string;
  producedFileCount: number;
  producedJsFileCount: number;
  primaryOutputJsPath: string;
  primaryOutputJsRelativePath: string;
}

export interface MonolithCensusStageInput {
  sourceJsPath: string;
  outputDirectory: string;
  lineageId: string;
}

export interface MonolithCensusStageOutput {
  outputDirectory: string;
  censusJsPath: string;
  mappingPath: string;
  sourceJsPath: string;
  lineageId: string;
  classCount: number;
  functionCount: number;
  callableVariableCount: number;
  variableCoverageCount: number;
  renamedDeclarationCount: number;
  qualityPromotionCandidateCount: number;
  unifiedMonolithPath: string;
  pass1MonolithPath: string;
  pass2MonolithPath: string;
  symbolTablePath: string;
  typingHintsPath: string;
}

export interface MonolithPassStageInput {
  symbolTablePath: string;
  sourceJsPath: string;
  pass2MonolithPath: string;
  lineageId: string;
  outputFilePath: string;
}

export interface MonolithPassStageOutput {
  outputFilePath: string;
  entryCount: number;
  parseCount: number;
  sumCount: number;
  stateCount: number;
  orchestrateCount: number;
}

export interface WakaruStageInput {
  sourceJsPath: string;
  outputDirectory: string;
  forceOverwriteOutputDirectory: boolean;
  concurrency: number;
}

export interface WakaruStageOutput {
  outputDirectory: string;
  producedFileCount: number;
  producedJsFileCount: number;
  outputFiles: string[];
}

export interface JavascriptDeobfuscatorStageInput {
  enabled: boolean;
  sourceJsPath: string;
  outputFilePath: string;
  parseAsModule: boolean;
}

export interface JavascriptDeobfuscatorStageOutput {
  status: OptionalStageStatus;
  outputFilePath: string;
  producedBytes: number;
  reason: string;
}

export interface SynchronyStageInput {
  enabled: boolean;
  sourceJsPath: string;
  outputFilePath: string;
  rename: boolean;
  loose: boolean;
}

export interface SynchronyStageOutput {
  status: OptionalStageStatus;
  outputFilePath: string;
  producedBytes: number;
  reason: string;
}

export interface UnwebpackSourcemapStageInput {
  enabled: boolean;
  pythonExecutable: string;
  referenceScriptPath: string;
  mapFilePaths: string[];
  outputDirectory: string;
  maxMaps: number;
}

export interface UnwebpackSourcemapStageOutput {
  status: OptionalStageStatus;
  outputDirectory: string;
  summaryFilePath: string;
  scannedMapCount: number;
  usedMapCount: number;
  extractedSourceFileCount: number;
  extractedSourceFiles: string[];
  reason: string;
}

export interface EvidenceSourceFile {
  tool: ToolId;
  stageId: StageId;
  lineageId: string;
  filePath: string;
  sourceKind: "javascript" | "sourcemap" | "text";
  baseConfidence: number;
}

export interface EvidenceStoreStageInput {
  sourceFiles: EvidenceSourceFile[];
  outputFilePath: string;
  maxRecords: number;
}

export interface EvidenceStoreStageOutput {
  outputFilePath: string;
  sourceFileCount: number;
  totalRecords: number;
  fileHintCount: number;
  symbolHintCount: number;
  callEdgeCount: number;
  stateKeyCount: number;
  sourceMapCount: number;
  ioSignatureCount: number;
}

export interface ToolWeights {
  asar: number;
  webcrack: number;
  wakaru: number;
  javascriptDeobfuscator: number;
  synchrony: number;
  unwebpackSourcemap: number;
}

export interface SemanticIrSweepProfile {
  profileId: string;
  toolWeights: ToolWeights;
}

export interface SemanticIrStageInput {
  evidenceStorePath: string;
  outputFilePath: string;
  toolWeights: ToolWeights;
  sweepProfiles: SemanticIrSweepProfile[];
}

export interface SemanticIrStageOutput {
  outputFilePath: string;
  fileCount: number;
  symbolCount: number;
  callEdgeCount: number;
  stateKeyCount: number;
  declarationFingerprintCount: number;
  symbolRoleResolutionCount: number;
  evidenceLedgerEntryCount: number;
  profileCount: number;
  anchorProfileId: string;
  mergedSymbolWinners: number;
  mergedFileHintWinners: number;
  obfuscationProfileId: string;
  obfuscationProfileConfidence: number;
}

export interface NamingMemoryStageInput {
  semanticIrPath: string;
  namingMemoryPath: string;
  snapshotPath: string;
  namedSemanticIrPath: string;
  coverageNamedSemanticIrPath: string;
  monolithTypingHintsPath: string;
  runId: string;
  monolithSymbolTablePath: string;
  promotionBudget: number;
}

export interface NamingMemoryStageOutput {
  namingMemoryPath: string;
  snapshotPath: string;
  namedSemanticIrPath: string;
  qualityNamedSemanticIrPath: string;
  coverageNamedSemanticIrPath: string;
  insertedEntryCount: number;
  updatedEntryCount: number;
  keptEntryCount: number;
  promotionBudget: number;
  promotionCandidateCount: number;
  promotionSelectedCount: number;
  promotionRejectedCount: number;
  baselineQualityBefore: number;
  baselineQualityAfter: number;
  baselineGuardPassed: boolean;
}

export interface OwnershipResolverStageInput {
  namedSemanticIrPath: string;
  outputFilePath: string;
}

export interface OwnershipResolverStageOutput {
  outputFilePath: string;
  symbolCount: number;
  layerCounts: Record<LayerId, number>;
  archetypeCounts: Record<ArchetypeId, number>;
}

export interface ChunkArtifactModelStageInput {
  sourceFiles: EvidenceSourceFile[];
  ownershipModelPath: string;
  outputFilePath: string;
}

export interface ChunkArtifactModelStageOutput {
  outputFilePath: string;
  artifactCount: number;
  symbolMappingCount: number;
}

export interface TemplateEmitterStageInput {
  ownershipModelPath: string;
  chunkArtifactsPath: string;
  semanticIrPath: string;
  monolithLayoutHintsPath: string;
  outputProjectDirectory: string;
  statementBudget: number;
  emittedFilesIndexPath: string;
}

export interface TemplateEmitterStageOutput {
  outputProjectDirectory: string;
  emittedFileCount: number;
  emittedModuleCount: number;
  emittedSymbolCount: number;
  emittedFilesIndexPath: string;
  fileQualityReportPath: string;
  rerenderedModuleCount: number;
  hotChunkCount: number;
}

export interface QualityGatesStageInput {
  chunkArtifactsPath: string;
  emittedFilesIndexPath: string;
  outputProjectDirectory: string;
  stableOutputRoot: string;
  stableOutputProfile: OutputProfile;
  qualityReportPath: string;
}

export interface QualityGatesStageOutput {
  qualityReportPath: string;
  passed: boolean;
  checkedFileCount: number;
  violations: string[];
  stableProjectDirectory: string;
}

export interface GreenGateCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  logPath: string;
}

export interface GreenGateStageInput {
  projectDirectory: string;
  logDirectory: string;
  outputReportPath: string;
}

export interface GreenGateStageOutput {
  passed: boolean;
  outputReportPath: string;
  checkedCommands: GreenGateCommandResult[];
  runtimeLogPath: string;
  runtimeErrorCount: number;
  runtimeWarningCount: number;
}

export interface OptionalStageSnapshot {
  status: OptionalStageStatus;
  reason: string;
}

export interface DecisionDashboardStageInput {
  runId: string;
  ownershipModelPath: string;
  metricsPath: string;
  outputJsonPath: string;
  outputMarkdownPath: string;
  javascriptDeobfuscator: OptionalStageSnapshot;
  synchrony: OptionalStageSnapshot;
  unwebpackSourcemap: OptionalStageSnapshot;
}

export interface DashboardDecisionItem {
  title: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface DecisionDashboardStageOutput {
  outputJsonPath: string;
  outputMarkdownPath: string;
  orchestratorActionCount: number;
  externalToolActionCount: number;
  postRenameActionCount: number;
}

export interface RunMetrics {
  mappedFiles: number;
  mappedSymbols: number;
  coverageSymbols: number;
  highConfidenceSymbols: number;
  nameQuality: number;
  coverageNameQuality: number;
  classCoverage: number;
  functionCoverage: number;
  functionClassCoverage: number;
  variableCoverage: number;
  buildHealth: boolean;
  devHealth: boolean;
  genericPathNoiseCount: number;
  proxyInQualityCount: number;
  lowQualitySymbolCount: number;
  coverageLowQualitySymbolCount: number;
  layerCoverage: Record<LayerId, number>;
  archetypeCoverage: Record<ArchetypeId, number>;
}

export interface RunSummary {
  manifestPath: string;
  runDirectory: string;
  runMetricsPath: string;
  decisionDashboardPath: string;
  stageOutputs: {
    asarExtract: AsarExtractStageOutput;
    webcrack: WebcrackStageOutput;
    monolithCensus: MonolithCensusStageOutput;
    monolithPass: MonolithPassStageOutput;
    wakaru: WakaruStageOutput;
    javascriptDeobfuscator: JavascriptDeobfuscatorStageOutput;
    synchrony: SynchronyStageOutput;
    unwebpackSourcemap: UnwebpackSourcemapStageOutput;
    evidenceStore: EvidenceStoreStageOutput;
    semanticIr: SemanticIrStageOutput;
    namingMemory: NamingMemoryStageOutput;
    ownershipResolver: OwnershipResolverStageOutput;
    chunkArtifactModel: ChunkArtifactModelStageOutput;
    templateEmitter: TemplateEmitterStageOutput;
    qualityGates: QualityGatesStageOutput;
    greenGates: GreenGateStageOutput;
    decisionDashboard: DecisionDashboardStageOutput;
  };
}
