import { readJsonFile } from "../utils/fs-json";
import { ToolVersionEntry, ToolVersions } from "../contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface PackageJsonVersion {
  version: string;
}

async function resolvePackageVersion(projectRoot: string, packageName: string): Promise<ToolVersionEntry> {
  const packageJsonPath = path.join(projectRoot, "node_modules", ...packageName.split("/"), "package.json");
  await fs.stat(packageJsonPath);
  const packageJson = await readJsonFile<PackageJsonVersion>(packageJsonPath);
  return {
    packageName,
    version: packageJson.version,
    source: "npm",
  };
}

export async function resolveToolVersions(projectRoot: string): Promise<ToolVersions> {
  const [asar, webcrack, wakaru, javascriptDeobfuscator, synchrony] = await Promise.all([
    resolvePackageVersion(projectRoot, "@electron/asar"),
    resolvePackageVersion(projectRoot, "webcrack"),
    resolvePackageVersion(projectRoot, "@wakaru/cli"),
    resolvePackageVersion(projectRoot, "js-deobfuscator"),
    resolvePackageVersion(projectRoot, "deobfuscator"),
  ]);
  const unwebpackSourcemapScript = path.join(
    projectRoot,
    "..",
    "reference",
    "decompile",
    "unwebpack-sourcemap",
    "unwebpack_sourcemap.py",
  );
  await fs.stat(unwebpackSourcemapScript);
  return {
    asar,
    webcrack,
    wakaru,
    javascriptDeobfuscator,
    synchrony,
    unwebpackSourcemap: {
      packageName: "unwebpack_sourcemap.py",
      version: "local-reference",
      source: "local-reference",
    },
  };
}
