import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";

interface ManualHotRescueTargetModel {
  rank: number;
  manualFilePath: string;
  exists: boolean;
}

interface ManualHotRescueReportModel {
  targets?: ManualHotRescueTargetModel[];
}

interface CliOptions {
  manualProjectPath: string;
  reportPath: string;
  outputPath: string;
  topUnique: number;
  maxLineGrowth: number;
  maxImportGrowth: number;
  maxClustersPerFile: number;
}

interface FileMetrics {
  lineCount: number;
  importCount: number;
  namespaceImportCount: number;
  runtimeVendorImportCount: number;
}

interface ExtractionRecord {
  name: string;
  kind: "function" | "variable";
  start: number;
  end: number;
  text: string;
}

interface ClosureExpansionResult {
  records: ExtractionRecord[];
  unresolvedNames: string[];
}

interface FileRefactorResult {
  filePath: string;
  behaviorModulePath: string;
  movedSymbolCount: number;
  movedSymbolNames: string[];
  before: FileMetrics;
  after: FileMetrics;
}

interface RefactorReport {
  generatedAtIso: string;
  manualProjectPath: string;
  reportPath: string;
  topUnique: number;
  maxClustersPerFile: number;
  targetCount: number;
  changedCount: number;
  unchangedCount: number;
  files: FileRefactorResult[];
}

function parseIntegerFlag(flag: string, rawValue: string, minValue: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < minValue) {
    throw new Error(`Invalid ${flag} value: ${rawValue}`);
  }
  return parsed;
}

function parseCli(argv: readonly string[], projectRoot: string): CliOptions {
  let manualProjectPath = path.resolve(projectRoot, "..", "manual-codex-app");
  let reportPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-hot-rescue-last-report.json");
  let outputPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-top-hot-refactor-last-report.json");
  let topUnique = 5;
  let maxLineGrowth = 0;
  let maxImportGrowth = 2;
  let maxClustersPerFile = 3;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--manual-project": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--manual-project requires a value");
        }
        manualProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--report": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--report requires a value");
        }
        reportPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--output": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--output requires a value");
        }
        outputPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--top-unique": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--top-unique requires a value");
        }
        topUnique = parseIntegerFlag("--top-unique", value, 1);
        index += 1;
        break;
      }
      case "--max-line-growth": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--max-line-growth requires a value");
        }
        maxLineGrowth = parseIntegerFlag("--max-line-growth", value, 0);
        index += 1;
        break;
      }
      case "--max-import-growth": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--max-import-growth requires a value");
        }
        maxImportGrowth = parseIntegerFlag("--max-import-growth", value, 0);
        index += 1;
        break;
      }
      case "--max-clusters-per-file": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--max-clusters-per-file requires a value");
        }
        maxClustersPerFile = parseIntegerFlag("--max-clusters-per-file", value, 1);
        index += 1;
        break;
      }
      default: {
        throw new Error(`Unknown option: ${token}`);
      }
    }
  }
  return {
    manualProjectPath,
    reportPath,
    outputPath,
    topUnique,
    maxLineGrowth,
    maxImportGrowth,
    maxClustersPerFile,
  };
}

function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function collectFileMetrics(content: string): FileMetrics {
  const importLines = content.split(/\r?\n/u).filter((line) => /^\s*import\s+/u.test(line));
  return {
    lineCount: content.split(/\r?\n/u).length,
    importCount: importLines.length,
    namespaceImportCount: importLines.filter((line) => /^\s*import\s+\*\s+as\s+/u.test(line)).length,
    runtimeVendorImportCount: importLines.filter((line) => /(?:\/runtime\/|\/vendor\/|\/artifacts\/)/iu.test(line)).length,
  };
}

function selectTopUniqueTargets(report: ManualHotRescueReportModel, topUnique: number): string[] {
  const targets = Array.isArray(report.targets) ? report.targets : [];
  const ordered = [...targets]
    .filter((entry) => entry && entry.exists === true && typeof entry.manualFilePath === "string")
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    const relativePath = normalizeRelativePath(entry.manualFilePath);
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    selected.push(relativePath);
    if (selected.length >= topUnique) {
      break;
    }
  }
  return selected;
}

function getDeclaredNamesFromVariableStatement(statement: ts.VariableStatement): string[] {
  const collectNames = (bindingName: ts.BindingName, result: string[]): void => {
    if (ts.isIdentifier(bindingName)) {
      result.push(bindingName.text);
      return;
    }
    if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
      for (const element of bindingName.elements) {
        if (ts.isOmittedExpression(element)) {
          continue;
        }
        collectNames(element.name, result);
      }
    }
  };
  const names: string[] = [];
  for (const declaration of statement.declarationList.declarations) {
    collectNames(declaration.name, names);
  }
  return names;
}

function hasStateEventToken(value: string): boolean {
  return /state|event/iu.test(value);
}

function hasRuntimeClusterToken(value: string): boolean {
  return /runtime|parser|lexer|language|payload|cluster|vendor|table|core/iu.test(value);
}

function isSeedCandidate(record: ExtractionRecord): boolean {
  const minimumLength = record.kind === "variable" ? 900 : 700;
  if (record.text.length >= minimumLength) {
    return true;
  }
  if (hasStateEventToken(record.name)) {
    return true;
  }
  return hasRuntimeClusterToken(record.name);
}

function buildBehaviorModulePath(fileRelativePath: string): string {
  const parsed = path.posix.parse(fileRelativePath);
  return `${parsed.dir}/${parsed.name}-behavior-split.ts`;
}

function buildBehaviorImportPath(fileRelativePath: string, behaviorModulePath: string): string {
  const fromDir = path.posix.dirname(fileRelativePath);
  const toWithoutExtension = behaviorModulePath.replace(/\.ts$/u, "");
  const relative = path.posix.relative(fromDir, toWithoutExtension).replace(/\\/g, "/");
  if (relative.startsWith(".")) {
    return `${relative}.js`;
  }
  return `./${relative}.js`;
}

function formatNamedImport(importNames: readonly string[], importPath: string): string {
  const sorted = [...importNames].sort((left, right) => left.localeCompare(right));
  if (sorted.length < 1) {
    return "";
  }
  if (sorted.length <= 4) {
    return `import { ${sorted.join(", ")} } from "${importPath}";`;
  }
  const lines = sorted.map((name) => `  ${name},`).join("\n");
  return `import {\n${lines}\n} from "${importPath}";`;
}

function ensureExportModifier(statementText: string): string {
  const trimmed = statementText.trimStart();
  if (/^export\s+/u.test(trimmed)) {
    return statementText;
  }
  const leadingWhitespaceMatch = statementText.match(/^\s*/u);
  const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : "";
  const body = statementText.slice(leadingWhitespace.length);
  return `${leadingWhitespace}export ${body}`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectIdentifiersInNode(node: ts.Node): Set<string> {
  const identifiers = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      identifiers.add(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return identifiers;
}

function collectExtractionRecords(sourceFile: ts.SourceFile, sourceText: string): ExtractionRecord[] {
  const records: ExtractionRecord[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      records.push({
        name: statement.name.text,
        kind: "function",
        start: statement.getStart(sourceFile),
        end: statement.end,
        text: sourceText.slice(statement.getStart(sourceFile), statement.end),
      });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const names = getDeclaredNamesFromVariableStatement(statement);
      if (names.length > 0) {
        const primaryName = names[0];
        if (!primaryName) {
          continue;
        }
        records.push({
          name: primaryName,
          kind: "variable",
          start: statement.getStart(sourceFile),
          end: statement.end,
          text: sourceText.slice(statement.getStart(sourceFile), statement.end),
        });
      }
    }
  }
  return records;
}

function createRecordLookup(sourceFile: ts.SourceFile, records: readonly ExtractionRecord[]): Map<string, ExtractionRecord> {
  const recordByName = new Map<string, ExtractionRecord>(records.map((record) => [record.name, record]));
  const recordByStart = new Map<number, ExtractionRecord>(records.map((record) => [record.start, record]));
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const record = recordByStart.get(statement.getStart(sourceFile));
    if (!record) {
      continue;
    }
    const names = getDeclaredNamesFromVariableStatement(statement);
    for (const name of names) {
      if (!name) {
        continue;
      }
      if (!recordByName.has(name)) {
        recordByName.set(name, record);
      }
    }
  }
  return recordByName;
}

function createDependencyMap(records: readonly ExtractionRecord[]): Map<string, Set<string>> {
  const names = records.map((record) => record.name);
  const dependencyMap = new Map<string, Set<string>>();
  for (const record of records) {
    const deps = new Set<string>();
    for (const candidate of names) {
      if (candidate === record.name) {
        continue;
      }
      const pattern = new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u");
      if (pattern.test(record.text)) {
        deps.add(candidate);
      }
    }
    dependencyMap.set(record.name, deps);
  }
  return dependencyMap;
}

function buildClosure(seed: string, dependencyMap: ReadonlyMap<string, Set<string>>): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [seed];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || closure.has(current)) {
      continue;
    }
    closure.add(current);
    const dependencies = dependencyMap.get(current);
    if (!dependencies) {
      continue;
    }
    for (const dependency of dependencies) {
      if (!closure.has(dependency)) {
        queue.push(dependency);
      }
    }
  }
  return closure;
}

function extractImportBindingNames(statement: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const importClause = statement.importClause;
  if (!importClause) {
    return names;
  }
  if (importClause.name) {
    names.push(importClause.name.text);
  }
  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return names;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    names.push(namedBindings.name.text);
    return names;
  }
  for (const element of namedBindings.elements) {
    names.push(element.name.text);
  }
  return names;
}

function collectImportsText(
  sourceFile: ts.SourceFile,
  sourceText: string,
  behaviorImportPath: string,
): { importStatements: string[]; lastImportEnd: number; existingBehaviorImportNames: string[] } {
  const importStatements: string[] = [];
  const existingBehaviorImportNames = new Set<string>();
  let lastImportEnd = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const moduleSpecifier = statement.moduleSpecifier.text;
      if (moduleSpecifier === behaviorImportPath || /-behavior-split$/iu.test(moduleSpecifier)) {
        for (const name of extractImportBindingNames(statement)) {
          existingBehaviorImportNames.add(name);
        }
        continue;
      }
    }
    importStatements.push(sourceText.slice(statement.getStart(sourceFile), statement.end));
    lastImportEnd = statement.end;
  }
  return {
    importStatements,
    lastImportEnd,
    existingBehaviorImportNames: [...existingBehaviorImportNames],
  };
}

interface RefactorSafetyPolicy {
  maxLineGrowth: number;
  maxImportGrowth: number;
  maxClustersPerFile: number;
}

function isHeavyHotModule(fileRelativePath: string): boolean {
  return /src\/services\/(?:store|service)\//iu.test(fileRelativePath);
}

function computeClosureSizeLimit(seed: ExtractionRecord, fileRelativePath: string): number {
  const heavyModule = isHeavyHotModule(fileRelativePath);
  if (seed.kind === "variable") {
    return heavyModule ? 2000 : 100;
  }
  return heavyModule ? 1000 : 48;
}

function expandDependencyClosure(
  sourceFile: ts.SourceFile,
  seed: ExtractionRecord,
  dependencyMap: ReadonlyMap<string, Set<string>>,
  recordByName: ReadonlyMap<string, ExtractionRecord>,
  importNames: ReadonlySet<string>,
  fileRelativePath: string,
): ClosureExpansionResult {
  const closureLimit = computeClosureSizeLimit(seed, fileRelativePath);
  const expansionPassLimit = isHeavyHotModule(fileRelativePath) ? 200 : 10;
  const closureNames = buildClosure(seed.name, dependencyMap);
  if (closureNames.size < 1 || closureNames.size > closureLimit) {
    return { records: [], unresolvedNames: [] };
  }
  let lastRecords: ExtractionRecord[] = [];
  let lastUnresolvedNames: string[] = [];
  for (let passIndex = 0; passIndex < expansionPassLimit; passIndex += 1) {
    const closureRecords = [...closureNames]
      .map((name) => recordByName.get(name))
      .filter((entry): entry is ExtractionRecord => Boolean(entry))
      .sort((left, right) => left.start - right.start);
    lastRecords = closureRecords;
    const closureNameSet = new Set(closureRecords.map((record) => record.name));
    if (![...closureNameSet].some((name) => hasStateEventToken(name) || hasRuntimeClusterToken(name))) {
      return { records: [], unresolvedNames: [] };
    }
    const unresolvedTopLevelNames = new Set<string>();
    for (const record of closureRecords) {
      const statementNode = sourceFile.statements.find((statement) => statement.getStart(sourceFile) === record.start);
      if (!statementNode) {
        continue;
      }
      const identifiers = collectIdentifiersInNode(statementNode);
      for (const identifier of identifiers) {
        if (closureNameSet.has(identifier) || importNames.has(identifier)) {
          continue;
        }
        if (recordByName.has(identifier)) {
          unresolvedTopLevelNames.add(identifier);
        }
      }
    }
    lastUnresolvedNames = [...unresolvedTopLevelNames].sort((left, right) => left.localeCompare(right));
    if (unresolvedTopLevelNames.size < 1) {
      return { records: closureRecords, unresolvedNames: [] };
    }
    let addedCount = 0;
    for (const unresolvedName of unresolvedTopLevelNames) {
      if (closureNames.has(unresolvedName)) {
        continue;
      }
      closureNames.add(unresolvedName);
      addedCount += 1;
      if (closureNames.size > closureLimit) {
        return { records: closureRecords, unresolvedNames: lastUnresolvedNames };
      }
    }
    if (addedCount < 1) {
      return { records: closureRecords, unresolvedNames: lastUnresolvedNames };
    }
  }
  return {
    records: lastRecords,
    unresolvedNames: lastUnresolvedNames,
  };
}

function expandSingleRecordFallback(
  sourceFile: ts.SourceFile,
  seed: ExtractionRecord,
  recordByName: ReadonlyMap<string, ExtractionRecord>,
  importNames: ReadonlySet<string>,
): ClosureExpansionResult {
  const statementNode = sourceFile.statements.find((statement) => statement.getStart(sourceFile) === seed.start);
  if (!statementNode) {
    return { records: [], unresolvedNames: [] };
  }
  const identifiers = collectIdentifiersInNode(statementNode);
  const unresolvedTopLevelNames = new Set<string>();
  for (const identifier of identifiers) {
    if (identifier === seed.name || importNames.has(identifier)) {
      continue;
    }
    if (recordByName.has(identifier)) {
      unresolvedTopLevelNames.add(identifier);
    }
  }
  if (unresolvedTopLevelNames.size > 0) {
    return {
      records: [seed],
      unresolvedNames: [...unresolvedTopLevelNames].sort((left, right) => left.localeCompare(right)),
    };
  }
  if (seed.text.length < 500 && !hasStateEventToken(seed.name) && !hasRuntimeClusterToken(seed.name)) {
    return { records: [], unresolvedNames: [] };
  }
  return { records: [seed], unresolvedNames: [] };
}

async function refactorSingleFile(
  manualProjectPath: string,
  fileRelativePath: string,
  policy: RefactorSafetyPolicy,
): Promise<FileRefactorResult | null> {
  const absoluteFilePath = path.join(manualProjectPath, fileRelativePath);
  const sourceText = await fs.readFile(absoluteFilePath, "utf8");
  const beforeMetrics = collectFileMetrics(sourceText);
  const sourceFile = ts.createSourceFile(fileRelativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records = collectExtractionRecords(sourceFile, sourceText);
  const recordByName = createRecordLookup(sourceFile, records);
  const dependencyMap = createDependencyMap(records);
  const seedCandidates = records.filter((record) => isSeedCandidate(record)).sort((left, right) => right.text.length - left.text.length);
  if (seedCandidates.length < 1) {
    return null;
  }

  const importNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }
    if (importClause.name) {
      importNames.add(importClause.name.text);
    }
    if (importClause.namedBindings) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        importNames.add(importClause.namedBindings.name.text);
      } else if (ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          importNames.add(element.name.text);
        }
      }
    }
  }

  const selectedClosureRecords: ExtractionRecord[] = [];
  const selectedRanges: Array<{ start: number; end: number }> = [];
  const selectedRecordNames = new Set<string>();
  const unresolvedFromSource = new Set<string>();
  for (const seed of seedCandidates) {
    let expansionResult = expandDependencyClosure(
      sourceFile,
      seed,
      dependencyMap,
      recordByName,
      importNames,
      normalizeRelativePath(fileRelativePath),
    );
    if (expansionResult.records.length < 1) {
      expansionResult = expandSingleRecordFallback(sourceFile, seed, recordByName, importNames);
    }
    const closureRecords = expansionResult.records;
    if (closureRecords.length < 1) {
      continue;
    }
    if (closureRecords.some((record) => selectedRecordNames.has(record.name))) {
      continue;
    }
    const overlapsExistingRanges = closureRecords.some((record) =>
      selectedRanges.some((range) => !(record.end <= range.start || record.start >= range.end)),
    );
    if (overlapsExistingRanges) {
      continue;
    }
    const clusterRanges = closureRecords
      .map((record) => ({ start: record.start, end: record.end }))
      .sort((left, right) => left.start - right.start);
    const firstRange = clusterRanges.at(0);
    const lastRange = clusterRanges.at(-1);
    if (!firstRange || !lastRange) {
      continue;
    }
    selectedRanges.push({
      start: firstRange.start,
      end: lastRange.end,
    });
    for (const record of closureRecords) {
      selectedClosureRecords.push(record);
      selectedRecordNames.add(record.name);
    }
    for (const unresolvedName of expansionResult.unresolvedNames) {
      if (!selectedRecordNames.has(unresolvedName)) {
        unresolvedFromSource.add(unresolvedName);
      }
    }
    if (selectedRanges.length >= policy.maxClustersPerFile) {
      break;
    }
  }

  if (selectedClosureRecords.length < 1) {
    return null;
  }

  const fileRelativePosix = normalizeRelativePath(fileRelativePath);
  const behaviorModulePath = buildBehaviorModulePath(fileRelativePosix);
  const behaviorImportPath = buildBehaviorImportPath(fileRelativePosix, behaviorModulePath);
  const sourceModuleImportPath = buildBehaviorImportPath(normalizeRelativePath(behaviorModulePath), fileRelativePosix);
  const movedNames = [...new Set(selectedClosureRecords.map((record) => record.name))];
  const unresolvedNames = [...unresolvedFromSource]
    .filter((name) => !movedNames.includes(name))
    .sort((left, right) => left.localeCompare(right));

  const { importStatements, lastImportEnd, existingBehaviorImportNames } = collectImportsText(
    sourceFile,
    sourceText,
    behaviorImportPath,
  );
  const splitModuleHeader = [
    "// @ts-nocheck",
    "// Auto-generated by manual hot refactor pass.",
    "// Extracted behavior cluster for state/event boundary readability.",
    "",
  ].join("\n");
  const sourceContextImportName = "__sourceContext";
  const sourceDependencyPrelude = unresolvedNames.length > 0
    ? [
      `import * as ${sourceContextImportName} from "${sourceModuleImportPath}";`,
      ...unresolvedNames.map((name) => `const ${name} = ${sourceContextImportName}.${name};`),
      "",
    ].join("\n")
    : "";
  const splitModuleBody = selectedClosureRecords
    .map((record) => ensureExportModifier(record.text).trim())
    .join("\n\n");
  const splitModuleContentBase = `${splitModuleHeader}${sourceDependencyPrelude}${importStatements.join("\n")}\n\n${splitModuleBody}\n`;

  let nextSource = sourceText;
  const removalRanges = selectedClosureRecords
    .map((record) => ({ start: record.start, end: record.end }))
    .sort((left, right) => right.start - left.start);
  for (const range of removalRanges) {
    nextSource = `${nextSource.slice(0, range.start)}${nextSource.slice(range.end)}`;
  }
  const mergedImportNames = [...new Set([...existingBehaviorImportNames, ...movedNames])];
  const importStatement = `${formatNamedImport(mergedImportNames, behaviorImportPath)}\n`;
  const insertionOffset = Math.max(0, lastImportEnd);
  nextSource = `${nextSource.slice(0, insertionOffset)}\n${importStatement}${nextSource.slice(insertionOffset)}`;
  nextSource = nextSource.replace(/\n{3,}/gu, "\n\n");
  const afterMetrics = collectFileMetrics(nextSource);
  const lineGrowth = afterMetrics.lineCount - beforeMetrics.lineCount;
  const importGrowth = afterMetrics.importCount - beforeMetrics.importCount;
  if (lineGrowth > policy.maxLineGrowth || importGrowth > policy.maxImportGrowth) {
    return null;
  }
  const absoluteBehaviorPath = path.join(manualProjectPath, behaviorModulePath);
  await ensureDirectory(path.dirname(absoluteBehaviorPath));
  let splitModuleContent = splitModuleContentBase;
  try {
    const existingBehaviorContent = await fs.readFile(absoluteBehaviorPath, "utf8");
    const missingExports = selectedClosureRecords
      .filter((record) => {
        const exportPattern = new RegExp(`\\bexport\\s+(?:function|const|var|class)\\s+${escapeRegExp(record.name)}\\b`, "u");
        return !exportPattern.test(existingBehaviorContent);
      })
      .map((record) => ensureExportModifier(record.text).trim())
      .join("\n\n");
    const missingSourceBindings = unresolvedNames
      .filter((name) => {
        const bindingPattern = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=\\s*${escapeRegExp(sourceContextImportName)}\\.${escapeRegExp(name)}\\b`, "u");
        return !bindingPattern.test(existingBehaviorContent);
      })
      .map((name) => `const ${name} = ${sourceContextImportName}.${name};`);
    const sourceImportPattern = new RegExp(`\\bimport\\s+\\*\\s+as\\s+${escapeRegExp(sourceContextImportName)}\\s+from\\s+["']${escapeRegExp(sourceModuleImportPath)}["']`, "u");
    const needsSourceImport = unresolvedNames.length > 0 && !sourceImportPattern.test(existingBehaviorContent);
    const sourcePrelude = (needsSourceImport || missingSourceBindings.length > 0)
      ? [
        needsSourceImport ? `import * as ${sourceContextImportName} from "${sourceModuleImportPath}";` : "",
        ...missingSourceBindings,
      ].filter((line) => line.length > 0).join("\n")
      : "";
    splitModuleContent = missingExports.length > 0
      ? `${sourcePrelude.length > 0 ? `${sourcePrelude}\n` : ""}${existingBehaviorContent.trimEnd()}\n\n${missingExports}\n`
      : `${sourcePrelude.length > 0 ? `${sourcePrelude}\n` : ""}${existingBehaviorContent.trimEnd()}\n`;
  } catch {
    splitModuleContent = splitModuleContentBase;
  }
  await fs.writeFile(absoluteBehaviorPath, splitModuleContent, "utf8");
  await fs.writeFile(absoluteFilePath, nextSource, "utf8");

  return {
    filePath: fileRelativePosix,
    behaviorModulePath: normalizeRelativePath(behaviorModulePath),
    movedSymbolCount: movedNames.length,
    movedSymbolNames: [...movedNames].sort((left, right) => left.localeCompare(right)),
    before: beforeMetrics,
    after: afterMetrics,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const policy: RefactorSafetyPolicy = {
    maxLineGrowth: cli.maxLineGrowth,
    maxImportGrowth: cli.maxImportGrowth,
    maxClustersPerFile: cli.maxClustersPerFile,
  };
  const report = await readJsonFile<ManualHotRescueReportModel>(cli.reportPath);
  const targets = selectTopUniqueTargets(report, cli.topUnique);
  const fileResults: FileRefactorResult[] = [];
  for (const targetPath of targets) {
    const result = await refactorSingleFile(cli.manualProjectPath, targetPath, policy);
    if (!result) {
      continue;
    }
    fileResults.push(result);
  }
  const output: RefactorReport = {
    generatedAtIso: new Date().toISOString(),
    manualProjectPath: cli.manualProjectPath,
    reportPath: cli.reportPath,
    topUnique: cli.topUnique,
    maxClustersPerFile: cli.maxClustersPerFile,
    targetCount: targets.length,
    changedCount: fileResults.length,
    unchangedCount: Math.max(0, targets.length - fileResults.length),
    files: fileResults,
  };
  await writeJsonFile(cli.outputPath, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
