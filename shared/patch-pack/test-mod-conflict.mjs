import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const patchPackRoot = path.dirname(currentFilePath);
const preflightPath = path.join(patchPackRoot, "preflight.mjs");

const args = [
  preflightPath,
  "--include-test-profiles",
  "--patch-profile",
  "test-mod-conflict",
  "--snapshot-label",
  "Codex-10711.dmg",
  "--app-version",
  "26.303.1606",
  "--build-number",
  "806",
];

const result = spawnSync(process.execPath, args, {
  cwd: path.resolve(patchPackRoot, "..", ".."),
  encoding: "utf8",
});

const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
const hasConflictMessage =
  combinedOutput.includes("conflicting mods") &&
  combinedOutput.includes("webview-sunset-optional") &&
  combinedOutput.includes("webview-sunset-strict");

if (result.status === 0) {
  throw new Error(
    "patch-pack conflict test failed: expected non-zero exit for test-mod-conflict profile, but preflight succeeded.",
  );
}

if (!hasConflictMessage) {
  throw new Error(`patch-pack conflict test failed: expected conflict message not found.\n${combinedOutput}`);
}

process.stdout.write("patch-pack conflict test passed: conflict profile is rejected as expected.\n");
