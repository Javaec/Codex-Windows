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
}

interface FileMetrics {
  importCount: number;
  namespaceImportCount: number;
  runtimeVendorImportCount: number;
}

interface FileQuarantineResult {
  filePath: string;
  depsFilePath: string;
  movedImportDeclarations: number;
  movedSymbols: number;
  before: FileMetrics;
  after: FileMetrics;
}

interface QuarantineReport {
  generatedAtIso: string;
  manualProjectPath: string;
  reportPath: string;
  topUnique: number;
  targetCount: number;
  changedCount: number;
  unchangedCount: number;
  files: FileQuarantineResult[];
}

interface MovedImportDeclaration {
  localNames: string[];
  exportStatements: string[];
}

function parseIntegerFlag(flag: string, rawValue: string, min: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < min) {
    throw new Error(`Invalid ${flag} value: ${rawValue}`);
  }
  return parsed;
}

function parseCli(argv: readonly string[], projectRoot: string): CliOptions {
  let manualProjectPath = path.resolve(projectRoot, "..", "manual-codex-app");
  let reportPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-hot-rescue-last-report.json");
  let outputPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-import-quarantine-last-report.json");
  let topUnique = 5;
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
  };
}

function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function shouldMoveModuleSpecifier(moduleSpecifier: string): boolean {
  return /\/artifacts\/|\/assets\/payloads\//i.test(moduleSpecifier);
}

function quoteModuleSpecifier(moduleSpecifier: string): string {
  return `'${moduleSpecifier.replace(/\\/g, "/")}'`;
}

function collectFileMetrics(content: string): FileMetrics {
  const importLines = content.split(/\r?\n/).filter((line) => /^\s*import\s+/u.test(line));
  return {
    importCount: importLines.length,
    namespaceImportCount: importLines.filter((line) => /^\s*import\s+\*\s+as\s+/u.test(line)).length,
    runtimeVendorImportCount: importLines.filter((line) => /(?:\/runtime\/|\/vendor\/|\/artifacts\/)/iu.test(line)).length,
  };
}

function createImportBlock(localNames: readonly string[], depsImportPath: string): string {
  if (localNames.length < 1) {
    return "";
  }
  if (localNames.length === 1) {
    const onlyName = localNames[0];
    if (!onlyName) {
      throw new Error("Single-name import block has no name");
    }
    return `import { ${onlyName} } from "${depsImportPath}";`;
  }
  const lines = localNames.map((name) => `  ${name},`).join("\n");
  return `import {\n${lines}\n} from "${depsImportPath}";`;
}

function collectMovedImportDeclaration(
  declaration: ts.ImportDeclaration,
): MovedImportDeclaration | null {
  if (!ts.isStringLiteralLike(declaration.moduleSpecifier)) {
    return null;
  }
  const importClause = declaration.importClause;
  if (!importClause || importClause.isTypeOnly) {
    return null;
  }
  const moduleSpecifier = declaration.moduleSpecifier.text;
  if (!shouldMoveModuleSpecifier(moduleSpecifier)) {
    return null;
  }
  const namedBindings = importClause.namedBindings;
  if (
    namedBindings &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.some((element) => element.isTypeOnly)
  ) {
    return null;
  }

  const localNames: string[] = [];
  const exportStatements: string[] = [];
  const moduleLiteral = quoteModuleSpecifier(moduleSpecifier);

  if (importClause.name) {
    localNames.push(importClause.name.text);
    exportStatements.push(`export { default as ${importClause.name.text} } from ${moduleLiteral};`);
  }

  if (namedBindings) {
    if (ts.isNamespaceImport(namedBindings)) {
      const namespaceName = namedBindings.name.text;
      localNames.push(namespaceName);
      exportStatements.push(`export * as ${namespaceName} from ${moduleLiteral};`);
    } else if (ts.isNamedImports(namedBindings)) {
      const elements = namedBindings.elements;
      if (elements.length > 0) {
        const specs = elements.map((element) => {
          if (element.propertyName) {
            return `${element.propertyName.text} as ${element.name.text}`;
          }
          return element.name.text;
        });
        for (const element of elements) {
          localNames.push(element.name.text);
        }
        exportStatements.push(`export { ${specs.join(", ")} } from ${moduleLiteral};`);
      }
    }
  }

  if (localNames.length < 1 || exportStatements.length < 1) {
    return null;
  }
  return {
    localNames,
    exportStatements,
  };
}

function selectTopUniqueTargets(
  report: ManualHotRescueReportModel,
  topUnique: number,
): string[] {
  const targets = Array.isArray(report.targets) ? report.targets : [];
  const ordered = [...targets]
    .filter((target) => target && target.exists === true && typeof target.manualFilePath === "string")
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const target of ordered) {
    const relativePath = normalizeRelativePath(target.manualFilePath);
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

function buildDepsFileRelativePath(fileRelativePath: string): string {
  const parsed = path.posix.parse(fileRelativePath);
  return `${parsed.dir}/${parsed.name}-deps.ts`;
}

function buildDepsImportPath(fileRelativePath: string, depsRelativePath: string): string {
  const fromDir = path.posix.dirname(fileRelativePath);
  const toPathWithoutExtension = depsRelativePath.replace(/\.ts$/u, "");
  const relative = path.posix.relative(fromDir, toPathWithoutExtension).replace(/\\/g, "/");
  if (relative.startsWith(".")) {
    return relative;
  }
  return `./${relative}`;
}

async function rewriteFileWithQuarantinedImports(
  manualProjectPath: string,
  fileRelativePath: string,
): Promise<FileQuarantineResult | null> {
  const absoluteFilePath = path.join(manualProjectPath, fileRelativePath);
  const original = await fs.readFile(absoluteFilePath, "utf8");
  const sourceFile = ts.createSourceFile(fileRelativePath, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importDeclarations = sourceFile.statements.filter(ts.isImportDeclaration);
  if (importDeclarations.length < 1) {
    return null;
  }

  const movedStatements: string[] = [];
  const movedLocalNames: string[] = [];
  const keptImports: string[] = [];
  let movedImportDeclarations = 0;

  for (const declaration of importDeclarations) {
    const moved = collectMovedImportDeclaration(declaration);
    if (!moved) {
      keptImports.push(declaration.getText(sourceFile));
      continue;
    }
    movedImportDeclarations += 1;
    movedStatements.push(...moved.exportStatements);
    movedLocalNames.push(...moved.localNames);
  }

  if (movedImportDeclarations < 1) {
    return null;
  }

  const firstImport = importDeclarations[0];
  const lastImport = importDeclarations[importDeclarations.length - 1];
  if (!firstImport || !lastImport) {
    return null;
  }

  const beforeImports = original.slice(0, firstImport.getStart(sourceFile));
  const afterImportsRaw = original.slice(lastImport.end);
  const afterImports = afterImportsRaw.replace(/^\s*\r?\n/u, "");

  const uniqueLocalNames = [...new Set(movedLocalNames)];
  uniqueLocalNames.sort((left, right) => left.localeCompare(right));
  const depsRelativePath = buildDepsFileRelativePath(normalizeRelativePath(fileRelativePath));
  const depsImportPath = buildDepsImportPath(normalizeRelativePath(fileRelativePath), depsRelativePath);
  const depsImportStatement = createImportBlock(uniqueLocalNames, depsImportPath);

  const importsBlockParts: string[] = [];
  importsBlockParts.push(...keptImports);
  if (depsImportStatement.length > 0) {
    importsBlockParts.push(depsImportStatement);
  }
  const importsBlock = importsBlockParts.join("\n");
  const rewritten = `${beforeImports}${importsBlock}\n\n${afterImports}`;

  const uniqueExportStatements = [...new Set(movedStatements)];
  const depsFileHeader = [
    "// Auto-generated by manual-sync quarantine-hot-imports.",
    "// Keeps heavy artifact imports out of hot domain modules.",
    "",
  ].join("\n");
  const depsFileContent = `${depsFileHeader}${uniqueExportStatements.join("\n")}\n`;

  const absoluteDepsPath = path.join(manualProjectPath, depsRelativePath);
  await ensureDirectory(path.dirname(absoluteDepsPath));
  await fs.writeFile(absoluteDepsPath, depsFileContent, "utf8");
  await fs.writeFile(absoluteFilePath, rewritten, "utf8");

  return {
    filePath: normalizeRelativePath(fileRelativePath),
    depsFilePath: normalizeRelativePath(depsRelativePath),
    movedImportDeclarations,
    movedSymbols: uniqueLocalNames.length,
    before: collectFileMetrics(original),
    after: collectFileMetrics(rewritten),
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const report = await readJsonFile<ManualHotRescueReportModel>(cli.reportPath);
  const targets = selectTopUniqueTargets(report, cli.topUnique);
  const fileResults: FileQuarantineResult[] = [];
  for (const target of targets) {
    const result = await rewriteFileWithQuarantinedImports(cli.manualProjectPath, target);
    if (!result) {
      continue;
    }
    fileResults.push(result);
  }
  const output: QuarantineReport = {
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
