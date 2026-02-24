import * as path from "node:path";
import * as ts from "typescript";

export interface ImportAliasResolverInput {
  sourceFile: string;
  importedSourceFile: string;
  importedSymbol: string;
  localAlias: string;
}

export interface ShapeImportAliasesInput {
  moduleBody: string;
  sourceFile: string;
  resolveAliasName: (input: ImportAliasResolverInput) => string | undefined;
  iterations?: number;
}

export interface ShapeImportAliasesResult {
  moduleBody: string;
  renamedAliases: number;
  prunedImportSpecifiers: number;
  passes: number;
}

interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function splitIdentifierTokens(input: string): string[] {
  const normalized = input
    .replace(/[_\-./:]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return normalized
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function toCamelIdentifierFromTokens(tokens: string[]): string {
  const cleaned = tokens
    .map((token) => token.replace(/[^A-Za-z0-9_$]/g, ""))
    .filter((token) => token.length > 0);
  if (cleaned.length === 0) return "";
  const pascal = cleaned.map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`).join("");
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

const RESERVED_NAMES = new Set<string>([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
]);

function sanitizeIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) return "";
  if (RESERVED_NAMES.has(normalized)) return "";
  return normalized;
}

function isWeakAliasName(name: string): boolean {
  if (/^[A-Za-z_$]{1,2}$/.test(name)) return true;
  if (/^[a-z]{2,3}$/.test(name)) return true;
  if (/^[A-Za-z]{1,2}\d+$/.test(name)) return true;
  if (/^[a-z][A-Z]$/.test(name)) return true;
  if (/^[A-Z][a-z]$/.test(name)) return true;
  if (/^[a-z]{1,3}[A-Z][A-Za-z]?$/.test(name)) return true;
  return false;
}

function isGenericAliasHintName(name: string): boolean {
  const normalized = name.trim();
  if (normalized.length < 5) return true;
  const lower = normalized.toLowerCase();
  if (/^(?:get|set|use|handle|run|create|update|load|fetch|process)[A-Z][A-Za-z0-9]*(?:Tool|Data|Value|Object|Item|Status|Result|State)\d*$/i.test(normalized)) {
    return true;
  }
  if (/^(?:get|set|use|run|do|make|build|create|update|load|fetch|handle|process|resolve|compute|parse|format|map)[a-z0-9]*$/.test(lower)) {
    const tokens = splitIdentifierTokens(normalized);
    if (tokens.length <= 2 && normalized.length <= 18) return true;
  }
  if (/(?:tool|value|data|item|object|entry|result|state|handler|runtime|service)\d*$/i.test(normalized)) {
    const tokens = splitIdentifierTokens(normalized);
    if (tokens.length <= 2) return true;
  }
  if (/\d{2,}$/.test(normalized)) return true;
  return false;
}

function scoreAliasName(name: string): number {
  let score = 0;
  if (name.length >= 4) score += 1.6;
  if (name.length >= 8) score += 0.6;
  if (/[A-Z]/.test(name.slice(1))) score += 0.5;
  if (!/\d/.test(name)) score += 0.4;
  if (!isWeakAliasName(name)) score += 1.3;
  if (/^(chunk|dep|helper)/i.test(name)) score -= 0.2;
  if (/^[a-z]{2,3}$/.test(name)) score -= 0.8;
  return score;
}

function resolveImportedSourceFile(sourceFile: string, moduleSpecifier: string): string | undefined {
  if (!/^\.\.?\//.test(moduleSpecifier)) return undefined;
  const sourceDir = path.posix.dirname(toPosixPath(sourceFile).replace(/^\.?\//, ""));
  const resolved = path.posix.normalize(path.posix.join(sourceDir, moduleSpecifier));
  if (resolved.startsWith("../")) return undefined;
  return resolved;
}

function buildFallbackAliasName(importedSymbol: string): string {
  const tokens = splitIdentifierTokens(importedSymbol).map((token) => token.toLowerCase());
  const fromSymbol = toCamelIdentifierFromTokens(tokens);
  const sanitizedSymbol = sanitizeIdentifier(fromSymbol);
  if (sanitizedSymbol.length >= 3 && !isWeakAliasName(sanitizedSymbol)) {
    return sanitizedSymbol;
  }
  const fallbackBase = toCamelIdentifierFromTokens(tokens.length > 0 ? tokens : ["dep"]);
  const normalizedFallback = sanitizeIdentifier(`chunk${fallbackBase.charAt(0).toUpperCase()}${fallbackBase.slice(1)}`);
  if (normalizedFallback.length > 0) return normalizedFallback;
  return "chunkDep";
}

function isDeclarationNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionExpression(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassExpression(parent) && parent.name === node) return true;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return true;
  if (ts.isModuleDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent) && parent.name === node) return true;
  if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) return true;
  if (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return true;
  if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isBreakStatement(parent) && parent.label === node) return true;
  if (ts.isContinueStatement(parent) && parent.label === node) return true;
  return false;
}

function shouldRenameIdentifierReference(node: ts.Identifier): boolean {
  if (isDeclarationNameIdentifier(node)) return false;
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return false;
  if (ts.isExportSpecifier(parent) && parent.propertyName === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isJsxAttribute(parent)) return false;
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) return false;
  return true;
}

function collectDeclarationCounts(sourceFile: ts.SourceFile): {
  declarationCountByName: Map<string, number>;
  importAliasCountByName: Map<string, number>;
} {
  const declarationCountByName = new Map<string, number>();
  const importAliasCountByName = new Map<string, number>();
  const bump = (map: Map<string, number>, name: string): void => {
    map.set(name, (map.get(name) ?? 0) + 1);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isDeclarationNameIdentifier(node)) {
      bump(declarationCountByName, node.text);
      if (ts.isImportSpecifier(node.parent) && node.parent.name === node) {
        bump(importAliasCountByName, node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { declarationCountByName, importAliasCountByName };
}

function applyReplacements(text: string, replacements: TextReplacement[]): string {
  if (replacements.length === 0) return text;
  const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end);
  let nextText = text;
  for (const replacement of sorted) {
    nextText = `${nextText.slice(0, replacement.start)}${replacement.text}${nextText.slice(replacement.end)}`;
  }
  return nextText;
}

function pruneUnusedNamedImports(moduleBody: string): { moduleBody: string; prunedImportSpecifiers: number } {
  const sourceFile = ts.createSourceFile("module.ts", moduleBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const importElementsByLocalName = new Map<string, Array<{ statement: ts.ImportDeclaration; element: ts.ImportSpecifier }>>();
  const elementKey = (element: ts.ImportSpecifier): string => `${element.name.getStart(sourceFile)}:${element.name.getEnd()}`;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const importClause = statement.importClause;
    if (!importClause) continue;
    if (importClause.isTypeOnly) continue;
    if (importClause.name) continue;
    const namedBindings = importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      const bucket = importElementsByLocalName.get(element.name.text) ?? [];
      bucket.push({ statement, element });
      importElementsByLocalName.set(element.name.text, bucket);
    }
  }

  if (importElementsByLocalName.size === 0) {
    return { moduleBody, prunedImportSpecifiers: 0 };
  }

  const usedElementKeys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const candidates = importElementsByLocalName.get(node.text);
      if (candidates && shouldRenameIdentifierReference(node)) {
        for (const candidate of candidates) {
          usedElementKeys.add(elementKey(candidate.element));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const replacements: TextReplacement[] = [];
  let prunedImportSpecifiers = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly || importClause.name) continue;
    const namedBindings = importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    const remainingElements = namedBindings.elements.filter((element) => usedElementKeys.has(elementKey(element)));
    if (remainingElements.length === namedBindings.elements.length) continue;

    prunedImportSpecifiers += namedBindings.elements.length - remainingElements.length;
    const replacementText =
      remainingElements.length > 0
        ? `import { ${remainingElements.map((element) => element.getText(sourceFile)).join(", ")} } from ${statement.moduleSpecifier.getText(sourceFile)};`
        : "";
    replacements.push({
      start: statement.getStart(sourceFile),
      end: statement.getEnd(),
      text: replacementText,
    });
  }

  if (replacements.length === 0) {
    return {
      moduleBody,
      prunedImportSpecifiers: 0,
    };
  }
  return {
    moduleBody: applyReplacements(moduleBody, replacements),
    prunedImportSpecifiers,
  };
}

function chooseAliasName(input: {
  localAlias: string;
  importedSymbol: string;
  hintName: string | undefined;
  usageHintName: string | undefined;
}): string {
  const hint = sanitizeIdentifier(input.hintName ?? "");
  if (hint.length >= 3 && !isWeakAliasName(hint) && !isGenericAliasHintName(hint)) {
    return hint;
  }
  const usageHint = sanitizeIdentifier(input.usageHintName ?? "");
  if (usageHint.length >= 3 && !isWeakAliasName(usageHint) && !isGenericAliasHintName(usageHint)) {
    return usageHint;
  }
  const imported = sanitizeIdentifier(input.importedSymbol);
  if (imported.length >= 3 && !isWeakAliasName(imported)) {
    return imported;
  }
  return buildFallbackAliasName(input.importedSymbol);
}

function collectAliasUsageHints(sourceFile: ts.SourceFile): Map<string, string> {
  const hintsByAlias = new Map<string, Map<string, number>>();
  const register = (alias: string, rawHint: string): void => {
    const normalizedHint = sanitizeIdentifier(toCamelIdentifierFromTokens(splitIdentifierTokens(rawHint).map((token) => token.toLowerCase())));
    if (normalizedHint.length < 4) return;
    if (isWeakAliasName(normalizedHint)) return;
    const bucket = hintsByAlias.get(alias) ?? new Map<string, number>();
    bucket.set(normalizedHint, (bucket.get(normalizedHint) ?? 0) + 1);
    hintsByAlias.set(alias, bucket);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const alias = node.expression.text;
      for (const arg of node.arguments) {
        if (ts.isStringLiteralLike(arg)) {
          register(alias, arg.text);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      register(node.expression.text, node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const result = new Map<string, string>();
  for (const [alias, bucket] of hintsByAlias) {
    const sorted = Array.from(bucket.entries()).sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const best = sorted[0]?.[0];
    if (!best) continue;
    result.set(alias, best);
  }
  return result;
}

function shapeImportAliasesPass(input: ShapeImportAliasesInput): { moduleBody: string; renamedAliases: number } {
  const sourceFilePath = toPosixPath(input.sourceFile);
  const sourceFile = ts.createSourceFile(sourceFilePath, input.moduleBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { declarationCountByName, importAliasCountByName } = collectDeclarationCounts(sourceFile);
  const usageHintsByAlias = collectAliasUsageHints(sourceFile);
  const occupiedNames = new Set<string>(Array.from(declarationCountByName.keys()));
  const renameMap = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifierNode = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(specifierNode)) continue;
    const importedSourceFile = resolveImportedSourceFile(sourceFilePath, specifierNode.text);
    if (!importedSourceFile) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      const localAlias = element.name.text;
      const importedSymbol = element.propertyName?.text ?? localAlias;
      const declarationCount = declarationCountByName.get(localAlias) ?? 0;
      const importAliasCount = importAliasCountByName.get(localAlias) ?? 0;
      if (declarationCount > importAliasCount) continue;

      const hintName = input.resolveAliasName({
        sourceFile: sourceFilePath,
        importedSourceFile,
        importedSymbol,
        localAlias,
      });
      const baseCandidate = chooseAliasName({
        localAlias,
        importedSymbol,
        hintName,
        usageHintName: usageHintsByAlias.get(localAlias),
      });
      let nextAlias = sanitizeIdentifier(baseCandidate);
      if (nextAlias.length === 0) continue;

      const localScore = scoreAliasName(localAlias);
      const nextScore = scoreAliasName(nextAlias);
      if (nextAlias === localAlias) continue;
      if (!isWeakAliasName(localAlias) && nextScore < localScore + 0.75) continue;

      let suffix = 2;
      while (
        occupiedNames.has(nextAlias) &&
        nextAlias !== localAlias &&
        renameMap.get(localAlias) !== nextAlias &&
        suffix < 200
      ) {
        nextAlias = sanitizeIdentifier(`${baseCandidate}${suffix}`);
        suffix += 1;
        if (nextAlias.length === 0) break;
      }
      if (nextAlias.length === 0 || nextAlias === localAlias || occupiedNames.has(nextAlias)) continue;

      renameMap.set(localAlias, nextAlias);
      occupiedNames.add(nextAlias);
    }
  }

  if (renameMap.size === 0) return { moduleBody: input.moduleBody, renamedAliases: 0 };

  const replacements: TextReplacement[] = [];
  const seen = new Set<string>();
  const registerReplacement = (start: number, end: number, text: string): void => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    replacements.push({ start, end, text });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const renamed = renameMap.get(node.name.text);
      if (renamed) {
        registerReplacement(node.name.getStart(sourceFile), node.name.getEnd(), renamed);
      }
      return;
    }

    if (ts.isIdentifier(node)) {
      const renamed = renameMap.get(node.text);
      if (renamed && shouldRenameIdentifierReference(node)) {
        registerReplacement(node.getStart(sourceFile), node.getEnd(), renamed);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (replacements.length === 0) {
    return { moduleBody: input.moduleBody, renamedAliases: 0 };
  }
  return {
    moduleBody: applyReplacements(input.moduleBody, replacements),
    renamedAliases: renameMap.size,
  };
}

export function shapeImportAliasesIterative(input: ShapeImportAliasesInput): ShapeImportAliasesResult {
  const maxIterations = Math.max(1, Math.min(8, Math.floor(input.iterations ?? 3)));
  let moduleBody = input.moduleBody;
  let renamedAliases = 0;
  let prunedImportSpecifiers = 0;
  let passes = 0;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const pass = shapeImportAliasesPass({
      moduleBody,
      sourceFile: input.sourceFile,
      resolveAliasName: input.resolveAliasName,
      iterations: 1,
    });
    if (pass.renamedAliases <= 0 || pass.moduleBody === moduleBody) break;
    moduleBody = pass.moduleBody;
    renamedAliases += pass.renamedAliases;
    passes += 1;
  }

  const pruned = pruneUnusedNamedImports(moduleBody);
  moduleBody = pruned.moduleBody;
  prunedImportSpecifiers = pruned.prunedImportSpecifiers;

  return {
    moduleBody,
    renamedAliases,
    prunedImportSpecifiers,
    passes,
  };
}
