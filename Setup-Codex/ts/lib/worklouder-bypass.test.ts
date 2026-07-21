import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildWorkLouderStubExpression,
  buildCodexLaunchEnvironment,
  CODEX_WORKLOUDER_MODULE,
  hasChatGPTProcessInTasklist,
  main,
  resolveWorkLouderLauncherMode,
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

test("launcher removes inherited session state and selects bundled CLI", () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), "codex-worklouder-env-"));
  try {
    const appRoot = path.join(packageRoot, "app");
    const executablePath = path.join(appRoot, "ChatGPT.exe");
    const bundledCliPath = path.join(appRoot, "resources", "codex.exe");
    mkdirSync(path.dirname(bundledCliPath), { recursive: true });
    writeFileSync(bundledCliPath, "bundled");
    const environment = buildCodexLaunchEnvironment(executablePath, {
      CODEX_HOME: "C:\\Users\\lensm\\.codex",
      CODEX_LB_API_KEY: "preserve",
      CODEX_THREAD_ID: "stale-thread",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "stale-originator",
      CODEX_WORKLOUDER_LOG_DIR: "launcher-log",
      CODEX_CLI_PATH: "stale-cli",
      PATH: "system-path",
    });
    assert.equal(environment.CODEX_HOME, "C:\\Users\\lensm\\.codex");
    assert.equal(environment.CODEX_LB_API_KEY, "preserve");
    assert.equal(environment.CODEX_THREAD_ID, undefined);
    assert.equal(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
    assert.equal(environment.CODEX_WORKLOUDER_LOG_DIR, undefined);
    assert.equal(environment.CODEX_CLI_PATH, bundledCliPath);
    assert.equal(environment.PATH, "system-path");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("launcher drops stale CLI overrides when bundled CLI is unavailable", () => {
  const environment = buildCodexLaunchEnvironment("C:\\missing\\ChatGPT.exe", {
    codex_thread_id: "stale-thread",
    CODEX_CLI_PATH: "stale-cli",
    PATH: "system-path",
  });
  assert.equal(environment.codex_thread_id, undefined);
  assert.equal(environment.CODEX_CLI_PATH, undefined);
  assert.equal(environment.PATH, "system-path");
});

test("stub intercepts Work Louder device kit and native watcher", () => {
  const originalLoad = moduleRuntime._load;
  try {
    Function("require", buildWorkLouderStubExpression(false))(require);
    const stub = moduleRuntime._load(CODEX_WORKLOUDER_MODULE, module, false) as {
      WLDeviceDiscovery: new () => { findWLDevices(): unknown[] };
      ConnectionType: { hid: number };
      DeviceType: { Project2077: string };
      OAILightingEffect: { off: number; shallowBreath: number };
    };
    assert.deepEqual(new stub.WLDeviceDiscovery().findWLDevices(), []);
    assert.equal(stub.ConnectionType.hid, 1);
    assert.equal(stub.DeviceType.Project2077, "project_2077");
    assert.equal(stub.OAILightingEffect.off, 0);
    assert.equal(stub.OAILightingEffect.shallowBreath, 6);
    const nativeWatcher = moduleRuntime._load("C:\\app\\native\\hid_topology_watcher.node", module, false) as {
      findCodexMicroInterfaces(): unknown[];
    };
    assert.deepEqual(nativeWatcher.findCodexMicroInterfaces(), []);
    const relativeNativeWatcher = moduleRuntime._load("hid-topology-watcher.node", module, false) as typeof nativeWatcher;
    assert.deepEqual(relativeNativeWatcher.findCodexMicroInterfaces(), []);
    assert.equal(moduleRuntime._load("node:fs", module, false), require("node:fs"));
  } finally {
    moduleRuntime._load = originalLoad;
  }
});

test("hook leaves Codex Micro service entry to Node", () => {
  const originalLoad = moduleRuntime._load;
  const packageRoot = mkdtempSync(path.join(tmpdir(), "codex-worklouder-service-"));
  const servicePath = path.join(packageRoot, "codex-micro-service-test.js");
  try {
    writeFileSync(servicePath, "module.exports = { original: true };\n", "ascii");
    Function("require", buildWorkLouderStubExpression(false))(require);
    assert.deepEqual(moduleRuntime._load(servicePath, module, false), { original: true });
  } finally {
    moduleRuntime._load = originalLoad;
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("injection expression is narrowly scoped", () => {
  const expression = buildWorkLouderStubExpression(false);
  assert.match(expression, /request\s*===\s*target/);
  assert.match(expression, new RegExp(CODEX_WORKLOUDER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(expression, /Module\._resolveFilename/);
  assert.doesNotMatch(expression, /codex-micro-service-/);
  assert.match(expression, /hid_topology_watcher/);
});

test("module request patterns cover packed and relative native paths", () => {
  const expression = buildWorkLouderStubExpression(false);
  assert.match(expression, /hid-topology-watcher/);
});

test("tasklist detection matches only ChatGPT.exe rows", () => {
  assert.equal(hasChatGPTProcessInTasklist('"ChatGPT.exe","1234","Console","1","120,000 K"'), true);
  assert.equal(hasChatGPTProcessInTasklist('"Codex.exe","1234","Console","1","120,000 K"'), false);
  assert.equal(hasChatGPTProcessInTasklist('"Other.exe","1234","Console","1","120,000 K"'), false);
  assert.equal(hasChatGPTProcessInTasklist("INFO: No tasks are running which match the specified criteria."), false);
});

test("launcher defaults to the safe non-persistent mode", () => {
  assert.equal(resolveWorkLouderLauncherMode([]), "launch-once");
  assert.equal(resolveWorkLouderLauncherMode(["--dry-run"]), "dry-run");
  assert.equal(resolveWorkLouderLauncherMode(["--diagnose"]), "diagnose");
});

test("persistent install is rejected before package or process access", async () => {
  await assert.rejects(
    () => main(["--install-persistent"]),
    /invalidates the signed AppX package/,
  );
});
