import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractAsarArchive } from "../asar";
import { fileExists, removePath } from "../exec";

const WEBVIEW_CWD_PATCH_MARKER = "/* CODEX-WINDOWS-CWD-NORMALIZER-V2 */";
const MAIN_WINDOWS_PATH_GUIDANCE_PATCH_MARKER = "/* CODEX-WINDOWS-PATH-GUIDANCE-V1 */";

export interface PortableRuntimeContractOptions {
  outputDir: string;
  includeRuntimeMods: boolean;
  requireWebviewCwdPatch: boolean;
}

function assertExists(targetPath: string, label: string): void {
  if (!fileExists(targetPath)) {
    throw new Error(`Portable runtime contract failed: missing ${label}: ${targetPath}`);
  }
}

function getFileSha256(targetPath: string): string {
  return createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
}

function verifyWebviewCwdPatch(resourcesAppDir: string): void {
  const assetsDir = path.join(resourcesAppDir, "webview", "assets");
  assertExists(assetsDir, "webview assets directory");
  const jsBundles = fs.readdirSync(assetsDir).filter((name) => /\.js$/i.test(name));
  if (jsBundles.length < 1) {
    throw new Error(`Portable runtime contract failed: no webview js bundle found in ${assetsDir}`);
  }
  const patched = jsBundles.some((fileName) => {
    const content = fs.readFileSync(path.join(assetsDir, fileName), "utf8");
    return content.includes(WEBVIEW_CWD_PATCH_MARKER);
  });
  if (!patched) {
    throw new Error("Portable runtime contract failed: webview cwd patch marker not found in packaged webview bundle.");
  }
}

function verifyMainPathGuidancePatch(resourcesAppDir: string): void {
  const buildDir = path.join(resourcesAppDir, ".vite", "build");
  assertExists(buildDir, "packaged build directory");
  const jsBundles = fs.readdirSync(buildDir).filter((name) => /\.js$/i.test(name));
  if (jsBundles.length < 1) {
    throw new Error(`Portable runtime contract failed: no build js bundle found in ${buildDir}`);
  }
  const patched = jsBundles.some((fileName) => {
    const content = fs.readFileSync(path.join(buildDir, fileName), "utf8");
    return content.includes(MAIN_WINDOWS_PATH_GUIDANCE_PATCH_MARKER);
  });
  if (!patched) {
    throw new Error("Portable runtime contract failed: Windows path guidance patch marker not found in packaged main bundle.");
  }
}

function resolvePackagedAppDir(outputDir: string, resourcesDir: string): { appDir: string; cleanup: () => void } {
  const unpackedAppDir = path.join(resourcesDir, "app");
  if (fileExists(unpackedAppDir)) {
    return { appDir: unpackedAppDir, cleanup: () => {} };
  }

  const packedAppPath = path.join(resourcesDir, "app.asar");
  assertExists(packedAppPath, "packaged app archive");
  assertExists(`${packedAppPath}.unpacked`, "packaged app unpacked directory");

  const inspectDir = path.join(outputDir, ".verify-app");
  removePath(inspectDir);
  extractAsarArchive(packedAppPath, inspectDir);
  return {
    appDir: inspectDir,
    cleanup: () => removePath(inspectDir),
  };
}

export function verifyPortableRuntimeContract(options: PortableRuntimeContractOptions): void {
  const resourcesDir = path.join(options.outputDir, "resources");
  const bundledRipgrepPath = path.join(resourcesDir, "rg.exe");
  const bundledPathRipgrepPath = path.join(resourcesDir, "path", "rg.exe");

  assertExists(path.join(options.outputDir, "Codex.exe"), "portable executable");
  assertExists(path.join(resourcesDir, "codex.exe"), "bundled codex.exe");
  assertExists(bundledRipgrepPath, "bundled rg.exe");
  assertExists(bundledPathRipgrepPath, "bundled path/rg.exe");
  if (getFileSha256(bundledRipgrepPath) !== getFileSha256(bundledPathRipgrepPath)) {
    throw new Error("Portable runtime contract failed: bundled rg.exe and path/rg.exe differ.");
  }
  assertExists(path.join(options.outputDir, "Launch-Codex.cmd"), "default launcher");
  const { appDir, cleanup } = resolvePackagedAppDir(options.outputDir, resourcesDir);
  try {
    assertExists(path.join(appDir, ".vite", "build", "codex-windows-path-contract.cjs"), "runtime windows path contract helper");
    verifyMainPathGuidancePatch(appDir);

    if (options.includeRuntimeMods) {
      assertExists(path.join(resourcesDir, "mods"), "runtime mods directory");
      assertExists(path.join(resourcesDir, "mod-api"), "runtime mod API directory");
      assertExists(path.join(resourcesDir, "mod-loader"), "runtime mod loader directory");
      assertExists(path.join(resourcesDir, "compatibility.cjs"), "runtime compatibility helper");
      assertExists(path.join(resourcesDir, "version-identity"), "runtime version identity directory");
      assertExists(path.join(options.outputDir, "Launch-Codex-with-mods.cmd"), "with-mods launcher");
    }

    if (options.requireWebviewCwdPatch) {
      verifyWebviewCwdPatch(appDir);
    }
  } finally {
    cleanup();
  }
}
