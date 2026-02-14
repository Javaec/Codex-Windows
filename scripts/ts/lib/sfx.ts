import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, removePath, runCommand, writeInfo } from "./exec";
import { applyExecutableBranding, copyCodexIconToOutput, resolveDefaultCodexIconPath } from "./branding";
import { resolve7z } from "./extract";

export interface SingleExeBuildResult {
  outputExe: string;
}

function resolveSfxModule(sevenZipExe: string): string | null {
  const candidates: string[] = [];
  const exeDir = path.dirname(sevenZipExe);
  candidates.push(path.join(exeDir, "7z.sfx"));
  candidates.push(path.join(exeDir, "7zCon.sfx"));

  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "7-Zip", "7z.sfx"));
    candidates.push(path.join(process.env.ProgramFiles, "7-Zip", "7zCon.sfx"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "7-Zip", "7z.sfx"));
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "7-Zip", "7zCon.sfx"));
  }

  const scoopMarker = `${path.sep}scoop${path.sep}shims${path.sep}`;
  const normalizedExe = path.normalize(sevenZipExe).toLowerCase();
  const scoopIndex = normalizedExe.indexOf(scoopMarker);
  if (scoopIndex >= 0) {
    const root = sevenZipExe.slice(0, scoopIndex);
    candidates.push(path.join(root, "scoop", "apps", "7zip", "current", "7z.sfx"));
    candidates.push(path.join(root, "scoop", "apps", "7zip", "current", "7zCon.sfx"));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

function buildSfxConfigFile(tempDir: string): string {
  const configPath = path.join(tempDir, "sfx-config.txt");
  const config = [
    ";!@Install@!UTF-8!",
    'Title="Codex Windows Portable"',
    'RunProgram="Launch-Codex.cmd"',
    'GUIMode="2"',
    ";!@InstallEnd@!",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, config, "utf8");
  return configPath;
}

export async function invokeSingleExeBuild(
  portableDir: string,
  distDir: string,
  workDir: string,
  appVersion: string,
): Promise<SingleExeBuildResult> {
  const sevenZipExe = resolve7z(workDir);
  const sfxModule = resolveSfxModule(sevenZipExe);
  if (!sfxModule) {
    throw new Error(
      `7z SFX module was not found near [${sevenZipExe}]. Install full 7-Zip distribution with 7z.sfx to build single EXE.`,
    );
  }

  const outputBaseName = path.basename(portableDir);
  const outputExe = path.join(distDir, `${outputBaseName}-single.exe`);
  const tempDir = path.join(workDir, "sfx-build", outputBaseName);
  const archivePath = path.join(tempDir, "payload.7z");

  removePath(tempDir);
  ensureDir(tempDir);

  writeInfo("Compressing portable payload for SFX...");
  const archiveResult = runCommand(
    sevenZipExe,
    ["a", "-t7z", "-mx=9", "-mmt=on", archivePath, "*"],
    { cwd: portableDir, allowNonZero: true, capture: true },
  );
  if (archiveResult.status !== 0 || !fs.existsSync(archivePath)) {
    throw new Error(
      `7z archive creation failed (exit=${archiveResult.status}).\n${archiveResult.stderr || archiveResult.stdout}`,
    );
  }

  const configPath = buildSfxConfigFile(tempDir);
  const sfxData = fs.readFileSync(sfxModule);
  const configData = fs.readFileSync(configPath);
  const archiveData = fs.readFileSync(archivePath);
  fs.writeFileSync(outputExe, Buffer.concat([sfxData, configData, archiveData]));

  if (!fs.existsSync(outputExe)) {
    throw new Error(`Failed to create single EXE at [${outputExe}]`);
  }

  const iconPath = resolveDefaultCodexIconPath();
  if (iconPath) {
    copyCodexIconToOutput(iconPath, path.dirname(outputExe));
  }
  await applyExecutableBranding(outputExe, {
    productName: "Codex",
    fileDescription: "Codex Windows Portable",
    appVersion,
    iconPath,
    workDir,
  });

  return { outputExe };
}
