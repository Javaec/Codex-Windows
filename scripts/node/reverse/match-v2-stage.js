"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMatchV2Stage = runMatchV2Stage;
const match_v2_1 = require("./match-v2");
const name_memory_1 = require("./name-memory");
const semantic_ir_1 = require("./semantic-ir");
const ownership_resolver_1 = require("./ownership-resolver");
function getRuleOutput(runtime, ruleId) {
    if (!runtime.outputs.has(ruleId)) {
        throw new Error(`Match-v2 rule output not found: ${ruleId}`);
    }
    return runtime.outputs.get(ruleId);
}
const MATCH_V2_RULE_REGISTRY = [
    {
        id: "match_v2",
        dependsOn: [],
        run: (runtime) => (0, match_v2_1.buildDeobfuscationTableMatchV2)({
            ...runtime.input.matchInput,
        }),
    },
    {
        id: "name_memory_apply",
        dependsOn: ["match_v2"],
        run: (runtime) => {
            const deobfuscationTable = getRuleOutput(runtime, "match_v2");
            return (0, name_memory_1.applyNameMemory)({
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
            return (0, name_memory_1.persistNameMemory)({
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
            const semanticIrModel = (0, semantic_ir_1.buildSemanticIrFromDeobfuscationTable)(applied.deobfuscationTable);
            const ownershipResolution = (0, ownership_resolver_1.resolveSemanticOwnership)(semanticIrModel);
            return {
                semanticIrModel,
                ownershipResolution,
            };
        },
    },
];
function resolveRuleExecutionOrder(registry) {
    const byId = new Map();
    for (const rule of registry) {
        if (byId.has(rule.id)) {
            throw new Error(`Duplicate match-v2 rule id: ${rule.id}`);
        }
        byId.set(rule.id, rule);
    }
    const visiting = new Set();
    const visited = new Set();
    const ordered = [];
    const visit = (ruleId, stack) => {
        if (visited.has(ruleId))
            return;
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
function runMatchV2Stage(input) {
    const runtime = {
        input,
        outputs: new Map(),
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
