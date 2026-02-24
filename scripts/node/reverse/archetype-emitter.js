"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitArchetypeModule = emitArchetypeModule;
const post_lift_beautify_1 = require("./post-lift-beautify");
const symbol_lifter_1 = require("./symbol-lifter");
const ARCHETYPE_EXPORT_WEIGHT_BUDGET = {
    hook: 5,
    ui: 7,
    transport: 8,
    store: 7,
    service: 7,
};
const ARCHETYPE_MIN_IMPORT_CONTRACT = {
    hook: 0,
    ui: 1,
    transport: 1,
    store: 0,
    service: 0,
};
function toRowKey(row) {
    return `${row.sourceSymbol}|${row.kind}`;
}
function getKindPriority(kind) {
    if (kind === "class")
        return 4;
    if (kind === "function")
        return 3;
    return 1;
}
function estimateExportWeight(row) {
    if (row.declarationLength <= 0)
        return 1;
    return Math.max(1, Math.min(6, Math.ceil(row.declarationLength / 1800)));
}
function computeTemplateScore(row, contract) {
    const requiredBonus = contract.requiredSymbolKinds.includes(row.kind) ? 3 : 0;
    const declarationPenalty = row.declarationLength > 0 ? Math.min(2.5, row.declarationLength / 6400) : 0;
    return row.confidence * 12 + row.nameQuality * 8 - row.generatedSignal * 10 + requiredBonus - declarationPenalty + getKindPriority(row.kind);
}
function rankRows(rows, contract) {
    return [...rows].sort((a, b) => {
        const scoreDelta = computeTemplateScore(b, contract) - computeTemplateScore(a, contract);
        if (scoreDelta !== 0)
            return scoreDelta;
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.nameQuality !== b.nameQuality)
            return b.nameQuality - a.nameQuality;
        if (a.generatedSignal !== b.generatedSignal)
            return a.generatedSignal - b.generatedSignal;
        if (a.declarationLength !== b.declarationLength)
            return a.declarationLength - b.declarationLength;
        return a.name.localeCompare(b.name);
    });
}
function buildTemplatePool(input) {
    const pool = new Map();
    for (const row of input.selectedRows) {
        pool.set(toRowKey(row), { ...row });
    }
    for (const row of input.candidateRows) {
        const key = toRowKey(row);
        if (!pool.has(key)) {
            pool.set(key, { ...row });
        }
    }
    return Array.from(pool.values());
}
function isTemplateRowUsable(row) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(row.name))
        return false;
    if (row.name.length < 3)
        return false;
    if (/^[A-Za-z_$]{1,2}$/.test(row.name))
        return false;
    if (/^[a-z]{2,3}$/.test(row.name))
        return false;
    if (row.kind === "variable" && /^[a-z]{2,4}$/.test(row.name))
        return false;
    if (row.nameQuality < 0.52)
        return false;
    return true;
}
function enforceTemplateSelection(input) {
    const rawPool = buildTemplatePool({
        selectedRows: input.selectedRows,
        candidateRows: input.candidateRows,
    });
    const filteredPoolRows = rawPool.filter((row) => isTemplateRowUsable(row));
    const pool = rankRows(filteredPoolRows.length > 0 ? filteredPoolRows : rawPool, input.contract);
    if (pool.length === 0) {
        throw new Error(`Template selection failed: no candidate exports for archetype=${input.contract.kind}`);
    }
    const maxSelected = Math.max(1, input.contract.maxSelectedExports);
    const selected = new Map();
    const requiredKinds = input.contract.requiredSymbolKinds.filter((kind) => pool.some((row) => row.kind === kind));
    const addedRequiredKinds = [];
    for (const row of rankRows(input.selectedRows.filter((item) => isTemplateRowUsable(item)), input.contract)) {
        if (selected.size >= maxSelected)
            break;
        selected.set(toRowKey(row), { ...row });
    }
    for (const kind of requiredKinds) {
        const alreadyHasKind = Array.from(selected.values()).some((row) => row.kind === kind);
        if (alreadyHasKind)
            continue;
        const candidate = pool.find((row) => row.kind === kind && !selected.has(toRowKey(row)));
        if (!candidate)
            continue;
        if (selected.size >= maxSelected) {
            const selectedRows = Array.from(selected.values());
            const countByKind = new Map();
            for (const row of selectedRows) {
                countByKind.set(row.kind, (countByKind.get(row.kind) ?? 0) + 1);
            }
            const weakestOptional = rankRows(Array.from(selected.values()), input.contract)
                .reverse()
                .find((row) => !requiredKinds.includes(row.kind) || (countByKind.get(row.kind) ?? 0) > 1);
            if (!weakestOptional) {
                throw new Error(`Template export contract failed: required kind ${kind} cannot fit into maxSelectedExports=${maxSelected} for archetype=${input.contract.kind}`);
            }
            selected.delete(toRowKey(weakestOptional));
        }
        selected.set(toRowKey(candidate), { ...candidate });
        addedRequiredKinds.push(kind);
    }
    const exportWeightBudget = ARCHETYPE_EXPORT_WEIGHT_BUDGET[input.contract.kind];
    const ranked = rankRows(Array.from(selected.values()), input.contract);
    const keep = [];
    const mustKeepKinds = new Set(requiredKinds);
    let consumedWeight = 0;
    let droppedByTemplateBudget = 0;
    let droppedByTemplateCap = 0;
    for (const row of ranked) {
        if (keep.length >= maxSelected) {
            droppedByTemplateCap += 1;
            continue;
        }
        const weight = estimateExportWeight(row);
        const requiredKindRow = mustKeepKinds.has(row.kind) && !keep.some((item) => item.kind === row.kind);
        if (!requiredKindRow && consumedWeight + weight > exportWeightBudget) {
            droppedByTemplateBudget += 1;
            continue;
        }
        keep.push(row);
        consumedWeight += weight;
    }
    for (const kind of requiredKinds) {
        if (keep.some((row) => row.kind === kind))
            continue;
        const fallback = ranked.find((row) => row.kind === kind && !keep.some((item) => toRowKey(item) === toRowKey(row)));
        if (!fallback) {
            throw new Error(`Template export contract failed: required kind ${kind} dropped for archetype=${input.contract.kind}`);
        }
        if (keep.length >= maxSelected) {
            const weakestOptionalIndex = keep
                .map((row, index) => ({ row, index }))
                .sort((a, b) => computeTemplateScore(a.row, input.contract) - computeTemplateScore(b.row, input.contract))
                .find((item) => !requiredKinds.includes(item.row.kind))?.index;
            if (typeof weakestOptionalIndex !== "number") {
                throw new Error(`Template export contract failed: required kind ${kind} cannot be restored after budget trimming for archetype=${input.contract.kind}`);
            }
            keep.splice(weakestOptionalIndex, 1);
        }
        keep.push(fallback);
    }
    const finalRows = rankRows(keep, input.contract).slice(0, maxSelected);
    if (finalRows.length === 0) {
        throw new Error(`Template selection failed: no exports survived contract for archetype=${input.contract.kind}`);
    }
    return {
        rows: finalRows,
        addedRequiredKinds,
        droppedByTemplateBudget,
        droppedByTemplateCap,
        exportWeightBudget,
    };
}
function countStaticImports(moduleBody) {
    return (moduleBody.match(/^\s*import\s/gm) ?? []).length;
}
function evaluateTemplateImportContract(input) {
    const minImports = ARCHETYPE_MIN_IMPORT_CONTRACT[input.archetype];
    if (minImports <= 0)
        return false;
    const sizeableModule = input.includedStatements >= Math.max(40, input.exportCount + 20);
    if (!sizeableModule)
        return false;
    return input.importCount < minImports;
}
function emitArchetypeModule(input) {
    const templateSelection = enforceTemplateSelection({
        contract: input.contract,
        selectedRows: input.selectedRows,
        candidateRows: input.candidateRows,
    });
    const exportRows = templateSelection.rows;
    const lifted = (0, symbol_lifter_1.liftModuleSource)({
        sourceFilePath: input.sourceFilePath,
        sourceText: input.sourceText,
        exports: exportRows.map((item) => ({
            exportName: item.name,
            sourceSymbol: item.sourceSymbol,
            kind: item.kind,
            sourceLine: item.sourceLine,
        })),
        maxDependencyStatements: input.contract.statementBudget,
        maxDependencyStatementLength: input.contract.maxDependencyStatementLength,
        maxPrimaryStatementLength: input.contract.maxPrimaryStatementLength,
        allowClosestFallback: input.contract.allowClosestFallback,
        allowParserRegistryUnpack: false,
    });
    const unresolvedRequired = lifted.unresolvedExports.filter((item) => item.kind === "class" || item.kind === "function");
    if ((lifted.liftedExports.length === 0 && exportRows.length > 0) || unresolvedRequired.length > 0) {
        const unresolvedPreview = unresolvedRequired
            .slice(0, 4)
            .map((item) => `${item.kind}:${item.sourceSymbol}->${item.exportName}@${item.sourceLine}`)
            .join(", ");
        throw new Error(`Strict AST lift failed for ${input.emittedPath} from ${input.sourceFilePath}. selected=${exportRows.length}, lifted=${lifted.liftedExports.length}, unresolvedRequired=${unresolvedRequired.length}${unresolvedPreview.length > 0 ? ` [${unresolvedPreview}]` : ""}`);
    }
    const statementBudgetViolated = lifted.includedStatements > input.contract.statementBudget;
    if (statementBudgetViolated) {
        throw new Error(`Template statement-budget exceeded for ${input.emittedPath}: included=${lifted.includedStatements}, budget=${input.contract.statementBudget}`);
    }
    const moduleBody = (0, post_lift_beautify_1.postLiftBeautifyModuleSource)({
        moduleBody: lifted.moduleBody,
        exportedNames: exportRows.map((item) => item.name),
        emittedPath: input.emittedPath,
    });
    const importCount = countStaticImports(moduleBody);
    const importContractViolated = evaluateTemplateImportContract({
        archetype: input.contract.kind,
        importCount,
        includedStatements: lifted.includedStatements,
        exportCount: exportRows.length,
    });
    return {
        moduleBody,
        exportRows,
        lifted,
        unresolvedRequired,
        diagnostics: {
            archetype: input.contract.kind,
            selectedBeforeTemplate: input.selectedRows.length,
            selectedAfterTemplate: exportRows.length,
            addedRequiredKinds: templateSelection.addedRequiredKinds,
            droppedByTemplateBudget: templateSelection.droppedByTemplateBudget,
            droppedByTemplateCap: templateSelection.droppedByTemplateCap,
            exportWeightBudget: templateSelection.exportWeightBudget,
            importCount,
            importContractViolated,
            statementBudget: input.contract.statementBudget,
            includedStatements: lifted.includedStatements,
            statementBudgetViolated,
        },
    };
}
