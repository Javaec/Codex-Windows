"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildReferenceParityGapsReport = buildReferenceParityGapsReport;
function addObservedKeyword(pool, value, splitReferenceToken) {
    for (const token of splitReferenceToken(value)) {
        const normalized = token.toLowerCase();
        if (normalized.length < 3)
            continue;
        pool.add(normalized);
    }
}
function isReferenceKeywordObserved(keyword, observed, observedValues, splitReferenceToken) {
    const normalized = keyword.toLowerCase();
    if (normalized.length < 3)
        return false;
    if (observed.has(normalized))
        return true;
    const parts = splitReferenceToken(keyword).map((part) => part.toLowerCase()).filter((part) => part.length >= 3);
    for (const part of parts) {
        if (observed.has(part))
            return true;
    }
    if (normalized.length < 5)
        return false;
    for (const observedValue of observedValues) {
        if (observedValue.includes(normalized))
            return true;
        if (normalized.includes(observedValue) && observedValue.length >= 5)
            return true;
    }
    return false;
}
function roundMetric(value) {
    return Math.round(value * 100) / 100;
}
function getParityGapConfidenceTier(impactScore, thresholds) {
    if (impactScore >= thresholds.critical)
        return "critical";
    if (impactScore >= thresholds.high)
        return "high";
    return "medium";
}
function buildReferenceParityGapsReport(input) {
    const observedKeywordPool = new Set();
    const observedValues = new Set();
    const pushObserved = (value) => {
        const normalized = value.trim().toLowerCase();
        if (!normalized)
            return;
        observedValues.add(normalized);
        addObservedKeyword(observedKeywordPool, normalized, input.helpers.splitReferenceToken);
    };
    const rowGroups = [
        input.routeRows,
        input.methodRows,
        input.messageTypeRows,
        input.statusRows,
        input.stateKeyRows,
        input.ipcRows,
    ];
    for (const rows of rowGroups) {
        for (const row of rows)
            pushObserved(row.value);
    }
    for (const boundary of input.componentBoundaries.boundaries) {
        for (const value of boundary.componentNames)
            pushObserved(value);
        for (const value of boundary.hookNames)
            pushObserved(value);
        for (const value of boundary.uiIndicators)
            pushObserved(value);
        for (const value of boundary.routes)
            pushObserved(value);
        for (const value of boundary.events)
            pushObserved(value);
        for (const value of boundary.rpcMethods)
            pushObserved(value);
        for (const value of boundary.stateKeys)
            pushObserved(value);
        for (const value of boundary.statuses)
            pushObserved(value);
        for (const value of boundary.ipcChannels)
            pushObserved(value);
    }
    for (const methodRow of input.rpcSchema.methods) {
        pushObserved(methodRow.method);
        for (const key of methodRow.payloadKeys)
            pushObserved(key);
        for (const hint of methodRow.readinessHints)
            pushObserved(hint);
        for (const envelope of methodRow.envelopes)
            pushObserved(envelope);
    }
    const observedValueList = Array.from(observedValues);
    const domains = [];
    for (const [domainKey, domainConfig] of Object.entries(input.domainDefinitions)) {
        const referenceKeywords = input.helpers.dedupeKeywords([...domainConfig.keywords, ...(input.referenceProfile.keywordGroups.domains[domainKey] ?? [])], 260);
        const matched = [];
        const missing = [];
        for (const keyword of referenceKeywords) {
            if (isReferenceKeywordObserved(keyword, observedKeywordPool, observedValueList, input.helpers.splitReferenceToken)) {
                matched.push(keyword);
            }
            else {
                missing.push(keyword);
            }
        }
        const coveragePercent = referenceKeywords.length > 0 ? roundMetric((matched.length / referenceKeywords.length) * 100) : 100;
        const priorityWeight = domainConfig.parityWeight;
        const gapScore = roundMetric((100 - coveragePercent) * priorityWeight);
        const missingRatio = 1 - coveragePercent / 100;
        const evidenceStrength = Math.min(1, referenceKeywords.length / 140);
        const impactScore = roundMetric((missingRatio * 100 * priorityWeight * (0.65 + evidenceStrength * 0.35)) + Math.min(18, missing.length * 0.22));
        const confidenceTier = getParityGapConfidenceTier(impactScore, input.tierThresholds);
        domains.push({
            domain: domainKey,
            label: domainConfig.label,
            priorityWeight,
            referenceKeywords: referenceKeywords.length,
            observedKeywords: matched.length,
            matchedKeywords: matched.slice(0, 36),
            missingKeywords: missing.slice(0, 36),
            coveragePercent,
            gapScore,
            impactScore,
            confidenceTier,
            priorityRank: 0,
        });
    }
    const totalWeight = domains.reduce((sum, row) => sum + row.priorityWeight, 0);
    const weightedCoveragePercent = totalWeight > 0
        ? roundMetric(domains.reduce((sum, row) => sum + row.coveragePercent * row.priorityWeight, 0) / totalWeight)
        : 100;
    const weightedGapScore = totalWeight > 0
        ? roundMetric(domains.reduce((sum, row) => sum + row.gapScore * row.priorityWeight, 0) / totalWeight)
        : 0;
    const rankedDomains = [...domains].sort((a, b) => {
        if (a.impactScore !== b.impactScore)
            return b.impactScore - a.impactScore;
        if (a.gapScore !== b.gapScore)
            return b.gapScore - a.gapScore;
        if (a.coveragePercent !== b.coveragePercent)
            return a.coveragePercent - b.coveragePercent;
        return a.domain.localeCompare(b.domain);
    });
    for (let i = 0; i < rankedDomains.length; i += 1) {
        rankedDomains[i].priorityRank = i + 1;
    }
    return {
        generatedAtUtc: new Date().toISOString(),
        strategy: "Auto-ranked reference parity gaps by matching 1code/CodexMonitor keyword priors against observed app signals (routes/methods/events/state/ipc/components/rpc-schema), with impact scoring and confidence tiers.",
        domains: rankedDomains,
        topGaps: rankedDomains.slice(0, 6),
        coverage: {
            weightedCoveragePercent,
            weightedGapScore,
            domains: rankedDomains.length,
        },
    };
}
