import * as fs from "node:fs";
import * as path from "node:path";

import { ensureDir } from "../lib/exec";

export interface BinaryExtractionResult {
  binaryPath: string | null;
  rawMatches: string[];
  rpcLikeMethods: string[];
}

export interface ReverseReportWriterInput {
  reportDir: string;
  summary: unknown;
  files: unknown;
  importsGraph: Map<string, string[]>;
  ipcRows: unknown;
  methodRows: unknown;
  rpcCatalog: unknown;
  rpcSchema: unknown;
  routeRows: unknown;
  messageTypeRows: unknown;
  statusRows: unknown;
  stateKeyRows: unknown;
  domainReport: unknown;
  ipcContractMap: unknown;
  componentBoundaries: unknown;
  deobfuscationTable: unknown;
  sessionFlow: unknown;
  routeBoundaryGraph: unknown;
  referenceParityGaps: unknown;
  runtimeProbe: unknown;
  parseFailureRows: unknown;
  designSystem: unknown;
  referenceModel: unknown;
  referenceSignals: unknown;
  referenceSymbols: unknown;
  qualityGates: unknown;
  deobfuscationMarkdown: string;
  deobfuscationCsv: string;
  renamePlanMarkdown: string;
  sessionFlowMarkdown: string;
  architectureMarkdown: string;
  binary: BinaryExtractionResult | null;
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeReverseReportArtifacts(input: ReverseReportWriterInput): void {
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

  if (!input.binary) return;

  writeJson(path.join(input.reportDir, "binary-signals.json"), input.binary);
  fs.writeFileSync(
    path.join(input.reportDir, "binary-rpc-methods.txt"),
    `${input.binary.rpcLikeMethods.join("\n")}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(input.reportDir, "binary-raw-signals.txt"),
    `${input.binary.rawMatches.join("\n")}\n`,
    "utf8",
  );
}
