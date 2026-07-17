import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildWorkLouderStubExpression,
  CODEX_WORKLOUDER_MODULE,
  hasChatGPTProcessInTasklist,
  validateCodexTarget,
} from "./worklouder-bypass";

const moduleRuntime = require("node:module") as {
  _load(request: string, parent: NodeModule, isMain: boolean): unknown;
};

test("adaptive target accepts a new version when the module contract exists", () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), "codex-worklouder-"));
  try {
    const appRoot = path.join(packageRoot, "app");
    const workLouderRoot = path.join(
      appRoot,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@worklouder",
      "device-kit-oai",
    );
    mkdirSync(path.join(workLouderRoot, "dist"), { recursive: true });
    writeFileSync(path.join(appRoot, "ChatGPT.exe"), "test");
    writeFileSync(path.join(appRoot, "resources", "app.asar"), "test");
    writeFileSync(
      path.join(workLouderRoot, "package.json"),
      JSON.stringify({ name: CODEX_WORKLOUDER_MODULE }),
    );
    writeFileSync(path.join(workLouderRoot, "dist", "index.js"), "module.exports = {};");

    const target = validateCodexTarget({
      name: "OpenAI.Codex",
      version: "99.100.200.0",
      installLocation: packageRoot,
    });
    assert.equal(target.version, "99.100.200.0");
    assert.equal(target.workLouderPackagePath, workLouderRoot);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("adaptive target accepts unpacked native-only package layout", () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), "codex-worklouder-"));
  try {
    const appRoot = path.join(packageRoot, "app");
    const deviceKitRoot = path.join(
      appRoot,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@worklouder",
      "device-kit-oai",
      "node_modules",
      "@worklouder",
      "wl-device-kit",
    );
    mkdirSync(path.join(deviceKitRoot, "node_modules", "node-hid", "build", "Release"), { recursive: true });
    mkdirSync(path.join(appRoot, "resources"), { recursive: true });
    writeFileSync(path.join(appRoot, "ChatGPT.exe"), "test");
    writeFileSync(path.join(appRoot, "resources", "app.asar"), "test");
    writeFileSync(path.join(deviceKitRoot, "node_modules", "node-hid", "build", "Release", "HID.node"), "test");

    const target = validateCodexTarget({
      name: "OpenAI.Codex",
      version: "99.100.200.0",
      installLocation: packageRoot,
    });
    assert.equal(target.version, "99.100.200.0");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("adaptive target accepts architecture-specific prebuilds", () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), "codex-worklouder-"));
  try {
    const appRoot = path.join(packageRoot, "app");
    const prebuildRoot = path.join(
      appRoot,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@worklouder",
      "device-kit-oai",
      "node_modules",
      "@worklouder",
      "wl-device-kit",
      "node_modules",
      "node-hid",
      "prebuilds",
      "win32-arm64",
    );
    mkdirSync(prebuildRoot, { recursive: true });
    mkdirSync(path.join(appRoot, "resources"), { recursive: true });
    writeFileSync(path.join(appRoot, "ChatGPT.exe"), "test");
    writeFileSync(path.join(appRoot, "resources", "app.asar"), "test");
    writeFileSync(path.join(prebuildRoot, "node.napi.node"), "test");

    assert.equal(validateCodexTarget({
      name: "OpenAI.Codex",
      version: "99.100.200.0",
      installLocation: packageRoot,
    }).version, "99.100.200.0");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("adaptive target fails closed when the module contract is missing", () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), "codex-worklouder-"));
  try {
    const appRoot = path.join(packageRoot, "app");
    mkdirSync(path.join(appRoot, "resources"), { recursive: true });
    writeFileSync(path.join(appRoot, "ChatGPT.exe"), "test");
    writeFileSync(path.join(appRoot, "resources", "app.asar"), "test");
    assert.throws(
      () => validateCodexTarget({ name: "OpenAI.Codex", version: "99.100.200.0", installLocation: packageRoot }),
      /adapter update required/,
    );
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("stub intercepts only Work Louder and returns no devices", () => {
  const originalLoad = moduleRuntime._load;
  try {
    Function("require", buildWorkLouderStubExpression(false))(require);
    const stub = moduleRuntime._load(CODEX_WORKLOUDER_MODULE, module, false) as {
      WLDeviceDiscovery: new () => { findWLDevices(): unknown[] };
    };
    assert.deepEqual(new stub.WLDeviceDiscovery().findWLDevices(), []);
    assert.equal(moduleRuntime._load("node:fs", module, false), require("node:fs"));
  } finally {
    moduleRuntime._load = originalLoad;
  }
});

test("injection expression is narrowly scoped", () => {
  const expression = buildWorkLouderStubExpression(false);
  assert.match(expression, /request\s*===\s*target/);
  assert.match(expression, new RegExp(CODEX_WORKLOUDER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(expression, /Module\._resolveFilename/);
});

test("tasklist detection matches only ChatGPT.exe rows", () => {
  assert.equal(hasChatGPTProcessInTasklist('"ChatGPT.exe","1234","Console","1","120,000 K"'), true);
  assert.equal(hasChatGPTProcessInTasklist('"Codex.exe","1234","Console","1","120,000 K"'), true);
  assert.equal(hasChatGPTProcessInTasklist('"Other.exe","1234","Console","1","120,000 K"'), false);
  assert.equal(hasChatGPTProcessInTasklist("INFO: No tasks are running which match the specified criteria."), false);
});
