import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { ArchetypeId } from "../contracts";
import { ChunkArtifactModel, ChunkArtifactRecord } from "../ir/chunk-artifact-model";
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
  importShapingCount: number;
  prunedDeclarationCount: number;
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
}

interface ImportShapingResult {
  sourceFile: ts.SourceFile;
  shapedCount: number;
}

interface BeautifyResult {
  sourceFile: ts.SourceFile;
  prunedDeclarationCount: number;
}

interface ExportCandidate {
  referenceName: string;
  exportName: string;
}

const DEFAULT_LIFT_OPTIONS: AstLiftOptions = {
  hotChunkMax: 24,
  targetCoverage: 0.95,
  minHotChunkCount: 8,
  preferredArchetypes: ["ui", "service", "hook", "transport"],
  minimumChunkScore: 0,
};

const GENERIC_IMPORT_TOKENS = new Set<string>(["index", "chunk", "main", "entry", "assets", "webview", "src"]);

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
  shapedCount: number;
} {
  const moduleSpecifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) {
    return {
      statement,
      bridges: [],
      shapedCount: 0,
    };
  }

  const clause = statement.importClause;
  if (!clause) {
    return {
      statement,
      bridges: [],
      shapedCount: 0,
    };
  }

  const bridges: ts.Statement[] = [];
  let shapedCount = 0;

  let defaultImportName = clause.name;
  if (clause.name) {
    const localName = clause.name.text;
    if (isObfuscatedIdentifier(localName)) {
      const shapedName = makeUniqueName(buildReadableImportName(moduleSpecifier.text, "default"), usedNames);
      defaultImportName = ts.factory.createIdentifier(shapedName);
      bridges.push(createAliasBridge(localName, shapedName));
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
    shapedCount,
  };
}

function applyImportShaping(sourceFile: ts.SourceFile): ImportShapingResult {
  const usedNames = collectTopLevelBoundNames(sourceFile);
  const imports: ts.ImportDeclaration[] = [];
  const bridges: ts.Statement[] = [];
  const others: ts.Statement[] = [];
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

  return {
    sourceFile: ts.factory.updateSourceFile(sourceFile, [...imports, ...bridges, ...others]),
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

  for (const symbol of sortedSymbols) {
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

    const preferredBase = isObfuscatedIdentifier(symbol.symbolName)
      ? sanitizeIdentifier(`${winner.referenceName}Symbol`, "liftedSymbol")
      : sanitizeIdentifier(symbol.symbolName, "liftedSymbol");
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

  return hotChunkIds.sort((left, right) => left.localeCompare(right));
}

function selectChunkById(chunkArtifacts: ChunkArtifactModel, chunkId: string): ChunkArtifactRecord {
  const chunk = chunkArtifacts.chunks.find((entry) => entry.chunkId === chunkId);
  if (!chunk) {
    throw new Error(`selectChunkById: missing chunk ${chunkId}`);
  }
  return chunk;
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
): Promise<LiftedChunkArtifact> {
  const sourceText = await fs.readFile(chunk.sourceFilePath, "utf8");
  const sourceFile = ts.createSourceFile(chunk.sourceFilePath, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  const importShaping = applyImportShaping(sourceFile);
  const beautify = applyBeautifyPipeline(importShaping.sourceFile);
  const exportCandidates = collectExportCandidates(beautify.sourceFile);
  const symbolBindings = bindChunkSymbols(chunk.chunkId, symbols, exportCandidates);

  const uniqueSourceIdentifiers = [...new Set(symbolBindings.map((binding) => binding.sourceIdentifier))].sort((left, right) =>
    left.localeCompare(right),
  );
  const usedBackingNames = new Set<string>();
  const backingBySourceIdentifier = new Map<string, string>();
  for (const identifier of uniqueSourceIdentifiers) {
    const backingName = makeUniqueName(sanitizeIdentifier(`lifted ${identifier}`, "liftedSource"), usedBackingNames);
    backingBySourceIdentifier.set(identifier, backingName);
  }

  const sourceDeclarationLines = uniqueSourceIdentifiers.map((identifier) => {
    const backingName = backingBySourceIdentifier.get(identifier);
    if (!backingName) {
      throw new Error(`liftChunkToTypescript: missing backing name for ${identifier}`);
    }
    return `const ${backingName}: unknown = Object.freeze({ lifted: true, chunkId: ${JSON.stringify(chunk.chunkId)}, sourceIdentifier: ${JSON.stringify(identifier)} });`;
  });
  const aliasLines = symbolBindings
    .sort((left, right) => left.exportName.localeCompare(right.exportName))
    .map((binding) => {
      const backingName = backingBySourceIdentifier.get(binding.sourceIdentifier);
      if (!backingName) {
        throw new Error(`liftChunkToTypescript: missing source binding for ${binding.sourceIdentifier}`);
      }
      return `export const ${binding.exportName} = ${backingName};`;
    });
  const metadataLines = [
    `export const liftedSourcePath = ${JSON.stringify(chunk.sourceFilePath.split(path.sep).join("/"))};`,
    `export const liftedImportShapingCount = ${importShaping.shapedCount};`,
    `export const liftedPrunedDeclarationCount = ${beautify.prunedDeclarationCount};`,
  ];

  const lines = [
    "// @ts-nocheck",
    `// Lifted from ${chunk.sourceFilePath.split(path.sep).join("/")}`,
    "",
    ...metadataLines,
    "",
    ...sourceDeclarationLines,
    ...(sourceDeclarationLines.length > 0 ? [""] : []),
    ...aliasLines,
    "",
  ];

  return {
    chunkId: chunk.chunkId,
    sourceFilePath: chunk.sourceFilePath,
    content: lines.join("\n"),
    symbolBindings,
    importShapingCount: importShaping.shapedCount,
    prunedDeclarationCount: beautify.prunedDeclarationCount,
  };
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

  const liftedChunks: LiftedChunkArtifact[] = [];
  const symbolBindingByKey = new Map<string, LiftedSymbolBinding>();

  const hotChunks = hotChunkIds.map((chunkId) => selectChunkById(chunkArtifacts, chunkId));
  for (const chunk of hotChunks) {
    if (chunk.sourceKind !== "javascript") {
      throw new Error(`buildAstLiftResult: hot chunk ${chunk.chunkId} is not javascript`);
    }

    const symbols = symbolsByChunk.get(chunk.chunkId) ?? [];
    const lifted = await liftChunkToTypescript(chunk, symbols);
    liftedChunks.push(lifted);

    for (const binding of lifted.symbolBindings) {
      symbolBindingByKey.set(binding.symbolKey, binding);
    }
  }

  liftedChunks.sort((left, right) => left.chunkId.localeCompare(right.chunkId));

  return {
    hotChunkIds,
    liftedChunks,
    symbolBindingByKey,
  };
}
