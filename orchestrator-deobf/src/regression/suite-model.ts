import { ToolWeights } from "../contracts";

export interface RegressionProfileFlags {
  enableWakaru: boolean;
  enableJavascriptDeobfuscator: boolean;
  enableSynchrony: boolean;
  enableUnwebpackSourcemap: boolean;
  javascriptDeobfuscatorParseAsModule: boolean;
  synchronyRename: boolean;
  synchronyLoose: boolean;
  unwebpackSourcemapMaxMaps: number;
  wakaruConcurrency: number;
  statementBudget: number;
}

export interface RegressionProfile {
  id: string;
  description: string;
  flags: RegressionProfileFlags;
}

export interface RegressionSuite {
  version: number;
  profiles: RegressionProfile[];
}

export interface RegressionProfileResult {
  profileId: string;
  runId: string;
  runDirectory: string;
  summaryPath: string;
  metricsPath: string;
}

export interface RegressionCandidate {
  candidateId: string;
  label: string;
  weights: ToolWeights;
}
