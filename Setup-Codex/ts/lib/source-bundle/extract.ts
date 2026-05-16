import * as fs from "node:fs";
import * as path from "node:path";
import {
  copyDirectory,
  copyFileSafe,
  ensureDir,
  fileExists,
  removePath,
  resolveCommand,
  runCommand,
  writeHeader,
  writeInfo,
  writeSuccess,
  writeWarn,
} from "../exec";
import { extractAsarArchive } from "../asar";
import {
  setManifestStepState,
  StateManifest,
  testManifestStepCurrent,
  writeStateManifest,
} from "../manifest";

export interface ExtractionStageResult {
  sevenZip: string;
  extractedDir: string;
  electronDir: string;
  appDir: string;
  performed: boolean;
}

function isSupportedSnapshotArchive(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".dmg" || extension === ".zip";
}

export function resolveDmgPath(explicit: string | undefined, repoRoot: string): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fileExists(resolved)) throw new Error(`Snapshot archive not found: ${resolved}`);
    if (!isSupportedSnapshotArchive(resolved)) {
      throw new Error(`Unsupported snapshot archive extension: ${resolved}`);
    }
    return resolved;
  }

  const defaultZip = path.join(repoRoot, "codex-26-506-31421.zip");
  if (fileExists(defaultZip)) return defaultZip;

  const defaultDmg = path.join(repoRoot, "Codex.dmg");
  if (fileExists(defaultDmg)) return defaultDmg;

  const candidate = fs.readdirSync(repoRoot).find((entry) => isSupportedSnapshotArchive(entry));
  if (candidate) return path.join(repoRoot, candidate);
  throw new Error(`No supported snapshot archive (.dmg/.zip) found in [${repoRoot}].`);
}

export function resolve7z(workDir: string): string {
  const fromPath = resolveCommand("7z.exe") ?? resolveCommand("7z");
  if (fromPath) return fromPath;

  if (process.env.ProgramFiles) {
    const p1 = path.join(process.env.ProgramFiles, "7-Zip", "7z.exe");
    if (fileExists(p1)) return p1;
  }
  if (process.env["ProgramFiles(x86)"]) {
    const p2 = path.join(process.env["ProgramFiles(x86)"], "7-Zip", "7z.exe");
    if (fileExists(p2)) return p2;
  }
  if (process.env.USERPROFILE) {
    const scoop = path.join(process.env.USERPROFILE, "scoop", "shims", "7z.exe");
    if (fileExists(scoop)) return scoop;
  }
  if (process.env.LOCALAPPDATA) {
    const winget = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "7z.exe");
    if (fileExists(winget)) return winget;
  }

  const portable = path.join(workDir, "tools", "7zip", "7z.exe");
  if (fileExists(portable)) return portable;
  throw new Error("7z not found.");
}

export function invokeExtractionStage(
  dmgPath: string,
  workDir: string,
  reuse: boolean,
  allowFallbackReuse: boolean,
  manifest: StateManifest,
  manifestPath: string,
  extractSignature: string,
): ExtractionStageResult {
  const sevenZip = resolve7z(workDir);
  const extractedDir = path.join(workDir, "extracted");
  const electronDir = path.join(workDir, "electron");
  const appDir = path.join(workDir, "app");

  const appPackage = path.join(appDir, "package.json");
  const extractCurrent = testManifestStepCurrent(manifest, "extract", extractSignature);
  const canReuse = reuse && fileExists(appPackage) && (extractCurrent || allowFallbackReuse);
  if (canReuse) {
    if (extractCurrent) writeSuccess("Extraction cache hit: snapshot archive signature unchanged. Reusing app payload.");
    else writeInfo("Extraction reuse fallback applied from legacy manifest state.");
    return { sevenZip, extractedDir, electronDir, appDir, performed: false };
  }

  writeHeader("Extracting snapshot archive");
  for (const dir of [extractedDir, electronDir, appDir]) {
    removePath(dir);
    ensureDir(dir);
  }
  const dmgExtract = runCommand(sevenZip, ["x", "-y", dmgPath, `-o${extractedDir}`], {
    capture: true,
    allowNonZero: true,
  });

  writeHeader("Extracting app.asar");
  const diskImage = [path.join(extractedDir, "4.hfs"), path.join(extractedDir, "4.apfs")].find(fileExists);
  const appResourceRoots = [
    path.join("Codex Installer", "Codex.app", "Contents", "Resources"),
    path.join("Codex.app", "Contents", "Resources"),
  ];
  const directResourceRoot = appResourceRoots.find((root) => fileExists(path.join(extractedDir, root, "app.asar")));
  const directApp = directResourceRoot ? path.join(extractedDir, directResourceRoot, "app.asar") : "";
  if (!diskImage && !directApp) {
    throw new Error(
      `Snapshot extraction did not produce expected payload (4.hfs/4.apfs/app.asar). 7z exit=${dmgExtract.status}\n${dmgExtract.stderr || dmgExtract.stdout}`,
    );
  }
  if (dmgExtract.status !== 0) {
    writeInfo(`7z returned exit=${dmgExtract.status} while extracting snapshot archive; required files are present, continuing.`);
  }

  if (diskImage) {
    const archiveResourceRoot = appResourceRoots.find((root) => {
      const probe = runCommand(sevenZip, ["l", diskImage, path.join(root, "app.asar")], {
        capture: true,
        allowNonZero: true,
      });
      return probe.status === 0 && probe.stdout.includes("app.asar");
    });
    if (!archiveResourceRoot) {
      throw new Error(`Failed to locate app.asar inside extracted disk image: ${diskImage}`);
    }
    const imageExtract = runCommand(
      sevenZip,
      [
        "x",
        "-y",
        diskImage,
        path.join(archiveResourceRoot, "app.asar"),
        path.join(archiveResourceRoot, "app.asar.unpacked"),
        `-o${electronDir}`,
      ],
      { capture: true, allowNonZero: true },
    );
    const extractedAsar = path.join(electronDir, archiveResourceRoot, "app.asar");
    if (!fileExists(extractedAsar)) {
      throw new Error(
        `Failed to extract app.asar from disk image (7z exit=${imageExtract.status}).\n${imageExtract.stderr || imageExtract.stdout}`,
      );
    }
    if (imageExtract.status !== 0) {
      writeInfo(`7z returned exit=${imageExtract.status} on disk image extraction; app.asar was extracted, continuing.`);
    }
  } else {
    if (!fileExists(directApp)) throw new Error("app.asar not found.");
    const directUnpacked = path.join(extractedDir, directResourceRoot as string, "app.asar.unpacked");
    const destBase = path.join(electronDir, directResourceRoot as string);
    ensureDir(destBase);
    copyFileSafe(directApp, path.join(destBase, "app.asar"));
    if (fileExists(directUnpacked)) {
      copyDirectory(directUnpacked, path.join(destBase, "app.asar.unpacked"));
    }
  }

  writeHeader("Unpacking app.asar");
  const extractedResourceRoot = appResourceRoots.find((root) => fileExists(path.join(electronDir, root, "app.asar")));
  if (!extractedResourceRoot) throw new Error("Extracted app.asar not found.");
  const resourcesDir = path.join(electronDir, extractedResourceRoot);
  const asarSource = path.join(resourcesDir, "app.asar");
  if (!fileExists(asarSource)) throw new Error("app.asar not found.");

  let asar = asarSource;
  const resourcesAlias = path.join(workDir, "_resources");
  try {
    removePath(resourcesAlias);
    fs.symlinkSync(resourcesDir, resourcesAlias, "junction");
    asar = path.join(resourcesAlias, "app.asar");
  } catch {
    // Fallback for environments where junction creation is blocked.
    asar = path.join(workDir, "input-app.asar");
    copyFileSafe(asarSource, asar);
    const unpackedSource = path.join(resourcesDir, "app.asar.unpacked");
    if (fileExists(unpackedSource)) {
      copyDirectory(unpackedSource, `${asar}.unpacked`);
    }
  }

  extractAsarArchive(asar, appDir);
  writeSuccess("app.asar unpacked via native Node extractor.");

  writeHeader("Syncing app.asar.unpacked");
  const unpacked = path.join(
    electronDir,
    "Codex Installer",
    "Codex.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
  );
  const directUnpacked = path.join(electronDir, "Codex.app", "Contents", "Resources", "app.asar.unpacked");
  const unpackedSource = [unpacked, directUnpacked].find(fileExists);
  if (unpackedSource) {
    copyDirectory(unpackedSource, appDir);
  }

  setManifestStepState(manifest, "extract", extractSignature, "ok", { dmgPath });
  writeStateManifest(manifestPath, manifest);
  return { sevenZip, extractedDir, electronDir, appDir, performed: true };
}
