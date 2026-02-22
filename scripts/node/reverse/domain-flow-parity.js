"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDomainBoundaryPipeline = buildDomainBoundaryPipeline;
exports.buildFlowParityPipeline = buildFlowParityPipeline;
const domain_boundaries_1 = require("./domain-boundaries");
const session_route_flow_1 = require("./session-route-flow");
const reference_parity_1 = require("./reference-parity");
function buildDomainBoundaryPipeline(input) {
    const domainDefinitions = input.referenceModel.unified.domainDefinitions;
    const domainReport = (0, domain_boundaries_1.buildDomainReport)({
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
    const componentBoundaries = (0, domain_boundaries_1.buildComponentBoundariesReport)({
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
function buildFlowParityPipeline(input) {
    const sessionFlow = (0, session_route_flow_1.buildSessionFlowReport)({
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
    const sessionFlowMarkdown = (0, session_route_flow_1.formatSessionFlowMarkdown)(sessionFlow);
    const routeBoundaryGraph = (0, session_route_flow_1.buildRouteBoundaryGraphReport)({
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
    const referenceParityGaps = (0, reference_parity_1.buildReferenceParityGapsReport)({
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
