import * as path from "node:path";
import { copyFileSafe, ensureDir, fileExists, resolveCommand, runCommand, writeWarn } from "./exec";

export interface BrandingOptions {
  productName: string;
  fileDescription: string;
  appVersion: string;
  iconPath: string;
  workDir: string;
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  await import("node:fs/promises").then((fsp) => fsp.writeFile(outputPath, data));
}

function normalizeVersion(value: string): string {
  const input = (value || "").trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(input)) return input;
  if (/^\d+\.\d+\.\d+$/.test(input)) return `${input}.0`;
  if (/^\d+\.\d+$/.test(input)) return `${input}.0.0`;
  if (/^\d+$/.test(input)) return `${input}.0.0.0`;
  return "1.0.0.0";
}

function resolveBundledRcedit(workDir: string): string {
  const rceditDir = ensureDir(path.join(workDir, "tools", "rcedit"));
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return path.join(rceditDir, `rcedit-${arch}.exe`);
}

export async function ensureRcedit(workDir: string): Promise<string> {
  const envOverride = process.env.CODEX_RCEDIT_PATH;
  if (envOverride && fileExists(envOverride)) return path.resolve(envOverride);

  const pathResolved = resolveCommand("rcedit.exe") ?? resolveCommand("rcedit");
  if (pathResolved) return pathResolved;

  const bundled = resolveBundledRcedit(workDir);
  if (fileExists(bundled)) return bundled;

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const url = `https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-${arch}.exe`;
  await downloadFile(url, bundled);
  if (!fileExists(bundled)) {
    throw new Error(`rcedit download failed: ${bundled}`);
  }
  return bundled;
}

export function resolveDefaultCodexIconPath(): string {
  if (process.env.CODEX_ICON_PATH && fileExists(process.env.CODEX_ICON_PATH)) {
    return path.resolve(process.env.CODEX_ICON_PATH);
  }

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const candidates = [
    path.join(repoRoot, "icons", "codex.ico"),
    path.join(repoRoot, "reference", "Codex-Windows-main-3", "icons", "codex.ico"),
    path.join(repoRoot, "reference", "Codex-Windows-main-2", "codexd-launcher", "codex.ico"),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return "";
}

export async function applyExecutableBranding(executablePath: string, options: BrandingOptions): Promise<boolean> {
  if (!fileExists(executablePath)) return false;

  const iconPath = options.iconPath && fileExists(options.iconPath) ? options.iconPath : "";
  const appVersion = normalizeVersion(options.appVersion);
  const rcedit = await ensureRcedit(options.workDir);
  const fileName = path.basename(executablePath);

  const args = [
    executablePath,
    "--set-version-string",
    "ProductName",
    options.productName,
    "--set-version-string",
    "FileDescription",
    options.fileDescription,
    "--set-version-string",
    "InternalName",
    options.productName,
    "--set-version-string",
    "OriginalFilename",
    fileName,
    "--set-version-string",
    "CompanyName",
    "OpenAI",
    "--set-file-version",
    appVersion,
    "--set-product-version",
    appVersion,
  ];

  if (iconPath) {
    args.push("--set-icon", iconPath);
  }

  const result = runCommand(rcedit, args, {
    allowNonZero: true,
    capture: true,
  });
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || "").trim();
    writeWarn(`rcedit branding failed (exit=${result.status}) for ${executablePath}${output ? ` :: ${output}` : ""}`);
    return false;
  }

  return true;
}

export function copyCodexIconToOutput(iconPath: string, outputDir: string): string {
  if (!iconPath || !fileExists(iconPath)) return "";
  const destination = path.join(outputDir, "codex.ico");
  copyFileSafe(iconPath, destination);
  return destination;
}

export async function prepareDirectLaunchExecutable(
  electronExePath: string,
  appVersion: string,
  workDir: string,
): Promise<string> {
  if (!fileExists(electronExePath)) return electronExePath;

  const targetExe = path.join(path.dirname(electronExePath), "Codex.exe");
  try {
    copyFileSafe(electronExePath, targetExe);
  } catch (error) {
    writeWarn(
      `Failed to copy direct runtime to Codex.exe; falling back to electron.exe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return electronExePath;
  }

  const iconPath = resolveDefaultCodexIconPath();
  try {
    const branded = await applyExecutableBranding(targetExe, {
      productName: "Codex",
      fileDescription: "Codex by OpenAI",
      appVersion,
      iconPath,
      workDir,
    });
    if (!branded) {
      writeWarn("Direct runtime branding did not apply cleanly; executable name will still be Codex.exe.");
    }
  } catch (error) {
    writeWarn(`Direct runtime branding failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return targetExe;
}
