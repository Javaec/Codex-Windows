"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeReverseReportArtifacts = writeReverseReportArtifacts;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../lib/exec");
function writeJson(filePath, value) {
    (0, exec_1.ensureDir)(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function writeReverseReportArtifacts(input) {
    writeJson(path.join(input.reportDir, "summary.json"), input.summary);
    writeJson(path.join(input.reportDir, "files.json"), input.files);
    writeJson(path.join(input.reportDir, "chunk-graph.json"), Object.fromEntries(input.importsGraph.entries()));
    writeJson(path.join(input.reportDir, "ipc-channels.json"), input.ipcRows);
    writeJson(path.join(input.reportDir, "methods.json"), input.methodRows);
    writeJson(path.join(input.reportDir, "rpc-catalog.json"), input.rpcCatalog);
    writeJson(path.join(input.reportDir, "rpc-schema.json"), input.rpcSchema);
    writeJson(path.join(input.reportDir, "routes.json"), input.routeRows);
    writeJson(path.join(input.reportDir, "message-types.json"), input.messageTypeRows);
    writeJson(path.join(input.reportDir, "statuses.json"), input.statusRows);
    writeJson(path.join(input.reportDir, "state-keys.json"), input.stateKeyRows);
    writeJson(path.join(input.reportDir, "domain-report.json"), input.domainReport);
    writeJson(path.join(input.reportDir, "ipc-contract-map.json"), input.ipcContractMap);
    writeJson(path.join(input.reportDir, "component-boundaries.json"), input.componentBoundaries);
    writeJson(path.join(input.reportDir, "deobfuscation-table.json"), input.deobfuscationTable);
    writeJson(path.join(input.reportDir, "session-flow.json"), input.sessionFlow);
    writeJson(path.join(input.reportDir, "route-boundary-graph.json"), input.routeBoundaryGraph);
    writeJson(path.join(input.reportDir, "reference-parity-gaps.json"), input.referenceParityGaps);
    writeJson(path.join(input.reportDir, "runtime-probe.json"), input.runtimeProbe);
    writeJson(path.join(input.reportDir, "parse-failures.json"), input.parseFailureRows);
    writeJson(path.join(input.reportDir, "design-system.json"), input.designSystem);
    writeJson(path.join(input.reportDir, "reference-model.json"), input.referenceModel);
    writeJson(path.join(input.reportDir, "reference-signals.json"), input.referenceSignals);
    writeJson(path.join(input.reportDir, "reference-symbols.json"), input.referenceSymbols);
    writeJson(path.join(input.reportDir, "quality-gates.json"), input.qualityGates);
    fs.writeFileSync(path.join(input.reportDir, "deobfuscation-table.md"), input.deobfuscationMarkdown, "utf8");
    fs.writeFileSync(path.join(input.reportDir, "deobfuscation-table.csv"), input.deobfuscationCsv, "utf8");
    fs.writeFileSync(path.join(input.reportDir, "rename-plan.md"), input.renamePlanMarkdown, "utf8");
    fs.writeFileSync(path.join(input.reportDir, "session-flow.md"), input.sessionFlowMarkdown, "utf8");
    fs.writeFileSync(path.join(input.reportDir, "architecture.md"), input.architectureMarkdown, "utf8");
    if (!input.binary)
        return;
    writeJson(path.join(input.reportDir, "binary-signals.json"), input.binary);
    fs.writeFileSync(path.join(input.reportDir, "binary-rpc-methods.txt"), `${input.binary.rpcLikeMethods.join("\n")}\n`, "utf8");
    fs.writeFileSync(path.join(input.reportDir, "binary-raw-signals.txt"), `${input.binary.rawMatches.join("\n")}\n`, "utf8");
}
