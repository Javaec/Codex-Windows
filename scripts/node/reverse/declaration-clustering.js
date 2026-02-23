"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyArchetypeAndCluster = applyArchetypeAndCluster;
function splitIdentifierTokens(input) {
    const normalized = input
        .replace(/[_\-./:]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    return normalized
        .split(/\s+/g)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length > 0);
}
function scorePathAlignment(name, emittedPath) {
    const moduleTokens = new Set(splitIdentifierTokens(emittedPath));
    const nameTokens = splitIdentifierTokens(name);
    if (moduleTokens.size === 0 || nameTokens.length === 0)
        return 0;
    let hits = 0;
    for (const token of nameTokens) {
        if (moduleTokens.has(token))
            hits += 1;
    }
    return Math.min(4, hits);
}
function scoreArchetypeNameFit(archetype, row, emittedPath) {
    const name = row.name.toLowerCase();
    const alignment = scorePathAlignment(row.name, emittedPath);
    if (archetype === "hook") {
        if (/^use[A-Z]/.test(row.name) && row.kind === "function")
            return 3 + alignment;
        if (/(state|signal|registry|store|hook)/.test(name))
            return 2 + alignment;
        return alignment - 1;
    }
    if (archetype === "ui") {
        if (/(component|ui|view|panel|modal|button|menu|classnames)/.test(name))
            return 2 + alignment;
        if (row.kind === "class")
            return 1 + alignment;
        return alignment;
    }
    if (archetype === "transport") {
        if (/(transport|ipc|event|stream|connection|socket)/.test(name))
            return 3 + alignment;
        return alignment - 1;
    }
    if (archetype === "store") {
        if (/(store|state|cache|registry|signal)/.test(name))
            return 3 + alignment;
        return alignment;
    }
    if (/(service|manager|provider|client|runtime|factory)/.test(name))
        return 2 + alignment;
    return alignment;
}
function isKindAllowed(contract, kind) {
    return contract.requiredSymbolKinds.includes(kind);
}
function pickBestGraphNode(nodes) {
    if (nodes.length === 0)
        return undefined;
    const sorted = [...nodes].sort((a, b) => {
        if (a.generatedSignal !== b.generatedSignal)
            return a.generatedSignal - b.generatedSignal;
        if (a.statementLength !== b.statementLength)
            return a.statementLength - b.statementLength;
        return a.line - b.line;
    });
    return sorted[0];
}
function addEdgeWeight(map, left, right, weight) {
    if (left === right)
        return;
    const ordered = [left, right].sort((a, b) => a.localeCompare(b));
    const key = `${ordered[0]}::${ordered[1]}`;
    map.set(key, (map.get(key) ?? 0) + weight);
}
function buildDependencyEdges(input) {
    const bySymbol = new Map();
    for (const row of input.rows)
        bySymbol.set(row.sourceSymbol, row);
    const edgeWeights = new Map();
    for (const row of input.rows) {
        const graphRows = input.declarationGraphByName.get(row.sourceSymbol) ?? [];
        const graph = pickBestGraphNode(graphRows);
        if (!graph)
            continue;
        for (const reference of graph.references) {
            if (!bySymbol.has(reference))
                continue;
            addEdgeWeight(edgeWeights, row.sourceSymbol, reference, 4);
        }
    }
    for (let index = 0; index < input.rows.length; index += 1) {
        const left = input.rows[index];
        for (let inner = index + 1; inner < input.rows.length; inner += 1) {
            const right = input.rows[inner];
            const leftTokens = new Set(splitIdentifierTokens(left.name));
            const rightTokens = splitIdentifierTokens(right.name);
            let overlap = 0;
            for (const token of rightTokens) {
                if (leftTokens.has(token))
                    overlap += 1;
            }
            if (overlap >= 2)
                addEdgeWeight(edgeWeights, left.sourceSymbol, right.sourceSymbol, 1);
            if (left.sourceLine > 0 && right.sourceLine > 0 && Math.abs(left.sourceLine - right.sourceLine) <= 12) {
                addEdgeWeight(edgeWeights, left.sourceSymbol, right.sourceSymbol, 1);
            }
        }
    }
    return edgeWeights;
}
function buildConnectedComponents(rows, edgeWeights) {
    const adjacency = new Map();
    for (const row of rows)
        adjacency.set(row.sourceSymbol, new Set());
    for (const [pair, weight] of edgeWeights.entries()) {
        if (weight < 3)
            continue;
        const [left, right] = pair.split("::");
        const leftSet = adjacency.get(left);
        const rightSet = adjacency.get(right);
        if (!leftSet || !rightSet)
            continue;
        leftSet.add(right);
        rightSet.add(left);
    }
    const bySymbol = new Map();
    for (const row of rows)
        bySymbol.set(row.sourceSymbol, row);
    const visited = new Set();
    const components = [];
    for (const row of rows) {
        if (visited.has(row.sourceSymbol))
            continue;
        const queue = [row.sourceSymbol];
        visited.add(row.sourceSymbol);
        const component = [];
        while (queue.length > 0) {
            const symbol = queue.shift();
            if (!symbol)
                continue;
            const current = bySymbol.get(symbol);
            if (current)
                component.push(current);
            const neighbors = adjacency.get(symbol) ?? new Set();
            for (const neighbor of neighbors) {
                if (visited.has(neighbor))
                    continue;
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
        if (component.length > 0)
            components.push(component);
    }
    return components;
}
function scoreRowForArchetype(row, contract, emittedPath) {
    const base = row.confidence * 10 + row.nameQuality * 5 - row.generatedSignal * 6;
    const archetype = scoreArchetypeNameFit(contract.kind, row, emittedPath);
    const kindBonus = isKindAllowed(contract, row.kind) ? 2 : -3;
    return base + archetype + kindBonus;
}
function scoreComponent(component, contract, emittedPath) {
    let score = 0;
    const kindSet = new Set();
    for (const row of component) {
        score += scoreRowForArchetype(row, contract, emittedPath);
        kindSet.add(row.kind);
    }
    for (const kind of contract.requiredSymbolKinds) {
        if (kindSet.has(kind))
            score += 2;
    }
    score += component.length * 1.2;
    return score;
}
function applyArchetypeAndCluster(input) {
    if (input.rows.length <= 1)
        return input.rows;
    const kindFiltered = input.rows.filter((row) => isKindAllowed(input.contract, row.kind));
    const filtered = kindFiltered.length > 0 ? kindFiltered : input.rows;
    const edgeWeights = buildDependencyEdges({
        rows: filtered,
        declarationGraphByName: input.declarationGraphByName,
    });
    const components = buildConnectedComponents(filtered, edgeWeights);
    if (components.length === 0)
        return filtered;
    const ranked = components
        .map((rows) => ({
        rows,
        score: scoreComponent(rows, input.contract, input.emittedPath),
    }))
        .sort((a, b) => b.score - a.score);
    const selected = ranked[0]?.rows ?? filtered;
    const finalRows = (selected.length >= 2 ? selected : filtered).sort((a, b) => {
        const scoreDelta = scoreRowForArchetype(b, input.contract, input.emittedPath) - scoreRowForArchetype(a, input.contract, input.emittedPath);
        if (scoreDelta !== 0)
            return scoreDelta;
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.declarationLength !== b.declarationLength)
            return a.declarationLength - b.declarationLength;
        return a.name.localeCompare(b.name);
    });
    return finalRows;
}
