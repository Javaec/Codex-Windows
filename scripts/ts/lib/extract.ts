import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists, resolveCommand, runCommand, runRobocopy, writeHeader, writeSuccess, writeWarn } from "./exec";
import { invokeNpmWithResult, invokeNpxWithResult } from "./npm";
import {
  setManifestStepState,
  StateManifest,
  writeStateManifest,
} from "./manifest";

export interface ExtractionStageResult {
  sevenZip: string;
  extractedDir: string;
  electronDir: string;
  appDir: string;
  performed: boolean;
}

export function resolveDmgPath(explicit: string | undefined, repoRoot: string): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fileExists(resolved)) throw new Error(`DMG not found: ${resolved}`);
    return resolved;
  }

  const defaultDmg = path.join(repoRoot, "Codex.dmg");
  if (fileExists(defaultDmg)) return defaultDmg;

  const candidate = fs.readdirSync(repoRoot).find((entry) => entry.toLowerCase().endsWith(".dmg"));
  if (candidate) return path.join(repoRoot, candidate);
  throw new Error(`No DMG found in [${repoRoot}].`);
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

  const winget = resolveCommand("winget.exe") ?? resolveCommand("winget");
  if (winget) {
    runCommand(
      winget,
      [
        "install",
        "--id",
        "7zip.7zip",
        "-e",
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
      ],
      { allowNonZero: true, capture: true },
    );
    const afterInstall = resolveCommand("7z.exe") ?? resolveCommand("7z");
    if (afterInstall) return afterInstall;
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
  const canReuse = reuse && fileExists(appPackage);
  if (canReuse) {
    writeSuccess("Extraction cache hit: DMG signature unchanged. Reusing app payload.");
    return { sevenZip, extractedDir, electronDir, appDir, performed: false };
  }

  writeHeader("Extracting DMG");
  for (const dir of [extractedDir, electronDir, appDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
  }
  const dmgExtract = runCommand(sevenZip, ["x", "-y", dmgPath, `-o${extractedDir}`], {
    capture: true,
    allowNonZero: true,
  });

  writeHeader("Extracting app.asar");
  const hfs = path.join(extractedDir, "4.hfs");
  const directApp = path.join(extractedDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar");
  if (!fileExists(hfs) && !fileExists(directApp)) {
    throw new Error(
      `DMG extraction did not produce expected payload (4.hfs/app.asar). 7z exit=${dmgExtract.status}\n${dmgExtract.stderr || dmgExtract.stdout}`,
    );
  }
  if (dmgExtract.status !== 0) {
    writeWarn(`7z returned exit=${dmgExtract.status} while extracting DMG; continuing because required files are present.`);
  }

  if (fileExists(hfs)) {
    const hfsExtract = runCommand(
      sevenZip,
      [
        "x",
        "-y",
        hfs,
        "Codex Installer/Codex.app/Contents/Resources/app.asar",
        "Codex Installer/Codex.app/Contents/Resources/app.asar.unpacked",
        `-o${electronDir}`,
      ],
      { capture: true, allowNonZero: true },
    );
    const extractedAsar = path.join(
      electronDir,
      "Codex Installer",
      "Codex.app",
      "Contents",
      "Resources",
      "app.asar",
    );
    if (!fileExists(extractedAsar)) {
      throw new Error(
        `Failed to extract app.asar from HFS (7z exit=${hfsExtract.status}).\n${hfsExtract.stderr || hfsExtract.stdout}`,
      );
    }
    if (hfsExtract.status !== 0) {
      writeWarn(`7z returned exit=${hfsExtract.status} on HFS extraction; continuing.`);
    }
  } else {
    if (!fileExists(directApp)) throw new Error("app.asar not found.");
    const directUnpacked = path.join(
      extractedDir,
      "Codex Installer",
      "Codex.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
    );
    const destBase = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources");
    ensureDir(destBase);
    fs.copyFileSync(directApp, path.join(destBase, "app.asar"));
    if (fileExists(directUnpacked)) {
      runRobocopy(directUnpacked, path.join(destBase, "app.asar.unpacked"));
    }
  }

  writeHeader("Unpacking app.asar");
  const resourcesDir = path.join(electronDir, "Codex Installer", "Codex.app", "Contents", "Resources");
  const asarSource = path.join(resourcesDir, "app.asar");
  if (!fileExists(asarSource)) throw new Error("app.asar not found.");

  let asar = asarSource;
  const resourcesAlias = path.join(workDir, "_resources");
  try {
    fs.rmSync(resourcesAlias, { recursive: true, force: true });
    fs.symlinkSync(resourcesDir, resourcesAlias, "junction");
    asar = path.join(resourcesAlias, "app.asar");
  } catch {
    // Fallback for environments where junction creation is blocked.
    asar = path.join(workDir, "input-app.asar");
    fs.copyFileSync(asarSource, asar);
    const unpackedSource = path.join(resourcesDir, "app.asar.unpacked");
    if (fileExists(unpackedSource)) {
      runRobocopy(unpackedSource, `${asar}.unpacked`);
    }
  }

  const npmResult = invokeNpmWithResult(
    ["exec", "--yes", "--package", "@electron/asar", "--", "asar", "extract", asar, appDir],
    undefined,
    false,
  );
  if (npmResult.status !== 0) {
    writeWarn(`npm exec failed (exit=${npmResult.status}). Retrying with npx...`);
    const npxResult = invokeNpxWithResult(["-y", "@electron/asar", "extract", asar, appDir], undefined, false);
    if (npxResult.status !== 0) {
      const globalAsar = resolveCommand("asar.cmd") ?? resolveCommand("asar");
      if (globalAsar) {
        writeWarn(`npx failed (exit=${npxResult.status}). Retrying with global asar...`);
        const asarResult = runCommand(globalAsar, ["extract", asar, appDir], {
          capture: true,
          allowNonZero: true,
        });
        if (asarResult.status === 0) {
          writeSuccess("app.asar unpacked via global asar command.");
        } else {
          const npmDiag = (npmResult.stderr || npmResult.stdout || "").trim();
          const npxDiag = (npxResult.stderr || npxResult.stdout || "").trim();
          const asarDiag = (asarResult.stderr || asarResult.stdout || "").trim();
          throw new Error(
            `app.asar extraction failed via npm exec (exit=${npmResult.status}), npx (exit=${npxResult.status}), and global asar (exit=${asarResult.status}).` +
              (npmDiag ? `\n[npm] ${npmDiag}` : "") +
              (npxDiag ? `\n[npx] ${npxDiag}` : "") +
              (asarDiag ? `\n[asar] ${asarDiag}` : ""),
          );
        }
      } else {
        const npmDiag = (npmResult.stderr || npmResult.stdout || "").trim();
        const npxDiag = (npxResult.stderr || npxResult.stdout || "").trim();
        throw new Error(
          `app.asar extraction failed via npm exec (exit=${npmResult.status}) and npx (exit=${npxResult.status}).` +
            (npmDiag ? `\n[npm] ${npmDiag}` : "") +
            (npxDiag ? `\n[npx] ${npxDiag}` : ""),
        );
      }
    } else {
      writeSuccess("app.asar unpacked via npx fallback.");
    }
  }

  writeHeader("Syncing app.asar.unpacked");
  const unpacked = path.join(
    electronDir,
    "Codex Installer",
    "Codex.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
  );
  if (fileExists(unpacked)) {
    runRobocopy(unpacked, appDir);
  }

  setManifestStepState(manifest, "extract", extractSignature, "ok", { dmgPath });
  writeStateManifest(manifestPath, manifest);
  return { sevenZip, extractedDir, electronDir, appDir, performed: true };
}
