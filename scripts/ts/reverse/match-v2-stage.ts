import {
  buildDeobfuscationTableMatchV2,
  type BuildDeobfuscationTableMatchV2Input,
  type DeobfuscationTableReport,
} from "./match-v2";
import { applyNameMemory, persistNameMemory, type ApplyNameMemoryResult, type PersistNameMemoryResult } from "./name-memory";
import { buildSemanticIrFromDeobfuscationTable, type SemanticIrModel } from "./semantic-ir";
import { resolveSemanticOwnership, type OwnershipResolutionResult } from "./ownership-resolver";

export type MatchV2RuleId = "match_v2" | "name_memory_apply" | "name_memory_persist" | "semantic_ownership";

export interface MatchV2StageInput {
  repoRoot: string;
  appKey: string;
  matchInput: BuildDeobfuscationTableMatchV2Input;
}

interface SemanticOwnershipRuleOutput {
  semanticIrModel: SemanticIrModel;
  ownershipResolution: OwnershipResolutionResult;
}

interface MatchV2RuleOutputMap {
  match_v2: DeobfuscationTableReport;
  name_memory_apply: ApplyNameMemoryResult;
  name_memory_persist: PersistNameMemoryResult;
  semantic_ownership: SemanticOwnershipRuleOutput;
}

interface MatchV2RuleRuntime {
  input: MatchV2StageInput;
  outputs: Map<MatchV2RuleId, unknown>;
}

interface MatchV2RuleDefinition<Id extends MatchV2RuleId = MatchV2RuleId> {
  id: Id;
  dependsOn: MatchV2RuleId[];
  run(runtime: MatchV2RuleRuntime): MatchV2RuleOutputMap[Id];
}

export interface MatchV2StageResult {
  deobfuscationTable: DeobfuscationTableReport;
  nameMemoryApply: ApplyNameMemoryResult;
  nameMemoryPersist: PersistNameMemoryResult;
  semanticIrModel: SemanticIrModel;
  ownershipResolution: OwnershipResolutionResult;
  executedRules: MatchV2RuleId[];
}

function getRuleOutput<Id extends MatchV2RuleId>(
  runtime: MatchV2RuleRuntime,
  ruleId: Id,
): MatchV2RuleOutputMap[Id] {
  if (!runtime.outputs.has(ruleId)) {
    throw new Error(`Match-v2 rule output not found: ${ruleId}`);
  }
  return runtime.outputs.get(ruleId) as MatchV2RuleOutputMap[Id];
}

const MATCH_V2_RULE_REGISTRY: MatchV2RuleDefinition[] = [
  {
    id: "match_v2",
    dependsOn: [],
    run: (runtime) =>
      buildDeobfuscationTableMatchV2({
        ...runtime.input.matchInput,
      }),
  },
  {
    id: "name_memory_apply",
    dependsOn: ["match_v2"],
    run: (runtime) => {
      const deobfuscationTable = getRuleOutput(runtime, "match_v2");
      return applyNameMemory({
        repoRoot: runtime.input.repoRoot,
        appKey: runtime.input.appKey,
        deobfuscationTable,
      });
    },
  },
  {
    id: "name_memory_persist",
    dependsOn: ["name_memory_apply"],
    run: (runtime) => {
      const applied = getRuleOutput(runtime, "name_memory_apply");
      return persistNameMemory({
        repoRoot: runtime.input.repoRoot,
        appKey: runtime.input.appKey,
        deobfuscationTable: applied.deobfuscationTable,
      });
    },
  },
  {
    id: "semantic_ownership",
    dependsOn: ["name_memory_apply"],
    run: (runtime) => {
      const applied = getRuleOutput(runtime, "name_memory_apply");
      const semanticIrModel = buildSemanticIrFromDeobfuscationTable(applied.deobfuscationTable);
      const ownershipResolution = resolveSemanticOwnership(semanticIrModel);
      return {
        semanticIrModel,
        ownershipResolution,
      };
    },
  },
];

function resolveRuleExecutionOrder(registry: MatchV2RuleDefinition[]): MatchV2RuleDefinition[] {
  const byId = new Map<MatchV2RuleId, MatchV2RuleDefinition>();
  for (const rule of registry) {
    if (byId.has(rule.id)) {
      throw new Error(`Duplicate match-v2 rule id: ${rule.id}`);
    }
    byId.set(rule.id, rule);
  }

  const visiting = new Set<MatchV2RuleId>();
  const visited = new Set<MatchV2RuleId>();
  const ordered: MatchV2RuleDefinition[] = [];

  const visit = (ruleId: MatchV2RuleId, stack: MatchV2RuleId[]): void => {
    if (visited.has(ruleId)) return;
    if (visiting.has(ruleId)) {
      const cycle = [...stack, ruleId].join(" -> ");
      throw new Error(`Cyclic match-v2 rule dependencies: ${cycle}`);
    }

    const rule = byId.get(ruleId);
    if (!rule) {
      throw new Error(`Unknown match-v2 rule dependency: ${ruleId}`);
    }

    visiting.add(ruleId);
    for (const dependencyId of rule.dependsOn) {
      visit(dependencyId, [...stack, ruleId]);
    }
    visiting.delete(ruleId);
    visited.add(ruleId);
    ordered.push(rule);
  };

  for (const rule of registry) {
    visit(rule.id, []);
  }

  return ordered;
}

export function runMatchV2Stage(input: MatchV2StageInput): MatchV2StageResult {
  const runtime: MatchV2RuleRuntime = {
    input,
    outputs: new Map<MatchV2RuleId, unknown>(),
  };

  const orderedRules = resolveRuleExecutionOrder(MATCH_V2_RULE_REGISTRY);
  for (const rule of orderedRules) {
    const output = rule.run(runtime);
    runtime.outputs.set(rule.id, output);
  }

  const nameMemoryApply = getRuleOutput(runtime, "name_memory_apply");
  const nameMemoryPersist = getRuleOutput(runtime, "name_memory_persist");
  const semanticOwnership = getRuleOutput(runtime, "semantic_ownership");

  return {
    deobfuscationTable: nameMemoryApply.deobfuscationTable,
    nameMemoryApply,
    nameMemoryPersist,
    semanticIrModel: semanticOwnership.semanticIrModel,
    ownershipResolution: semanticOwnership.ownershipResolution,
    executedRules: orderedRules.map((rule) => rule.id),
  };
}
