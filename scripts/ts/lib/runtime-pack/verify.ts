import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists } from "../exec";

const WEBVIEW_CWD_PATCH_MARKER = "/* CODEX-WINDOWS-CWD-NORMALIZER-V1 */";

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

export function verifyPortableRuntimeContract(options: PortableRuntimeContractOptions): void {
  const resourcesDir = path.join(options.outputDir, "resources");
  const appDir = path.join(resourcesDir, "app");

  assertExists(path.join(options.outputDir, "Codex.exe"), "portable executable");
  assertExists(appDir, "packaged app directory");
  assertExists(path.join(resourcesDir, "codex.exe"), "bundled codex.exe");
  assertExists(path.join(resourcesDir, "rg.exe"), "bundled rg.exe");
  assertExists(path.join(resourcesDir, "path", "rg.exe"), "bundled path/rg.exe");
  assertExists(path.join(options.outputDir, "Launch-Codex.cmd"), "default launcher");

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
}
