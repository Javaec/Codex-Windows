import type { SemanticIrModule, SemanticLayer } from "./semantic-ir";

export type ModuleTemplateKind = "default" | "hook" | "transport";

export interface ModuleSynthesisContract {
  layer: SemanticLayer;
  kind: ModuleTemplateKind;
  statementBudget: number;
  maxPrimaryStatementLength: number;
  maxDependencyStatementLength: number;
  maxSelectedExports: number;
  allowClosestFallback: boolean;
  requiredSymbolKinds: Array<"class" | "function" | "variable">;
}

function inferTemplateKind(modulePath: string): ModuleTemplateKind {
  const normalized = modulePath.toLowerCase();
  if (normalized.includes("/hooks/") || /\/use[A-Z]/.test(modulePath)) return "hook";
  if (normalized.includes("transport")) return "transport";
  return "default";
}

function baseBudgetByLayer(layer: SemanticLayer): number {
  if (layer === "renderer") return 420;
  if (layer === "services") return 500;
  if (layer === "main") return 520;
  if (layer === "tauri") return 520;
  return 460;
}

function budgetAdjustmentBySymbolCount(symbolCount: number): number {
  if (symbolCount >= 24) return 180;
  if (symbolCount >= 12) return 120;
  if (symbolCount >= 6) return 70;
  return 0;
}

export function buildModuleSynthesisContract(input: {
  module: SemanticIrModule;
  candidateExports: number;
}): ModuleSynthesisContract {
  const kind = inferTemplateKind(input.module.modulePath);
  const symbolCount = input.module.symbols.length;
  const baseBudget = baseBudgetByLayer(input.module.ownerLayer);
  const budget = Math.min(900, Math.max(260, baseBudget + budgetAdjustmentBySymbolCount(symbolCount)));
  const denseCandidates = input.candidateExports >= 700;
  const maxPrimaryStatementLength = denseCandidates ? 3600 : kind === "hook" ? 4200 : 5200;
  const maxDependencyStatementLength = denseCandidates ? 5200 : kind === "transport" ? 7000 : 6000;
  const maxSelectedExports = kind === "default" ? 14 : 10;
  const requiredSymbolKinds =
    kind === "hook"
      ? (["function", "variable"] as Array<"class" | "function" | "variable">)
      : kind === "transport"
        ? (["class", "function"] as Array<"class" | "function" | "variable">)
        : (["class", "function", "variable"] as Array<"class" | "function" | "variable">);

  return {
    layer: input.module.ownerLayer,
    kind,
    statementBudget: budget,
    maxPrimaryStatementLength,
    maxDependencyStatementLength,
    maxSelectedExports,
    allowClosestFallback: false,
    requiredSymbolKinds,
  };
}

