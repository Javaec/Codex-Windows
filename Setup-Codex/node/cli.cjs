#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runner = path.join(__dirname, "run.js");
const result = spawnSync(process.execPath, [runner, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 1);
