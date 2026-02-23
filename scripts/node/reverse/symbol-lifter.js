"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.liftModuleSource = liftModuleSource;
const ts = __importStar(require("typescript"));
const GLOBAL_REFERENCE_EXCLUDES = new Set([
    "undefined",
    "nan",
    "infinity",
    "globalthis",
    "window",
    "document",
    "console",
    "process",
    "buffer",
    "object",
    "array",
    "string",
    "number",
    "boolean",
    "symbol",
    "reflect",
    "json",
    "math",
    "date",
    "set",
    "map",
    "weakmap",
    "weakset",
    "promise",
    "error",
    "regexp",
    "url",
    "urlsearchparams",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    "navigator",
    "location",
    "self",
]);
function collectBindingIdentifiers(name, out) {
    if (ts.isIdentifier(name)) {
        out.add(name.text);
        return;
    }
    for (const element of name.elements) {
        if (ts.isOmittedExpression(element))
            continue;
        collectBindingIdentifiers(element.name, out);
    }
}
function inferVariableDeclarationKind(declaration) {
    if (!declaration.initializer)
        return "variable";
    if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
        return "function";
    if (ts.isClassExpression(declaration.initializer))
        return "class";
    return "variable";
}
function isDeclarationNameNode(node) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isParameter(parent) && parent.name === node)
        return true;
    if (ts.isFunctionDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isFunctionExpression(parent) && parent.name === node)
        return true;
    if (ts.isClassDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isClassExpression(parent) && parent.name === node)
        return true;
    if (ts.isBindingElement(parent) && parent.name === node)
        return true;
    if (ts.isTypeParameterDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isImportClause(parent) && parent.name === node)
        return true;
    if (ts.isImportSpecifier(parent) && parent.name === node)
        return true;
    if (ts.isNamespaceImport(parent) && parent.name === node)
        return true;
    if (ts.isImportEqualsDeclaration(parent) && parent.name === node)
        return true;
    return false;
}
function shouldIgnoreIdentifierReference(node) {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node)
        return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node)
        return true;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
        return false;
    if (ts.isMethodDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isGetAccessorDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isSetAccessorDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isQualifiedName(parent) && parent.right === node)
        return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node)
        return true;
    if (ts.isLabeledStatement(parent) && parent.label === node)
        return true;
    return false;
}
function collectDeclaredNames(statement) {
    const names = new Set();
    if (ts.isFunctionDeclaration(statement) && statement.name) {
        names.add(statement.name.text);
        return names;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
        names.add(statement.name.text);
        return names;
    }
    if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
            collectBindingIdentifiers(declaration.name, names);
        }
    }
    return names;
}
function collectStatementReferences(statement, declaredNames) {
    const references = new Set();
    const visit = (node) => {
        if (ts.isIdentifier(node)) {
            const normalized = node.text.trim();
            if (normalized.length === 0) {
                ts.forEachChild(node, visit);
                return;
            }
            const lower = normalized.toLowerCase();
            if (GLOBAL_REFERENCE_EXCLUDES.has(lower)) {
                ts.forEachChild(node, visit);
                return;
            }
            if (declaredNames.has(normalized)) {
                ts.forEachChild(node, visit);
                return;
            }
            if (isDeclarationNameNode(node) || shouldIgnoreIdentifierReference(node)) {
                ts.forEachChild(node, visit);
                return;
            }
            references.add(normalized);
            ts.forEachChild(node, visit);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(statement);
    return references;
}
function collectTopLevelRecords(sourceFile, sourceText) {
    const statements = [];
    const declarationsByName = new Map();
    const declarations = [];
    const pushDeclaration = (row) => {
        declarations.push(row);
        const bucket = declarationsByName.get(row.name) ?? [];
        bucket.push(row);
        declarationsByName.set(row.name, bucket);
    };
    const pushStatementDeclaration = (statementIndex, node, name, kind) => {
        if (name.trim().length === 0)
            return;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        pushDeclaration({
            name,
            kind,
            line,
            statementIndex,
        });
    };
    sourceFile.statements.forEach((statement, index) => {
        const start = statement.getStart(sourceFile);
        const end = statement.end;
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        const text = sourceText.slice(start, end).trim();
        const declaredNames = collectDeclaredNames(statement);
        const references = collectStatementReferences(statement, declaredNames);
        statements.push({
            index,
            line,
            text,
            declaredNames,
            references,
        });
        if (ts.isFunctionDeclaration(statement) && statement.name) {
            pushStatementDeclaration(index, statement.name, statement.name.text, "function");
            return;
        }
        if (ts.isClassDeclaration(statement) && statement.name) {
            pushStatementDeclaration(index, statement.name, statement.name.text, "class");
            return;
        }
        if (!ts.isVariableStatement(statement))
            return;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name))
                continue;
            pushStatementDeclaration(index, declaration.name, declaration.name.text, inferVariableDeclarationKind(declaration));
        }
    });
    return { statements, declarationsByName, declarations };
}
function scoreDeclarationKind(expected, actual) {
    if (expected === actual)
        return 0;
    if (expected === "function" && actual === "variable")
        return 1;
    if (expected === "class" && actual === "variable")
        return 1;
    if (expected === "variable")
        return 2;
    return 3;
}
function pickBestDeclaration(records, expectedKind, sourceLine) {
    if (records.length === 0)
        return undefined;
    const lineHint = sourceLine > 0 ? sourceLine : records[0]?.line ?? 0;
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const row of records) {
        const kindScore = scoreDeclarationKind(expectedKind, row.kind);
        const lineDistance = Math.abs(row.line - lineHint) * 0.01;
        const score = kindScore * 100 + lineDistance + row.statementIndex * 0.0001;
        if (score < bestScore) {
            best = row;
            bestScore = score;
        }
    }
    return best;
}
function pickDependencyDeclaration(records, statementLine) {
    if (records.length === 0)
        return undefined;
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const row of records) {
        const beforePenalty = row.line > statementLine ? 0.5 : 0;
        const lineDistance = Math.abs(row.line - statementLine);
        const score = lineDistance + beforePenalty;
        if (score < bestScore) {
            best = row;
            bestScore = score;
        }
    }
    return best;
}
function pickFallbackDeclaration(declarations, expectedKind, sourceLine, usedStatementIndexes) {
    if (declarations.length === 0)
        return undefined;
    const lineHint = sourceLine > 0 ? sourceLine : declarations[0]?.line ?? 0;
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const row of declarations) {
        const kindScore = scoreDeclarationKind(expectedKind, row.kind);
        const lineDistance = Math.abs(row.line - lineHint) * 0.02;
        const usedPenalty = usedStatementIndexes.has(row.statementIndex) ? 9 : 0;
        const score = kindScore * 100 + lineDistance + usedPenalty + row.statementIndex * 0.0001;
        if (score < bestScore) {
            best = row;
            bestScore = score;
        }
    }
    return best;
}
function liftModuleSource(input) {
    let sourceFile;
    try {
        sourceFile = ts.createSourceFile(input.sourceFilePath, input.sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse source chunk for lifting: ${input.sourceFilePath}. ${message}`);
    }
    const { statements, declarationsByName, declarations } = collectTopLevelRecords(sourceFile, input.sourceText);
    const includeStatementIndexes = new Set();
    const queue = [];
    const liftedExports = [];
    const unresolvedExports = [];
    const usedPrimaryStatementIndexes = new Set();
    for (const spec of input.exports) {
        const sourceSymbol = spec.sourceSymbol.trim();
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sourceSymbol)) {
            unresolvedExports.push(spec);
            continue;
        }
        const records = declarationsByName.get(sourceSymbol) ?? [];
        let best = pickBestDeclaration(records, spec.kind, spec.sourceLine);
        if (!best) {
            best = pickFallbackDeclaration(declarations, spec.kind, spec.sourceLine, usedPrimaryStatementIndexes);
        }
        if (!best) {
            unresolvedExports.push(spec);
            continue;
        }
        usedPrimaryStatementIndexes.add(best.statementIndex);
        if (!includeStatementIndexes.has(best.statementIndex)) {
            includeStatementIndexes.add(best.statementIndex);
            queue.push(best.statementIndex);
        }
        liftedExports.push({
            exportName: spec.exportName,
            sourceSymbol: best.name,
            kind: spec.kind,
            sourceLine: spec.sourceLine,
        });
    }
    const dependencyLimit = input.maxDependencyStatements > 0 ? input.maxDependencyStatements : 700;
    while (queue.length > 0) {
        if (includeStatementIndexes.size > dependencyLimit) {
            throw new Error(`Dependency closure exceeded limit (${dependencyLimit}) while lifting ${input.sourceFilePath}. ` +
                `This indicates an overly broad symbol ownership map.`);
        }
        const statementIndex = queue.shift();
        if (typeof statementIndex !== "number")
            continue;
        const statement = statements[statementIndex];
        if (!statement)
            continue;
        for (const referenceName of statement.references) {
            const dependencyRows = declarationsByName.get(referenceName);
            if (!dependencyRows || dependencyRows.length === 0)
                continue;
            const dependency = pickDependencyDeclaration(dependencyRows, statement.line);
            if (!dependency)
                continue;
            if (includeStatementIndexes.has(dependency.statementIndex))
                continue;
            includeStatementIndexes.add(dependency.statementIndex);
            queue.push(dependency.statementIndex);
        }
    }
    const statementBodies = Array.from(includeStatementIndexes)
        .sort((a, b) => a - b)
        .map((index) => statements[index]?.text ?? "")
        .filter((text) => text.length > 0);
    const bodyLines = [];
    if (statementBodies.length > 0) {
        for (const statementText of statementBodies) {
            bodyLines.push(statementText, "");
        }
    }
    const exportSpecs = new Map();
    for (const spec of liftedExports) {
        const key = spec.exportName.trim();
        if (key.length === 0)
            continue;
        if (exportSpecs.has(key))
            continue;
        exportSpecs.set(key, spec);
    }
    if (exportSpecs.size === 0) {
        bodyLines.push("export {};", "");
    }
    else {
        bodyLines.push("export {");
        for (const spec of exportSpecs.values()) {
            const clause = spec.sourceSymbol === spec.exportName ? spec.sourceSymbol : `${spec.sourceSymbol} as ${spec.exportName}`;
            bodyLines.push(`  ${clause},`);
        }
        bodyLines.push("};", "");
    }
    return {
        moduleBody: `${bodyLines.join("\n").trimEnd()}\n`,
        liftedExports,
        unresolvedExports,
        includedStatements: includeStatementIndexes.size,
    };
}
