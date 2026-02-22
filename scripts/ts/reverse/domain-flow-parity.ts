import {
  buildComponentBoundariesReport,
  buildDomainReport,
  type ComponentBoundariesReport,
  type DomainReport,
} from "./domain-boundaries";
import {
  buildRouteBoundaryGraphReport,
  buildSessionFlowReport,
  formatSessionFlowMarkdown,
  type EnvelopeKind,
  type RouteBoundaryGraphReport,
  type SessionFlowReport,
} from "./session-route-flow";
import { buildReferenceParityGapsReport, type ReferenceParityGapsReport } from "./reference-parity";
import type { ReferenceModel } from "./reference-model";
import type { RpcSchemaReport } from "./rpc-schema";

export interface IndexRow {
  value: string;
  count: number;
  files: string[];
}

export interface FileRecord {
  relPath: string;
}

export interface SignalRows {
  routeRows: IndexRow[];
  methodRows: IndexRow[];
  messageTypeRows: IndexRow[];
  statusRows: IndexRow[];
  stateKeyRows: IndexRow[];
  ipcRows: IndexRow[];
}

export interface DomainBoundaryPipelineHelpers {
  dedupeKeywords(values: Iterable<string>, max: number): string[];
  isCandidateBoundaryFile(file: string): boolean;
  isLikelyCoreAppFile(file: string): boolean;
  isVendorFile(file: string): boolean;
  getChunkIdFromFile(file: string): string;
}

export interface FlowParityPipelineHelpers {
  dedupeKeywords(values: Iterable<string>, max: number): string[];
  escapeRegex(value: string): string;
  buildValueCountMap(rows: IndexRow[]): Map<string, number>;
  buildFileValueMap(rows: IndexRow[]): Map<string, Set<string>>;
  isLikelyCoreAppFile(file: string): boolean;
  isCandidateBoundaryFile(file: string): boolean;
  inferEnvelopeKindsFromText(text: string): Set<EnvelopeKind>;
  splitReferenceToken(value: string): string[];
}

export function buildDomainBoundaryPipeline(input: {
  top: number;
  jsFiles: FileRecord[];
  importsGraph: Map<string, string[]>;
  sourceByFile: Map<string, string>;
  rows: SignalRows;
  designSystem: {
    vars: string[];
    classes: string[];
  };
  referenceModel: ReferenceModel;
  helpers: DomainBoundaryPipelineHelpers;
}): {
  domainDefinitions: ReferenceModel["unified"]["domainDefinitions"];
  domainReport: DomainReport;
  componentBoundaries: ComponentBoundariesReport;
} {
  const domainDefinitions = input.referenceModel.unified.domainDefinitions;

  const domainReport = buildDomainReport({
    top: input.top,
    routeRows: input.rows.routeRows,
    methodRows: input.rows.methodRows,
    messageTypeRows: input.rows.messageTypeRows,
    statusRows: input.rows.statusRows,
    stateKeyRows: input.rows.stateKeyRows,
    ipcRows: input.rows.ipcRows,
    cssVars: input.designSystem.vars,
    cssClasses: input.designSystem.classes,
    domainDefinitions,
    helpers: {
      dedupeKeywords: input.helpers.dedupeKeywords,
      isCandidateBoundaryFile: input.helpers.isCandidateBoundaryFile,
      isLikelyCoreAppFile: input.helpers.isLikelyCoreAppFile,
      isVendorFile: input.helpers.isVendorFile,
      getChunkIdFromFile: input.helpers.getChunkIdFromFile,
    },
  });

  const componentBoundaries = buildComponentBoundariesReport({
    jsFiles: input.jsFiles,
    importsGraph: input.importsGraph,
    sourceByFile: input.sourceByFile,
    routeRows: input.rows.routeRows,
    methodRows: input.rows.methodRows,
    messageTypeRows: input.rows.messageTypeRows,
    statusRows: input.rows.statusRows,
    stateKeyRows: input.rows.stateKeyRows,
    ipcRows: input.rows.ipcRows,
    top: input.top,
    referenceProfile: input.referenceModel.signals,
    helpers: {
      dedupeKeywords: input.helpers.dedupeKeywords,
      isCandidateBoundaryFile: input.helpers.isCandidateBoundaryFile,
      isLikelyCoreAppFile: input.helpers.isLikelyCoreAppFile,
      isVendorFile: input.helpers.isVendorFile,
      getChunkIdFromFile: input.helpers.getChunkIdFromFile,
    },
  });

  return {
    domainDefinitions,
    domainReport,
    componentBoundaries,
  };
}

export function buildFlowParityPipeline(input: {
  top: number;
  rows: SignalRows;
  componentBoundaries: ComponentBoundariesReport;
  rpcSchema: RpcSchemaReport;
  referenceModel: ReferenceModel;
  tierThresholds: { critical: number; high: number };
  helpers: FlowParityPipelineHelpers;
}): {
  sessionFlow: SessionFlowReport;
  sessionFlowMarkdown: string;
  routeBoundaryGraph: RouteBoundaryGraphReport;
  referenceParityGaps: ReferenceParityGapsReport;
} {
  const sessionFlow = buildSessionFlowReport({
    top: input.top,
    routeRows: input.rows.routeRows,
    messageTypeRows: input.rows.messageTypeRows,
    methodRows: input.rows.methodRows,
    stateKeyRows: input.rows.stateKeyRows,
    statusRows: input.rows.statusRows,
    ipcRows: input.rows.ipcRows,
    rpcSchema: input.rpcSchema,
    referenceProfile: input.referenceModel.signals,
    helpers: {
      dedupeKeywords: input.helpers.dedupeKeywords,
      escapeRegex: input.helpers.escapeRegex,
      buildValueCountMap: input.helpers.buildValueCountMap,
      buildFileValueMap: input.helpers.buildFileValueMap,
      isLikelyCoreAppFile: input.helpers.isLikelyCoreAppFile,
      isCandidateBoundaryFile: input.helpers.isCandidateBoundaryFile,
      inferEnvelopeKindsFromText: input.helpers.inferEnvelopeKindsFromText,
    },
  });
  const sessionFlowMarkdown = formatSessionFlowMarkdown(sessionFlow);

  const routeBoundaryGraph = buildRouteBoundaryGraphReport({
    routeRows: input.rows.routeRows,
    methodRows: input.rows.methodRows,
    ipcRows: input.rows.ipcRows,
    componentBoundaries: input.componentBoundaries,
    rpcSchema: input.rpcSchema,
    helpers: {
      dedupeKeywords: input.helpers.dedupeKeywords,
      escapeRegex: input.helpers.escapeRegex,
      buildValueCountMap: input.helpers.buildValueCountMap,
      buildFileValueMap: input.helpers.buildFileValueMap,
      isLikelyCoreAppFile: input.helpers.isLikelyCoreAppFile,
      isCandidateBoundaryFile: input.helpers.isCandidateBoundaryFile,
      inferEnvelopeKindsFromText: input.helpers.inferEnvelopeKindsFromText,
    },
  });

  const referenceParityGaps = buildReferenceParityGapsReport({
    referenceProfile: input.referenceModel.signals,
    routeRows: input.rows.routeRows,
    methodRows: input.rows.methodRows,
    messageTypeRows: input.rows.messageTypeRows,
    statusRows: input.rows.statusRows,
    stateKeyRows: input.rows.stateKeyRows,
    ipcRows: input.rows.ipcRows,
    componentBoundaries: input.componentBoundaries,
    rpcSchema: input.rpcSchema,
    domainDefinitions: input.referenceModel.unified.domainDefinitions,
    tierThresholds: input.tierThresholds,
    helpers: {
      dedupeKeywords: input.helpers.dedupeKeywords,
      splitReferenceToken: input.helpers.splitReferenceToken,
    },
  });

  return {
    sessionFlow,
    sessionFlowMarkdown,
    routeBoundaryGraph,
    referenceParityGaps,
  };
}
