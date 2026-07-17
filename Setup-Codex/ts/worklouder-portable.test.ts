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
    "Launch-Codex-WorkLouder-Bypass.cmd",
    "README.md",
    "SHA256SUMS.txt",
    "build-metadata.json",
    "worklouder-bypass.js",
  ]);
  assert.equal(files.some((file) => /Codex-Windows|node_modules|\.codex/i.test(file)), false);
});
