import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import { buildPortablePackage } from "./worklouder-portable";

test("portable archive contains only shareable launcher files", () => {
  const result = buildPortablePackage();
  assert.equal(fs.existsSync(result.archivePath), true);

  const listing = spawnSync("tar.exe", ["-tf", result.archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.equal(listing.status, 0, String(listing.stderr || "tar failed"));
  const files = String(listing.stdout || "")
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(files, [
    "Check-Persistent-Patch.cmd",
    "Install-Persistent-Patch.cmd",
    "Launch-Codex-WorkLouder-Bypass.cmd",
    "Manage-Persistent-Patch.ps1",
    "README.md",
    "Restore-Persistent-Patch.cmd",
    "SHA256SUMS.txt",
    "build-metadata.json",
    "worklouder-bypass.js",
    "worklouder-persistent-patch.js",
  ]);
  assert.equal(files.some((file) => /Codex-Windows|node_modules|\.codex/i.test(file)), false);
});
