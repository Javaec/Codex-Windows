"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postLiftBeautifyModuleSource = postLiftBeautifyModuleSource;
function normalizeWhitespace(text) {
    const normalized = text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}
function normalizeSimpleObjectAliases(text) {
    return text
        .replace(/^var ([A-Za-z_$][A-Za-z0-9_$]*) = Object\.create;$/gm, "const $1 = Object.create;")
        .replace(/^var ([A-Za-z_$][A-Za-z0-9_$]*) = Object\.defineProperty;$/gm, "const $1 = Object.defineProperty;")
        .replace(/^var ([A-Za-z_$][A-Za-z0-9_$]*) = Object\.getOwnPropertyNames;$/gm, "const $1 = Object.getOwnPropertyNames;")
        .replace(/^var ([A-Za-z_$][A-Za-z0-9_$]*) = Object\.getPrototypeOf;$/gm, "const $1 = Object.getPrototypeOf;");
}
function stableExportOrder(text, exportedNames) {
    const lines = text.split("\n");
    const exportLineIndexes = [];
    const exportNameByIndex = new Map();
    const pattern = /^export \{ ([A-Za-z_$][A-Za-z0-9_$]*) \};$/;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const match = line.match(pattern);
        if (!match)
            continue;
        exportLineIndexes.push(index);
        exportNameByIndex.set(index, match[1]);
    }
    if (exportLineIndexes.length <= 1)
        return text;
    const desiredOrder = [...exportedNames]
        .filter((name, idx, arr) => arr.indexOf(name) === idx)
        .concat(Array.from(exportNameByIndex.values()).filter((name, idx, arr) => arr.indexOf(name) === idx))
        .filter((name, idx, arr) => arr.indexOf(name) === idx);
    const orderMap = new Map(desiredOrder.map((name, index) => [name, index]));
    const sortedNames = Array.from(exportNameByIndex.values()).sort((a, b) => {
        const orderA = orderMap.get(a) ?? Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.get(b) ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB)
            return orderA - orderB;
        return a.localeCompare(b);
    });
    for (let i = 0; i < exportLineIndexes.length; i += 1) {
        const lineIndex = exportLineIndexes[i];
        const name = sortedNames[i];
        if (!name)
            continue;
        lines[lineIndex] = `export { ${name} };`;
    }
    return lines.join("\n");
}
function postLiftBeautifyModuleSource(input) {
    const normalized = normalizeWhitespace(input.moduleBody);
    const aliasNormalized = normalizeSimpleObjectAliases(normalized);
    return normalizeWhitespace(stableExportOrder(aliasNormalized, input.exportedNames));
}
