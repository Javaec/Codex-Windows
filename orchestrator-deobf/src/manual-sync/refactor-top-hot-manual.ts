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
  let maxImportGrowth = 0;
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
  const names: string[] = [];
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) {
      names.push(declaration.name.text);
    }
  }
  return names;
}

function hasStateEventToken(value: string): boolean {
  return /state|event/iu.test(value);
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
    return relative;
  }
  return `./${relative}`;
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
      if (names.length === 1) {
        const name = names[0];
        if (!name) {
          continue;
        }
        records.push({
          name,
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

function collectImportsText(
  sourceFile: ts.SourceFile,
  sourceText: string,
  behaviorImportPath: string,
): { importStatements: string[]; lastImportEnd: number } {
  const importStatements: string[] = [];
  let lastImportEnd = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const moduleSpecifier = statement.moduleSpecifier.text;
      if (moduleSpecifier === behaviorImportPath || /-behavior-split$/iu.test(moduleSpecifier)) {
        continue;
      }
    }
    importStatements.push(sourceText.slice(statement.getStart(sourceFile), statement.end));
    lastImportEnd = statement.end;
  }
  return {
    importStatements,
    lastImportEnd,
  };
}

interface RefactorSafetyPolicy {
  maxLineGrowth: number;
  maxImportGrowth: number;
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
  const recordByName = new Map(records.map((record) => [record.name, record]));
  const dependencyMap = createDependencyMap(records);
  const seedCandidates = records
    .filter((record) => record.kind === "function")
    .filter((record) => record.text.length >= 1200 || hasStateEventToken(record.name))
    .sort((left, right) => right.text.length - left.text.length);
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

  let selectedClosureRecords: ExtractionRecord[] = [];
  for (const seed of seedCandidates) {
    const closureNames = buildClosure(seed.name, dependencyMap);
    if (closureNames.size < 1 || closureNames.size > 12) {
      continue;
    }
    const closureRecords = [...closureNames]
      .map((name) => recordByName.get(name))
      .filter((entry): entry is ExtractionRecord => Boolean(entry))
      .sort((left, right) => left.start - right.start);
    const closureNameSet = new Set(closureRecords.map((record) => record.name));
    if (![...closureNameSet].some((name) => hasStateEventToken(name))) {
      continue;
    }
    const unresolvedTopLevelNames = new Set<string>();
    for (const record of closureRecords) {
      const statementNode = sourceFile.statements.find((statement) => statement.getStart(sourceFile) === record.start);
      if (!statementNode) {
        continue;
      }
      const identifiers = collectIdentifiersInNode(statementNode);
      for (const identifier of identifiers) {
        if (closureNameSet.has(identifier)) {
          continue;
        }
        if (importNames.has(identifier)) {
          continue;
        }
        if (recordByName.has(identifier)) {
          unresolvedTopLevelNames.add(identifier);
        }
      }
    }
    if (unresolvedTopLevelNames.size > 0) {
      continue;
    }
    selectedClosureRecords = closureRecords;
    break;
  }

  if (selectedClosureRecords.length < 1) {
    return null;
  }

  const fileRelativePosix = normalizeRelativePath(fileRelativePath);
  const behaviorModulePath = buildBehaviorModulePath(fileRelativePosix);
  const behaviorImportPath = buildBehaviorImportPath(fileRelativePosix, behaviorModulePath);
  const movedNames = selectedClosureRecords.map((record) => record.name);

  const { importStatements, lastImportEnd } = collectImportsText(sourceFile, sourceText, behaviorImportPath);
  const splitModuleHeader = [
    "// @ts-nocheck",
    "// Auto-generated by manual hot refactor pass.",
    "// Extracted behavior cluster for state/event boundary readability.",
    "",
  ].join("\n");
  const splitModuleBody = selectedClosureRecords
    .map((record) => ensureExportModifier(record.text).trim())
    .join("\n\n");
  const splitModuleContent = `${splitModuleHeader}${importStatements.join("\n")}\n\n${splitModuleBody}\n`;

  let nextSource = sourceText;
  const removalRanges = selectedClosureRecords
    .map((record) => ({ start: record.start, end: record.end }))
    .sort((left, right) => right.start - left.start);
  for (const range of removalRanges) {
    nextSource = `${nextSource.slice(0, range.start)}${nextSource.slice(range.end)}`;
  }
  const importStatement = `${formatNamedImport(movedNames, behaviorImportPath)}\n`;
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
