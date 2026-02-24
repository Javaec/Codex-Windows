"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildModuleSynthesisContract = buildModuleSynthesisContract;
function inferTemplateKind(modulePath, layer) {
    const normalized = modulePath.toLowerCase();
    if (normalized.includes("/hooks/") || /\/use[A-Z]/.test(modulePath))
        return "hook";
    if (normalized.includes("transport") || normalized.includes("ipc") || normalized.includes("socket"))
        return "transport";
    if (normalized.includes("/store/") || normalized.includes("state") || normalized.includes("cache") || normalized.includes("registry")) {
        return "store";
    }
    if (normalized.includes("/components/") || normalized.includes("/ui/"))
        return "ui";
    if (normalized.startsWith("src/services/") || layer === "services")
        return "service";
    if (layer === "renderer")
        return "ui";
    return "service";
}
function baseBudgetByArchetype(archetype) {
    if (archetype === "hook")
        return 900;
    if (archetype === "ui")
        return 1200;
    if (archetype === "store")
        return 1400;
    if (archetype === "transport")
        return 1800;
    return 2200;
}
function budgetAdjustmentBySymbolCount(symbolCount) {
    if (symbolCount >= 48)
        return 1800;
    if (symbolCount >= 24)
        return 1200;
    if (symbolCount >= 12)
        return 700;
    if (symbolCount >= 6)
        return 320;
    return 0;
}
function buildModuleSynthesisContract(input) {
    const kind = inferTemplateKind(input.module.modulePath, input.module.ownerLayer);
    const symbolCount = input.module.symbols.length;
    const baseBudget = baseBudgetByArchetype(kind);
    const budget = Math.min(5200, Math.max(640, baseBudget + budgetAdjustmentBySymbolCount(symbolCount)));
    const denseCandidates = input.candidateExports >= 700;
    const maxPrimaryStatementLength = denseCandidates ? 52000 : kind === "hook" ? 42000 : kind === "transport" ? 68000 : 56000;
    const maxDependencyStatementLength = denseCandidates ? 120000 : kind === "transport" ? 180000 : 150000;
    const maxSelectedExports = kind === "hook" ? 6 : kind === "ui" ? 8 : kind === "transport" ? 8 : 10;
    const requiredSymbolKinds = kind === "hook"
        ? ["function", "variable"]
        : kind === "transport"
            ? ["class", "function"]
            : kind === "ui"
                ? ["class", "function"]
                : kind === "store"
                    ? ["function", "variable"]
                    : ["class", "function", "variable"];
    const preferredNameTokens = kind === "hook"
        ? ["use", "hook", "state", "signal"]
        : kind === "ui"
            ? ["component", "ui", "view", "panel", "modal"]
            : kind === "transport"
                ? ["transport", "ipc", "event", "stream", "connection"]
                : kind === "store"
                    ? ["store", "state", "cache", "registry"]
                    : ["service", "manager", "provider", "client"];
    return {
        layer: input.module.ownerLayer,
        kind,
        statementBudget: budget,
        maxPrimaryStatementLength,
        maxDependencyStatementLength,
        maxSelectedExports,
        allowClosestFallback: false,
        requiredSymbolKinds,
        preferredNameTokens,
    };
}
