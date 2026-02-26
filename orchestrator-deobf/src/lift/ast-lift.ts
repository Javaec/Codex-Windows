import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { ArchetypeId } from "../contracts";
import { ChunkArtifactModel, ChunkArtifactRecord } from "../ir/chunk-artifact-model";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
import { OwnershipModel, OwnershipRecord } from "../ir/ownership-model";

export interface LiftedSymbolBinding {
  symbolKey: string;
  symbolName: string;
  chunkId: string;
  sourceIdentifier: string;
  exportName: string;
  confidence: number;
}

export interface LiftedChunkArtifact {
  chunkId: string;
  sourceFilePath: string;
  content: string;
  symbolBindings: LiftedSymbolBinding[];
  dependencies: LiftedChunkDependency[];
  exportedIdentifiers: string[];
  hasDefaultExport: boolean;
  importShapingCount: number;
  prunedDeclarationCount: number;
  liftedDeclarationCount: number;
}

export interface AstLiftResult {
  hotChunkIds: string[];
  liftedChunks: LiftedChunkArtifact[];
  symbolBindingByKey: Map<string, LiftedSymbolBinding>;
}

export interface AstLiftOptions {
  hotChunkMax: number;
  targetCoverage: number;
  minHotChunkCount: number;
  preferredArchetypes: ArchetypeId[];
  minimumChunkScore: number;
  closureChunkLimit: number;
}

export interface LiftedChunkDependency {
  chunkId: string;
  namedImports: string[];
  requiresDefaultExport: boolean;
  requiresNamespaceImport: boolean;
}

interface ImportShapingResult {
  sourceFile: ts.SourceFile;
  shapedCount: number;
}

interface ImportResolutionResult {
  sourceFile: ts.SourceFile;
  rewrittenCount: number;
}

interface ImportRenamePair {
  from: string;
  to: string;
}

interface RenameScopeFrame {
  node: ts.Node;
  declarations: Set<string>;
  parent?: RenameScopeFrame;
}

interface BeautifyResult {
  sourceFile: ts.SourceFile;
  prunedDeclarationCount: number;
}

interface LiftedStatementSelection {
  statements: ts.Statement[];
  availableIdentifiers: Set<string>;
}

interface LiftChunkRequirements {
  requiredIdentifiers: ReadonlySet<string>;
  requiresDefaultExport: boolean;
  requiresNamespaceImport: boolean;
}

interface ExportCandidate {
  referenceName: string;
  exportName: string;
}

interface MutableLiftChunkRequirements {
  requiredIdentifiers: Set<string>;
  requiresDefaultExport: boolean;
  requiresNamespaceImport: boolean;
}

const DEFAULT_LIFT_OPTIONS: AstLiftOptions = {
  hotChunkMax: 24,
  targetCoverage: 0.95,
  minHotChunkCount: 8,
  preferredArchetypes: ["ui", "service", "hook", "transport"],
  minimumChunkScore: 0,
  closureChunkLimit: 128,
};

const GENERIC_IMPORT_TOKENS = new Set<string>(["index", "chunk", "main", "entry", "assets", "webview", "src"]);
const LIFTED_SYMBOL_MIN_QUALITY = 0.56;

const RESERVED_WORDS = new Set<string>([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function normalizeModuleToken(value: string): string {
  const cleaned = value
    .replace(/\.[cm]?[jt]sx?$/i, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => !GENERIC_IMPORT_TOKENS.has(token.toLowerCase()));

  if (cleaned.length === 0) {
    return "module";
  }

  return cleaned
    .map((token, tokenIndex) => {
      if (tokenIndex === 0) {
        return token.charAt(0).toLowerCase() + token.slice(1);
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("");
}

function sanitizeIdentifier(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9_$]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part, index) => {
      if (part.length === 0) {
        return "";
      }
      if (index === 0) {
        return part.charAt(0).toLowerCase() + part.slice(1);
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");

  if (cleaned.length === 0) {
    return fallback;
  }

  const head = cleaned.charAt(0);
  if (!/[A-Za-z_$]/.test(head)) {
    return `${fallback}${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
  }

  if (RESERVED_WORDS.has(cleaned)) {
    return `${cleaned}Symbol`;
  }

  return cleaned;
}

function chunkTopicLabel(chunkId: string): string {
  const normalized = chunkId.replace(/^chunk-/, "");
  const tokens = normalized
    .split("-")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^[a-f0-9]{7,}$/i.test(token))
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, 1);
  if (tokens.length === 0) {
    return "chunk";
  }
  return tokens
    .map((token, index) => {
      if (index === 0) {
        return token.charAt(0).toLowerCase() + token.slice(1);
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("");
}

function shouldKeepLiftedSymbolName(symbolName: string): boolean {
  if (isGenericName(symbolName)) {
    return false;
  }
  if (scoreNameQuality(symbolName) < LIFTED_SYMBOL_MIN_QUALITY) {
    return false;
  }
  if (/^[a-z]{3,4}\d*$/i.test(symbolName)) {
    return false;
  }
  return true;
}

function buildLiftedSymbolBaseName(chunkId: string, symbol: OwnershipRecord, sourceIdentifier: string, ordinal: number): string {
  if (shouldKeepLiftedSymbolName(symbol.symbolName)) {
    return sanitizeIdentifier(symbol.symbolName, "liftedSymbol");
  }

  const sourceQuality = scoreNameQuality(sourceIdentifier);
  if (!isGenericName(sourceIdentifier) && sourceQuality >= LIFTED_SYMBOL_MIN_QUALITY && !isObfuscatedIdentifier(sourceIdentifier)) {
    return sanitizeIdentifier(`${sourceIdentifier}Lifted`, "liftedSymbol");
  }

  const chunkTopic = chunkTopicLabel(chunkId);
  const chunkStem = chunkTopic.charAt(0).toUpperCase() + chunkTopic.slice(1);
  return sanitizeIdentifier(`${symbol.archetype}${chunkStem}Member${ordinal}`, "liftedSymbol");
}

function makeUniqueName(base: string, usedNames: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function isObfuscatedIdentifier(name: string): boolean {
  if (name.length <= 2) {
    return true;
  }
  if (/^[a-z]{1,2}[A-Z][A-Za-z0-9]*$/.test(name)) {
    return true;
  }
  if (/^[A-Z][a-z]$/.test(name)) {
    return true;
  }
  if (/^[_$][A-Za-z0-9_$]*$/.test(name) && name.length <= 4) {
    return true;
  }
  return false;
}

function collectTopLevelBoundNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) {
        continue;
      }
      if (clause.name) {
        names.add(clause.name.text);
      }
      const namedBindings = clause.namedBindings;
      if (!namedBindings) {
        continue;
      }
      if (ts.isNamespaceImport(namedBindings)) {
        names.add(namedBindings.name.text);
        continue;
      }
      for (const element of namedBindings.elements) {
        names.add(element.name.text);
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        names.add(statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
    }
  }

  return names;
}

function buildReadableImportName(modulePath: string, importedName: string): string {
  const moduleToken = normalizeModuleToken(path.basename(modulePath));
  const importToken = isObfuscatedIdentifier(importedName) ? "symbol" : importedName;
  return sanitizeIdentifier(`${moduleToken} ${importToken}`, "moduleSymbol");
}

function createAliasBridge(oldName: string, newName: string): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          ts.factory.createIdentifier(oldName),
          undefined,
          undefined,
          ts.factory.createIdentifier(newName),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function shapeImportDeclaration(
  statement: ts.ImportDeclaration,
  usedNames: Set<string>,
): {
  statement: ts.ImportDeclaration;
  bridges: ts.Statement[];
  renamePairs: ImportRenamePair[];
  shapedCount: number;
} {
  const moduleSpecifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) {
    return {
      statement,
      bridges: [],
      renamePairs: [],
      shapedCount: 0,
    };
  }

  const clause = statement.importClause;
  if (!clause) {
    return {
      statement,
      bridges: [],
      renamePairs: [],
      shapedCount: 0,
    };
  }

  const bridges: ts.Statement[] = [];
  const renamePairs: ImportRenamePair[] = [];
  let shapedCount = 0;

  let defaultImportName = clause.name;
  if (clause.name) {
    const localName = clause.name.text;
    if (isObfuscatedIdentifier(localName)) {
      const shapedName = makeUniqueName(buildReadableImportName(moduleSpecifier.text, "default"), usedNames);
      defaultImportName = ts.factory.createIdentifier(shapedName);
      bridges.push(createAliasBridge(localName, shapedName));
      renamePairs.push({ from: localName, to: shapedName });
      shapedCount += 1;
    } else {
      usedNames.add(localName);
    }
  }

  let namedBindings = clause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    const localName = namedBindings.name.text;
    if (isObfuscatedIdentifier(localName)) {
      const shapedName = makeUniqueName(buildReadableImportName(moduleSpecifier.text, "namespace"), usedNames);
      namedBindings = ts.factory.createNamespaceImport(ts.factory.createIdentifier(shapedName));
      bridges.push(createAliasBridge(localName, shapedName));
      renamePairs.push({ from: localName, to: shapedName });
      shapedCount += 1;
    } else {
      usedNames.add(localName);
    }
  } else if (namedBindings && ts.isNamedImports(namedBindings)) {
    const shapedElements: ts.ImportSpecifier[] = [];
    for (const element of namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      const localName = element.name.text;
      const shouldShape = isObfuscatedIdentifier(localName) || isObfuscatedIdentifier(importedName);
      if (!shouldShape) {
        usedNames.add(localName);
        shapedElements.push(element);
        continue;
      }

      const shapedName = makeUniqueName(buildReadableImportName(moduleSpecifier.text, importedName), usedNames);
      const propertyName = importedName === shapedName ? undefined : ts.factory.createIdentifier(importedName);
      shapedElements.push(
        ts.factory.createImportSpecifier(
          false,
          propertyName,
          ts.factory.createIdentifier(shapedName),
        ),
      );
      bridges.push(createAliasBridge(localName, shapedName));
      renamePairs.push({ from: localName, to: shapedName });
      shapedCount += 1;
    }
    namedBindings = ts.factory.createNamedImports(shapedElements);
  }

  const importClause = ts.factory.createImportClause(
    clause.isTypeOnly,
    defaultImportName,
    namedBindings,
  );

  return {
    statement: ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      importClause,
      statement.moduleSpecifier,
      statement.attributes,
    ),
    bridges,
    renamePairs,
    shapedCount,
  };
}

function addBindingName(bindingName: ts.BindingName, sink: Set<string>): void {
  if (ts.isIdentifier(bindingName)) {
    sink.add(bindingName.text);
    return;
  }
  for (const element of bindingName.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    addBindingName(element.name, sink);
  }
}

function isScopeNode(node: ts.Node): boolean {
  if (ts.isSourceFile(node)) {
    return true;
  }
  if (ts.isBlock(node)) {
    return true;
  }
  if (ts.isFunctionLike(node)) {
    return true;
  }
  if (ts.isCatchClause(node)) {
    return true;
  }
  return false;
}

function collectDirectDeclarations(scopeNode: ts.Node): Set<string> {
  const declarations = new Set<string>();

  if (ts.isSourceFile(scopeNode)) {
    for (const statement of scopeNode.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) {
          continue;
        }
        if (clause.name) {
          declarations.add(clause.name.text);
        }
        const namedBindings = clause.namedBindings;
        if (!namedBindings) {
          continue;
        }
        if (ts.isNamespaceImport(namedBindings)) {
          declarations.add(namedBindings.name.text);
          continue;
        }
        for (const element of namedBindings.elements) {
          declarations.add(element.name.text);
        }
        continue;
      }
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        declarations.add(statement.name.text);
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, declarations);
        }
      }
    }
    return declarations;
  }

  if (ts.isFunctionLike(scopeNode)) {
    if ((ts.isFunctionDeclaration(scopeNode) || ts.isFunctionExpression(scopeNode)) && scopeNode.name) {
      declarations.add(scopeNode.name.text);
    }
    for (const parameter of scopeNode.parameters) {
      addBindingName(parameter.name, declarations);
    }
    return declarations;
  }

  if (ts.isCatchClause(scopeNode)) {
    if (scopeNode.variableDeclaration) {
      addBindingName(scopeNode.variableDeclaration.name, declarations);
    }
    return declarations;
  }

  if (ts.isBlock(scopeNode)) {
    for (const statement of scopeNode.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        declarations.add(statement.name.text);
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, declarations);
        }
      }
    }
  }

  return declarations;
}

function identifierCanBeRenamed(
  name: string,
  scope: RenameScopeFrame | undefined,
  sourceImportRenames: Set<string>,
): boolean {
  let cursor = scope;
  while (cursor) {
    if (cursor.declarations.has(name)) {
      if (ts.isSourceFile(cursor.node) && sourceImportRenames.has(name)) {
        cursor = cursor.parent;
        continue;
      }
      return false;
    }
    cursor = cursor.parent;
  }
  return true;
}

function applyScopedIdentifierRenames(
  statements: ts.Statement[],
  renameMap: Map<string, string>,
): ts.Statement[] {
  if (renameMap.size === 0) {
    return statements;
  }

  const sourceImportRenames = new Set<string>(renameMap.keys());
  const transformerFactory: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node, scope: RenameScopeFrame | undefined): ts.VisitResult<ts.Node> => {
      const nextScope = isScopeNode(node)
        ? {
            node,
            declarations: collectDirectDeclarations(node),
            parent: scope,
          }
        : scope;

      if (ts.isIdentifier(node) && isIdentifierReference(node)) {
        const replacement = renameMap.get(node.text);
        if (replacement && identifierCanBeRenamed(node.text, nextScope, sourceImportRenames)) {
          return ts.factory.createIdentifier(replacement);
        }
      }

      return ts.visitEachChild(
        node,
        (child) => visit(child, nextScope),
        context,
      );
    };

    return (sourceFile) => ts.visitNode(sourceFile, (node) => visit(node, undefined)) as ts.SourceFile;
  };

  const syntheticFile = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );
  const result = ts.transform(syntheticFile, [transformerFactory]);
  const transformed = result.transformed[0];
  if (!transformed) {
    throw new Error("applyScopedIdentifierRenames: missing transformed source");
  }
  result.dispose();
  return [...transformed.statements];
}

function applyImportShaping(sourceFile: ts.SourceFile): ImportShapingResult {
  const usedNames = collectTopLevelBoundNames(sourceFile);
  const imports: ts.ImportDeclaration[] = [];
  const bridges: ts.Statement[] = [];
  const others: ts.Statement[] = [];
  const renameMap = new Map<string, string>();
  let shapedCount = 0;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      others.push(statement);
      continue;
    }

    const shaped = shapeImportDeclaration(statement, usedNames);
    imports.push(shaped.statement);
    for (const bridge of shaped.bridges) {
      bridges.push(bridge);
    }
    for (const rename of shaped.renamePairs) {
      renameMap.set(rename.from, rename.to);
    }
    shapedCount += shaped.shapedCount;
  }

  imports.sort((left, right) => {
    const leftSpecifier = left.moduleSpecifier;
    const rightSpecifier = right.moduleSpecifier;
    if (!ts.isStringLiteral(leftSpecifier) || !ts.isStringLiteral(rightSpecifier)) {
      return 0;
    }
    return leftSpecifier.text.localeCompare(rightSpecifier.text);
  });

  const renamedOthers = applyScopedIdentifierRenames(others, renameMap);

  return {
    sourceFile: ts.factory.updateSourceFile(sourceFile, [...imports, ...bridges, ...renamedOthers]),
    shapedCount,
  };
}

function hasSideEffectExpression(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isDeleteExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isBinaryExpression(node)
  ) {
    return true;
  }

  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(child) ||
      ts.isNewExpression(child) ||
      ts.isAwaitExpression(child) ||
      ts.isYieldExpression(child) ||
      ts.isDeleteExpression(child) ||
      ts.isPostfixUnaryExpression(child) ||
      ts.isPrefixUnaryExpression(child) ||
      ts.isBinaryExpression(child)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };

  ts.forEachChild(node, visit);
  return found;
}

function collectDeclaredNamesFromNode(node: ts.Node): string[] {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name ? [node.name.text] : [];
  }

  if (ts.isVariableStatement(node)) {
    const names: string[] = [];
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        names.push(declaration.name.text);
      }
    }
    return names;
  }

  return [];
}

function statementHasExportModifier(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (!modifiers) {
    return false;
  }
  for (const modifier of modifiers) {
    if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
      return true;
    }
  }
  return false;
}

function collectExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const exported = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (statementHasExportModifier(statement)) {
      for (const name of collectDeclaredNamesFromNode(statement)) {
        exported.add(name);
      }
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exported.add(element.name.text);
      }
    }
  }

  return exported;
}

function hasDefaultExport(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return true;
    }
    if (!statementHasExportModifier(statement)) {
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers) {
      continue;
    }
    for (const modifier of modifiers) {
      if (modifier.kind === ts.SyntaxKind.DefaultKeyword) {
        return true;
      }
    }
  }
  return false;
}

function chunkIdFromRelativeImport(moduleSpecifier: string): string | undefined {
  if (!moduleSpecifier.startsWith(".")) {
    return undefined;
  }
  const normalized = moduleSpecifier.replace(/\\/g, "/");
  const baseName = path.basename(normalized).replace(/\.[cm]?[jt]sx?$/i, "");
  if (baseName.length === 0) {
    return undefined;
  }
  return baseName;
}

function rewriteChunkImportSpecifier(moduleSpecifier: string, chunkAliasToId: ReadonlyMap<string, string>): string {
  if (!moduleSpecifier.startsWith(".")) {
    return moduleSpecifier;
  }
  const normalized = moduleSpecifier.replace(/\\/g, "/");
  const extensionMatch = normalized.match(/\.[cm]?[jt]sx?$/i);
  const extension = extensionMatch ? extensionMatch[0] : "";
  const withoutExtension = extension.length > 0 ? normalized.slice(0, -extension.length) : normalized;
  const baseName = path.posix.basename(withoutExtension);
  if (baseName.length === 0) {
    return moduleSpecifier;
  }
  const resolvedChunkId = chunkAliasToId.get(baseName);
  if (!resolvedChunkId || resolvedChunkId === baseName) {
    return moduleSpecifier;
  }
  const directory = path.posix.dirname(withoutExtension);
  const rewrittenBase = `${resolvedChunkId}${extension}`;
  return directory === "." ? `./${rewrittenBase}` : `${directory}/${rewrittenBase}`;
}

function applyChunkImportResolution(
  sourceFile: ts.SourceFile,
  chunkAliasToId: ReadonlyMap<string, string>,
): ImportResolutionResult {
  if (chunkAliasToId.size === 0) {
    return {
      sourceFile,
      rewrittenCount: 0,
    };
  }

  let rewrittenCount = 0;
  const nextStatements = sourceFile.statements.map((statement) => {
    if (!ts.isImportDeclaration(statement)) {
      return statement;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      return statement;
    }
    const currentSpecifier = statement.moduleSpecifier.text;
    const rewrittenSpecifier = rewriteChunkImportSpecifier(currentSpecifier, chunkAliasToId);
    if (rewrittenSpecifier === currentSpecifier) {
      return statement;
    }
    rewrittenCount += 1;
    return ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      statement.importClause,
      ts.factory.createStringLiteral(rewrittenSpecifier),
      statement.attributes,
    );
  });

  return {
    sourceFile: rewrittenCount > 0 ? ts.factory.updateSourceFile(sourceFile, nextStatements) : sourceFile,
    rewrittenCount,
  };
}

function collectLiftedChunkDependencies(sourceFile: ts.SourceFile): LiftedChunkDependency[] {
  const byChunk = new Map<string, { namedImports: Set<string>; requiresDefaultExport: boolean; requiresNamespaceImport: boolean }>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) {
      continue;
    }
    const chunkId = chunkIdFromRelativeImport(specifier.text);
    if (!chunkId) {
      continue;
    }

    const dependency = byChunk.get(chunkId) ?? {
      namedImports: new Set<string>(),
      requiresDefaultExport: false,
      requiresNamespaceImport: false,
    };
    const clause = statement.importClause;
    if (clause?.name) {
      dependency.requiresDefaultExport = true;
    }
    const namedBindings = clause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      dependency.requiresNamespaceImport = true;
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = element.propertyName ?? element.name;
        dependency.namedImports.add(imported.text);
      }
    }
    byChunk.set(chunkId, dependency);
  }

  return [...byChunk.entries()]
    .map(([chunkId, dependency]) => ({
      chunkId,
      namedImports: [...dependency.namedImports].sort((left, right) => left.localeCompare(right)),
      requiresDefaultExport: dependency.requiresDefaultExport,
      requiresNamespaceImport: dependency.requiresNamespaceImport,
    }))
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return true;
  }

  if (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  ) {
    return false;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }

  if (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }

  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return false;
  }

  if (ts.isMethodDeclaration(parent) && parent.name === node) {
    return false;
  }

  if (ts.isPropertyDeclaration(parent) && parent.name === node) {
    return false;
  }

  if (ts.isLabeledStatement(parent) && parent.label === node) {
    return false;
  }

  return true;
}

function collectReferenceCounts(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      const current = counts.get(node.text) ?? 0;
      counts.set(node.text, current + 1);
    }
    ts.forEachChild(node, visit);
  };

  for (const statement of sourceFile.statements) {
    ts.forEachChild(statement, visit);
  }

  return counts;
}

function pruneDeadVariableDeclarations(
  statement: ts.VariableStatement,
  exportedNames: Set<string>,
  referenceCounts: Map<string, number>,
): {
  statement: ts.VariableStatement;
  prunedCount: number;
} {
  const keptDeclarations: ts.VariableDeclaration[] = [];
  let prunedCount = 0;

  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      keptDeclarations.push(declaration);
      continue;
    }

    const name = declaration.name.text;
    const refCount = referenceCounts.get(name) ?? 0;
    const exported = exportedNames.has(name);
    const hasSideEffects = declaration.initializer ? hasSideEffectExpression(declaration.initializer) : false;

    if (exported || refCount > 0 || hasSideEffects) {
      keptDeclarations.push(declaration);
      continue;
    }

    prunedCount += 1;
  }

  if (keptDeclarations.length === statement.declarationList.declarations.length) {
    return {
      statement,
      prunedCount,
    };
  }

  const updatedStatement = ts.factory.updateVariableStatement(
    statement,
    statement.modifiers,
    ts.factory.updateVariableDeclarationList(statement.declarationList, keptDeclarations),
  );

  return {
    statement: updatedStatement,
    prunedCount,
  };
}

function applyBeautifyPipeline(sourceFile: ts.SourceFile): BeautifyResult {
  const exportedNames = collectExportedNames(sourceFile);
  const referenceCounts = collectReferenceCounts(sourceFile);

  const statements: ts.Statement[] = [];
  let prunedDeclarationCount = 0;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      statements.push(statement);
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      const declarationName = statement.name.text;
      const exported = exportedNames.has(declarationName);
      const references = referenceCounts.get(declarationName) ?? 0;
      if (!exported && references === 0) {
        prunedDeclarationCount += 1;
        continue;
      }
      statements.push(statement);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const pruned = pruneDeadVariableDeclarations(statement, exportedNames, referenceCounts);
      prunedDeclarationCount += pruned.prunedCount;
      if (pruned.statement.declarationList.declarations.length === 0) {
        continue;
      }
      statements.push(pruned.statement);
      continue;
    }

    statements.push(statement);
  }

  return {
    sourceFile: ts.factory.updateSourceFile(sourceFile, statements),
    prunedDeclarationCount,
  };
}

function buildDeclarationStatementIndex(sourceFile: ts.SourceFile): Map<string, ts.Statement> {
  const index = new Map<string, ts.Statement>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        index.set(statement.name.text, statement);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        index.set(declaration.name.text, statement);
      }
    }
  }
  return index;
}

function isSafeTopLevelDeclaration(statement: ts.Statement): boolean {
  if (ts.isFunctionDeclaration(statement)) {
    return true;
  }
  if (ts.isClassDeclaration(statement)) {
    return true;
  }
  if (!ts.isVariableStatement(statement)) {
    return false;
  }
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer;
    if (!initializer) {
      continue;
    }
    if (hasSideEffectExpression(initializer)) {
      return false;
    }
  }
  return true;
}

function collectIdentifierReferences(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(statement, visit);
  return names;
}

function keepImportDeclaration(importDeclaration: ts.ImportDeclaration, referencedNames: Set<string>): boolean {
  const clause = importDeclaration.importClause;
  if (!clause) {
    return false;
  }
  if (clause.name && referencedNames.has(clause.name.text)) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (!bindings) {
    return false;
  }
  if (ts.isNamespaceImport(bindings)) {
    return referencedNames.has(bindings.name.text);
  }
  for (const element of bindings.elements) {
    if (referencedNames.has(element.name.text)) {
      return true;
    }
  }
  return false;
}

function collectImportBindingNames(importDeclaration: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const clause = importDeclaration.importClause;
  if (!clause) {
    return names;
  }
  if (clause.name) {
    names.push(clause.name.text);
  }
  const bindings = clause.namedBindings;
  if (!bindings) {
    return names;
  }
  if (ts.isNamespaceImport(bindings)) {
    names.push(bindings.name.text);
    return names;
  }
  for (const element of bindings.elements) {
    names.push(element.name.text);
  }
  return names;
}

function selectLiftedStatements(
  sourceFile: ts.SourceFile,
  targetIdentifiers: string[],
  requiredIdentifiers: ReadonlySet<string>,
): LiftedStatementSelection {
  const declarationIndex = buildDeclarationStatementIndex(sourceFile);
  const selectedStatements = new Set<ts.Statement>();
  const availableIdentifiers = new Set<string>();
  const queue: string[] = [...new Set(targetIdentifiers)].sort((left, right) => left.localeCompare(right));
  const unsafeAllowlist = new Set<string>([...queue, ...requiredIdentifiers]);

  while (queue.length > 0) {
    const identifier = queue.shift();
    if (!identifier) {
      continue;
    }
    const declaration = declarationIndex.get(identifier);
    if (!declaration) {
      continue;
    }
    const declaredNames = collectDeclaredNamesFromNode(declaration);
    const allowlistedDeclaration = declaredNames.some((declaredName) => unsafeAllowlist.has(declaredName));
    if (!isSafeTopLevelDeclaration(declaration) && !allowlistedDeclaration) {
      continue;
    }
    if (selectedStatements.has(declaration)) {
      continue;
    }

    selectedStatements.add(declaration);
    for (const declaredName of declaredNames) {
      availableIdentifiers.add(declaredName);
    }

    const references = collectIdentifierReferences(declaration);
    for (const referenceName of references) {
      if (allowlistedDeclaration && declarationIndex.has(referenceName)) {
        unsafeAllowlist.add(referenceName);
      }
      if (declarationIndex.has(referenceName)) {
        queue.push(referenceName);
      }
    }
  }

  const referencedNames = new Set<string>();
  for (const statement of selectedStatements) {
    const refs = collectIdentifierReferences(statement);
    for (const refName of refs) {
      referencedNames.add(refName);
    }
  }

  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement));
  const keptImports = imports
    .filter((statement) => keepImportDeclaration(statement, referencedNames))
    .sort((left, right) => {
      const leftSpecifier = left.moduleSpecifier;
      const rightSpecifier = right.moduleSpecifier;
      if (!ts.isStringLiteral(leftSpecifier) || !ts.isStringLiteral(rightSpecifier)) {
        return 0;
      }
      return leftSpecifier.text.localeCompare(rightSpecifier.text);
    });

  for (const importDeclaration of keptImports) {
    for (const name of collectImportBindingNames(importDeclaration)) {
      availableIdentifiers.add(name);
    }
  }

  const declarationStatements = sourceFile.statements.filter((statement) => selectedStatements.has(statement));
  const statements: ts.Statement[] = [...keptImports, ...declarationStatements];
  return {
    statements,
    availableIdentifiers,
  };
}

function collectExportCandidates(sourceFile: ts.SourceFile): ExportCandidate[] {
  const candidates: ExportCandidate[] = [];
  const seen = new Set<string>();

  const register = (referenceName: string, exportName: string): void => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(referenceName)) {
      return;
    }
    const key = `${referenceName}::${exportName}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({
      referenceName,
      exportName,
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        register(statement.name.text, statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          register(declaration.name.text, declaration.name.text);
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        const exportName = element.name.text;
        register(localName, exportName);
      }
    }
  }

  return candidates;
}

function exportLocalPriority(exportName: string, localName: string): number {
  let score = 0;
  if (localName !== exportName) {
    score += 2;
  }
  if (!isObfuscatedIdentifier(localName)) {
    score += 2;
  }
  if (localName.length >= 4) {
    score += 1;
  }
  return score;
}

function buildExportLocalsByExportName(candidates: ReadonlyArray<ExportCandidate>): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const locals = grouped.get(candidate.exportName) ?? new Set<string>();
    locals.add(candidate.referenceName);
    grouped.set(candidate.exportName, locals);
  }

  const result = new Map<string, string[]>();
  for (const [exportName, locals] of grouped.entries()) {
    const orderedLocals = [...locals].sort((left, right) => {
      const leftPriority = exportLocalPriority(exportName, left);
      const rightPriority = exportLocalPriority(exportName, right);
      if (leftPriority !== rightPriority) {
        return rightPriority - leftPriority;
      }
      return left.localeCompare(right);
    });
    result.set(exportName, orderedLocals);
  }
  return result;
}

function symbolKeyAnchor(symbolKey: string): string {
  const parts = symbolKey.split(":");
  return parts[parts.length - 1] ?? "";
}

function tokenizeName(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

function nameOverlapScore(left: string, right: string): number {
  const leftTokens = tokenizeName(left);
  const rightTokens = tokenizeName(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.length, rightTokens.length);
}

function scoreCandidate(symbol: OwnershipRecord, candidate: ExportCandidate): number {
  const anchor = symbolKeyAnchor(symbol.symbolKey);
  const overlap = Math.max(
    nameOverlapScore(symbol.symbolName, candidate.referenceName),
    nameOverlapScore(symbol.symbolName, candidate.exportName),
  );
  const anchorMatch = anchor.length > 0 && (anchor === candidate.referenceName || anchor === candidate.exportName) ? 0.85 : 0;
  const obfuscationPenalty = isObfuscatedIdentifier(candidate.referenceName) ? 0.18 : 0;
  return overlap * 0.75 + anchorMatch + (1 - obfuscationPenalty) * 0.25;
}

function bindChunkSymbols(
  chunkId: string,
  symbols: OwnershipRecord[],
  candidates: ExportCandidate[],
): LiftedSymbolBinding[] {
  const sortedSymbols = [...symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
  const sortedCandidates = [...candidates].sort((left, right) => left.referenceName.localeCompare(right.referenceName));
  const usedExportNames = new Set<string>(sortedCandidates.map((candidate) => candidate.referenceName));
  const usedCandidates = new Set<number>();
  const bindings: LiftedSymbolBinding[] = [];

  for (let symbolIndex = 0; symbolIndex < sortedSymbols.length; symbolIndex += 1) {
    const symbol = sortedSymbols[symbolIndex];
    if (!symbol) {
      continue;
    }
    let bestIndex = -1;
    let bestScore = -1;

    for (let index = 0; index < sortedCandidates.length; index += 1) {
      const candidate = sortedCandidates[index];
      if (!candidate) {
        continue;
      }
      const score = scoreCandidate(symbol, candidate);
      if (!usedCandidates.has(index)) {
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
        continue;
      }

      const reuseScore = score * 0.62;
      if (reuseScore > bestScore) {
        bestScore = reuseScore;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      continue;
    }

    const winner = sortedCandidates[bestIndex];
    if (!winner) {
      continue;
    }

    usedCandidates.add(bestIndex);

    const preferredBase = buildLiftedSymbolBaseName(chunkId, symbol, winner.referenceName, symbolIndex + 1);
    const exportName = makeUniqueName(preferredBase, usedExportNames);

    bindings.push({
      symbolKey: symbol.symbolKey,
      symbolName: symbol.symbolName,
      chunkId,
      sourceIdentifier: winner.referenceName,
      exportName,
      confidence: clamp(bestScore),
    });
  }

  return bindings;
}

function archetypeHotWeight(archetype: ArchetypeId): number {
  if (archetype === "ui") {
    return 1.65;
  }
  if (archetype === "service") {
    return 1.45;
  }
  if (archetype === "hook") {
    return 1.25;
  }
  if (archetype === "transport") {
    return 1.1;
  }
  return 0.85;
}

function computeChunkHotScores(
  chunkArtifacts: ChunkArtifactModel,
  ownershipModel: OwnershipModel,
  options: AstLiftOptions,
): Map<string, number> {
  const ownershipByKey = new Map<string, OwnershipRecord>();
  for (const symbol of ownershipModel.symbols) {
    ownershipByKey.set(symbol.symbolKey, symbol);
  }

  const preferredArchetypes = new Set<ArchetypeId>(options.preferredArchetypes);
  const chunkScores = new Map<string, number>();
  const chunkSymbolCounts = new Map<string, number>();

  for (const mapping of chunkArtifacts.symbolMappings) {
    const symbol = ownershipByKey.get(mapping.symbolKey);
    if (!symbol) {
      continue;
    }

    const archetypeWeight = archetypeHotWeight(symbol.archetype);
    const preferenceMultiplier = preferredArchetypes.has(symbol.archetype) ? 1.2 : 0.45;
    const confidenceWeight = Math.max(0.25, symbol.confidence);
    const increment = archetypeWeight * preferenceMultiplier * confidenceWeight;
    const currentScore = chunkScores.get(mapping.chunkId) ?? 0;
    chunkScores.set(mapping.chunkId, currentScore + increment);

    const currentCount = chunkSymbolCounts.get(mapping.chunkId) ?? 0;
    chunkSymbolCounts.set(mapping.chunkId, currentCount + 1);
  }

  for (const chunk of chunkArtifacts.chunks) {
    const currentScore = chunkScores.get(chunk.chunkId) ?? 0;
    const symbolCount = chunkSymbolCounts.get(chunk.chunkId) ?? 0;
    const densityBonus = symbolCount > 0 ? Math.log10(symbolCount + 1) * 0.35 : 0;
    chunkScores.set(chunk.chunkId, currentScore + densityBonus);
  }

  return chunkScores;
}

function pickHotChunks(
  chunkArtifacts: ChunkArtifactModel,
  ownershipModel: OwnershipModel,
  options: AstLiftOptions,
): string[] {
  const chunkScores = computeChunkHotScores(chunkArtifacts, ownershipModel, options);
  const rankedChunks = [...chunkArtifacts.chunks]
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      score: chunkScores.get(chunk.chunkId) ?? 0,
    }))
    .filter((entry) => entry.score >= options.minimumChunkScore)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.chunkId.localeCompare(right.chunkId);
    });

  if (rankedChunks.length === 0) {
    const fallback = [...chunkArtifacts.chunks]
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId))
      .slice(0, 1)
      .map((chunk) => chunk.chunkId);
    return fallback;
  }

  const totalScore = rankedChunks.reduce((sum, entry) => sum + entry.score, 0);
  const hotChunkIds: string[] = [];
  const picked = new Set<string>();
  let collectedScore = 0;

  for (const entry of rankedChunks) {
    if (hotChunkIds.length >= options.hotChunkMax) {
      break;
    }
    hotChunkIds.push(entry.chunkId);
    picked.add(entry.chunkId);
    collectedScore += entry.score;
    if (totalScore > 0 && collectedScore / totalScore >= options.targetCoverage && hotChunkIds.length >= options.minHotChunkCount) {
      break;
    }
  }

  for (const entry of rankedChunks) {
    if (hotChunkIds.length >= options.hotChunkMax) {
      break;
    }
    if (hotChunkIds.length >= options.minHotChunkCount) {
      break;
    }
    if (picked.has(entry.chunkId)) {
      continue;
    }
    hotChunkIds.push(entry.chunkId);
    picked.add(entry.chunkId);
  }

  if (hotChunkIds.length === 0) {
    const firstChunk = rankedChunks[0];
    if (!firstChunk) {
      throw new Error("pickHotChunks: no ranked chunks");
    }
    hotChunkIds.push(firstChunk.chunkId);
  }

  return hotChunkIds;
}

function selectChunkById(chunkArtifacts: ChunkArtifactModel, chunkId: string): ChunkArtifactRecord {
  const chunk = chunkArtifacts.chunks.find((entry) => entry.chunkId === chunkId);
  if (!chunk) {
    throw new Error(`selectChunkById: missing chunk ${chunkId}`);
  }
  return chunk;
}

function buildChunkAliasToId(chunkArtifacts: ChunkArtifactModel): Map<string, string> {
  const sourcePriority = (sourceFilePath: string): number => {
    const normalized = sourceFilePath.replace(/\\/g, "/").toLowerCase();
    let score = 0;
    if (normalized.includes("/asar-extract/")) {
      score += 6;
    }
    if (normalized.includes("/webview/assets/")) {
      score += 5;
    }
    if (normalized.includes("/.vite/build/")) {
      score += 4;
    }
    if (normalized.includes("/webcrack/")) {
      score -= 2;
    }
    if (normalized.includes("/wakaru/")) {
      score -= 2;
    }
    if (normalized.includes("/javascript-deobfuscator/")) {
      score -= 2;
    }
    if (normalized.includes("/synchrony/")) {
      score -= 2;
    }
    return score;
  };

  const aliasToChunkId = new Map<string, string>();
  const aliasToScore = new Map<string, number>();
  for (const chunk of chunkArtifacts.chunks) {
    const alias = path.basename(chunk.sourceFilePath).replace(/\.[cm]?[jt]sx?$/i, "");
    if (alias.length === 0) {
      continue;
    }
    const nextScore = sourcePriority(chunk.sourceFilePath);
    const existing = aliasToChunkId.get(alias);
    if (!existing) {
      aliasToChunkId.set(alias, chunk.chunkId);
      aliasToScore.set(alias, nextScore);
      continue;
    }
    const existingScore = aliasToScore.get(alias) ?? Number.NEGATIVE_INFINITY;
    if (nextScore > existingScore || (nextScore === existingScore && chunk.chunkId.localeCompare(existing) < 0)) {
      aliasToChunkId.set(alias, chunk.chunkId);
      aliasToScore.set(alias, nextScore);
    }
  }
  return aliasToChunkId;
}

function buildSymbolsByChunk(
  chunkArtifacts: ChunkArtifactModel,
  ownershipModel: OwnershipModel,
): Map<string, OwnershipRecord[]> {
  const ownershipByKey = new Map<string, OwnershipRecord>();
  for (const symbol of ownershipModel.symbols) {
    ownershipByKey.set(symbol.symbolKey, symbol);
  }

  const symbolsByChunk = new Map<string, OwnershipRecord[]>();
  for (const mapping of chunkArtifacts.symbolMappings) {
    const symbol = ownershipByKey.get(mapping.symbolKey);
    if (!symbol) {
      continue;
    }
    const existing = symbolsByChunk.get(mapping.chunkId);
    if (existing) {
      existing.push(symbol);
      continue;
    }
    symbolsByChunk.set(mapping.chunkId, [symbol]);
  }

  for (const [chunkId, symbols] of symbolsByChunk.entries()) {
    symbolsByChunk.set(
      chunkId,
      [...symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    );
  }

  return symbolsByChunk;
}

async function liftChunkToTypescript(
  chunk: ChunkArtifactRecord,
  symbols: OwnershipRecord[],
  requirements: LiftChunkRequirements,
  chunkAliasToId: ReadonlyMap<string, string>,
): Promise<LiftedChunkArtifact> {
  const sourceText = await fs.readFile(chunk.sourceFilePath, "utf8");
  const sourceFile = ts.createSourceFile(chunk.sourceFilePath, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  const importResolution = applyChunkImportResolution(sourceFile, chunkAliasToId);
  const importShaping = applyImportShaping(importResolution.sourceFile);
  const beautify = applyBeautifyPipeline(importShaping.sourceFile);
  const exportCandidates = collectExportCandidates(beautify.sourceFile);
  const exportLocalsByName = buildExportLocalsByExportName(exportCandidates);
  const symbolBindings = bindChunkSymbols(chunk.chunkId, symbols, exportCandidates);

  const requiredSourceIdentifiers = new Set<string>();
  for (const requiredName of requirements.requiredIdentifiers) {
    requiredSourceIdentifiers.add(requiredName);
    const aliasLocals = exportLocalsByName.get(requiredName) ?? [];
    for (const aliasLocal of aliasLocals) {
      if (aliasLocal.length === 0) {
        continue;
      }
      requiredSourceIdentifiers.add(aliasLocal);
    }
  }

  const uniqueSourceIdentifiers = [
    ...new Set<string>([
      ...symbolBindings.map((binding) => binding.sourceIdentifier),
      ...requiredSourceIdentifiers,
    ]),
  ]
    .filter((identifier) => identifier.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const liftedSelection = selectLiftedStatements(
    beautify.sourceFile,
    uniqueSourceIdentifiers,
    requiredSourceIdentifiers,
  );
  const liftedSourceFile = ts.factory.updateSourceFile(beautify.sourceFile, liftedSelection.statements);
  const dependencies = collectLiftedChunkDependencies(liftedSourceFile);
  const liftedDeclarationCount = liftedSelection.statements.reduce(
    (count, statement) => count + (ts.isImportDeclaration(statement) ? 0 : 1),
    0,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const liftedDeclarationsText = liftedSelection.statements.length > 0 ? printer.printFile(liftedSourceFile).trim() : "";
  const requiresNoCondAssignDisable = /\b(?:if|while|for)\s*\([^)]*\b[A-Za-z_$][A-Za-z0-9_$]*\s*=(?!=)[^)]*\)/.test(
    liftedDeclarationsText,
  );
  const existingExports = collectExportedNames(liftedSourceFile);
  const defaultExportPresent = hasDefaultExport(liftedSourceFile);
  let liftedHasDefaultExport = defaultExportPresent;
  const existingIdentifiers = liftedSelection.availableIdentifiers;
  const resolvedBindings: LiftedSymbolBinding[] = [];

  const aliasLines = symbolBindings
    .sort((left, right) => left.exportName.localeCompare(right.exportName))
    .flatMap((binding): string[] => {
      if (!existingIdentifiers.has(binding.sourceIdentifier)) {
        return [];
      }

      resolvedBindings.push(binding);
      if (binding.exportName === binding.sourceIdentifier) {
        if (existingExports.has(binding.sourceIdentifier)) {
          return [];
        }
        existingExports.add(binding.sourceIdentifier);
        return [`export { ${binding.sourceIdentifier} };`];
      }
      return [`export { ${binding.sourceIdentifier} as ${binding.exportName} };`];
    });

  const requiredExportLines: string[] = [];
  const requiredIdentifiers = [...requirements.requiredIdentifiers].sort((left, right) => left.localeCompare(right));
  for (const identifier of requiredIdentifiers) {
    if (existingExports.has(identifier)) {
      continue;
    }

    if (existingIdentifiers.has(identifier)) {
      requiredExportLines.push(`export { ${identifier} };`);
      existingExports.add(identifier);
      continue;
    }

    const aliasLocals = exportLocalsByName.get(identifier) ?? [];
    const aliasLocal = aliasLocals.find((candidate) => existingIdentifiers.has(candidate));
    if (!aliasLocal) {
      throw new Error(
        `liftChunkToTypescript: chunk ${chunk.chunkId} missing required export "${identifier}" in ${chunk.sourceFilePath}`,
      );
    }
    if (aliasLocal === identifier) {
      requiredExportLines.push(`export { ${aliasLocal} };`);
      existingExports.add(identifier);
      continue;
    }
    requiredExportLines.push(`export { ${aliasLocal} as ${identifier} };`);
    existingExports.add(identifier);
  }
  const syntheticDefaultExportLines: string[] = [];
  if (requirements.requiresDefaultExport && !liftedHasDefaultExport) {
    const sortedIdentifiers = [...existingIdentifiers].sort((left, right) => left.localeCompare(right));
    const preferredIdentifierFromRequirements = requiredIdentifiers.find((identifier) => existingIdentifiers.has(identifier));
    const preferredIdentifierFromBindings = resolvedBindings.find((binding) => existingIdentifiers.has(binding.sourceIdentifier))
      ?.sourceIdentifier;
    const preferredIdentifierFromExports = [...existingExports]
      .sort((left, right) => left.localeCompare(right))
      .find((identifier) => existingIdentifiers.has(identifier));
    const preferredIdentifier =
      preferredIdentifierFromRequirements ??
      preferredIdentifierFromBindings ??
      preferredIdentifierFromExports ??
      sortedIdentifiers[0];

    const takenIdentifiers = new Set<string>([...existingIdentifiers]);
    const createSyntheticIdentifier = (baseName: string): string => {
      let candidate = baseName;
      let index = 1;
      while (takenIdentifiers.has(candidate)) {
        candidate = `${baseName}${String(index).padStart(2, "0")}`;
        index += 1;
      }
      takenIdentifiers.add(candidate);
      return candidate;
    };

    const defaultExportAlias = createSyntheticIdentifier("__liftedDefaultExport");
    if (preferredIdentifier) {
      syntheticDefaultExportLines.push(`const ${defaultExportAlias} = ${preferredIdentifier};`);
      syntheticDefaultExportLines.push(`export default ${defaultExportAlias};`);
      liftedHasDefaultExport = true;
    } else {
      syntheticDefaultExportLines.push(`const ${defaultExportAlias} = Object.freeze({}) as const;`);
      syntheticDefaultExportLines.push(`export default ${defaultExportAlias};`);
      liftedHasDefaultExport = true;
    }
  }

  const metadataLines = [
    `export const liftedSourcePath = ${JSON.stringify(chunk.sourceFilePath.split(path.sep).join("/"))};`,
    `export const liftedImportResolutionCount = ${importResolution.rewrittenCount};`,
    `export const liftedImportShapingCount = ${importShaping.shapedCount};`,
    `export const liftedPrunedDeclarationCount = ${beautify.prunedDeclarationCount};`,
    `export const liftedDeclarationCount = ${liftedDeclarationCount};`,
  ];

  const lines = [
    "// @ts-nocheck",
    ...(requiresNoCondAssignDisable ? ["/* eslint-disable no-cond-assign */"] : []),
    `// Lifted from ${chunk.sourceFilePath.split(path.sep).join("/")}`,
    "",
    ...(liftedDeclarationsText.length > 0 ? [liftedDeclarationsText, ""] : []),
    ...requiredExportLines,
    ...(requiredExportLines.length > 0 ? [""] : []),
    ...syntheticDefaultExportLines,
    ...(syntheticDefaultExportLines.length > 0 ? [""] : []),
    ...metadataLines,
    "",
    ...aliasLines,
    "",
  ];

  return {
    chunkId: chunk.chunkId,
    sourceFilePath: chunk.sourceFilePath,
    content: lines.join("\n"),
    symbolBindings: resolvedBindings,
    dependencies,
    exportedIdentifiers: [...existingExports].sort((left, right) => left.localeCompare(right)),
    hasDefaultExport: liftedHasDefaultExport,
    importShapingCount: importShaping.shapedCount,
    prunedDeclarationCount: beautify.prunedDeclarationCount,
    liftedDeclarationCount,
  };
}

function createMutableRequirements(): MutableLiftChunkRequirements {
  return {
    requiredIdentifiers: new Set<string>(),
    requiresDefaultExport: false,
    requiresNamespaceImport: false,
  };
}

function assertRequiredExportClosure(
  liftedChunkById: ReadonlyMap<string, LiftedChunkArtifact>,
  requirementsByChunk: ReadonlyMap<string, MutableLiftChunkRequirements>,
): void {
  const chunkIds = [...requirementsByChunk.keys()].sort((left, right) => left.localeCompare(right));
  for (const chunkId of chunkIds) {
    const requirements = requirementsByChunk.get(chunkId);
    if (!requirements) {
      continue;
    }
    const liftedChunk = liftedChunkById.get(chunkId);
    if (!liftedChunk) {
      throw new Error(`required-export closure: missing lifted chunk ${chunkId}`);
    }

    const exported = new Set<string>(liftedChunk.exportedIdentifiers);
    const requiredIdentifiers = [...requirements.requiredIdentifiers].sort((left, right) => left.localeCompare(right));
    const missingNamedExports = requiredIdentifiers.filter((identifier) => !exported.has(identifier));
    if (missingNamedExports.length > 0) {
      const preview = missingNamedExports.slice(0, 12).join(", ");
      throw new Error(
        `required-export closure: chunk ${chunkId} missing named export(s): ${preview}`,
      );
    }
    if (requirements.requiresDefaultExport && !liftedChunk.hasDefaultExport) {
      throw new Error(`required-export closure: chunk ${chunkId} requires default export but none was lifted`);
    }
  }
}

export async function buildAstLiftResult(
  chunkArtifacts: ChunkArtifactModel,
  ownershipModel: OwnershipModel,
  optionsInput: Partial<AstLiftOptions> = {},
): Promise<AstLiftResult> {
  const options: AstLiftOptions = {
    ...DEFAULT_LIFT_OPTIONS,
    ...optionsInput,
  };

  const hotChunkIds = pickHotChunks(chunkArtifacts, ownershipModel, options);
  const symbolsByChunk = buildSymbolsByChunk(chunkArtifacts, ownershipModel);
  const chunkById = new Map<string, ChunkArtifactRecord>(
    chunkArtifacts.chunks.map((chunk) => [chunk.chunkId, chunk]),
  );
  const chunkAliasToId = buildChunkAliasToId(chunkArtifacts);

  const liftedChunkById = new Map<string, LiftedChunkArtifact>();
  const symbolBindingByKey = new Map<string, LiftedSymbolBinding>();
  const processedChunkIds = new Set<string>();
  const queuedChunkIds = new Set<string>();
  const queue: string[] = [];
  const requirementsByChunk = new Map<string, MutableLiftChunkRequirements>();

  const enqueue = (chunkId: string): void => {
    if (processedChunkIds.has(chunkId) || queuedChunkIds.has(chunkId)) {
      return;
    }
    if (!chunkById.has(chunkId)) {
      return;
    }
    queue.push(chunkId);
    queuedChunkIds.add(chunkId);
  };

  const mergeRequirements = (
    chunkId: string,
    dependency: LiftedChunkDependency,
  ): void => {
    const existing = requirementsByChunk.get(chunkId) ?? createMutableRequirements();
    let changed = false;
    for (const name of dependency.namedImports) {
      if (existing.requiredIdentifiers.has(name)) {
        continue;
      }
      existing.requiredIdentifiers.add(name);
      changed = true;
    }
    if (dependency.requiresDefaultExport && !existing.requiresDefaultExport) {
      existing.requiresDefaultExport = true;
      changed = true;
    }
    if (dependency.requiresNamespaceImport && !existing.requiresNamespaceImport) {
      existing.requiresNamespaceImport = true;
      changed = true;
    }
    requirementsByChunk.set(chunkId, existing);
    if (changed && processedChunkIds.has(chunkId)) {
      processedChunkIds.delete(chunkId);
      enqueue(chunkId);
    }
  };

  for (const hotChunkId of hotChunkIds) {
    requirementsByChunk.set(hotChunkId, createMutableRequirements());
    enqueue(hotChunkId);
  }

  while (queue.length > 0) {
    if (processedChunkIds.size >= options.closureChunkLimit) {
      break;
    }
    const chunkId = queue.shift();
    if (!chunkId) {
      continue;
    }
    queuedChunkIds.delete(chunkId);
    if (processedChunkIds.has(chunkId)) {
      continue;
    }

    const chunk = selectChunkById(chunkArtifacts, chunkId);
    if (chunk.sourceKind !== "javascript") {
      throw new Error(`buildAstLiftResult: chunk ${chunk.chunkId} is not javascript`);
    }

    const symbols = symbolsByChunk.get(chunk.chunkId) ?? [];
    const requirements = requirementsByChunk.get(chunk.chunkId) ?? createMutableRequirements();
    requirementsByChunk.set(chunk.chunkId, requirements);
    const lifted = await liftChunkToTypescript(chunk, symbols, {
      requiredIdentifiers: requirements.requiredIdentifiers,
      requiresDefaultExport: requirements.requiresDefaultExport,
      requiresNamespaceImport: requirements.requiresNamespaceImport,
    }, chunkAliasToId);
    const previousLifted = liftedChunkById.get(chunk.chunkId);
    if (previousLifted) {
      for (const binding of previousLifted.symbolBindings) {
        const currentBinding = symbolBindingByKey.get(binding.symbolKey);
        if (currentBinding && currentBinding.chunkId === chunk.chunkId) {
          symbolBindingByKey.delete(binding.symbolKey);
        }
      }
    }
    liftedChunkById.set(chunk.chunkId, lifted);
    processedChunkIds.add(chunk.chunkId);

    for (const binding of lifted.symbolBindings) {
      symbolBindingByKey.set(binding.symbolKey, binding);
    }

    for (const dependency of lifted.dependencies) {
      if (!chunkById.has(dependency.chunkId)) {
        continue;
      }
      mergeRequirements(dependency.chunkId, dependency);
      enqueue(dependency.chunkId);
    }
  }

  assertRequiredExportClosure(liftedChunkById, requirementsByChunk);

  const liftedChunks = [...liftedChunkById.values()].sort((left, right) => left.chunkId.localeCompare(right.chunkId));

  return {
    hotChunkIds,
    liftedChunks,
    symbolBindingByKey,
  };
}
