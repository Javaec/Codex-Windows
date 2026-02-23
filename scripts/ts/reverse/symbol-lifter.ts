import * as ts from "typescript";

export type LiftedExportKind = "class" | "function" | "variable";

export interface LiftedExportSpec {
  exportName: string;
  sourceSymbol: string;
  kind: LiftedExportKind;
  sourceLine: number;
}

export interface LiftedModuleSourceInput {
  sourceFilePath: string;
  sourceText: string;
  exports: LiftedExportSpec[];
  maxDependencyStatements: number;
  maxDependencyStatementLength: number;
  maxPrimaryStatementLength: number;
  allowClosestFallback?: boolean;
  allowParserRegistryUnpack?: boolean;
}

export interface LiftedModuleSourceResult {
  moduleBody: string;
  liftedExports: LiftedExportSpec[];
  unresolvedExports: LiftedExportSpec[];
  includedStatements: number;
  dependencyBudget: number;
  dependencyTrimmed: boolean;
  skippedDependencies: number;
  skippedOversizedDependencies: number;
  renameCandidates: number;
  renamedDeclarations: number;
  skippedRenames: number;
  rewrittenReferenceSymbols: number;
  rewrittenReferenceIdentifiers: number;
}

export interface LiftDeclarationStat {
  name: string;
  kind: LiftedExportKind;
  line: number;
  statementLength: number;
  generatedSignal: number;
}

interface TopLevelDeclarationRecord {
  name: string;
  kind: LiftedExportKind;
  line: number;
  statementIndex: number;
  declarationStart: number;
}

interface TopLevelStatementRecord {
  index: number;
  line: number;
  text: string;
  generatedSignal: number;
  declaredNames: Set<string>;
  references: Set<string>;
}

interface RenameCandidate {
  sourceSymbol: string;
  exportName: string;
  kind: LiftedExportKind;
  line: number;
  statementIndex: number;
  declarationStart: number;
}

const GLOBAL_REFERENCE_EXCLUDES = new Set<string>([
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

function scoreGeneratedSignal(statementText: string): number {
  let score = 0;
  if (/__vite__mapDeps/.test(statementText)) score += 0.5;
  if (/productions_|symbols_|terminals_/.test(statementText)) score += 0.45;
  const commaCount = (statementText.match(/,/g) ?? []).length;
  if (commaCount > 160) score += 0.35;
  if (commaCount > 320) score += 0.2;
  if (statementText.length > 4500) score += 0.35;
  if (statementText.length > 8000) score += 0.25;
  return Math.max(0, Math.min(1, score));
}

function isGeneratedParserRegistryStatement(statementText: string): boolean {
  if (statementText.length < 1200) return false;
  const normalized = statementText.toLowerCase();
  const hasGrammarSignals =
    normalized.includes("symbols_:") ||
    normalized.includes("terminals_:") ||
    normalized.includes("productions_:") ||
    normalized.includes("performaction");
  const hasRegistrySignals =
    normalized.includes("rules: [") ||
    normalized.includes("conditions: {") ||
    normalized.includes("parser") ||
    normalized.includes("registry");
  return hasGrammarSignals || (hasRegistrySignals && normalized.includes("function"));
}

function collectBindingIdentifiers(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingIdentifiers(element.name, out);
  }
}

function inferVariableDeclarationKind(declaration: ts.VariableDeclaration): LiftedExportKind {
  if (!declaration.initializer) return "variable";
  if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) return "function";
  if (ts.isClassExpression(declaration.initializer)) return "class";
  return "variable";
}

function isDeclarationNameNode(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionExpression(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassExpression(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent) && parent.name === node) return true;
  if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return true;
  return false;
}

function shouldIgnoreIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return true;
  if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  return false;
}

function collectDeclaredNames(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
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

function collectStatementReferences(statement: ts.Statement, declaredNames: Set<string>): Set<string> {
  const references = new Set<string>();
  const visit = (node: ts.Node): void => {
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

function collectTopLevelRecords(sourceFile: ts.SourceFile, sourceText: string): {
  statements: TopLevelStatementRecord[];
  declarationsByName: Map<string, TopLevelDeclarationRecord[]>;
  declarations: TopLevelDeclarationRecord[];
} {
  const statements: TopLevelStatementRecord[] = [];
  const declarationsByName = new Map<string, TopLevelDeclarationRecord[]>();
  const declarations: TopLevelDeclarationRecord[] = [];

  const pushDeclaration = (row: TopLevelDeclarationRecord): void => {
    declarations.push(row);
    const bucket = declarationsByName.get(row.name) ?? [];
    bucket.push(row);
    declarationsByName.set(row.name, bucket);
  };

  const pushStatementDeclaration = (statementIndex: number, node: ts.Node, name: string, kind: LiftedExportKind): void => {
    if (name.trim().length === 0) return;
    const declarationStart = node.getStart(sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(declarationStart).line + 1;
    pushDeclaration({
      name,
      kind,
      line,
      statementIndex,
      declarationStart,
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
      generatedSignal: scoreGeneratedSignal(text),
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
    if (!ts.isVariableStatement(statement)) return;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      pushStatementDeclaration(index, declaration.name, declaration.name.text, inferVariableDeclarationKind(declaration));
    }
  });

  return { statements, declarationsByName, declarations };
}

function scoreDeclarationKind(expected: LiftedExportKind, actual: LiftedExportKind): number {
  if (expected === actual) return 0;
  if (expected === "function" && actual === "variable") return 1;
  if (expected === "class" && actual === "variable") return 1;
  if (expected === "variable") return 2;
  return 3;
}

function pickBestDeclaration(
  records: TopLevelDeclarationRecord[],
  expectedKind: LiftedExportKind,
  sourceLine: number,
): TopLevelDeclarationRecord | undefined {
  if (records.length === 0) return undefined;
  const lineHint = sourceLine > 0 ? sourceLine : records[0]?.line ?? 0;
  let best: TopLevelDeclarationRecord | undefined;
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

function pickDependencyDeclaration(
  records: TopLevelDeclarationRecord[],
  statementLine: number,
): TopLevelDeclarationRecord | undefined {
  if (records.length === 0) return undefined;
  let best: TopLevelDeclarationRecord | undefined;
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

function pickFallbackDeclaration(
  declarations: TopLevelDeclarationRecord[],
  expectedKind: LiftedExportKind,
  sourceLine: number,
  usedStatementIndexes: Set<number>,
): TopLevelDeclarationRecord | undefined {
  if (declarations.length === 0) return undefined;
  const lineHint = sourceLine > 0 ? sourceLine : declarations[0]?.line ?? 0;
  let best: TopLevelDeclarationRecord | undefined;
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

function isSafeIdentifierName(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function countIncludedReferences(statements: TopLevelStatementRecord[], includedStatementIndexes: Set<number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of statements) {
    if (!includedStatementIndexes.has(row.index)) continue;
    for (const reference of row.references) {
      counts.set(reference, (counts.get(reference) ?? 0) + 1);
    }
  }
  return counts;
}

function collectIncludedDeclaredNames(statements: TopLevelStatementRecord[], includedStatementIndexes: Set<number>): Set<string> {
  const names = new Set<string>();
  for (const row of statements) {
    if (!includedStatementIndexes.has(row.index)) continue;
    for (const name of row.declaredNames) {
      names.add(name);
    }
  }
  return names;
}

function canRewriteReferencesForCandidate(input: {
  sourceFile: ts.SourceFile;
  includedStatementIndexes: Set<number>;
  candidate: RenameCandidate;
}): boolean {
  let sawReference = false;
  for (const statementIndex of input.includedStatementIndexes) {
    const statement = input.sourceFile.statements[statementIndex];
    if (!statement) continue;
    const visit = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node) && node.text === input.candidate.sourceSymbol) {
        if (isDeclarationNameNode(node)) {
          const declarationStart = node.getStart(input.sourceFile);
          if (declarationStart !== input.candidate.declarationStart) return false;
          return true;
        }
        if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return false;
        if (shouldIgnoreIdentifierReference(node)) return true;
        sawReference = true;
      }
      let isValid = true;
      node.forEachChild((child) => {
        if (!isValid) return;
        if (!visit(child)) {
          isValid = false;
        }
      });
      return isValid;
    };
    if (visit(statement) === false) return false;
  }
  return sawReference;
}

function buildTopLevelRenamePlan(input: {
  candidates: RenameCandidate[];
  sourceFile: ts.SourceFile;
  includedStatementIndexes: Set<number>;
  statements: TopLevelStatementRecord[];
}): { renameMap: Map<string, string>; referenceRewriteSources: Set<string>; skipped: number } {
  const renameMap = new Map<string, string>();
  const referenceRewriteSources = new Set<string>();
  const referenceCounts = countIncludedReferences(input.statements, input.includedStatementIndexes);
  const declaredNames = collectIncludedDeclaredNames(input.statements, input.includedStatementIndexes);
  const usedTargets = new Set<string>();
  let skipped = 0;

  for (const candidate of input.candidates) {
    if (candidate.sourceSymbol === candidate.exportName) {
      skipped += 1;
      continue;
    }
    if (!isSafeIdentifierName(candidate.sourceSymbol) || !isSafeIdentifierName(candidate.exportName)) {
      skipped += 1;
      continue;
    }
    const hasReferences = (referenceCounts.get(candidate.sourceSymbol) ?? 0) > 0;
    if (hasReferences && !canRewriteReferencesForCandidate({
      sourceFile: input.sourceFile,
      includedStatementIndexes: input.includedStatementIndexes,
      candidate,
    })) {
      skipped += 1;
      continue;
    }
    if (declaredNames.has(candidate.exportName) && candidate.exportName !== candidate.sourceSymbol) {
      skipped += 1;
      continue;
    }
    if (usedTargets.has(candidate.exportName)) {
      skipped += 1;
      continue;
    }
    renameMap.set(candidate.sourceSymbol, candidate.exportName);
    if (hasReferences) referenceRewriteSources.add(candidate.sourceSymbol);
    usedTargets.add(candidate.exportName);
  }

  return {
    renameMap,
    referenceRewriteSources,
    skipped,
  };
}

function rewriteStatementIdentifierReferences(input: {
  statement: ts.Statement;
  renameMap: Map<string, string>;
  rewriteSources: Set<string>;
}): { statement: ts.Statement; replacements: number } {
  if (input.renameMap.size === 0 || input.rewriteSources.size === 0) {
    return {
      statement: input.statement,
      replacements: 0,
    };
  }

  let replacements = 0;
  const transformer: ts.TransformerFactory<ts.Statement> = (context) => (root) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node)) {
        const sourceName = node.text;
        if (!input.rewriteSources.has(sourceName)) {
          return ts.visitEachChild(node, visit, context);
        }
        if (isDeclarationNameNode(node) || shouldIgnoreIdentifierReference(node)) {
          return ts.visitEachChild(node, visit, context);
        }
        const targetName = input.renameMap.get(sourceName);
        if (!targetName || targetName === sourceName) {
          return ts.visitEachChild(node, visit, context);
        }
        replacements += 1;
        return ts.factory.createIdentifier(targetName);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.Statement;
  };

  const transformed = ts.transform(input.statement, [transformer]);
  const statement = transformed.transformed[0] ?? input.statement;
  transformed.dispose();
  return {
    statement,
    replacements,
  };
}

function renameTopLevelStatement(statement: ts.Statement, renameMap: Map<string, string>): ts.Statement {
  if (renameMap.size === 0) return statement;
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    const nextName = renameMap.get(statement.name.text);
    if (!nextName) return statement;
    return ts.factory.updateFunctionDeclaration(
      statement,
      statement.modifiers,
      statement.asteriskToken,
      ts.factory.createIdentifier(nextName),
      statement.typeParameters,
      statement.parameters,
      statement.type,
      statement.body,
    );
  }
  if (ts.isClassDeclaration(statement) && statement.name) {
    const nextName = renameMap.get(statement.name.text);
    if (!nextName) return statement;
    return ts.factory.updateClassDeclaration(
      statement,
      statement.modifiers,
      ts.factory.createIdentifier(nextName),
      statement.typeParameters,
      statement.heritageClauses,
      statement.members,
    );
  }
  if (ts.isVariableStatement(statement)) {
    let changed = false;
    const declarations = statement.declarationList.declarations.map((declaration) => {
      if (!ts.isIdentifier(declaration.name)) return declaration;
      const nextName = renameMap.get(declaration.name.text);
      if (!nextName) return declaration;
      changed = true;
      return ts.factory.updateVariableDeclaration(
        declaration,
        ts.factory.createIdentifier(nextName),
        declaration.exclamationToken,
        declaration.type,
        declaration.initializer,
      );
    });
    if (!changed) return statement;
    return ts.factory.updateVariableStatement(
      statement,
      statement.modifiers,
      ts.factory.updateVariableDeclarationList(statement.declarationList, declarations),
    );
  }
  return statement;
}

function parseLiftSourceFile(sourceFilePath: string, sourceText: string): ts.SourceFile {
  try {
    return ts.createSourceFile(sourceFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse source chunk for lifting: ${sourceFilePath}. ${message}`);
  }
}

export function inspectLiftSourceDeclarations(input: {
  sourceFilePath: string;
  sourceText: string;
}): LiftDeclarationStat[] {
  const sourceFile = parseLiftSourceFile(input.sourceFilePath, input.sourceText);
  const { statements, declarations } = collectTopLevelRecords(sourceFile, input.sourceText);
  const rows: LiftDeclarationStat[] = [];
  for (const declaration of declarations) {
    const statement = statements[declaration.statementIndex];
    rows.push({
      name: declaration.name,
      kind: declaration.kind,
      line: declaration.line,
      statementLength: statement?.text.length ?? 0,
      generatedSignal: statement?.generatedSignal ?? 0,
    });
  }
  return rows;
}

export function liftModuleSource(input: LiftedModuleSourceInput): LiftedModuleSourceResult {
  const sourceFile = parseLiftSourceFile(input.sourceFilePath, input.sourceText);

  const { statements, declarationsByName, declarations } = collectTopLevelRecords(sourceFile, input.sourceText);
  const includeStatementIndexes = new Set<number>();
  const queue: number[] = [];
  const liftedExports: LiftedExportSpec[] = [];
  const unresolvedExports: LiftedExportSpec[] = [];
  const usedPrimaryStatementIndexes = new Set<number>();
  const renameCandidates: RenameCandidate[] = [];
  const allowClosestFallback = input.allowClosestFallback === true;

  for (const spec of input.exports) {
    const sourceSymbol = spec.sourceSymbol.trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sourceSymbol)) {
      unresolvedExports.push(spec);
      continue;
    }
    const records = declarationsByName.get(sourceSymbol) ?? [];
    let best = pickBestDeclaration(records, spec.kind, spec.sourceLine);
    if (!best && allowClosestFallback && (spec.kind === "class" || spec.kind === "function")) {
      best = pickFallbackDeclaration(declarations, spec.kind, spec.sourceLine, usedPrimaryStatementIndexes);
    }
    if (!best) {
      unresolvedExports.push(spec);
      continue;
    }
    const primaryStatement = statements[best.statementIndex];
    const allowParserRegistryUnpack = input.allowParserRegistryUnpack === true;
    const parserRegistryPrimary =
      !!primaryStatement &&
      primaryStatement.generatedSignal >= 0.72 &&
      primaryStatement.text.length > 1200 &&
      isGeneratedParserRegistryStatement(primaryStatement.text);
    if (
      best.kind === "variable" &&
      primaryStatement &&
      primaryStatement.generatedSignal >= 0.72 &&
      primaryStatement.text.length > 1200 &&
      !(allowParserRegistryUnpack && parserRegistryPrimary)
    ) {
      unresolvedExports.push(spec);
      continue;
    }
    const maxPrimaryStatementLength = input.maxPrimaryStatementLength > 0 ? input.maxPrimaryStatementLength : 0;
    if (
      maxPrimaryStatementLength > 0 &&
      primaryStatement &&
      primaryStatement.text.length > maxPrimaryStatementLength &&
      best.kind === "variable" &&
      !(allowParserRegistryUnpack && parserRegistryPrimary)
    ) {
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
    renameCandidates.push({
      sourceSymbol: best.name,
      exportName: spec.exportName,
      kind: spec.kind,
      line: best.line,
      statementIndex: best.statementIndex,
      declarationStart: best.declarationStart,
    });
  }

  const dependencyLimit = input.maxDependencyStatements > 0 ? input.maxDependencyStatements : 700;
  const maxDependencyStatementLength = input.maxDependencyStatementLength > 0 ? input.maxDependencyStatementLength : 0;
  let dependencyTrimmed = false;
  let skippedDependencies = 0;
  let skippedOversizedDependencies = 0;
  while (queue.length > 0) {
    if (includeStatementIndexes.size >= dependencyLimit) {
      dependencyTrimmed = true;
      skippedDependencies += queue.length;
      queue.length = 0;
      break;
    }
    const statementIndex = queue.shift();
    if (typeof statementIndex !== "number") continue;
    const statement = statements[statementIndex];
    if (!statement) continue;
    for (const referenceName of statement.references) {
      const dependencyRows = declarationsByName.get(referenceName);
      if (!dependencyRows || dependencyRows.length === 0) continue;
      const dependency = pickDependencyDeclaration(dependencyRows, statement.line);
      if (!dependency) continue;
      if (includeStatementIndexes.has(dependency.statementIndex)) continue;
      const dependencyStatement = statements[dependency.statementIndex];
      if (
        dependency.kind === "variable" &&
        dependencyStatement &&
        dependencyStatement.generatedSignal >= 0.82 &&
        dependencyStatement.text.length > 1600
      ) {
        dependencyTrimmed = true;
        skippedDependencies += 1;
        skippedOversizedDependencies += 1;
        continue;
      }
      if (
        maxDependencyStatementLength > 0 &&
        dependencyStatement &&
        dependencyStatement.text.length > maxDependencyStatementLength
      ) {
        dependencyTrimmed = true;
        skippedDependencies += 1;
        skippedOversizedDependencies += 1;
        continue;
      }
      if (includeStatementIndexes.size >= dependencyLimit) {
        dependencyTrimmed = true;
        skippedDependencies += 1;
        continue;
      }
      includeStatementIndexes.add(dependency.statementIndex);
      queue.push(dependency.statementIndex);
    }
  }

  const renamePlan = buildTopLevelRenamePlan({
    candidates: renameCandidates,
    sourceFile,
    includedStatementIndexes: includeStatementIndexes,
    statements,
  });
  const renameMap = renamePlan.renameMap;
  const referenceRewriteSources = renamePlan.referenceRewriteSources;
  const renamedDeclarations = renameMap.size;
  const skippedRenames = renamePlan.skipped;
  let rewrittenReferenceIdentifiers = 0;

  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });
  const statementBodies = Array.from(includeStatementIndexes)
    .sort((a, b) => a - b)
    .map((index) => sourceFile.statements[index])
    .filter((statement): statement is ts.Statement => !!statement)
    .map((statement) => renameTopLevelStatement(statement, renameMap))
    .map((statement) =>
      rewriteStatementIdentifierReferences({
        statement,
        renameMap,
        rewriteSources: referenceRewriteSources,
      }),
    )
    .map((row) => {
      rewrittenReferenceIdentifiers += row.replacements;
      return row.statement;
    })
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trim())
    .filter((text) => text.length > 0);

  const bodyLines: string[] = [];
  if (statementBodies.length > 0) {
    for (const statementText of statementBodies) {
      bodyLines.push(statementText, "");
    }
  }

  const exportSpecs = new Map<string, LiftedExportSpec>();
  for (const spec of liftedExports) {
    const key = spec.exportName.trim();
    if (key.length === 0) continue;
    if (exportSpecs.has(key)) continue;
    const renamedSource = renameMap.get(spec.sourceSymbol) ?? spec.sourceSymbol;
    exportSpecs.set(key, spec);
    if (renamedSource !== spec.sourceSymbol) {
      exportSpecs.set(key, {
        ...spec,
        sourceSymbol: renamedSource,
      });
    }
  }

  if (exportSpecs.size === 0) {
    bodyLines.push("export {};", "");
  } else {
    bodyLines.push("// Public API");
    for (const spec of exportSpecs.values()) {
      if (spec.sourceSymbol === spec.exportName) {
        bodyLines.push(`export { ${spec.exportName} };`);
        continue;
      }
      bodyLines.push(`export const ${spec.exportName} = ${spec.sourceSymbol};`);
    }
    bodyLines.push("");
  }

  return {
    moduleBody: `${bodyLines.join("\n").trimEnd()}\n`,
    liftedExports: liftedExports.map((spec) => ({
      ...spec,
      sourceSymbol: renameMap.get(spec.sourceSymbol) ?? spec.sourceSymbol,
    })),
    unresolvedExports,
    includedStatements: includeStatementIndexes.size,
    dependencyBudget: dependencyLimit,
    dependencyTrimmed,
    skippedDependencies,
    skippedOversizedDependencies,
    renameCandidates: renameCandidates.length,
    renamedDeclarations,
    skippedRenames,
    rewrittenReferenceSymbols: referenceRewriteSources.size,
    rewrittenReferenceIdentifiers,
  };
}
