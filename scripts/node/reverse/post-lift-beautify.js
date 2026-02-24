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
exports.postLiftBeautifyModuleSource = postLiftBeautifyModuleSource;
const path = __importStar(require("node:path"));
const ts = __importStar(require("typescript"));
const identifier_utils_1 = require("./identifier-utils");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function splitIdentifierTokens(input) {
    const normalized = input
        .replace(/[_\-./:]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    return normalized
        .split(/\s+/g)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}
function toCamelIdentifier(tokens) {
    const cleaned = tokens
        .map((token) => token.replace(/[^A-Za-z0-9_$]/g, ""))
        .filter((token) => token.length > 0);
    if (cleaned.length === 0)
        return "";
    const pascal = cleaned.map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`).join("");
    return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}
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
function toPascalIdentifier(tokens) {
    const cleaned = tokens
        .map((token) => token.replace(/[^A-Za-z0-9_$]/g, ""))
        .filter((token) => token.length > 0);
    if (cleaned.length === 0)
        return "";
    return cleaned.map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`).join("");
}
function dedupeTokens(tokens) {
    const seen = new Set();
    const result = [];
    for (const token of tokens) {
        if (seen.has(token))
            continue;
        seen.add(token);
        result.push(token);
    }
    return result;
}
const NOISY_IDENTIFIER_TOKENS = new Set([
    "tmp",
    "temp",
    "var",
    "value",
    "data",
    "item",
    "obj",
    "object",
    "fn",
    "func",
    "function",
    "class",
    "module",
    "runtime",
    "handler",
    "manager",
    "service",
    "bridge",
    "helper",
    "util",
    "utils",
    "misc",
    "index",
    "main",
    "renderer",
    "feature",
    "features",
    "component",
    "components",
    "shared",
    "common",
    "base",
    "core",
]);
const FUNCTION_VERBS = new Set([
    "use",
    "get",
    "set",
    "create",
    "build",
    "load",
    "fetch",
    "read",
    "write",
    "save",
    "parse",
    "decode",
    "encode",
    "serialize",
    "format",
    "compute",
    "derive",
    "normalize",
    "resolve",
    "register",
    "handle",
    "dispatch",
    "emit",
    "subscribe",
    "connect",
    "update",
    "merge",
    "map",
    "transform",
]);
function normalizeIdentifierToken(input) {
    return input.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}
function isNoisyIdentifierToken(input) {
    const token = normalizeIdentifierToken(input);
    if (["is", "has", "to", "on", "of", "by"].includes(token))
        return false;
    if (token.length <= 1)
        return true;
    if (NOISY_IDENTIFIER_TOKENS.has(token))
        return true;
    if (/^\d+$/.test(token))
        return true;
    if (/^[a-z]{1,2}\d{0,2}$/.test(token))
        return true;
    if (/^(?:fn|class|var)\d+$/.test(token))
        return true;
    if (/^(?:tmp|temp|line|ref)\d+$/.test(token))
        return true;
    if (/^x[0-9a-f]{2,}$/i.test(token))
        return true;
    return false;
}
function extractIdentifierTokens(input) {
    return splitIdentifierTokens(input)
        .map((token) => normalizeIdentifierToken(token))
        .filter((token) => token.length > 0);
}
function scoreCallableNameQuality(input) {
    const name = input.name.trim();
    if (name.length === 0)
        return 0;
    let score = 1;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
        score -= 0.55;
    if (name.length < 3)
        score -= 0.75;
    else if (name.length < 5)
        score -= 0.3;
    if (/\$/.test(name))
        score -= 0.45;
    if (/^_+/.test(name))
        score -= 0.25;
    if (/(?:Fn|Class|Var)\d+$/i.test(name))
        score -= 0.75;
    if (/^[A-Za-z]{1,3}\d{0,2}$/.test(name))
        score -= 0.65;
    if (/\d{2,}$/.test(name))
        score -= 0.25;
    if (/(?:runtime|handler|manager|service)\d+$/i.test(name))
        score -= 0.45;
    if (input.kind === "class" && !/^[A-Z]/.test(name))
        score -= 0.2;
    if (input.kind === "function" && /^use[A-Z]/.test(name))
        score += 0.1;
    return Math.max(0, Math.min(1, score));
}
function shouldAutoRenameCallable(input) {
    const quality = scoreCallableNameQuality(input);
    if (quality < 0.9)
        return true;
    const normalized = normalizeIdentifierToken(input.name);
    if (/(?:fn|class|var)\d+$/.test(normalized))
        return true;
    if (/(?:legacy|inline|internal)\d+$/.test(normalized))
        return true;
    return false;
}
function isDeclarationNameIdentifier(node) {
    const parent = node.parent;
    if (!parent)
        return false;
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
    if (ts.isInterfaceDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isTypeAliasDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isEnumDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isModuleDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isImportClause(parent) && parent.name === node)
        return true;
    if (ts.isImportSpecifier(parent) && parent.name === node)
        return true;
    if (ts.isNamespaceImport(parent) && parent.name === node)
        return true;
    if (ts.isImportEqualsDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isBindingElement(parent) && parent.name === node)
        return true;
    if (ts.isTypeParameterDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node)
        return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isPropertySignature(parent) && parent.name === node)
        return true;
    if (ts.isMethodDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isMethodSignature(parent) && parent.name === node)
        return true;
    if (ts.isGetAccessorDeclaration(parent) && parent.name === node)
        return true;
    if (ts.isSetAccessorDeclaration(parent) && parent.name === node)
        return true;
    return false;
}
function shouldRenameReferenceIdentifier(node) {
    if (isDeclarationNameIdentifier(node))
        return true;
    const parent = node.parent;
    if (!parent)
        return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node)
        return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node)
        return false;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
        return true;
    if (ts.isQualifiedName(parent) && parent.right === node)
        return false;
    if (ts.isImportSpecifier(parent) && parent.propertyName === node)
        return false;
    if (ts.isExportSpecifier(parent) && parent.propertyName === node)
        return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node)
        return false;
    if (ts.isJsxAttribute(parent))
        return false;
    if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent))
        return false;
    return true;
}
function collectDeclarationCounts(sourceFile) {
    const declarationCounts = new Map();
    const bump = (name) => {
        declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
    };
    const visit = (node) => {
        if (ts.isIdentifier(node) && isDeclarationNameIdentifier(node)) {
            bump(node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return declarationCounts;
}
function applyReplacements(text, replacements) {
    if (replacements.length === 0)
        return text;
    const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end);
    let nextText = text;
    for (const replacement of sorted) {
        nextText = `${nextText.slice(0, replacement.start)}${replacement.text}${nextText.slice(replacement.end)}`;
    }
    return nextText;
}
function createModuleSemanticContext(moduleBody) {
    const moduleFile = "/__generated_module__.tsx";
    const compilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
        allowJs: true,
        checkJs: false,
        skipLibCheck: true,
        noResolve: true,
        noLib: true,
    };
    const host = ts.createCompilerHost(compilerOptions, true);
    host.getSourceFile = (fileName, languageVersion) => {
        if (toPosixPath(fileName) !== moduleFile)
            return undefined;
        return ts.createSourceFile(moduleFile, moduleBody, languageVersion, true, ts.ScriptKind.TSX);
    };
    host.readFile = () => undefined;
    host.fileExists = (fileName) => toPosixPath(fileName) === moduleFile;
    host.writeFile = () => undefined;
    host.getCurrentDirectory = () => "/";
    host.getDirectories = () => [];
    host.getCanonicalFileName = (fileName) => fileName;
    host.getNewLine = () => "\n";
    host.useCaseSensitiveFileNames = () => true;
    const program = ts.createProgram([moduleFile], compilerOptions, host);
    const sourceFile = program.getSourceFile(moduleFile);
    if (!sourceFile) {
        throw new Error("Failed to build semantic context for post-lift rename pass.");
    }
    return {
        sourceFile,
        checker: program.getTypeChecker(),
    };
}
function buildModuleRenameBase(emittedPath) {
    const fallback = "moduleRuntime";
    if (!emittedPath) {
        return {
            camel: fallback,
            pascal: "ModuleRuntime",
            tokens: ["module", "runtime"],
            isHook: false,
            isTransport: false,
            isService: false,
            isStore: false,
        };
    }
    const normalizedPath = toPosixPath(emittedPath).toLowerCase();
    const stem = path.posix.basename(normalizedPath, path.posix.extname(normalizedPath));
    const moduleTokens = toPosixPath(normalizedPath)
        .replace(/^\.?\//, "")
        .replace(/\.[^.]+$/, "")
        .split("/")
        .flatMap((segment) => splitIdentifierTokens(segment))
        .map((token) => normalizeIdentifierToken(token))
        .filter((token) => token.length > 0);
    const filtered = moduleTokens.filter((token) => token.length >= 3 &&
        ![
            "src",
            "main",
            "renderer",
            "services",
            "features",
            "feature",
            "components",
            "component",
            "chunks",
            "chunkts",
            "chunks-ts",
            "index",
            "shared",
            "common",
            "module",
        ].includes(token));
    const baseSourceTokens = filtered.length > 0 ? filtered : extractIdentifierTokens(stem);
    const uniqueTokens = dedupeTokens(baseSourceTokens).slice(0, 3);
    const baseCamel = (0, identifier_utils_1.sanitizeIdentifier)(toCamelIdentifier(uniqueTokens.length > 0 ? uniqueTokens : ["module", "runtime"]));
    const camel = baseCamel.length > 0 ? baseCamel : fallback;
    const pascal = `${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
    return {
        camel,
        pascal,
        tokens: uniqueTokens.length > 0 ? uniqueTokens : ["module", "runtime"],
        isHook: normalizedPath.includes("/hooks/"),
        isTransport: /(transport|ipc|rpc|bridge|socket|channel|daemon)/.test(normalizedPath),
        isService: normalizedPath.includes("/services/"),
        isStore: /(store|state)/.test(normalizedPath),
    };
}
function collectInitializerNameHints(node) {
    let hintName = "";
    const hints = [];
    const pushHint = (value) => {
        const normalized = value.trim();
        if (!/^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(normalized))
            return;
        if (hintName.length === 0 && normalized.length >= 4) {
            const normalizedTokens = extractIdentifierTokens(normalized).filter((token) => !isNoisyIdentifierToken(token));
            if (normalizedTokens.length >= 2 || normalizedTokens[0]?.length >= 5) {
                hintName = normalized;
            }
        }
        for (const token of extractIdentifierTokens(normalized)) {
            if (isNoisyIdentifierToken(token))
                continue;
            hints.push(token);
        }
    };
    const visit = (current) => {
        if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
            pushHint(current.text);
        }
        ts.forEachChild(current, visit);
    };
    visit(node);
    return {
        hintName,
        hintTokens: dedupeTokens(hints).slice(0, 6),
    };
}
function inferCallableKindFromInitializer(initializer) {
    const inferNode = (node) => {
        if (ts.isFunctionExpression(node) || ts.isArrowFunction(node))
            return "function";
        if (ts.isClassExpression(node))
            return "class";
        if (ts.isParenthesizedExpression(node))
            return inferNode(node.expression);
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
            return inferNode(node.expression);
        }
        if (ts.isConditionalExpression(node)) {
            return inferNode(node.whenTrue) ?? inferNode(node.whenFalse);
        }
        if (ts.isBinaryExpression(node)) {
            if (node.operatorToken.kind === ts.SyntaxKind.CommaToken || node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                return inferNode(node.right) ?? inferNode(node.left);
            }
            return inferNode(node.right);
        }
        if (ts.isCommaListExpression(node)) {
            for (let index = node.elements.length - 1; index >= 0; index -= 1) {
                const element = node.elements[index];
                if (!element)
                    continue;
                const inferred = inferNode(element);
                if (inferred)
                    return inferred;
            }
            return undefined;
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const args = node.arguments ?? [];
            for (const arg of args) {
                const inferred = inferNode(arg);
                if (inferred)
                    return inferred;
            }
            return undefined;
        }
        return undefined;
    };
    return inferNode(initializer);
}
function isTopLevelDeclarationIdentifier(node) {
    const parent = node.parent;
    if (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) {
        return ts.isSourceFile(parent.parent);
    }
    if (!ts.isVariableDeclaration(parent) || parent.name !== node)
        return false;
    let current = parent;
    while (current) {
        if (ts.isVariableStatement(current)) {
            return ts.isSourceFile(current.parent);
        }
        if (ts.isSourceFile(current))
            break;
        current = current.parent;
    }
    return false;
}
function collectCallableDeclarations(sourceFile) {
    const declarations = [];
    const pushDeclaration = (declaration) => {
        declarations.push(declaration);
    };
    const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) {
            pushDeclaration({
                name: node.name.text,
                nameNode: node.name,
                kind: "function",
                contextNode: node,
                hintName: "",
                hintTokens: [],
                isTopLevel: ts.isSourceFile(node.parent),
                start: node.getStart(sourceFile),
            });
        }
        else if (ts.isClassDeclaration(node) && node.name) {
            pushDeclaration({
                name: node.name.text,
                nameNode: node.name,
                kind: "class",
                contextNode: node,
                hintName: "",
                hintTokens: [],
                isTopLevel: ts.isSourceFile(node.parent),
                start: node.getStart(sourceFile),
            });
        }
        else if (ts.isFunctionExpression(node) && node.name) {
            pushDeclaration({
                name: node.name.text,
                nameNode: node.name,
                kind: "function",
                contextNode: node,
                hintName: "",
                hintTokens: [],
                isTopLevel: false,
                start: node.getStart(sourceFile),
            });
        }
        else if (ts.isClassExpression(node) && node.name) {
            pushDeclaration({
                name: node.name.text,
                nameNode: node.name,
                kind: "class",
                contextNode: node,
                hintName: "",
                hintTokens: [],
                isTopLevel: false,
                start: node.getStart(sourceFile),
            });
        }
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const kind = inferCallableKindFromInitializer(node.initializer);
            if (kind) {
                const initializerHints = collectInitializerNameHints(node.initializer);
                pushDeclaration({
                    name: node.name.text,
                    nameNode: node.name,
                    kind,
                    contextNode: node.initializer,
                    hintName: initializerHints.hintName,
                    hintTokens: initializerHints.hintTokens,
                    isTopLevel: isTopLevelDeclarationIdentifier(node.name),
                    start: node.getStart(sourceFile),
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return declarations.sort((left, right) => left.start - right.start);
}
function collectStatementContextTokens(input) {
    const tokens = [];
    const pushToken = (token) => {
        if (isNoisyIdentifierToken(token))
            return;
        tokens.push(token);
    };
    const visit = (node) => {
        if (ts.isIdentifier(node)) {
            if (node.text !== input.declarationName) {
                for (const token of extractIdentifierTokens(node.text)) {
                    pushToken(token);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(input.contextNode);
    const statementText = input.contextNode.getText(input.sourceFile);
    const lexicalHints = statementText.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
    for (const lexical of lexicalHints.slice(0, 200)) {
        for (const token of extractIdentifierTokens(lexical)) {
            pushToken(token);
        }
    }
    return dedupeTokens(tokens).slice(0, 10);
}
function pickFunctionVerb(input) {
    if (input.module.isHook)
        return "use";
    const merged = [...input.sourceTokens, ...input.contextTokens];
    const hasToken = (token) => merged.includes(token);
    if (hasToken("is"))
        return "is";
    if (hasToken("has"))
        return "has";
    if (hasToken("to"))
        return "to";
    if (hasToken("get") || hasToken("read") || hasToken("query"))
        return "get";
    if (hasToken("set") || hasToken("assign"))
        return "set";
    if (hasToken("create") || hasToken("make") || hasToken("init"))
        return "create";
    if (hasToken("build") || hasToken("compose"))
        return "build";
    if (hasToken("load") || hasToken("fetch") || hasToken("request"))
        return "load";
    if (hasToken("parse") || hasToken("decode"))
        return "parse";
    if (hasToken("encode") || hasToken("serialize"))
        return "serialize";
    if (hasToken("compute") || hasToken("derive") || hasToken("calculate"))
        return "compute";
    if (hasToken("format") || hasToken("normalize"))
        return "format";
    if (hasToken("register") || hasToken("bind"))
        return "register";
    if (hasToken("dispatch") || hasToken("emit") || hasToken("send") || hasToken("publish"))
        return "dispatch";
    if (hasToken("subscribe") || hasToken("listen") || hasToken("watch"))
        return "subscribe";
    if (hasToken("connect") || hasToken("open"))
        return "connect";
    if (hasToken("update") || hasToken("refresh"))
        return "update";
    if (input.module.isTransport)
        return "dispatch";
    if (input.module.isService)
        return "resolve";
    if (input.module.isStore)
        return "update";
    return "resolve";
}
function pickClassSuffix(input) {
    const merged = [...input.sourceTokens, ...input.contextTokens, ...input.module.tokens];
    const has = (value) => merged.includes(value);
    if (has("store") || has("state") || has("cache") || input.module.isStore)
        return "Store";
    if (has("adapter") || has("bridge") || has("tauri"))
        return "Adapter";
    if (has("controller") || has("route") || has("navigation"))
        return "Controller";
    if (has("client") || has("transport") || has("ipc") || has("rpc") || has("socket") || input.module.isTransport)
        return "Client";
    if (has("service") || has("api") || input.module.isService)
        return "Service";
    return "Runtime";
}
function collectSubjectTokens(input) {
    const merged = [...input.sourceTokens, ...input.contextTokens, ...input.moduleTokens];
    const subject = merged.filter((token) => !isNoisyIdentifierToken(token) && !FUNCTION_VERBS.has(token));
    return dedupeTokens(subject).slice(0, input.max);
}
function buildCallableRenameBase(input) {
    const sanitizeHintName = () => {
        const rawHint = input.declaration.hintName.trim();
        if (rawHint.length === 0)
            return "";
        if (input.declaration.kind === "function") {
            const tokens = extractIdentifierTokens(rawHint).filter((token) => !isNoisyIdentifierToken(token));
            if (tokens.length === 0)
                return "";
            const hintName = toCamelIdentifier(tokens);
            return (0, identifier_utils_1.sanitizeIdentifier)(hintName);
        }
        const tokens = extractIdentifierTokens(rawHint).filter((token) => !isNoisyIdentifierToken(token));
        if (tokens.length === 0)
            return "";
        const hintName = toPascalIdentifier(tokens);
        return (0, identifier_utils_1.sanitizeIdentifier)(hintName);
    };
    const normalizedHintName = sanitizeHintName();
    if (normalizedHintName.length > 0) {
        const hintQuality = scoreCallableNameQuality({
            name: normalizedHintName,
            kind: input.declaration.kind,
        });
        if (hintQuality >= 0.86) {
            return normalizedHintName;
        }
    }
    const declarationTokens = extractIdentifierTokens(input.declaration.name).filter((token) => !isNoisyIdentifierToken(token));
    const sourceTokens = dedupeTokens([...input.declaration.hintTokens, ...declarationTokens]).filter((token) => !isNoisyIdentifierToken(token));
    const contextTokens = collectStatementContextTokens({
        sourceFile: input.sourceFile,
        contextNode: input.declaration.contextNode,
        declarationName: input.declaration.name,
    });
    const subjectTokens = collectSubjectTokens({
        sourceTokens,
        contextTokens,
        moduleTokens: input.module.tokens,
        max: 2,
    });
    const safeSubject = subjectTokens.length > 0 ? subjectTokens : input.module.tokens.slice(0, 2);
    if (input.declaration.kind === "function") {
        const verb = pickFunctionVerb({
            module: input.module,
            sourceTokens,
            contextTokens,
        });
        const subjectPascal = toPascalIdentifier(safeSubject.length > 0 ? safeSubject : ["runtime"]);
        if (verb === "use")
            return `use${subjectPascal}`;
        return toCamelIdentifier([verb, subjectPascal]);
    }
    const classBase = toPascalIdentifier(safeSubject.length > 0 ? safeSubject : ["runtime"]);
    const suffix = pickClassSuffix({
        module: input.module,
        sourceTokens,
        contextTokens,
    });
    if (classBase.endsWith(suffix))
        return classBase;
    return `${classBase}${suffix}`;
}
function renameWeakTopLevelDeclarations(input) {
    const semanticContext = createModuleSemanticContext(input.moduleBody);
    const sourceFile = semanticContext.sourceFile;
    const checker = semanticContext.checker;
    const declarationCounts = collectDeclarationCounts(sourceFile);
    const exported = new Set(input.exportedNames);
    const occupiedNames = new Set(Array.from(declarationCounts.keys()).map((name) => (0, identifier_utils_1.sanitizeIdentifier)(name)).filter((name) => name.length > 0));
    const symbolRenameMap = new Map();
    const moduleBase = buildModuleRenameBase(input.emittedPath);
    const callableDeclarations = collectCallableDeclarations(sourceFile);
    const reserveName = (baseName, previousName) => {
        const sanitizedBase = (0, identifier_utils_1.sanitizeIdentifier)(baseName);
        if (sanitizedBase.length === 0)
            return "";
        let nextName = sanitizedBase;
        let suffix = 2;
        while (occupiedNames.has(nextName) && nextName !== previousName && suffix < 2000) {
            nextName = (0, identifier_utils_1.sanitizeIdentifier)(`${sanitizedBase}${suffix}`);
            suffix += 1;
        }
        if (nextName.length === 0 || nextName === previousName || occupiedNames.has(nextName))
            return "";
        occupiedNames.add(nextName);
        return nextName;
    };
    for (const declaration of callableDeclarations) {
        const symbol = checker.getSymbolAtLocation(declaration.nameNode);
        if (!symbol)
            continue;
        if (symbolRenameMap.has(symbol))
            continue;
        if (declaration.isTopLevel && exported.has(declaration.name))
            continue;
        if (!shouldAutoRenameCallable({ name: declaration.name, kind: declaration.kind }))
            continue;
        const candidateBase = buildCallableRenameBase({
            declaration,
            module: moduleBase,
            sourceFile,
        });
        const fallbackBase = declaration.kind === "function" ? `${moduleBase.camel}Runtime` : `${moduleBase.pascal}Runtime`;
        const candidate = reserveName(candidateBase, declaration.name) || reserveName(fallbackBase, declaration.name);
        if (candidate.length === 0)
            continue;
        symbolRenameMap.set(symbol, candidate);
    }
    if (symbolRenameMap.size === 0)
        return input.moduleBody;
    const replacements = [];
    const seen = new Set();
    const registerReplacement = (start, end, text) => {
        const key = `${start}:${end}`;
        if (seen.has(key))
            return;
        seen.add(key);
        replacements.push({ start, end, text });
    };
    const visit = (node) => {
        if (ts.isIdentifier(node)) {
            if (shouldRenameReferenceIdentifier(node)) {
                const symbol = checker.getSymbolAtLocation(node);
                const renamed = symbol ? symbolRenameMap.get(symbol) : undefined;
                if (renamed && renamed !== node.text) {
                    registerReplacement(node.getStart(sourceFile), node.getEnd(), renamed);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return applyReplacements(input.moduleBody, replacements);
}
function postLiftBeautifyModuleSource(input) {
    const normalized = normalizeWhitespace(input.moduleBody);
    const aliasNormalized = normalizeSimpleObjectAliases(normalized);
    const topLevelRenamed = renameWeakTopLevelDeclarations({
        moduleBody: aliasNormalized,
        emittedPath: input.emittedPath,
        exportedNames: input.exportedNames,
    });
    const ordered = stableExportOrder(topLevelRenamed, input.exportedNames);
    return normalizeWhitespace(ordered);
}
